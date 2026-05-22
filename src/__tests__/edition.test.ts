import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveEdition, EditionConfigError } from '../edition.js';

// console.warn を spy するための共通 setup (v2 設計の WARN-only path / opt-in path で検証)
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

    it("EDITION='professional' を受け入れる", () => {
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'professional',
        DATABASE_URL: 'postgresql://localhost:5432/agent_hub',
        OIDC_ISSUER: 'https://accounts.example.com',
      });
      expect(cfg.edition).toBe('professional');
    });

    it('大文字 / 空白を許容', () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: '  Private  ' });
      expect(cfg.edition).toBe('private');
    });

    it('未知の値は EditionConfigError (enterprise は未実装)', () => {
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

    // v2 設計 1d=(B): CE+trust は v1 で WARN-only、v2 で hard reject (= migration anchor)
    it('AUTH_MODE=trust は v1 では WARN-only で許容 (= 起動成功)', () => {
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'community',
        AUTH_MODE: 'trust',
      });
      expect(cfg.edition).toBe('community');
      expect(cfg.authMode).toBe('trust'); // legacy mode で起動許可
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0][0]);
      expect(msg).toMatch(/次バージョン \(v2\) から reject/);
      expect(msg).toMatch(/AGENT_HUB_EDITION=private/); // LAN への移行 hint
      expect(msg).toMatch(/AUTH_MODE=pat/); // PAT 公開への移行 hint
      expect(msg).toMatch(/AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1/); // opt-in path 明示
    });

    it("AUTH_MODE=trust + AGENT_HUB_ALLOW_LEGACY_CE_TRUST='1' で audit-friendly opt-in WARN に切替え", () => {
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'community',
        AUTH_MODE: 'trust',
        AGENT_HUB_ALLOW_LEGACY_CE_TRUST: '1',
      });
      expect(cfg.authMode).toBe('trust');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const msg = String(warnSpy.mock.calls[0][0]);
      expect(msg).toMatch(/legacy CE\+trust mode running under explicit opt-in/);
      expect(msg).toMatch(/v2 でも WARN-only で延命/);
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

    it('requiresPostgres=false / requiresRedis=false (CE は SQLite + in-process)', () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: 'community' });
      expect(cfg.requiresPostgres).toBe(false);
      expect(cfg.requiresRedis).toBe(false);
    });

    it('AUTH_MODE=oidc は EditionConfigError (Professional Edition 専用)', () => {
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'community', AUTH_MODE: 'oidc' })
      ).toThrow(EditionConfigError);
      try {
        resolveEdition({ AGENT_HUB_EDITION: 'community', AUTH_MODE: 'oidc' });
      } catch (err) {
        expect(String((err as Error).message)).toMatch(/AGENT_HUB_EDITION=professional/);
      }
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

    // v2 設計: PE+pat は設計矛盾、常に hard reject (= 1d の inverse 側、v1/v2 共通)
    it('AUTH_MODE=pat は v1/v2 共通で hard reject (= 設計矛盾)', () => {
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'private', AUTH_MODE: 'pat' })
      ).toThrow(EditionConfigError);
      try {
        resolveEdition({ AGENT_HUB_EDITION: 'private', AUTH_MODE: 'pat' });
      } catch (err) {
        const msg = String((err as Error).message);
        // 両方向 hint を検証 (Sug 3 反映)
        expect(msg).toMatch(/AUTH_MODE 指定を削除/); // LAN 専用への path
        expect(msg).toMatch(/AGENT_HUB_EDITION=community/); // PAT 公開への path
      }
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

    it('requiresPostgres=false / requiresRedis=false (PE は SQLite + in-process)', () => {
      const cfg = resolveEdition({ AGENT_HUB_EDITION: 'private' });
      expect(cfg.requiresPostgres).toBe(false);
      expect(cfg.requiresRedis).toBe(false);
    });

    it('AUTH_MODE=oidc は EditionConfigError (Professional Edition 専用)', () => {
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'private', AUTH_MODE: 'oidc' })
      ).toThrow(EditionConfigError);
      try {
        resolveEdition({ AGENT_HUB_EDITION: 'private', AUTH_MODE: 'oidc' });
      } catch (err) {
        expect(String((err as Error).message)).toMatch(/AGENT_HUB_EDITION=professional/);
      }
    });
  });

  describe('Professional Edition の振る舞い', () => {
    // BASE env: minimum valid professional config
    const BASE: Record<string, string> = {
      AGENT_HUB_EDITION: 'professional',
      DATABASE_URL: 'postgresql://localhost:5432/agent_hub',
      OIDC_ISSUER: 'https://accounts.example.com',
      REDIS_URL: 'redis://localhost:6379',
    };

    it('default で auth=oidc / named tenant 許可 / CE-admin tools 露出 / init gate あり / requiresPostgres=true / requiresRedis=true', () => {
      const cfg = resolveEdition(BASE);
      expect(cfg.edition).toBe('professional');
      expect(cfg.authMode).toBe('oidc');
      expect(cfg.allowsNamedTenant).toBe(true);
      expect(cfg.enforcesDeploymentInitGate).toBe(true);
      expect(cfg.exposesCeAdminTools).toBe(true);
      expect(cfg.requiresPostgres).toBe(true);
      expect(cfg.requiresRedis).toBe(true);
    });

    it('AUTH_MODE=oidc を明示しても等価', () => {
      const cfg = resolveEdition({ ...BASE, AUTH_MODE: 'oidc' });
      expect(cfg.authMode).toBe('oidc');
    });

    it('AUTH_MODE=pat は EditionConfigError', () => {
      expect(() => resolveEdition({ ...BASE, AUTH_MODE: 'pat' })).toThrow(EditionConfigError);
      try {
        resolveEdition({ ...BASE, AUTH_MODE: 'pat' });
      } catch (err) {
        const msg = String((err as Error).message);
        expect(msg).toMatch(/OIDC 認証のみサポート/);
        expect(msg).toMatch(/AUTH_MODE=oidc/);
      }
    });

    it('AUTH_MODE=trust は EditionConfigError', () => {
      expect(() => resolveEdition({ ...BASE, AUTH_MODE: 'trust' })).toThrow(EditionConfigError);
    });

    it('DATABASE_URL 未設定は EditionConfigError', () => {
      const env = { ...BASE, DATABASE_URL: undefined };
      expect(() => resolveEdition(env)).toThrow(EditionConfigError);
      try {
        resolveEdition(env);
      } catch (err) {
        expect(String((err as Error).message)).toMatch(/DATABASE_URL/);
      }
    });

    it('OIDC_ISSUER 未設定は EditionConfigError', () => {
      const env = { ...BASE, OIDC_ISSUER: undefined };
      expect(() => resolveEdition(env)).toThrow(EditionConfigError);
      try {
        resolveEdition(env);
      } catch (err) {
        expect(String((err as Error).message)).toMatch(/OIDC_ISSUER/);
      }
    });

    it('REDIS_URL 未設定は WARN-only で requiresRedis=false (起動は成功)', () => {
      const env = { ...BASE, REDIS_URL: undefined };
      const cfg = resolveEdition(env);
      expect(cfg.requiresRedis).toBe(false);
      expect(cfg.requiresPostgres).toBe(true); // PostgreSQL は引き続き必須
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toMatch(/REDIS_URL/);
    });

    it('REDIS_URL 設定済みなら requiresRedis=true', () => {
      const cfg = resolveEdition(BASE);
      expect(cfg.requiresRedis).toBe(true);
    });

    it('DISABLE_DEFAULT_TENANT 未指定 → restriction 有効 (secure-by-default)', () => {
      const cfg = resolveEdition(BASE);
      expect(cfg.enforcesDefaultTenantRestriction).toBe(true);
    });

    it("DISABLE_DEFAULT_TENANT='0' で restriction 解除", () => {
      const cfg = resolveEdition({ ...BASE, AGENT_HUB_DISABLE_DEFAULT_TENANT: '0' });
      expect(cfg.enforcesDefaultTenantRestriction).toBe(false);
    });

    it('大文字も許容 (PROFESSIONAL)', () => {
      const cfg = resolveEdition({ ...BASE, AGENT_HUB_EDITION: ' PROFESSIONAL ' });
      expect(cfg.edition).toBe('professional');
    });
  });

  describe('AUTH_MODE の値 validation', () => {
    it('未知の AUTH_MODE は EditionConfigError', () => {
      expect(() =>
        resolveEdition({ AGENT_HUB_EDITION: 'community', AUTH_MODE: 'oauth2' })
      ).toThrow(EditionConfigError);
    });

    it("AUTH_MODE='oidc' は valid (Professional Edition 専用)", () => {
      // 'oidc' は有効な AuthMode だが professional 以外では reject される
      // professional: DATABASE_URL + OIDC_ISSUER が揃えば正常
      const cfg = resolveEdition({
        AGENT_HUB_EDITION: 'professional',
        AUTH_MODE: 'oidc',
        DATABASE_URL: 'postgresql://localhost:5432/agent_hub',
        OIDC_ISSUER: 'https://accounts.example.com',
      });
      expect(cfg.authMode).toBe('oidc');
    });
  });
});
