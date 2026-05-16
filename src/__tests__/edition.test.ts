import { describe, it, expect } from 'vitest';
import { resolveEdition, EditionConfigError } from '../edition.js';

describe('resolveEdition', () => {
  describe('AGENT_HUB_EDITION の解釈', () => {
    it('未指定なら community をデフォルト採用 (secure-by-default)', () => {
      const cfg = resolveEdition({});
      expect(cfg.edition).toBe('community');
      expect(cfg.authMode).toBe('pat');
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

    it('AUTH_MODE=pat を明示しても等価', () => {
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'community',
        AUTH_MODE: 'pat',
      });
      expect(cfg.authMode).toBe('pat');
    });

    it('AUTH_MODE=trust は conflict として弾く', () => {
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'community', AUTH_MODE: 'trust' })
      ).toThrow(/AGENT_HUB_EDITION=private/); // 移行先 hint を含む
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
    it('auth=trust / named tenant 不可 / CE-admin tools 非露出 / init gate なし', () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: 'private' });
      expect(cfg.authMode).toBe('trust');
      expect(cfg.allowsNamedTenant).toBe(false);
      expect(cfg.enforcesDeploymentInitGate).toBe(false);
      expect(cfg.exposesCeAdminTools).toBe(false);
    });

    it('AUTH_MODE=trust を明示しても等価', () => {
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'private',
        AUTH_MODE: 'trust',
      });
      expect(cfg.authMode).toBe('trust');
    });

    it('AUTH_MODE=pat は conflict として弾く', () => {
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'private', AUTH_MODE: 'pat' })
      ).toThrow(/AGENT_HUB_EDITION=community/); // 移行先 hint を含む
    });

    it('DISABLE_DEFAULT_TENANT は無視される (PE では意味を持たない)', () => {
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'private',
        AGENT_HUB_DISABLE_DEFAULT_TENANT: '1',
      });
      expect(cfg.enforcesDefaultTenantRestriction).toBe(false);
    });
  });

  describe('AUTH_MODE の値 validation', () => {
    it('未知の AUTH_MODE は EditionConfigError', () => {
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'community', AUTH_MODE: 'oauth2' })
      ).toThrow(EditionConfigError);
    });
  });
});
