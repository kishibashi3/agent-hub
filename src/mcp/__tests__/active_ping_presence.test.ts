import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isPingLoopDisabled,
  resolvePingLoopMode,
  _resetPingLoopObserveStateForTests,
  _getObservedFailingSessionsForTests,
  startActivePingLoop,
  stopActivePingLoop,
  runOneActivePingCycle,
  isOrphanEvictionDisabled,
  startOrphanEvictionLoop,
  stopOrphanEvictionLoop,
  runOneOrphanEvictionCycle,
  getOrphanEvictionIntervalMs,
  validateMcpEnvConfig,
  EnvConfigError,
  ORPHAN_EVICTION_INTERVAL_MS,
  ORPHAN_EVICTION_INTERVAL_MIN_MS,
  ORPHAN_EVICTION_INTERVAL_MAX_MS,
  MCPServer,
  _addSessionForTesting,
  _clearSessionsForTesting,
  _isEvictingSessionForTesting,
  ORPHAN_EVICT_LOG_LIMIT,
  getOrphanEvictionHeartbeatMs,
  ORPHAN_EVICTION_HEARTBEAT_MS,
  ORPHAN_EVICTION_HEARTBEAT_MIN_MS,
  ORPHAN_EVICTION_HEARTBEAT_MAX_MS,
} from '../server.js';

/**
 * issue #91 active ping-based presence の behavior test。
 *
 * spec (= issue #91): server が 30s 周期で全 session に ping、 応答なし → retry 2 回 →
 * 全 fail なら SSE disconnect + sessions Map から削除 → is_online 自動 false。
 *
 * scope (= 本 file):
 * - **feature flag** (= `AGENT_HUB_MCP_PING_LOOP_DISABLED`) の env binary signal 検証
 * - `startActivePingLoop()` / `stopActivePingLoop()` の idempotent + lifecycle 検証
 *
 * scope (= 別 test file 候補):
 * - 実 MCP transport 経由の ping/pong round-trip (= integration test、 別 issue #49 整備依存)
 * - retry sequence の正確な実機 verify (= 同上、 supertest infrastructure 必要)
 *
 * 本 unit test では public API contract + feature flag のみ verify、 retry / disconnect の
 * core path は integration test (= 別 issue) で cover。
 */
describe('MCP active ping presence (issue #91)', () => {
  // process.env 操作 isolation
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
    delete process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
  });

  afterEach(() => {
    // 何かしら起動した interval を必ず停止 (= test isolation)
    stopActivePingLoop();
    if (originalEnv === undefined) {
      delete process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
    } else {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = originalEnv;
    }
  });

  describe('isPingLoopDisabled() feature flag', () => {
    it('env unset → false (= active ping enabled、 default behavior)', () => {
      delete process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
      expect(isPingLoopDisabled()).toBe(false);
    });

    it('env empty string → false (= unset 同等、 redline #1 整合)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '';
      expect(isPingLoopDisabled()).toBe(false);
    });

    it('env="1" → true (= ping loop disabled、 SSE-only presence に倒す)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '1';
      expect(isPingLoopDisabled()).toBe(true);
    });

    it('env="true" → true (= 値の中身を問わない binary signal)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = 'true';
      expect(isPingLoopDisabled()).toBe(true);
    });

    it('env="0" → true (= 「0 だから false」 ではなく binary set/unset signal、 #68 と同 pattern)', () => {
      // operator rollback misconfig 防御: 値の semantic 解釈なし
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '0';
      expect(isPingLoopDisabled()).toBe(true);
    });

    it('env="false" → true (= 上記同様、 binary semantic)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = 'false';
      expect(isPingLoopDisabled()).toBe(true);
    });
  });

  describe('startActivePingLoop() / stopActivePingLoop() lifecycle', () => {
    it('flag disabled → start は no-op (= interval を作らない)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '1';
      const stop = startActivePingLoop();
      // stop function は返るが、 実際の clearInterval は no-op (= interval 不在)
      // double-stop でも crash しないことを確認
      stop();
      stopActivePingLoop();
      // ここまで example noop で完走 → expectations 不要だが framework として 1 expect:
      expect(isPingLoopDisabled()).toBe(true);
    });

    it('start → start (= 2 回目) は no-op (= idempotent、 重複 interval を作らない)', () => {
      delete process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
      const stop1 = startActivePingLoop();
      const stop2 = startActivePingLoop();
      // 両方 valid stop function を返す (= test 用 contract)
      expect(typeof stop1).toBe('function');
      expect(typeof stop2).toBe('function');
      // 停止
      stop1();
      // 2 回目 stop も crash しない (= 既に止まっている状態を許容)
      stop2();
    });

    it('start → stop → start → stop で再起動可能 (= 停止後 再起動 OK)', () => {
      delete process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
      const stop1 = startActivePingLoop();
      stop1();
      // 停止後の再 start
      const stop2 = startActivePingLoop();
      stop2();
      expect(typeof stop1).toBe('function');
      expect(typeof stop2).toBe('function');
    });

    it('stopActivePingLoop() を 起動なしで呼んでも crash しない (= defensive)', () => {
      delete process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
      // 起動なしの状態で stop を直接呼んでも safely no-op
      expect(() => stopActivePingLoop()).not.toThrow();
      // 連続 stop も OK
      expect(() => stopActivePingLoop()).not.toThrow();
    });
  });
});

/**
 * issue #155: orphan session eviction の behavior test。
 *
 * spec: bridge の kill → re-spawn 時に initialize が短時間に複数発行され、
 * subscribe に到達しない orphan session が sessions Map に残留する。
 * ping は alive のまま (StreamableHTTP 接続が alive) なため ping loop で回収されない。
 * → `runOneOrphanEvictionCycle` の eviction sweep で ORPHAN_IDLE_TTL_MS (5 min) 超の
 *   未 subscribe session を強制 close + delete する。
 *
 * issue #369: この sweep は元々 `runOneActivePingCycle` 末尾に同居しており、
 * `AGENT_HUB_MCP_PING_LOOP_DISABLED=1` で GC ごと停止していた。独立 loop に分離済み。
 *
 * テスト注入: `_addSessionForTesting` / `_clearSessionsForTesting` (issue #155 追加 export)。
 * production コードでは呼ばない (_resetGhostWarnCacheForTests と同 pattern)。
 */
