import { describe, it, expect } from 'vitest';
import { selectNotificationTargets, type NotifiableSession } from '../server.js';

/**
 * issue #7: SSE notification の tenant 越え leak ガードのための単体テスト。
 *
 * `notifyResourceUpdated` 本体は実 Server インスタンスに依存して mock しづらいが、
 * dispatch の filter 部分を `selectNotificationTargets` に切り出してあるので、
 * ここでは「どの session id が対象になるか」だけを検証する。
 */
describe('selectNotificationTargets (issue #7: tenant leak ガード)', () => {
  function mkSession(
    tenantDomain: string,
    uris: string[]
  ): NotifiableSession {
    return {
      tenantDomain,
      subscribedUris: new Set(uris),
    };
  }

  it('same-tenant subscribe にのみ届く (default の @admin)', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-A', mkSession('default', ['inbox://@admin'])],
      ['sid-B', mkSession('kaz', ['inbox://@admin'])],
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
      ['sid-A', mkSession('default', ['inbox://@admin'])],
      ['sid-B', mkSession('kaz', ['inbox://@admin'])],
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
      ['sid-A', mkSession('default', ['inbox://@admin'])],
      ['sid-C', mkSession('default', ['inbox://@admin'])],
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
      ['sid-A', mkSession('default', ['inbox://@admin'])],
      ['sid-D', mkSession('default', ['inbox://@bob'])], // 別 URI を subscribe
    ];

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@admin',
      'default'
    );

    expect(targets).toEqual(['sid-A']);
  });

  it('既存の single-tenant 動作: 同 tenant 内の複数 subscriber 全員に届く', () => {
    const sessions: Array<[string, NotifiableSession]> = [
      ['sid-1', mkSession('default', ['inbox://@team'])],
      ['sid-2', mkSession('default', ['inbox://@team'])],
      ['sid-3', mkSession('default', ['inbox://@team'])],
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
      ['sid-A', mkSession('default', ['inbox://@admin'])],
      ['sid-B', mkSession('kaz', ['inbox://@admin'])],
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
      ['sid-A', mkSession('default', ['inbox://@admin'])],
      ['sid-B', mkSession('foo', ['inbox://@admin'])],
    ];

    const targets = selectNotificationTargets(
      sessions,
      'inbox://@admin',
      'unknown-tenant'
    );

    expect(targets).toEqual([]);
  });
});
