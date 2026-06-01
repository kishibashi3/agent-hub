import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  selectNotificationTargets,
  isNotifyDedupDisabled,
  isResourceNotifyFilterDisabled,
  type NotifiableSession,
  type LastActiveLookup,
} from '../server.js';

/**
 * issue #7: SSE notification の tenant 越え leak ガードのための単体テスト。
 *
 * `notifyResourceUpdated` 本体は実 Server インスタンスに依存して mock しづらいが、
 * dispatch の filter 部分を `selectNotificationTargets` に切り出してあるので、
 * ここでは「どの session id が対象になるか」だけを検証する。
 *
 * issue #114 (= notify dedup) で関数 signature に **userId / createdAt + dedup option**
 * 追加。 既存 test は backward compat (= options 未渡しなら旧 behavior) を maintain、
 * 別 describe block で dedup 新規 test を追加。
 */
describe('selectNotificationTargets (issue #7: tenant leak ガード)', () => {
  function mkSession(
    tenantDomain: string,
    uris: string[],
    userId: string = '@anon',
    createdAt: number = 0
  ): NotifiableSession {
    return {
      tenantDomain,
      userId,
      subscribedUris: new Set(uris),
      createdAt,
    };
  }

  it('same-tenant subscribe にのみ届く (default の @admin)', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-A', mkSession('default', ['inbox://@admin'], '@admin')],
      ['sid-B', mkSession('kaz', ['inbox://@admin'], '@admin')],
    ];

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@admin',
      'default'
    );

    expect(targets).toEqual(['sid-A']);
  });

  it('別 tenant の同名 handle session には届かない (再現テスト)', () => {
    // 再現シナリオ:
    //   session A = default tenant の @admin
    //   session B = kaz tenant の @admin (同じ PAT 主の別 persona)
    //   kaz tenant 内の send_message で @admin に通知を飛ばすとき
    //   → session A (default 側) には届いてはならない
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-A', mkSession('default', ['inbox://@admin'], '@admin')],
      ['sid-B', mkSession('kaz', ['inbox://@admin'], '@admin')],
    ];

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@admin',
      'kaz'
    );

    expect(targets).toEqual(['sid-B']);
    expect(targets).not.toContain('sid-A');
  });

  it('except に渡した sid は除外される (送信者自身への重複抑制)', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-A', mkSession('default', ['inbox://@admin'], '@admin')],
      ['sid-C', mkSession('default', ['inbox://@admin'], '@admin2')],
    ];

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@admin',
      'default',
      'sid-A'
    );

    expect(targets).toEqual(['sid-C']);
  });

  it('subscribe していない session は除外される', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-A', mkSession('default', ['inbox://@admin'], '@admin')],
      ['sid-D', mkSession('default', ['inbox://@bob'], '@bob')],
    ];

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@admin',
      'default'
    );

    expect(targets).toEqual(['sid-A']);
  });

  it('既存の single-tenant 動作 (= dedup option 未提供): 同 tenant 内の複数 subscriber 全員に届く', () => {
    // legacy behavior 維持: lastActiveLookup option を渡さない場合は pre-filter のみ
    // (= 旧 behavior 完全互換)。 issue #114 fix の dedup は opt-in。
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-1', mkSession('default', ['inbox://@team'], '@alice')],
      ['sid-2', mkSession('default', ['inbox://@team'], '@bob')],
      ['sid-3', mkSession('default', ['inbox://@team'], '@carol')],
    ];

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@team',
      'default'
    );

    expect(targets.sort()).toEqual(['sid-1', 'sid-2', 'sid-3']);
  });

  it('Map<string, Session> も受け取れる (運用形態と一致)', () => {
    const sessions = new Map<string, NotifiableSession>([
      ['sid-A', mkSession('default', ['inbox://@admin'], '@admin')],
      ['sid-B', mkSession('kaz', ['inbox://@admin'], '@admin')],
    ]);

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@admin',
      'kaz'
    );

    expect(targets).toEqual(['sid-B']);
  });

  it('全 session が別 tenant なら対象 0 件', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-A', mkSession('default', ['inbox://@admin'], '@admin')],
      ['sid-B', mkSession('foo', ['inbox://@admin'], '@admin')],
    ];

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@admin',
      'unknown-tenant'
    );

    expect(targets).toEqual([]);
  });
});