describe('orphan session eviction (issue #155)', () => {
  const SIX_MIN_MS = 6 * 60_000;  // ORPHAN_IDLE_TTL_MS (5min) より大きい
  const THIRTY_SEC_MS = 30_000;   // ORPHAN_IDLE_TTL_MS より小さい

  /**
   * mock session を作る。
   * - `server.ping()` は常に resolve (= ping フェーズでは回収されない)
   * - `transport.close()` は vi.fn() で副作用なし
   * - lastActivityAt は ageMs と同じ (= session 作成以来 POST なし) がデフォルト。
   *   Go bridge (bridge-tmux 等) のシミュレートには lastActivityAtMs を小さく渡す。
   */
  function makeMockSession(opts: {
    subscribedUris?: string[];
    ageMs: number;
    lastActivityAtMs?: number; // デフォルト: ageMs と同じ (最後の活動も session 作成時)
  }) {
    const activityAge = opts.lastActivityAtMs ?? opts.ageMs;
    return {
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      server: { ping: vi.fn().mockResolvedValue(undefined) },
      userId: '@test-user',
      githubLogin: 'test-user',
      tenantDomain: 'default',
      subscribedUris: new Set(opts.subscribedUris ?? []),
      createdAt: Date.now() - opts.ageMs,
      lastActivityAt: Date.now() - activityAge,
    };
  }

  afterEach(() => {
    _clearSessionsForTesting();
  });

  it('TTL 超え + unsubscribed → evicted (orphansEvicted=1)', async () => {
    _addSessionForTesting('orphan-old', makeMockSession({ ageMs: SIX_MIN_MS }));
    const stats = await runOneOrphanEvictionCycle();
    expect(stats.orphansEvicted).toBe(1);
  });

  it('TTL 未満 + unsubscribed → not evicted (= 初期化中の猶予)', async () => {
    _addSessionForTesting('new-unsubscribed', makeMockSession({ ageMs: THIRTY_SEC_MS }));
    const stats = await runOneOrphanEvictionCycle();
    expect(stats.orphansEvicted).toBe(0);
  });

  it('TTL 超え + subscribed → not evicted (= 正常 session は保護)', async () => {
    _addSessionForTesting('active-subscribed', makeMockSession({
      subscribedUris: ['inbox://@test-user'],
      ageMs: SIX_MIN_MS,
    }));
    const stats = await runOneOrphanEvictionCycle();
    expect(stats.orphansEvicted).toBe(0);
  });

  it('orphan 2 件 + 正常 1 件 → orphan 2 件のみ evict', async () => {
    _addSessionForTesting('orphan-1', makeMockSession({ ageMs: SIX_MIN_MS }));
    _addSessionForTesting('orphan-2', makeMockSession({ ageMs: SIX_MIN_MS }));
    _addSessionForTesting('active-1', makeMockSession({
      subscribedUris: ['inbox://@test-user'],
      ageMs: SIX_MIN_MS,
    }));
    const stats = await runOneOrphanEvictionCycle();
    expect(stats.orphansEvicted).toBe(2);
    expect(stats.total).toBe(3);
  });

  it('runOneOrphanEvictionCycle の返り値に orphansEvicted フィールドが含まれる', async () => {
    const stats = await runOneOrphanEvictionCycle();
    expect(typeof stats.orphansEvicted).toBe('number');
  });

  // --- lastActivityAt 補完 (issue #155 + bridge-tmux 5min 切断 fix) ---
  //
  // Go bridge (bridge-tmux) は resources/subscribe を実装しないため subscribedUris が常に空。
  // lastActivityAt (= POST /mcp のたびに更新) が新しければ正常 session と判断し eviction しない。

  it('TTL 超え + unsubscribed でも lastActivityAt が新しければ evict しない (= active Go bridge)', async () => {
    // bridge-tmux は 5s ごとに get_messages を POST → lastActivityAt は常に新鮮
    _addSessionForTesting('active-go-bridge', makeMockSession({
      ageMs: SIX_MIN_MS,
      lastActivityAtMs: THIRTY_SEC_MS, // 30 秒前に最後のアクティビティ
    }));
    const stats = await runOneOrphanEvictionCycle();
    expect(stats.orphansEvicted).toBe(0);
  });

  it('TTL 超え + unsubscribed + lastActivityAt も古い → evicted (= 真の zombie orphan)', async () => {
    // 真の orphan: re-spawn レース由来 → 誰も POST しない → lastActivityAt も古い
    _addSessionForTesting('true-zombie', makeMockSession({
      ageMs: SIX_MIN_MS,
      lastActivityAtMs: SIX_MIN_MS, // 6 分前に最後のアクティビティ (= session 作成以来 POST なし)
    }));
    const stats = await runOneOrphanEvictionCycle();
    expect(stats.orphansEvicted).toBe(1);
  });

  it('active Go bridge + zombie orphan が混在 → zombie のみ evict', async () => {
    _addSessionForTesting('go-bridge', makeMockSession({
      ageMs: SIX_MIN_MS,
      lastActivityAtMs: THIRTY_SEC_MS, // 最近活動あり
    }));
    _addSessionForTesting('zombie', makeMockSession({
      ageMs: SIX_MIN_MS,
      lastActivityAtMs: SIX_MIN_MS, // 活動なし
    }));
    const stats = await runOneOrphanEvictionCycle();
    expect(stats.orphansEvicted).toBe(1);
    expect(stats.total).toBe(2);
  });
});

/**
 * issue #369: orphan eviction を ping loop から分離した結果の behavior test。
 *
 * 背景: orphan eviction (#155) が `runOneActivePingCycle()` 末尾に同居していたため、
 * `AGENT_HUB_MCP_PING_LOOP_DISABLED=1` (= 本番の polling-only fleet 向け設定、#106/#26)
 * で session GC も一緒に停止し、session が 8700+ まで蓄積していた (#361)。
 *
 * spec: 「ping の可否」と「GC の可否」を独立した 2 つの env flag で制御する。
 * - `AGENT_HUB_MCP_PING_LOOP_DISABLED`   → ping loop のみ
 * - `AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED` → orphan eviction loop のみ
 */
