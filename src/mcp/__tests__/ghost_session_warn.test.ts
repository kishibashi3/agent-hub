import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../db/migrations.js';
import { registerParticipant } from '../../db/participants.js';
import {
  maybeWarnGhostSession,
  _resetGhostWarnCacheForTests,
} from '../server.js';

/**
 * issue #28 server-side Path B (= ghost-session detection WARN) の behavior test。
 *
 * @admin (Pi5) 報告の「見えない幽霊」 bug = AGENT_HUB_TENANT 伝播失敗時、 server が
 * 「default tenant 着地だが named tenant 登録もある」 を検知して WARN を log するかを検証。
 *
 * - 直接 helper を呼ぶことで HTTP middleware 経路を bypass し、 unit test の
 *   isolation を保つ (= 別 PR (#73, #74, #76) の test pattern と整合)
 */
describe('ghost-session detection WARN (issue #28)', () => {
  let db: Database.Database;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  /** named tenant を直接 INSERT する helper (= TOFU 経路 bypass) */
  function ensureTenant(domain: string, owner: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO tenants (domain, owner) VALUES (?, ?)`
    ).run(domain, owner);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    _resetGhostWarnCacheForTests();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    db.close();
  });

  it('default tenant 着地 + 同 (owner, handle) が named tenant にも存在 → WARN 発火', () => {
    // setup: alice が default + tenant-a 両方に @bridge-claude を登録
    registerParticipant(db, 'default', { name: 'bridge-claude' }, 'alice');
    ensureTenant('tenant-a', 'alice');
    registerParticipant(db, 'tenant-a', { name: 'bridge-claude' }, 'alice');

    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain('[ghost-session-detect]');
    expect(warnMsg).toContain('@bridge-claude');
    expect(warnMsg).toContain('owner=alice');
    expect(warnMsg).toContain('tenant-a');
    expect(warnMsg).toContain('AGENT_HUB_TENANT');
    expect(warnMsg).toContain('#28');
  });

  it('named tenant 着地時は WARN 発火しない (= 正規 path)', () => {
    ensureTenant('tenant-a', 'alice');
    registerParticipant(db, 'tenant-a', { name: 'bridge-claude' }, 'alice');

    maybeWarnGhostSession(db, '@bridge-claude', 'tenant-a', 'alice');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('default tenant 着地でも named tenant に該当登録なし → WARN なし (= 真の default-only user)', () => {
    registerParticipant(db, 'default', { name: 'bridge-claude' }, 'alice');

    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('@admin handle は WARN 対象外 (= operator legitimate use case)', () => {
    // @admin が default + named 両方に登録あっても WARN しない
    registerParticipant(db, 'default', { name: 'admin' }, 'ope-ultp1635');
    ensureTenant('tenant-a', 'ope-ultp1635');
    registerParticipant(db, 'tenant-a', { name: 'admin' }, 'ope-ultp1635');

    maybeWarnGhostSession(db, '@admin', 'default', 'ope-ultp1635');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('別 owner の同名 handle は match させない (= false positive 防止)', () => {
    // tenant-a 側の @bridge-claude は別 owner (= bob)
    registerParticipant(db, 'default', { name: 'bridge-claude' }, 'alice');
    ensureTenant('tenant-a', 'bob');
    registerParticipant(db, 'tenant-a', { name: 'bridge-claude' }, 'bob');

    // alice が default に着地 → tenant-a の @bridge-claude(bob) は alice の物ではない
    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('同 (owner, handle) で 60s 以内の重複 WARN は cooldown で抑制', () => {
    registerParticipant(db, 'default', { name: 'bridge-claude' }, 'alice');
    ensureTenant('tenant-a', 'alice');
    registerParticipant(db, 'tenant-a', { name: 'bridge-claude' }, 'alice');

    // 1 回目 → fire
    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');
    // 2 回目 immediate → suppressed
    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');
    // 3 回目 immediate → suppressed
    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('cooldown は (owner, handle) tuple 単位 → 別 handle なら別 cache key', () => {
    registerParticipant(db, 'default', { name: 'bridge-claude' }, 'alice');
    registerParticipant(db, 'default', { name: 'bridge-gemini' }, 'alice');
    ensureTenant('tenant-a', 'alice');
    registerParticipant(db, 'tenant-a', { name: 'bridge-claude' }, 'alice');
    registerParticipant(db, 'tenant-a', { name: 'bridge-gemini' }, 'alice');

    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');
    maybeWarnGhostSession(db, '@bridge-gemini', 'default', 'alice');

    // 別 handle なので両方 fire (= cooldown は (owner, handle) tuple 別)
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('cooldown は (owner, handle) tuple 単位 → 別 owner なら別 cache key', () => {
    registerParticipant(db, 'default', { name: 'bridge-claude' }, 'alice');
    registerParticipant(db, 'default', { name: 'bridge-claude-2' }, 'bob');
    ensureTenant('tenant-a', 'alice');
    ensureTenant('tenant-b', 'bob');
    registerParticipant(db, 'tenant-a', { name: 'bridge-claude' }, 'alice');
    registerParticipant(db, 'tenant-b', { name: 'bridge-claude-2' }, 'bob');

    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');
    maybeWarnGhostSession(db, '@bridge-claude-2', 'default', 'bob');

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('複数 named tenant に登録がある場合、 WARN message に全て列挙される', () => {
    registerParticipant(db, 'default', { name: 'bridge-claude' }, 'alice');
    ensureTenant('tenant-a', 'alice');
    ensureTenant('tenant-b', 'alice');
    ensureTenant('tenant-c', 'alice');
    registerParticipant(db, 'tenant-a', { name: 'bridge-claude' }, 'alice');
    registerParticipant(db, 'tenant-b', { name: 'bridge-claude' }, 'alice');
    registerParticipant(db, 'tenant-c', { name: 'bridge-claude' }, 'alice');

    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain('tenant-a');
    expect(warnMsg).toContain('tenant-b');
    expect(warnMsg).toContain('tenant-c');
  });

  it('cooldown 期限 (60s) を過ぎたら同 (owner, handle) で再 WARN 発火 (= reviewer Suggestion 2)', () => {
    // setup: ghost state
    registerParticipant(db, 'default', { name: 'bridge-claude' }, 'alice');
    ensureTenant('tenant-a', 'alice');
    registerParticipant(db, 'tenant-a', { name: 'bridge-claude' }, 'alice');

    // 1 回目: fire
    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 2 回目 immediate: cooldown で suppressed (= 既存 test の重複だが期限前 baseline 確認)
    maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 3 回目: fake timer で 61s 経過 → cooldown 切れて再 fire 期待
    // (= Date.now() を stub することで `now - lastWarn >= 60_000` の path に到達)
    vi.useFakeTimers();
    try {
      // fake timer は import 時刻基準で start するので、 spec 通り 61s 進める前に
      // 「現在時刻」 を fake timer 時刻に lock するため `setSystemTime` で実時刻に揃える
      const baseTime = new Date();
      vi.setSystemTime(baseTime);
      vi.advanceTimersByTime(61_000);

      maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');
      // cooldown 切れて 2 回目の fire
      expect(warnSpy).toHaveBeenCalledTimes(2);

      // さらに immediate 再 call → 新たな cooldown 内なので suppressed
      maybeWarnGhostSession(db, '@bridge-claude', 'default', 'alice');
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
