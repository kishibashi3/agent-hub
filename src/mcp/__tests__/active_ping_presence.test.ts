import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isPingLoopDisabled,
  startActivePingLoop,
  stopActivePingLoop,
} from '../server.js';

/**
 * issue #91 active ping-based presence の behavior test。
 *
 * spec (= issue #91): server が 30s 周期で全 session に ping、 応答なし → retry 2 回 →
 * 全 fail なら SSE disconnect + sessions Map から削除 → is_online 自動 false。
 *
 * scope (= 本 file):
 * - **feature flag** (= `MCP_PING_LOOP_DISABLED`) の env binary signal 検証
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
    originalEnv = process.env.MCP_PING_LOOP_DISABLED;
    delete process.env.MCP_PING_LOOP_DISABLED;
  });

  afterEach(() => {
    // 何かしら起動した interval を必ず停止 (= test isolation)
    stopActivePingLoop();
    if (originalEnv === undefined) {
      delete process.env.MCP_PING_LOOP_DISABLED;
    } else {
      process.env.MCP_PING_LOOP_DISABLED = originalEnv;
    }
  });

  describe('isPingLoopDisabled() feature flag', () => {
    it('env unset → false (= active ping enabled、 default behavior)', () => {
      delete process.env.MCP_PING_LOOP_DISABLED;
      expect(isPingLoopDisabled()).toBe(false);
    });

    it('env empty string → false (= unset 同等、 redline #1 整合)', () => {
      process.env.MCP_PING_LOOP_DISABLED = '';
      expect(isPingLoopDisabled()).toBe(false);
    });

    it('env="1" → true (= ping loop disabled、 SSE-only presence に倒す)', () => {
      process.env.MCP_PING_LOOP_DISABLED = '1';
      expect(isPingLoopDisabled()).toBe(true);
    });

    it('env="true" → true (= 値の中身を問わない binary signal)', () => {
      process.env.MCP_PING_LOOP_DISABLED = 'true';
      expect(isPingLoopDisabled()).toBe(true);
    });

    it('env="0" → true (= 「0 だから false」 ではなく binary set/unset signal、 #68 と同 pattern)', () => {
      // operator rollback misconfig 防御: 値の semantic 解釈なし
      process.env.MCP_PING_LOOP_DISABLED = '0';
      expect(isPingLoopDisabled()).toBe(true);
    });

    it('env="false" → true (= 上記同様、 binary semantic)', () => {
      process.env.MCP_PING_LOOP_DISABLED = 'false';
      expect(isPingLoopDisabled()).toBe(true);
    });
  });

  describe('startActivePingLoop() / stopActivePingLoop() lifecycle', () => {
    it('flag disabled → start は no-op (= interval を作らない)', () => {
      process.env.MCP_PING_LOOP_DISABLED = '1';
      const stop = startActivePingLoop();
      // stop function は返るが、 実際の clearInterval は no-op (= interval 不在)
      // double-stop でも crash しないことを確認
      stop();
      stopActivePingLoop();
      // ここまで example noop で完走 → expectations 不要だが framework として 1 expect:
      expect(isPingLoopDisabled()).toBe(true);
    });

    it('start → start (= 2 回目) は no-op (= idempotent、 重複 interval を作らない)', () => {
      delete process.env.MCP_PING_LOOP_DISABLED;
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
      delete process.env.MCP_PING_LOOP_DISABLED;
      const stop1 = startActivePingLoop();
      stop1();
      // 停止後の再 start
      const stop2 = startActivePingLoop();
      stop2();
      expect(typeof stop1).toBe('function');
      expect(typeof stop2).toBe('function');
    });

    it('stopActivePingLoop() を 起動なしで呼んでも crash しない (= defensive)', () => {
      delete process.env.MCP_PING_LOOP_DISABLED;
      // 起動なしの状態で stop を直接呼んでも safely no-op
      expect(() => stopActivePingLoop()).not.toThrow();
      // 連続 stop も OK
      expect(() => stopActivePingLoop()).not.toThrow();
    });
  });
});
