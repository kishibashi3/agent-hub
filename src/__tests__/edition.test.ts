import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveEdition, EditionConfigError } from '../edition.js';

// console.warn を spy するための共通 setup
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('resolveEdition', () => {
  describe('AGENT_HUB_EDITION の解釈', () => {
    it('未指定なら EditionConfigError をスロー (= 起動失敗、issue #55 fix)', () => {
      // AGENT_HUB_EDITION 未設定時の silent community fallback は廃止。
      // PE 環境でのセット忘れを設定ミスとして早期検知する。
      expect(() => resolveEdition({})).toThrow(EditionConfigError);
      expect(() => resolveEdition({})).toThrow(/AGENT_HUB_EDITION が未設定/);
    });

    it('空文字列も未設定扱いで EditionConfigError をスロー', () => {
      expect(() => resolveEdition({ AGENT_HUB_EDITION: '' })).toThrow(EditionConfigError);
      expect(() => resolveEdition({ AGENT_HUB_EDITION: '   ' })).toThrow(EditionConfigError);
    });

    it("EDITION='community' を受け入れる", () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: 'community' });
      expect(cfg.edition).toBe('community');
    });

    it("EDITION='private' を受け入れる", () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: 'private' });
      expect(cfg.edition).toBe('private');
    });

    it('大文字 / 空白を許容', () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: '  Private  ' });
      expect(cfg.edition).toBe('private');
    });

    it('未知の値は EditionConfigError', () => {
      expect(() => resolveEdition({ AGENT_HUB_EDITION: 'enterprise' })).toThrow(
        EditionConfigError
      );
    });
  });

  describe('Community Edition の振る舞い', () => {
    it('default で auth=pat / named tenant 許可 / CE-admin tools 露出', () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: 'community' });
      expect(cfg.authMode).toBe('pat');
      expect(cfg.allowsNamedTenant).toBe(true);
      expect(cfg.enforcesDeploymentInitGate).toBe(true);
      expect(cfg.exposesCeAdminTools).toBe(true);
    });

    it('AGENT_HUB_AUTH_MODE=pat を明示しても等価', () => {
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'community',
        AGENT_HUB_AUTH_MODE: 'pat',
      });
      expect(cfg.authMode).toBe('pat');
    });

    // issue #271: trust mode 廃止 — 設定されたら EditionConfigError
    it('AGENT_HUB_AUTH_MODE=trust は廃止済みで EditionConfigError をスロー', () => {
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'community', AGENT_HUB_AUTH_MODE: 'trust' })
      ).toThrow(EditionConfigError);
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'community', AGENT_HUB_AUTH_MODE: 'trust' })
      ).toThrow(/廃止/);
    });

    it('DISABLE_DEFAULT_TENANT 未指定 → restriction 有効 (secure-by-default)', () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: 'community' });
      expect(cfg.enforcesDefaultTenantRestriction).toBe(true);
    });

    it("DISABLE_DEFAULT_TENANT='0' で restriction 解除", () => {
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'community',
        AGENT_HUB_DISABLE_DEFAULT_TENANT: '0',
      });
      expect(cfg.enforcesDefaultTenantRestriction).toBe(false);
    });
  });

  describe('Private Edition の振る舞い', () => {
    it('auth=pat / named tenant 不可 / CE-admin tools 非露出 / init gate なし', () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: 'private' });
      expect(cfg.authMode).toBe('pat');
      expect(cfg.allowsNamedTenant).toBe(false);
      expect(cfg.enforcesDeploymentInitGate).toBe(false);
      expect(cfg.exposesCeAdminTools).toBe(false);
    });

    it('AGENT_HUB_AUTH_MODE=pat を明示しても等価', () => {
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'private',
        AGENT_HUB_AUTH_MODE: 'pat',
      });
      expect(cfg.authMode).toBe('pat');
    });

    // issue #271: trust mode 廃止
    it('AGENT_HUB_AUTH_MODE=trust は廃止済みで EditionConfigError をスロー', () => {
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'private', AGENT_HUB_AUTH_MODE: 'trust' })
      ).toThrow(EditionConfigError);
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'private', AGENT_HUB_AUTH_MODE: 'trust' })
      ).toThrow(/廃止/);
    });

    // v2 設計 Minor 4: PE で AGENT_HUB_DISABLE_DEFAULT_TENANT が設定されていたら WARN log
    it('DISABLE_DEFAULT_TENANT は無視される + WARN log を出す (silent ignore 廃止)', () => {
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'private',
        AGENT_HUB_DISABLE_DEFAULT_TENANT: '1',
      });
      expect(cfg.enforcesDefaultTenantRestriction).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0][0]);
      expect(msg).toMatch(
        /\[PE\] AGENT_HUB_DISABLE_DEFAULT_TENANT is set but has no effect/
      );
    });

    it('DISABLE_DEFAULT_TENANT 未設定なら WARN log は出ない', () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: 'private' });
      expect(cfg.enforcesDefaultTenantRestriction).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('AGENT_HUB_AUTH_MODE の値 validation', () => {
    it('未知の AGENT_HUB_AUTH_MODE は EditionConfigError', () => {
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'community', AGENT_HUB_AUTH_MODE: 'oauth2' })
      ).toThrow(EditionConfigError);
    });

    it("未設定なら pat がデフォルトで適用される", () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: 'community' });
      expect(cfg.authMode).toBe('pat');
    });
  });
});
