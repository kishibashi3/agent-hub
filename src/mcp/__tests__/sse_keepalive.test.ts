import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SSE_KEEPALIVE_INTERVAL_MS,
  writeSseKeepalive,
  getPingTimeoutMs,
} from '../server.js';

/**
 * issue #240: SSE keepalive + PING_TIMEOUT_MS 緩和 のユニットテスト。
 *
 * spec (= issue #240):
 * - Option A: GET /mcp に 15s 周期の SSE keepalive comment を追加
 * - Option B: PING_TIMEOUT_MS を 5_000 → 10_000 に引き上げ
 *
 * scope (= 本 file):
 * - SSE_KEEPALIVE_INTERVAL_MS 定数値の検証
 * - writeSseKeepalive() の書き込み動作・close race 対策の検証
 * - getPingTimeoutMs() が 10_000 を返すことの検証
 * - fake timer を使った setInterval ベースの keepalive 周期確認
 */
describe('SSE keepalive (issue #240)', () => {
  describe('定数', () => {
    it('SSE_KEEPALIVE_INTERVAL_MS は 15 秒', () => {
      expect(SSE_KEEPALIVE_INTERVAL_MS).toBe(15_000);
    });

    it('PING_TIMEOUT_MS は 10 秒 (issue #240: 5s → 10s 緩和)', () => {
      expect(getPingTimeoutMs()).toBe(10_000);
    });
  });

  describe('writeSseKeepalive()', () => {
    it('ストリームが開いている場合に ": keepalive\\n\\n" を書き込む', () => {
      const writes: string[] = [];
      const mockRes = {
        writableEnded: false,
        write: (chunk: string) => { writes.push(chunk); return true; },
      };
      writeSseKeepalive(mockRes);
      expect(writes).toEqual([': keepalive\n\n']);
    });

    it('writableEnded が true の場合は書き込みをスキップする (close race 対策)', () => {
      const writes: string[] = [];
      const mockRes = {
        writableEnded: true,
        write: (chunk: string) => { writes.push(chunk); return true; },
      };
      writeSseKeepalive(mockRes);
      expect(writes).toHaveLength(0);
    });

    it('複数回呼び出しても writableEnded が false の間は毎回書き込む', () => {
      const writes: string[] = [];
      const mockRes = {
        writableEnded: false,
        write: (chunk: string) => { writes.push(chunk); return true; },
      };
      writeSseKeepalive(mockRes);
      writeSseKeepalive(mockRes);
      writeSseKeepalive(mockRes);
      expect(writes).toHaveLength(3);
      expect(writes.every((w) => w === ': keepalive\n\n')).toBe(true);
    });
  });

  describe('keepalive interval 動作 (fake timer)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('15s 経過ごとに writeSseKeepalive が呼ばれる', () => {
      const writes: string[] = [];
      const mockRes = {
        writableEnded: false,
        write: (chunk: string) => { writes.push(chunk); return true; },
      };

      const timer = setInterval(() => {
        writeSseKeepalive(mockRes);
      }, SSE_KEEPALIVE_INTERVAL_MS);

      // 0s: 未送信
      expect(writes).toHaveLength(0);

      // 15s: 1 回目
      vi.advanceTimersByTime(15_000);
      expect(writes).toHaveLength(1);

      // 30s: 2 回目
      vi.advanceTimersByTime(15_000);
      expect(writes).toHaveLength(2);

      // 14s 追加 (= 44s 合計): まだ 2 回
      vi.advanceTimersByTime(14_000);
      expect(writes).toHaveLength(2);

      clearInterval(timer);
    });

    it('clearInterval 後は keepalive が送信されない', () => {
      const writes: string[] = [];
      const mockRes = {
        writableEnded: false,
        write: (chunk: string) => { writes.push(chunk); return true; },
      };

      const timer = setInterval(() => {
        writeSseKeepalive(mockRes);
      }, SSE_KEEPALIVE_INTERVAL_MS);

      vi.advanceTimersByTime(15_000);
      expect(writes).toHaveLength(1);

      clearInterval(timer);

      vi.advanceTimersByTime(30_000);
      // interval 停止後は追加送信なし
      expect(writes).toHaveLength(1);
    });
  });
});
