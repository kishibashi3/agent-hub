import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  evictSessionOnDisconnect,
  _addSessionForTesting,
  _clearSessionsForTesting,
} from '../server.js';

/**
 * issue #342/#337: bridge プロセスが SIGKILL/OOM で abrupt に落ちた場合、
 * transport.onclose が発火せず session が sessions Map に残り続け is_online が
 * true のまま zombie 化する。GET /mcp の `req.on('close')` から呼ぶ
 * `evictSessionOnDisconnect()` の eviction 動作を検証する。
 */
describe('evictSessionOnDisconnect (issue #342/#337)', () => {
  afterEach(() => {
    _clearSessionsForTesting();
  });

  function makeMockSession(closeImpl?: () => Promise<void>) {
    return {
      transport: { close: closeImpl ?? vi.fn().mockResolvedValue(undefined) },
      server: { ping: vi.fn().mockResolvedValue(undefined) },
      userId: '@test-user',
      githubLogin: 'test-user',
      tenantDomain: 'default',
      subscribedUris: new Set(['inbox://@test-user']),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
  }

  it('存在する session を transport.close() → sessions.delete() の順で除去する', async () => {
    const session = makeMockSession();
    _addSessionForTesting('sid-1', session);

    const evicted = await evictSessionOnDisconnect('sid-1');

    expect(evicted).toBe(true);
    expect(session.transport.close).toHaveBeenCalledTimes(1);
  });

  it('除去後は is_online の判定元となる subscribedUris ごと sessions から消える', async () => {
    _addSessionForTesting('sid-2', makeMockSession());
    await evictSessionOnDisconnect('sid-2');

    // 再度呼んでも存在しないので false (= 冪等)
    const secondCall = await evictSessionOnDisconnect('sid-2');
    expect(secondCall).toBe(false);
  });

  it('存在しない sessionId を渡しても false を返し、例外を投げない', async () => {
    await expect(evictSessionOnDisconnect('does-not-exist')).resolves.toBe(false);
  });

  it('transport.close() が reject しても sessions からは削除される (= 切断済み transport への耐性)', async () => {
    const session = makeMockSession(vi.fn().mockRejectedValue(new Error('already closed')));
    _addSessionForTesting('sid-3', session);

    const evicted = await evictSessionOnDisconnect('sid-3');

    expect(evicted).toBe(true);
    // 2 回目呼び出しで session が既に存在しないことを確認 (= delete が実行された)
    await expect(evictSessionOnDisconnect('sid-3')).resolves.toBe(false);
  });
});
