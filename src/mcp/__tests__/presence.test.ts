import { describe, it, expect } from 'vitest';
import { isParticipantOnline, type PresenceSession } from '../server.js';

/**
 * issue #1 (presence layer / depth A): `is_online` 判定のための単体テスト。
 *
 * `notifyResourceUpdated` / `selectNotificationTargets` と同様、実 Server
 * インスタンスを立ち上げずに「どんな session 集合のとき online と判定すべきか」
 * の純粋関数だけを検証する。
 */
describe('isParticipantOnline (issue #1: presence depth A)', () => {
  // subscribedUris は実 server では canonicalizeInboxUri 経由で `@` を strip 済の
  // `inbox://<name>` 形式で格納される (server.ts の subscribe handler 参照)。
  // test fixture もその canonical 形 (`inbox://alice`) で組み立てる。
  function mkSession(
    tenantDomain: string,
    userId: string,
    uris: string[]
  ): PresenceSession {
    return {
      tenantDomain,
      userId,
      subscribedUris: new Set(uris),
    };
  }

  it('自分の inbox を subscribe 中の session があれば true', () => {
    const sessions: Array<[string, PresenceSession]> = [
      ['sid-A', mkSession('default', '@alice', ['inbox://alice'])],
    ];

    expect(isParticipantOnline(sessions, 'default', '@alice')).toBe(true);
  });

  it('register 直後で未 subscribe の participant は false', () => {
    const sessions: Array<[string, PresenceSession]> = [
      ['sid-A', mkSession('default', '@alice', [])], // subscribe していない
    ];

    expect(isParticipantOnline(sessions, 'default', '@alice')).toBe(false);
  });

  it('session が存在しない participant は false (= 完全 offline)', () => {
    const sessions: Array<[string, PresenceSession]> = [
      ['sid-A', mkSession('default', '@alice', ['inbox://alice'])],
    ];

    expect(isParticipantOnline(sessions, 'default', '@bob')).toBe(false);
  });

  it('同一 handle で複数 session: 1 つでも subscribe 中なら true', () => {
    // Claude Code 複数起動の状況。subscribe している方が 1 つでもあれば online。
    const sessions: Array<[string, PresenceSession]> = [
      ['sid-A1', mkSession('default', '@alice', [])], // session ある、未 subscribe
      ['sid-A2', mkSession('default', '@alice', ['inbox://alice'])],
    ];

    expect(isParticipantOnline(sessions, 'default', '@alice')).toBe(true);
  });

  it('同一 handle で全 session が未 subscribe なら false', () => {
    const sessions: Array<[string, PresenceSession]> = [
      ['sid-A1', mkSession('default', '@alice', [])],
      ['sid-A2', mkSession('default', '@alice', [])],
    ];

    expect(isParticipantOnline(sessions, 'default', '@alice')).toBe(false);
  });

  it('別 tenant の同名 handle session を online と誤認しない', () => {
    // tenant_a に @alice、tenant_b にも @alice (別エンティティ) が居て
    // tenant_b 側でのみ subscribe している状況。tenant_a 視点では offline でなければならない。
    const sessions: Array<[string, PresenceSession]> = [
      ['sid-B', mkSession('tenant_b', '@alice', ['inbox://alice'])],
    ];

    expect(isParticipantOnline(sessions, 'tenant_a', '@alice')).toBe(false);
    expect(isParticipantOnline(sessions, 'tenant_b', '@alice')).toBe(true);
  });

  it('別の handle の subscribe を取り違えない', () => {
    // sid-A の userId は @alice だが、subscribe しているのは @bob の inbox。
    // (実運用では起きないが、判定ロジックが userId と URI 双方を見ていることを担保)
    const sessions: Array<[string, PresenceSession]> = [
      ['sid-A', mkSession('default', '@alice', ['inbox://bob'])],
    ];

    expect(isParticipantOnline(sessions, 'default', '@alice')).toBe(false);
    expect(isParticipantOnline(sessions, 'default', '@bob')).toBe(false);
  });

  it('Map<string, Session> も受け取れる (運用形態と一致)', () => {
    const sessions = new Map<string, PresenceSession>([
      ['sid-A', mkSession('default', '@alice', ['inbox://alice'])],
    ]);

    expect(isParticipantOnline(sessions, 'default', '@alice')).toBe(true);
  });
});
