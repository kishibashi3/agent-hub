import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isPingLoopDisabled,
  startActivePingLoop,
  stopActivePingLoop,
  runOneActivePingCycle,
  isOrphanEvictionDisabled,
  startOrphanEvictionLoop,
  stopOrphanEvictionLoop,
  runOneOrphanEvictionCycle,
  getOrphanEvictionIntervalMs,
  ORPHAN_EVICTION_INTERVAL_MS,
  _addSessionForTesting,
  _clearSessionsForTesting,
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

    it('非数値 → 既定値に fall back し warning を出す', () => {
      process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = 'abc';
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(getOrphanEvictionIntervalMs()).toBe(30_000);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('invalid AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS')
      );
      spy.mockRestore();
    });

    it('0 以下 → 既定値に fall back し warning を出す', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      for (const bad of ['0', '-1']) {
        process.env.AGENT_HUB_MCP_ORPHAN_EVICTION_INTERVAL_MS = bad;
        expect(getOrphanEvictionIntervalMs()).toBe(30_000);
      }
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
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