describe('orphan eviction loop の ping loop からの分離 (issue #369)', () => {
  const SIX_MIN_MS = 6 * 60_000;
  let originalPingEnv: string | undefined;
  let originalEvictionEnv: string | undefined;
  let originalIntervalEnv: string | undefined;

  function makeOrphanSession(ageMs: number) {
    return {
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      server: { ping: vi.fn().mockResolvedValue(undefined) },
      userId: '@test-user',
      githubLogin: 'test-user',
      tenantDomain: 'default',
      subscribedUris: new Set<string>(),
      createdAt: Date.now() - ageMs,
      lastActivityAt: Date.now() - ageMs,
    };
  }

  beforeEach(() => {
    originalPingEnv = process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
    originalEvictionEnv = process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED;
    originalIntervalEnv = process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS;
    delete process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
    delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED;
    delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS;
  });

  afterEach(() => {
    stopActivePingLoop();
    stopOrphanEvictionLoop();
    _clearSessionsForTesting();
    vi.useRealTimers();
    if (originalPingEnv === undefined) {
      delete process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
    } else {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = originalPingEnv;
    }
    if (originalEvictionEnv === undefined) {
      delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED;
    } else {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED = originalEvictionEnv;
    }
    if (originalIntervalEnv === undefined) {
      delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS;
    } else {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = originalIntervalEnv;
    }
  });

  describe('isOrphanEvictionDisabled() feature flag', () => {
    it('env unset → false (= GC 有効、 default behavior)', () => {
      delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED;
      expect(isOrphanEvictionDisabled()).toBe(false);
    });

    it('env empty string → false (= unset 同等、 redline #1 整合)', () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED = '';
      expect(isOrphanEvictionDisabled()).toBe(false);
    });

    it('env="1" → true (= GC 無効、 rollback path)', () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED = '1';
      expect(isOrphanEvictionDisabled()).toBe(true);
    });

    it('env="0" でも true (= 値の中身は問わない binary signal)', () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED = '0';
      expect(isOrphanEvictionDisabled()).toBe(true);
    });
  });

  describe('flag の独立性', () => {
    it('PING_LOOP_DISABLED=1 でも orphan eviction loop は動作する (= #369 の本体)', async () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '1';
      vi.useFakeTimers();
      _addSessionForTesting('zombie-orphan', makeOrphanSession(SIX_MIN_MS));

      startActivePingLoop();        // flag により no-op
      startOrphanEvictionLoop();    // こちらは起動する

      await vi.advanceTimersByTimeAsync(30_000);

      const stats = await runOneOrphanEvictionCycle();
      // 既に interval 側の sweep で回収済み → 2 回目の sweep では 0 件かつ session も空
      expect(stats.total).toBe(0);
      expect(stats.orphansEvicted).toBe(0);
    });

    it('ORPHAN_EVICTION_DISABLED=1 なら loop は起動せず orphan は残る', async () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED = '1';
      vi.useFakeTimers();
      _addSessionForTesting('zombie-orphan', makeOrphanSession(SIX_MIN_MS));

      startOrphanEvictionLoop();
      await vi.advanceTimersByTimeAsync(30_000);

      // loop 未起動 → 手動 sweep でまだ回収対象として残っている
      const stats = await runOneOrphanEvictionCycle();
      expect(stats.total).toBe(1);
      expect(stats.orphansEvicted).toBe(1);
    });

    it('ORPHAN_EVICTION_DISABLED=1 は ping loop 側に影響しない', () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED = '1';
      expect(isPingLoopDisabled()).toBe(false);
    });

    it('PING_LOOP_DISABLED=1 は orphan eviction 側に影響しない', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '1';
      expect(isOrphanEvictionDisabled()).toBe(false);
    });
  });

  describe('startOrphanEvictionLoop() / stopOrphanEvictionLoop() lifecycle', () => {
    it('起動 → stop function が返る / stop は idempotent', () => {
      const stop = startOrphanEvictionLoop();
      expect(typeof stop).toBe('function');
      expect(() => stop()).not.toThrow();
      expect(() => stop()).not.toThrow();
    });

    it('二重起動しても interval は 1 本 (= 起動 idempotent)', async () => {
      vi.useFakeTimers();
      _addSessionForTesting('zombie-orphan', makeOrphanSession(SIX_MIN_MS));
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      startOrphanEvictionLoop();
      startOrphanEvictionLoop();
      await vi.advanceTimersByTimeAsync(30_000);

      const evictionLogs = spy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('orphan session evicted')
      );
      spy.mockRestore();
      // interval が 2 本走っていれば同一 session の evict ログが 2 回出る
      expect(evictionLogs).toHaveLength(1);
    });

    it('未起動で stop しても crash しない (= defensive)', () => {
      expect(() => stopOrphanEvictionLoop()).not.toThrow();
    });
  });

  /**
   * operator 条件 2 (= GO DM, 2026-09-20): sweep 周期を既定値そのまま (30s) で env から
   * 変えられるようにする。#355 (`AGENT_HUB_MCP_GET_CLOSE_GRACE_MS`) と同じ作法。
   */
  describe('sweep 間隔の env 上書き (AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS)', () => {
    it('env 未設定 → 既定値 30000ms (= PR 現状と完全に同一挙動)', () => {
      delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS;
      expect(getOrphanEvictionIntervalMs()).toBe(30_000);
      expect(ORPHAN_EVICTION_INTERVAL_MS).toBe(30_000);
    });

    it('env 空文字 → 既定値 (= unset 同等)', () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = '';
      expect(getOrphanEvictionIntervalMs()).toBe(30_000);
    });

    it('正常値が反映される', () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = '5000';
      expect(getOrphanEvictionIntervalMs()).toBe(5_000);
    });

    // issue #384: env が set されているのに解釈できない値は、黙って既定値に落とさず
    // EnvConfigError で fail-fast する (= サイレント縮退の排除)。
    it('非数値 → EnvConfigError を throw する (既定値に fall back しない)', () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = 'abc';
      expect(() => getOrphanEvictionIntervalMs()).toThrow(EnvConfigError);
      expect(() => getOrphanEvictionIntervalMs()).toThrow(
        /invalid AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS/
      );
    });

    it('0 以下 → EnvConfigError を throw する', () => {
      for (const bad of ['0', '-1']) {
        process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = bad;
        expect(() => getOrphanEvictionIntervalMs()).toThrow(EnvConfigError);
      }
    });

    it('下限 (1000ms) 未満 → EnvConfigError を throw する (= 秒/ms 取り違え防御)', () => {
      for (const bad of ['30', '999']) {
        process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = bad;
        expect(() => getOrphanEvictionIntervalMs()).toThrow(EnvConfigError);
      }
      expect(ORPHAN_EVICTION_INTERVAL_MIN_MS).toBe(1_000);
    });

    it('上限 (32bit signed int) 超過 → EnvConfigError を throw する (= setInterval 1ms クランプ防御)', () => {
      // Node の setInterval は delay が 2147483647 を超えると 1ms にクランプするため、
      // 桁ミス (例: 86400000000) が「意図と正反対の常時 sweep」に無警告で縮退する。
      for (const bad of ['2147483648', '86400000000']) {
        process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = bad;
        expect(() => getOrphanEvictionIntervalMs()).toThrow(EnvConfigError);
      }
      expect(ORPHAN_EVICTION_INTERVAL_MAX_MS).toBe(2_147_483_647);
    });

    it('不正値でも warning での黙った fall back はしない (= console.warn を出さない)', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = 'abc';
      expect(() => getOrphanEvictionIntervalMs()).toThrow(EnvConfigError);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('境界値 (min / max ちょうど) は受理される', () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = String(
        ORPHAN_EVICTION_INTERVAL_MIN_MS
      );
      expect(getOrphanEvictionIntervalMs()).toBe(ORPHAN_EVICTION_INTERVAL_MIN_MS);
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = String(
        ORPHAN_EVICTION_INTERVAL_MAX_MS
      );
      expect(getOrphanEvictionIntervalMs()).toBe(ORPHAN_EVICTION_INTERVAL_MAX_MS);
    });

    it('env 値が実際の loop 周期に反映される (= 5s で sweep が走る)', async () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = '5000';
      vi.useFakeTimers();
      _addSessionForTesting('zombie-orphan', makeOrphanSession(SIX_MIN_MS));

      startOrphanEvictionLoop();
      await vi.advanceTimersByTimeAsync(5_000);

      // 既定の 30s を待たずに回収済み
      const stats = await runOneOrphanEvictionCycle();
      expect(stats.total).toBe(0);
      expect(stats.orphansEvicted).toBe(0);
    });

    it('env 未設定なら 30s 未満では sweep が走らない (= 既定周期の回帰防止)', async () => {
      delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS;
      vi.useFakeTimers();
      _addSessionForTesting('zombie-orphan', makeOrphanSession(SIX_MIN_MS));

      startOrphanEvictionLoop();
      await vi.advanceTimersByTimeAsync(29_999);

      // まだ 1 度も sweep していない → 手動 sweep で回収対象として残っている
      const stats = await runOneOrphanEvictionCycle();
      expect(stats.total).toBe(1);
      expect(stats.orphansEvicted).toBe(1);
    });
  });

  describe('sweep の例外が server を落とさない', () => {
    it('cycle が reject しても loop は継続し、error log のみ出る (= unhandledRejection 防止)', async () => {
      vi.useFakeTimers();
      // subscribedUris の参照で throw する session を注入して sweep 内の想定外例外を再現する。
      // (index.ts は unhandledRejection で process.exit(1) するため、catch がなければ本番停止)
      const exploding = makeOrphanSession(SIX_MIN_MS);
      Object.defineProperty(exploding, 'subscribedUris', {
        get() {
          throw new Error('boom');
        },
      });
      _addSessionForTesting('exploding', exploding);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const rejections: unknown[] = [];
      const onUnhandled = (err: unknown) => rejections.push(err);
      process.on('unhandledRejection', onUnhandled);

      startOrphanEvictionLoop();
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);

      process.off('unhandledRejection', onUnhandled);
      const failureLogs = errSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('orphan eviction cycle failed')
      );
      errSpy.mockRestore();

      expect(rejections).toHaveLength(0);
      // 1 回目の失敗で loop が死なず、2 周目も実行されている
      expect(failureLogs).toHaveLength(2);
    });
  });

  /**
   * issue #361 の再発防止: #369 を実際に直しているのは `MCPServer.start()` からの
   * `startOrphanEvictionLoop()` 呼び出し 1 行。ここが消えても loop 単体のテストは
   * 全 green のまま GC が止まるため、start() 側に固定する。
   */
  describe('MCPServer.start() からの起動 (issue #361 回帰防止)', () => {
    let originalEdition: string | undefined;

    beforeEach(() => {
      originalEdition = process.env.AGENT_HUB_EDITION;
      process.env.AGENT_HUB_EDITION = 'private';
    });

    afterEach(() => {
      if (originalEdition === undefined) {
        delete process.env.AGENT_HUB_EDITION;
      } else {
        process.env.AGENT_HUB_EDITION = originalEdition;
      }
    });

    it('start() が orphan eviction loop を起動し、sweep が実際に走る', async () => {
      // ping loop は本 test の対象外 (= 分離済み) なので disabled にしておく
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '1';
      const server = new MCPServer(0);
      // DB / TCP listen は本 test の関心外。start() の loop 起動だけを観測する。
      vi.spyOn(server, 'initDatabase').mockImplementation(() => {});
      const fakeHttpServer = { keepAliveTimeout: 0, headersTimeout: 0, on: vi.fn() };
      vi.spyOn(server.getApp(), 'listen').mockImplementation(((
        _port: number,
        _host: string,
        cb: () => void
      ) => {
        cb();
        return fakeHttpServer;
      }) as never);

      vi.useFakeTimers();
      _addSessionForTesting('zombie-orphan', makeOrphanSession(SIX_MIN_MS));
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await server.start();
      await vi.advanceTimersByTimeAsync(30_000);

      const startLogs = logSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('orphan eviction loop starting')
      );
      logSpy.mockRestore();
      vi.restoreAllMocks();

      expect(startLogs).toHaveLength(1);
      // loop が実際に sweep しており、orphan は既に回収済み
      const stats = await runOneOrphanEvictionCycle();
      expect(stats.total).toBe(0);
    });
  });

  it('runOneActivePingCycle は orphan を evict しない (= 分離の回帰防止)', async () => {
    _addSessionForTesting('zombie-orphan', makeOrphanSession(SIX_MIN_MS));

    const pingStats = await runOneActivePingCycle();
    expect(pingStats.total).toBe(1);
    expect(pingStats.alive).toBe(1); // ping は成功する = ping 経路では回収されない

    // ping cycle 後も session は残っており、orphan sweep 側が回収する
    const evictionStats = await runOneOrphanEvictionCycle();
    expect(evictionStats.orphansEvicted).toBe(1);
  });
});

