import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isPingLoopDisabled,
  startActivePingLoop,
  stopActivePingLoop,
  runOneActivePingCycle,
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
 * → `runOneActivePingCycle` 末尾の eviction sweep で ORPHAN_IDLE_TTL_MS (5 min) 超の
 *   未 subscribe session を強制 close + delete する。
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
   */
  function makeMockSession(opts: {
    subscribedUris?: string[];
    ageMs: number;
  }) {
    return {
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      server: { ping: vi.fn().mockResolvedValue(undefined) },
      userId: '@test-user',
      githubLogin: 'test-user',
      tenantDomain: 'default',
      subscribedUris: new Set(opts.subscribedUris ?? []),
      createdAt: Date.now() - opts.ageMs,
    };
  }

  afterEach(() => {
    _clearSessionsForTesting();
  });

  it('TTL 超え + unsubscribed → evicted (orphansEvicted=1)', async () => {
    _addSessionForTesting('orphan-old', makeMockSession({ ageMs: SIX_MIN_MS }));
    const stats = await runOneActivePingCycle();
    expect(stats.orphansEvicted).toBe(1);
    expect(stats.disconnected).toBe(0); // ping 失敗ではなく eviction で回収
  });

  it('TTL 未満 + unsubscribed → not evicted (= 初期化中の猶予)', async () => {
    _addSessionForTesting('new-unsubscribed', makeMockSession({ ageMs: THIRTY_SEC_MS }));
    const stats = await runOneActivePingCycle();
    expect(stats.orphansEvicted).toBe(0);
  });

  it('TTL 超え + subscribed → not evicted (= 正常 session は保護)', async () => {
    _addSessionForTesting('active-subscribed', makeMockSession({
      subscribedUris: ['inbox://@test-user'],
      ageMs: SIX_MIN_MS,
    }));
    const stats = await runOneActivePingCycle();
    expect(stats.orphansEvicted).toBe(0);
  });

  it('orphan 2 件 + 正常 1 件 → orphan 2 件のみ evict', async () => {
    _addSessionForTesting('orphan-1', makeMockSession({ ageMs: SIX_MIN_MS }));
    _addSessionForTesting('orphan-2', makeMockSession({ ageMs: SIX_MIN_MS }));
    _addSessionForTesting('active-1', makeMockSession({
      subscribedUris: ['inbox://@test-user'],
      ageMs: SIX_MIN_MS,
    }));
    const stats = await runOneActivePingCycle();
    expect(stats.orphansEvicted).toBe(2);
    expect(stats.total).toBe(3);
  });

  it('runOneActivePingCycle の返り値に orphansEvicted フィールドが含まれる', async () => {
    const stats = await runOneActivePingCycle();
    expect(typeof stats.orphansEvicted).toBe('number');
  });
});