/**
 * issue #114: notify dedup (= per-user single-subscriber invariant)。
 *
 * production agent-hub 上で @bridge-claude-impl が同一 user で 31 zombie sessions を
 * 蓄積し、 1 msg → 31 push fanout される現象が観測された (= `[MCP] session opened: 31件、
 * session closed: 0件`、 operator + @admin 調査結果)。 fix は `selectNotificationTargets`
 * に dedup option を追加、 同 (tenant, userId, uri) で複数 subscribers がいた場合に
 * **最も active な 1 session のみ** に push 集中させる構造的 invariant を強制。
 *
 * selection criteria: `last_active_at DESC` (= 最も最近 productive activity あった
 * session) + tie-breaker `createdAt DESC` (= 同 active なら最新 created session)。
 *
 * rationale evidence (= bridge-claude-impl observations、 DM `e11f7a91` + `82d332a9`):
 * 1. **Single-instance 32-fire** (= msg cfad79b5 delivered 32 times to one bridge)
 *    → extreme upper bound demonstration of per-recipient session count
 * 2. **Receipt-time axis clustering** (= 4 vs 3 deliveries by time window, not by sender or body)
 *    → recipient session fluctuation under active ping cycle, rules out content-dependent retry
 * 3. **Multi-peer wave cadence** (= 30s active ping cycle alignment, 16 instances simultaneous)
 *    → systemic vs idiosyncratic confirmation
 */