/**
 * issue #363: ping loop flag の 3 値化 (disabled / observe-only / enforce)。
 *
 * spec:
 * - `AGENT_HUB_MCP_PING_LOOP_MODE` が valid な 3 値ならそれを採用
 * - 未設定 / 空なら旧 flag `AGENT_HUB_MCP_PING_LOOP_DISABLED` (binary) に委譲
 * - どちらも未設定なら `observe-only` (= 安全側の既定。旧 default (enforce) から意図的に変更)
 * - **不正値は `EnvConfigError` で fail-fast** (= 旧 flag / default に倒さない、 issue #384 と同方針)
 * - `observe-only` は ping 非応答を観測するだけで evict しない
 *   (= 判定条件は enforce と同一、 結果の扱いだけが違う)
 */
describe('ping loop mode 3 値化 (issue #363)', () => {
  let originalMode: string | undefined;
  let originalDisabled: string | undefined;

  beforeEach(() => {
    originalMode = process.env.AGENT_HUB_MCP_PING_LOOP_MODE;
    originalDisabled = process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
    delete process.env.AGENT_HUB_MCP_PING_LOOP_MODE;
    delete process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED;
    _resetPingLoopObserveStateForTests();
  });

  afterEach(() => {
    stopActivePingLoop();
    _clearSessionsForTesting();
    _resetPingLoopObserveStateForTests();
    for (const [key, value] of [
      ['AGENT_HUB_MCP_PING_LOOP_MODE', originalMode],
      ['AGENT_HUB_MCP_PING_LOOP_DISABLED', originalDisabled],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('resolvePingLoopMode()', () => {
    it('両 env 未設定 → observe-only (= 安全側の既定。旧 default (enforce) から意図的に変更)', () => {
      expect(resolvePingLoopMode()).toBe('observe-only');
      expect(isPingLoopDisabled()).toBe(false);
    });

    it('旧 flag のみ set → disabled (= 後方互換、 production 現行設定)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '1';
      expect(resolvePingLoopMode()).toBe('disabled');
      expect(isPingLoopDisabled()).toBe(true);
    });

    it('MODE=disabled → disabled', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = 'disabled';
      expect(resolvePingLoopMode()).toBe('disabled');
      expect(isPingLoopDisabled()).toBe(true);
    });

    it('MODE=observe-only → observe-only (= isPingLoopDisabled は false: loop 自体は動く)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = 'observe-only';
      expect(resolvePingLoopMode()).toBe('observe-only');
      expect(isPingLoopDisabled()).toBe(false);
    });

    it('MODE=enforce → enforce (= 旧 flag が set でも MODE が優先)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '1';
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = 'enforce';
      expect(resolvePingLoopMode()).toBe('enforce');
      expect(isPingLoopDisabled()).toBe(false);
    });

    it('MODE は前後 space / 大文字小文字を許容する', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = '  Observe-Only ';
      expect(resolvePingLoopMode()).toBe('observe-only');
    });

    it('MODE が不正値 → EnvConfigError で fail-fast (= 旧 flag に倒さない)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '1';
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = 'observe_only'; // typo: underscore
      expect(() => resolvePingLoopMode()).toThrow(EnvConfigError);
      expect(() => resolvePingLoopMode()).toThrow(/observe_only/);
    });

    it('MODE が不正値 + 旧 flag 未設定 → EnvConfigError (= default にも倒さない)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = 'nonsense';
      expect(() => resolvePingLoopMode()).toThrow(EnvConfigError);
    });

    it('validateMcpEnvConfig() が不正 MODE を起動前に弾く (= listen 前 fail-fast)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = 'enfroce';
      expect(() => validateMcpEnvConfig()).toThrow(EnvConfigError);
    });

    it('MODE が空文字 → 未設定と同等 (= 旧 flag / default に委譲)', () => {
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = '';
      expect(resolvePingLoopMode()).toBe('observe-only');
      process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED = '1';
      expect(resolvePingLoopMode()).toBe('disabled');
    });
  });

  describe('runOneActivePingCycle() の mode 別挙動', () => {
    /** ping が常に失敗する (= 即 reject) mock session。 */
    function makeDeadSession() {
      return {
        transport: { close: vi.fn().mockResolvedValue(undefined) },
        server: { ping: vi.fn().mockRejectedValue(new Error('no pong')) },
        userId: '@dead-peer',
        githubLogin: 'dead-peer',
        tenantDomain: 'default',
        subscribedUris: new Set(['inbox://@dead-peer']),
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
    }

    /** ping に応答する mock session。 */
    function makeAliveSession() {
      return {
        transport: { close: vi.fn().mockResolvedValue(undefined) },
        server: { ping: vi.fn().mockResolvedValue(undefined) },
        userId: '@live-peer',
        githubLogin: 'live-peer',
        tenantDomain: 'default',
        subscribedUris: new Set(['inbox://@live-peer']),
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
    }

    it('enforce → ping 非応答 session を evict する (= 従来動作)', async () => {
      const session = makeDeadSession();
      _addSessionForTesting('dead-1', session);
      const stats = await runOneActivePingCycle('enforce');
      expect(stats.disconnected).toBe(1);
      expect(stats.observedFailures).toBe(0);
      expect(session.transport.close).toHaveBeenCalled();
    });

    it('observe-only → ping 非応答でも evict しない (= 観測のみ、 session は残る)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const session = makeDeadSession();
      _addSessionForTesting('dead-2', session);
      const stats = await runOneActivePingCycle('observe-only');
      expect(stats.observedFailures).toBe(1);
      expect(stats.disconnected).toBe(0);
      expect(session.transport.close).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('observe-only の warning は落ち続けても 1 回だけ (= 1 日 2,880 行/session を避ける)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      _addSessionForTesting('dead-6', makeDeadSession());
      for (let i = 0; i < 3; i++) {
        const stats = await runOneActivePingCycle('observe-only');
        expect(stats.observedFailures).toBe(1); // 観測カウントは毎 cycle 立つ
      }
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it('observe-only で復帰した session は recovered ログを 1 回出し、再び落ちれば再 warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      _addSessionForTesting('flaky-1', makeDeadSession());
      await runOneActivePingCycle('observe-only');
      expect(warn).toHaveBeenCalledOnce();

      _clearSessionsForTesting();
      _addSessionForTesting('flaky-1', makeAliveSession());
      await runOneActivePingCycle('observe-only');
      expect(
        log.mock.calls.filter((c) => typeof c[0] === 'string' && c[0].includes('ping recovered'))
      ).toHaveLength(1);

      _clearSessionsForTesting();
      _addSessionForTesting('flaky-1', makeDeadSession());
      await runOneActivePingCycle('observe-only');
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
      log.mockRestore();
    });

    it('observe-only でも ping の判定条件は enforce と同一 (= retry 回数分 ping する)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const observed = makeDeadSession();
      _addSessionForTesting('dead-3', observed);
      await runOneActivePingCycle('observe-only');
      const observeCalls = observed.server.ping.mock.calls.length;
      _clearSessionsForTesting();

      const enforced = makeDeadSession();
      _addSessionForTesting('dead-4', enforced);
      await runOneActivePingCycle('enforce');
      expect(observeCalls).toBe(enforced.server.ping.mock.calls.length);
      warn.mockRestore();
    });

    it('observe-only で応答する session は alive に数える (= 誤検知なし)', async () => {
      _addSessionForTesting('alive-1', makeAliveSession());
      const stats = await runOneActivePingCycle('observe-only');
      expect(stats.alive).toBe(1);
      expect(stats.observedFailures).toBe(0);
      expect(stats.disconnected).toBe(0);
    });

    it('mode 引数省略時は env から解決する (= MODE=observe-only なら evict しない)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = 'observe-only';
      const session = makeDeadSession();
      _addSessionForTesting('dead-5', session);
      const stats = await runOneActivePingCycle();
      expect(stats.observedFailures).toBe(1);
      expect(session.transport.close).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('消滅した session の sid は次 cycle 冒頭で prune される (= 単調増加させない、 issue #390)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      _addSessionForTesting('gone-1', makeDeadSession());
      await runOneActivePingCycle('observe-only');
      expect(_getObservedFailingSessionsForTests()).toEqual(['gone-1']);

      // ping 復帰ではなく orphan eviction / GET close eviction / transport.onclose で
      // session が消えた場合 (= sessions Map から居なくなる)。
      _clearSessionsForTesting();
      await runOneActivePingCycle('observe-only');
      expect(_getObservedFailingSessionsForTests()).toEqual([]);
      warn.mockRestore();
    });

    it('prune 後に同 sid が再び落ちれば warning が再度出る (= 記録が閉じている、 issue #390)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      _addSessionForTesting('gone-2', makeDeadSession());
      await runOneActivePingCycle('observe-only');
      expect(warn).toHaveBeenCalledOnce();

      _clearSessionsForTesting();
      await runOneActivePingCycle('observe-only');

      _addSessionForTesting('gone-2', makeDeadSession());
      await runOneActivePingCycle('observe-only');
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('生きている session の sid は prune されない (= 失敗記録を維持する)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      _addSessionForTesting('stay-1', makeDeadSession());
      await runOneActivePingCycle('observe-only');
      await runOneActivePingCycle('observe-only');
      expect(_getObservedFailingSessionsForTests()).toEqual(['stay-1']);
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it('同数の復帰 + 新規失敗でも observedTransitions が立つ (= 相殺されない、 issue #390)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      _addSessionForTesting('swap-old', makeDeadSession());
      _addSessionForTesting('swap-new', makeAliveSession());
      const first = await runOneActivePingCycle('observe-only');
      expect(first.observedFailures).toBe(1);
      expect(first.observedTransitions).toBe(1);

      // 同一 cycle で swap-old が復帰し、 swap-new が新規に落ちる (= 件数は 1 のまま)。
      _clearSessionsForTesting();
      _addSessionForTesting('swap-old', makeAliveSession());
      _addSessionForTesting('swap-new', makeDeadSession());
      const second = await runOneActivePingCycle('observe-only');
      expect(second.observedFailures).toBe(first.observedFailures); // 件数は変化しない
      expect(second.observedTransitions).toBe(2); // 復帰 1 + 新規失敗 1
      warn.mockRestore();
      log.mockRestore();
    });

    it('状態遷移が無い cycle は observedTransitions=0 (= summary を抑制できる)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      _addSessionForTesting('steady-1', makeDeadSession());
      const first = await runOneActivePingCycle('observe-only');
      expect(first.observedTransitions).toBe(1);
      const second = await runOneActivePingCycle('observe-only');
      expect(second.observedFailures).toBe(1);
      expect(second.observedTransitions).toBe(0);
      warn.mockRestore();
    });

    it('MODE=disabled で直接呼ばれた場合は非破壊 (= observe-only 扱い)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = 'disabled';
      const session = makeDeadSession();
      _addSessionForTesting('dead-7', session);
      const stats = await runOneActivePingCycle();
      expect(stats.observedFailures).toBe(1);
      expect(stats.disconnected).toBe(0);
      expect(session.transport.close).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('startActivePingLoop() の mode 別挙動', () => {
    it('MODE=disabled → loop を起動しない', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = 'disabled';
      startActivePingLoop();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('disabled'));
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('starting'));
      log.mockRestore();
    });

    it('MODE=observe-only → loop を起動する (= mode 付きで log)', () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      process.env.AGENT_HUB_MCP_PING_LOOP_MODE = 'observe-only';
      startActivePingLoop();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('mode=observe-only'));
      stopActivePingLoop();
      log.mockRestore();
    });
  });
});

