import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  evictSessionOnDisconnect,
  scheduleEvictionOnDisconnect,
  cancelPendingEviction,
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

/**
 * issue #343 再設計: GET /mcp の req.on('close') は「bridge プロセス死亡」だけでなく
 * 公式 SDK client の正常な Last-Event-ID reconnect でも発火する。即時 evict だと
 * resumable reconnect (eventStore による notification 再送) が壊れるため、
 * grace period 付き eviction (scheduleEvictionOnDisconnect / cancelPendingEviction) で
 * 「一時的な GET 切断からの正常な reconnect」と「実死亡」を区別することを検証する。
 */
describe('scheduleEvictionOnDisconnect / cancelPendingEviction (issue #343 再設計)', () => {
  afterEach(() => {
    _clearSessionsForTesting();
    vi.useRealTimers();
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

  it('grace period 内に同一 session への reconnect (cancelPendingEviction) が来れば evict されない', async () => {
    vi.useFakeTimers();
    const session = makeMockSession();
    _addSessionForTesting('sid-reconnect', session);

    scheduleEvictionOnDisconnect('sid-reconnect', 60_000);
    // GET 再接続が grace period 内に成立 (= 正常な Last-Event-ID reconnect)
    vi.advanceTimersByTime(30_000);
    cancelPendingEviction('sid-reconnect');
    vi.advanceTimersByTime(60_000);
    await vi.runOnlyPendingTimersAsync();

    // evict されていないので transport.close は呼ばれない
    expect(session.transport.close).not.toHaveBeenCalled();
    expect(await evictSessionOnDisconnect('sid-reconnect')).toBe(true);
  });

  it('grace period 内に reconnect が来なければ猶予期間経過後に evict される', async () => {
    vi.useFakeTimers();
    const session = makeMockSession();
    _addSessionForTesting('sid-dead', session);

    scheduleEvictionOnDisconnect('sid-dead', 60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(session.transport.close).toHaveBeenCalledTimes(1);
    // sessions から削除済みなので再度 evict しても false
    await expect(evictSessionOnDisconnect('sid-dead')).resolves.toBe(false);
  });

  it('既に pending timer がある session に再度 schedule しても多重 timer にならない (防御的 guard)', async () => {
    vi.useFakeTimers();
    const session = makeMockSession();
    _addSessionForTesting('sid-dup', session);

    scheduleEvictionOnDisconnect('sid-dup', 60_000);
    scheduleEvictionOnDisconnect('sid-dup', 60_000); // 2 回目は no-op

    await vi.advanceTimersByTimeAsync(60_000);

    expect(session.transport.close).toHaveBeenCalledTimes(1);
  });

  it('存在しない sessionId に対しては何もしない (例外を投げない)', () => {
    expect(() => scheduleEvictionOnDisconnect('does-not-exist', 60_000)).not.toThrow();
    expect(() => cancelPendingEviction('does-not-exist')).not.toThrow();
  });
});