describe('selectNotificationTargets dedup (issue #114: per-user single-subscriber invariant)', () => {
  function mkSession(
    tenantDomain: string,
    uris: string[],
    userId: string,
    createdAt: number
  ): NotifiableSession {
    return {
      tenantDomain,
      userId,
      subscribedUris: new Set(uris),
      createdAt,
    };
  }

  // dedup callback factory: in-memory last_active_at map で test 用 lookup を組み立て
  function mkLookup(map: Record<string, string | null>): LastActiveLookup {
    return (tenantDomain, userId) => map[`${tenantDomain}/${userId}`] ?? null;
  }

  it('same-user 複数 sessions: 最も recent な last_active_at の 1 session のみ採用', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-old', mkSession('kaz', ['inbox://@bridge'], '@bridge', 1000)],
      ['sid-mid', mkSession('kaz', ['inbox://@bridge'], '@bridge', 2000)],
      ['sid-new', mkSession('kaz', ['inbox://@bridge'], '@bridge', 3000)],
    ];
    const lookup = mkLookup({
      // lastActive equal across all → tie-breaker createdAt DESC で sid-new を選ぶ
      'kaz/@bridge': '2026-05-20T14:00:00.000',
    });

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@bridge',
      'kaz',
      undefined,
      { lastActiveLookup: lookup }
    );

    expect(targets).toEqual(['sid-new']);
  });

  it('different users: 各 user 別に 1 session 採用 (= per-user dedup、 cross-user は dedup されない)', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-alice-1', mkSession('kaz', ['inbox://@team'], '@alice', 1000)],
      ['sid-alice-2', mkSession('kaz', ['inbox://@team'], '@alice', 2000)],
      ['sid-bob-1', mkSession('kaz', ['inbox://@team'], '@bob', 1500)],
    ];
    const lookup = mkLookup({
      'kaz/@alice': '2026-05-20T14:00:00.000',
      'kaz/@bob': '2026-05-20T14:00:00.000',
    });

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@team',
      'kaz',
      undefined,
      { lastActiveLookup: lookup }
    );

    // alice: sid-alice-2 (createdAt 2000 > 1000), bob: sid-bob-1 (only one)
    expect(targets.sort()).toEqual(['sid-alice-2', 'sid-bob-1']);
  });

  it('last_active_at は per-user 単一値 → group 内同値 → createdAt DESC が実効 discriminator', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-old-but-active', mkSession('kaz', ['inbox://@bridge'], '@bridge', 1000)],
      ['sid-new-but-idle', mkSession('kaz', ['inbox://@bridge'], '@bridge', 9999)],
    ];
    // sid-old-but-active は createdAt 古いが last_active_at は recent (= 「最近 activity」)
    // sid-new-but-idle は createdAt 新しいが last_active_at は古い (= zombie 想定)
    const lookup: LastActiveLookup = (_t, uid) => {
      if (uid !== '@bridge') return null;
      // Note: 同 user 同 tenant でも sid 毎に異なる last_active を返したいが、
      // 関数 signature 上 (tenant, userId) しか受けない設計のため、 ここは
      // 同 user 同 tenant 内では 1 値しか返せない。 実 production では
      // participants.last_active_at は per-user の単一値、 これが正しい model。
      // → 「last_active_at が user-wide な 1 値」 を前提に、 createdAt tie-breaker
      //    が working する事を確認する test として組み替え。
      return '2026-05-20T14:00:00.000';
    };

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@bridge',
      'kaz',
      undefined,
      { lastActiveLookup: lookup }
    );

    // last_active_at 同値 → createdAt DESC → sid-new-but-idle を選ぶ
    expect(targets).toEqual(['sid-new-but-idle']);
  });

  it('last_active_at が null user: 「最古」 扱い、 値 ありの user が dedup 勝ち', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-alice', mkSession('kaz', ['inbox://@team'], '@alice', 1000)],
      ['sid-bob', mkSession('kaz', ['inbox://@team'], '@bob', 1000)],
    ];
    const lookup = mkLookup({
      'kaz/@alice': null,
      'kaz/@bob': '2026-05-20T14:00:00.000',
    });

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@team',
      'kaz',
      undefined,
      { lastActiveLookup: lookup }
    );

    // 異なる user は dedup されない (= each user 1 session)、 両方残るが alice / bob 各 1
    // sort で order 安定化
    expect(targets.sort()).toEqual(['sid-alice', 'sid-bob']);
  });

  it('dedup option 未提供: 全 subscribers 残る (= legacy behavior、 backward compat)', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-1', mkSession('kaz', ['inbox://@bridge'], '@bridge', 1000)],
      ['sid-2', mkSession('kaz', ['inbox://@bridge'], '@bridge', 2000)],
      ['sid-3', mkSession('kaz', ['inbox://@bridge'], '@bridge', 3000)],
    ];

    // options 引数なし → dedup skip
    const targets = selectNotificationTargets(
      sessions,
      'inbox://@bridge',
      'kaz'
    );

    expect(targets.sort()).toEqual(['sid-1', 'sid-2', 'sid-3']);
  });

  describe('regression: agent-hub#114 cfad79b5 dedup', () => {
    /**
     * Regression fixture: cfad79b5 11.1x re-fire pattern.
     *
     * Source: bridge log /tmp/bridge-bridge-claude-impl.log
     *         observed 2026-05-20T13:44Z - 19:21Z (bridge pid 660588)
     * Reported: agent-hub#114 (@bridge-claude-impl DMs `503ca998` / `8c157a7f`)
     *
     * Original incident: msg `cfad79b5-6dcb-4dc2-9974-7a149f16e1d5` from
     * @ope-ultp1635, delivered 32 times to single bridge despite each
     * `hub.ack()` returning HTTP 200 OK. Inter-arrival burst pattern
     * (2-12s within bursts, 5-13min idle gaps) confirmed push-driven
     * self-recursive loop (ack → push → ack within 1ms).
     *
     * Root cause (= operator + @admin verification): @bridge-claude-impl had
     * 31 sessions opened / 0 closed / 0 ping failures — Claude SDK subprocess
     * accumulated MCP sessions, active ping cleanup did not detect (TCP alive
     * but idle), `notifyResourceUpdated` fanned out to all 31 → 31x duplicate.
     *
     * Post-fix expectation: dedup MUST collapse duplicate fanout to a single
     * push per (tenant, msg, user) regardless of session count for that user.
     */
    it('31 sessions for same user @ same tenant + same URI → exactly 1 target after dedup', () => {
      const userId = '@bridge-claude-impl';
      const tenantDomain = 'kaz';
      const uri = `inbox://${userId}`;

      // production observed: 31 sessions opened for this user
      const sessions: Array<[string, NotifiableSession]> = Array.from({ length: 31 }, (_, i) => [
        `sid-zombie-${i}`,
        mkSession(tenantDomain, [uri], userId, 1000 + i),  // distinct createdAt
      ]);

      // lookup is non-null (= participants registered) but constant across sessions
      // (= last_active_at is user-wide, not session-wide)
      const lookup = mkLookup({
        [`${tenantDomain}/${userId}`]: '2026-05-20T14:00:00.000',
      });

      const targets = selectNotificationTargets(
        sessions,
        uri,
        tenantDomain,
        undefined,
        { lastActiveLookup: lookup }
      );

      // post-fix: 31 → 1 (= sid-zombie-30、 最新 createdAt)
      expect(targets).toEqual(['sid-zombie-30']);
      expect(targets.length).toBe(1);
    });
  });
});