/**
 * issue #377 (PR #372 follow-up): orphan eviction sweep の in-flight guard と
 * 初回 sweep のログ量圧縮。
 *
 * 動機は初回本番 sweep (~8700 件)。sweep が interval (既定 30s) を超えると 2 本目が
 * 同じ状態で走り、1 件 2 行のログは ~17,400 行になる。どちらも「operator がこの
 * ログで動作確認する」場面を壊す。
 */
describe('orphan eviction sweep: in-flight guard / log 圧縮 (issue #377)', () => {
  const SIX_MIN_MS = 6 * 60 * 1000;

  function makeOrphan(closeImpl?: () => Promise<void>) {
    return {
      transport: { close: closeImpl ?? vi.fn().mockResolvedValue(undefined) },
      server: { ping: vi.fn().mockResolvedValue(undefined) },
      userId: '@test-user',
      githubLogin: 'test-user',
      tenantDomain: 'default',
      subscribedUris: new Set<string>(),
      createdAt: Date.now() - SIX_MIN_MS,
      lastActivityAt: Date.now() - SIX_MIN_MS,
    };
  }

  beforeEach(() => {
    delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED;
    delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS;
  });

  afterEach(() => {
    stopOrphanEvictionLoop();
    _clearSessionsForTesting();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('in-flight guard', () => {
    it('sweep が interval を超えても 2 本目は走らず、skip を WARN に残す', async () => {
      vi.useFakeTimers();

      // close() を解決させないことで sweep を interval を跨いで滞留させる
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slowClose = vi.fn().mockReturnValue(blocked);
      _addSessionForTesting('slow-orphan', makeOrphan(slowClose));

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      startOrphanEvictionLoop();

      // 1 本目の sweep が close() で滞留したまま、interval を 2 回跨ぐ
      await vi.advanceTimersByTimeAsync(30_000);
      expect(slowClose).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);

      // 2 本目・3 本目は guard で弾かれるので close() は増えない
      expect(slowClose).toHaveBeenCalledTimes(1);
      const skips = warn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('orphan eviction cycle skipped')
      );
      expect(skips.length).toBe(2);

      release?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    it('sweep 完了後は guard が降り、次の cycle が走る', async () => {
      vi.useFakeTimers();
      _addSessionForTesting('orphan-1', makeOrphan());
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      startOrphanEvictionLoop();
      await vi.advanceTimersByTimeAsync(30_000);

      // 1 本目は完了済み。次の cycle は skip されない
      _addSessionForTesting('orphan-2', makeOrphan());
      await vi.advanceTimersByTimeAsync(30_000);

      const skips = warn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('orphan eviction cycle skipped')
      );
      expect(skips).toHaveLength(0);
      const stats = await runOneOrphanEvictionCycle();
      expect(stats.total).toBe(0); // 2 件とも回収済み
    });

    it('sweep が throw しても guard は降りる (= GC が永久停止しない)', async () => {
      vi.useFakeTimers();
      const boom = vi.fn().mockRejectedValue(new Error('boom'));
      // transport.close() の throw は cycle 内で catch されるため、cycle 自体を
      // 失敗させるには sessions Map の iteration を壊す必要がある。ここでは
      // getter で throw する session を差し込む。
      _addSessionForTesting('exploding', {
        get subscribedUris(): Set<string> {
          throw new Error('boom');
        },
        transport: { close: boom },
        server: { ping: vi.fn() },
        userId: '@x',
        githubLogin: 'x',
        tenantDomain: 'default',
        createdAt: Date.now() - SIX_MIN_MS,
        lastActivityAt: Date.now() - SIX_MIN_MS,
      });
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      startOrphanEvictionLoop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        err.mock.calls.some(
          (c) => typeof c[0] === 'string' && c[0].includes('orphan eviction cycle failed')
        )
      ).toBe(true);

      // guard が降りていれば次の cycle は skip されない
      await vi.advanceTimersByTimeAsync(30_000);
      const skips = warn.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('orphan eviction cycle skipped')
      );
      expect(skips).toHaveLength(0);
    });
  });

  describe('ログ量の圧縮', () => {
    it('閾値以下なら全件が個別行で出る (= 通常運用では従来どおり)', async () => {
      for (let i = 0; i < ORPHAN_EVICT_LOG_LIMIT; i++) {
        _addSessionForTesting(`orphan-${i}`, makeOrphan());
      }
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const stats = await runOneOrphanEvictionCycle();

      expect(stats.orphansEvicted).toBe(ORPHAN_EVICT_LOG_LIMIT);
      const lines = log.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('orphan session evicted')
      );
      expect(lines).toHaveLength(ORPHAN_EVICT_LOG_LIMIT);
      expect(
        lines.some((c) => String(c[0]).includes('more suppressed'))
      ).toBe(false);
    });

    it('閾値を超えた分はサマリ 1 行に畳まれる', async () => {
      const n = ORPHAN_EVICT_LOG_LIMIT + 30;
      for (let i = 0; i < n; i++) {
        _addSessionForTesting(`orphan-${i}`, makeOrphan());
      }
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      const stats = await runOneOrphanEvictionCycle();

      expect(stats.orphansEvicted).toBe(n);
      const all = log.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('orphan session evicted'));
      const individual = all.filter((line) => !line.includes('more suppressed'));
      const summary = all.filter((line) => line.includes('more suppressed'));

      expect(individual).toHaveLength(ORPHAN_EVICT_LOG_LIMIT);
      expect(summary).toHaveLength(1);
      // 抑制した事実と件数は必ず残す (無言で減らさない)
      expect(summary[0]).toContain(`${n - ORPHAN_EVICT_LOG_LIMIT} more suppressed`);
      // 8700 件規模でも個別行 + サマリで 21 行に収まる
      expect(all).toHaveLength(ORPHAN_EVICT_LOG_LIMIT + 1);
    });

    it('evict 中は session closed log が抑止される (= 1 件 2 行 → 1 行)', async () => {
      let seenDuringClose: boolean | undefined;
      _addSessionForTesting(
        'orphan-close-probe',
        makeOrphan(async () => {
          // transport.onclose が走るのと同じタイミングで抑止条件を観測する
          seenDuringClose = _isEvictingSessionForTesting('orphan-close-probe');
        })
      );
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await runOneOrphanEvictionCycle();

      expect(seenDuringClose).toBe(true);
      // sweep を抜けたら抑止は解除されている (= 通常の切断は従来どおり log が出る)
      expect(_isEvictingSessionForTesting('orphan-close-probe')).toBe(false);
    });

    it('close() が throw しても抑止フラグは残らない', async () => {
      _addSessionForTesting(
        'orphan-close-throws',
        makeOrphan(() => Promise.reject(new Error('close failed')))
      );
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await runOneOrphanEvictionCycle();

      expect(_isEvictingSessionForTesting('orphan-close-throws')).toBe(false);
    });
  });
});

/**
 * issue #386 (#369 follow-up): orphan eviction cycle の低頻度 heartbeat ログ。
 *
 * cycle log は `orphansEvicted > 0` のときだけ出るため、「回収 0 件の正常稼働」と
 * 「loop が動いていない」が journal 上どちらも沈黙になる。heartbeat はこの 2 状態を
 * ログだけで区別可能にするための signal。
 */
describe('orphan eviction heartbeat log (issue #386)', () => {
  const HEARTBEAT_ENV = 'AGENT_HUB_MCP_ORPHAN_EVICTION_HEARTBEAT_MS';

  function heartbeatLines(log: ReturnType<typeof vi.spyOn>) {
    return (log.mock.calls as unknown[][]).filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('orphan eviction heartbeat')
    );
  }

  function cycleLines(log: ReturnType<typeof vi.spyOn>) {
    return (log.mock.calls as unknown[][]).filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('orphan eviction cycle:')
    );
  }

  function makeOrphan() {
    const sixMinMs = 6 * 60 * 1000;
    return {
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      server: { ping: vi.fn().mockResolvedValue(undefined) },
      userId: '@test-user',
      githubLogin: 'test-user',
      tenantDomain: 'default',
      subscribedUris: new Set<string>(),
      createdAt: Date.now() - sixMinMs,
      lastActivityAt: Date.now() - sixMinMs,
    };
  }

  beforeEach(() => {
    delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED;
    delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS;
    delete process.env[HEARTBEAT_ENV];
  });

  afterEach(() => {
    stopOrphanEvictionLoop();
    _clearSessionsForTesting();
    delete process.env[HEARTBEAT_ENV];
    delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED;
    delete process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('getOrphanEvictionHeartbeatMs()', () => {
    it('env 未設定 → 既定値 (= 30min)', () => {
      expect(getOrphanEvictionHeartbeatMs()).toBe(ORPHAN_EVICTION_HEARTBEAT_MS);
      expect(ORPHAN_EVICTION_HEARTBEAT_MS).toBe(30 * 60_000);
    });

    it('env 空文字 → 既定値 (= unset 同等)', () => {
      process.env[HEARTBEAT_ENV] = '';
      expect(getOrphanEvictionHeartbeatMs()).toBe(ORPHAN_EVICTION_HEARTBEAT_MS);
    });

    it('env 数値 → その値で上書き', () => {
      process.env[HEARTBEAT_ENV] = '60000';
      expect(getOrphanEvictionHeartbeatMs()).toBe(60_000);
    });

    it('非数値 → EnvConfigError (= 既定値に黙って縮退しない、 issue #384)', () => {
      process.env[HEARTBEAT_ENV] = 'thirty-minutes';
      expect(() => getOrphanEvictionHeartbeatMs()).toThrow(EnvConfigError);
    });

    it('下限未満 → EnvConfigError (= 秒/ms の取り違え防御)', () => {
      process.env[HEARTBEAT_ENV] = String(ORPHAN_EVICTION_HEARTBEAT_MIN_MS - 1);
      expect(() => getOrphanEvictionHeartbeatMs()).toThrow(EnvConfigError);
    });

    it('上限超過 → EnvConfigError (= 桁ミスで事実上 heartbeat なしに倒れない)', () => {
      process.env[HEARTBEAT_ENV] = String(ORPHAN_EVICTION_HEARTBEAT_MAX_MS + 1);
      expect(() => getOrphanEvictionHeartbeatMs()).toThrow(EnvConfigError);
    });

    it('validateMcpEnvConfig() が不正値を listen 前に弾く', () => {
      process.env[HEARTBEAT_ENV] = '-1';
      expect(() => validateMcpEnvConfig()).toThrow(EnvConfigError);
    });
  });

  describe('startOrphanEvictionLoop() の heartbeat 出力', () => {
    it('evict 0 件の cycle が続いても heartbeat が一定間隔で出る (完了条件 1)', async () => {
      vi.useFakeTimers();
      process.env[HEARTBEAT_ENV] = '60000'; // 60s = interval 30s の 2 cycle 分
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      startOrphanEvictionLoop();

      // 1 cycle 目 (30s): heartbeat 間隔未満なので沈黙のまま
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatLines(log)).toHaveLength(0);

      // 2 cycle 目 (60s): 起点から heartbeatMs 経過 → 1 行出る
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatLines(log)).toHaveLength(1);
      expect(heartbeatLines(log)[0][0]).toContain('orphansEvicted=0');

      // 次の 1 cycle (90s) では出ず、 さらに次 (120s) で 2 行目
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatLines(log)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatLines(log)).toHaveLength(2);
    });

    it('既定値では 30min 未満に heartbeat を出さない (= journal を汚さない)', async () => {
      vi.useFakeTimers();
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      startOrphanEvictionLoop();
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(heartbeatLines(log)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(heartbeatLines(log)).toHaveLength(1);
    });

    it('evict > 0 の cycle では従来の cycle log が出て heartbeat は重ねない (完了条件 2)', async () => {
      vi.useFakeTimers();
      process.env[HEARTBEAT_ENV] = '60000';
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      startOrphanEvictionLoop();
      _addSessionForTesting('orphan-hb-1', makeOrphan());

      // 1 cycle 目 (30s) で 1 件回収 → 従来の cycle log が出る (= heartbeat の起点が進む)
      await vi.advanceTimersByTimeAsync(30_000);
      expect(cycleLines(log)).toHaveLength(1);
      expect(heartbeatLines(log)).toHaveLength(0);

      // 以降は回収 0 件。cycle log から heartbeatMs 経過するまでは heartbeat を重ねない
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatLines(log)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeatLines(log)).toHaveLength(1);
    });

    it('AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED=1 なら heartbeat も出ない (完了条件 3)', async () => {
      vi.useFakeTimers();
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED = '1';
      process.env[HEARTBEAT_ENV] = '60000';
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});

      startOrphanEvictionLoop();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(heartbeatLines(log)).toHaveLength(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('orphan eviction loop disabled'));
    });

    it('起動 log に heartbeat の実効値が出る (= 設定を journal から確認できる)', () => {
      process.env[HEARTBEAT_ENV] = '60000';
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      startOrphanEvictionLoop();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('1min heartbeat'));
    });
  });
});