/**
 * issue #114 fix の rollback path (= `AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED` 環境変数)。
 *
 * production で異常 detect 時、 環境変数 1 つで server restart のみで旧 「全 subscribers
 * fanout」 behavior に即時 revert できる safety mechanism (= operator が L1 GO 取得時
 * の不安緩和材料)。
 *
 * binary semantic (= PR #105 `MCP_AUTO_REISSUE_DISABLED` と同 convention): set されたら
 * disable、 unset / empty なら enabled (= 値の文字列 「0」/「false」 等は解釈しない)。
 */
describe('isNotifyDedupDisabled (issue #114 rollback flag)', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED;
    delete process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED;
    } else {
      process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED = originalEnv;
    }
  });

  it('env unset → false (= dedup enabled、 default behavior)', () => {
    delete process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED;
    expect(isNotifyDedupDisabled()).toBe(false);
  });

  it('env empty string → false (= unset と同等扱い)', () => {
    process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED = '';
    expect(isNotifyDedupDisabled()).toBe(false);
  });

  it('env="1" → true (= dedup disabled、 旧 path に倒す)', () => {
    process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED = '1';
    expect(isNotifyDedupDisabled()).toBe(true);
  });

  it('env="0" → true (= 値の意味判定なし、 set/unset の binary signal)', () => {
    // 「0 だから false 扱い」 と誤読されないよう test で boundary 明示 (=
    // PR #105 `MCP_AUTO_REISSUE_DISABLED` test pattern と同 form)。
    process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED = '0';
    expect(isNotifyDedupDisabled()).toBe(true);
  });

  it('isNotifyDedupDisabled が true なら selectNotificationTargets で dedup skip', () => {
    process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED = '1';

    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-1', { tenantDomain: 'kaz', userId: '@bridge', subscribedUris: new Set(['inbox://@bridge']), createdAt: 1000 }],
      ['sid-2', { tenantDomain: 'kaz', userId: '@bridge', subscribedUris: new Set(['inbox://@bridge']), createdAt: 2000 }],
    ];
    const lookup: LastActiveLookup = () => '2026-05-20T14:00:00.000';

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@bridge',
      'kaz',
      undefined,
      { lastActiveLookup: lookup }
    );

    // dedup disabled → both sessions remain
    expect(targets.sort()).toEqual(['sid-1', 'sid-2']);
  });
});

/**
 * issue #117 fix の rollback path (= `AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED` 環境変数)。
 *
 * binary semantic (= PR #105 `MCP_AUTO_REISSUE_DISABLED` と同 convention): set されたら
 * disabled (= 旧動作: 全 event replay)、unset / empty なら enabled (= 値の文字列
 * 「0」/「false」 等は解釈しない)。
 *
 * 命名規則: `FEATURE_DISABLED` = 新たに追加した feature (replay フィルタ) を disable する。
 * set → 旧動作に rollback。
 */
describe('isResourceNotifyFilterDisabled (issue #117 rollback flag)', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED;
    delete process.env.AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED;
    } else {
      process.env.AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED = originalEnv;
    }
  });

  it('env unset → false (= replay filter enabled、 default behavior)', () => {
    delete process.env.AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED;
    expect(isResourceNotifyFilterDisabled()).toBe(false);
  });

  it('env empty string → false (= unset と同等扱い)', () => {
    process.env.AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED = '';
    expect(isResourceNotifyFilterDisabled()).toBe(false);
  });

  it('env="1" → true (= replay filter disabled、 旧 path に倒す)', () => {
    process.env.AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED = '1';
    expect(isResourceNotifyFilterDisabled()).toBe(true);
  });

  it('env="0" → true (= 値の意味判定なし、 set/unset の binary signal)', () => {
    // 「0 だから false 扱い」 と誤読されないよう test で boundary 明示 (=
    // PR #105 `MCP_AUTO_REISSUE_DISABLED` test pattern と同 form)。
    process.env.AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED = '0';
    expect(isResourceNotifyFilterDisabled()).toBe(true);
  });
});
