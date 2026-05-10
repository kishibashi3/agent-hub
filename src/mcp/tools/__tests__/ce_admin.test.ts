import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';
import { handleRegister } from '../register.js';
import { handleSendMessage } from '../send_message.js';
import {
  handleListTenants,
  handleGetTenant,
  handleDeleteTenant,
} from '../ce_admin.js';

describe('CE operator tools', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    initDatabase(db);

    // default tenant に @admin を register (= deployment 初期化、operator 確立)
    const defaultScope = scopeToTenant(db, 'default');
    await handleRegister(defaultScope, { name: 'admin' }, 'admin', 'kishibashi');

    // named tenant 'acme' を kishibashi が claim、@admin と @bob を register
    db.prepare(
      `INSERT INTO tenants (domain, owner) VALUES ('acme', 'kishibashi')`
    ).run();
    const acmeScope = scopeToTenant(db, 'acme');
    await handleRegister(acmeScope, { name: 'admin' }, 'admin', 'kishibashi');
    await handleRegister(acmeScope, { name: 'bob' }, 'bob', 'kishibashi');
    await handleSendMessage(acmeScope, { to: 'bob', message: 'hi bob' }, 'admin');
  });

  describe('list_tenants', () => {
    it('default tenant の @admin から呼ぶと全 tenant 一覧が返る', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleListTenants(scope, {}, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.count).toBe(2);
      const domains = body.tenants.map((t: { domain: string }) => t.domain);
      expect(domains).toContain('default');
      expect(domains).toContain('acme');

      const acme = body.tenants.find((t: { domain: string }) => t.domain === 'acme');
      expect(acme.owner).toBe('kishibashi');
      expect(acme.participant_count).toBe(2);
      expect(acme.message_count).toBe(1);
    });

    it('default tenant の非 @admin からは forbidden', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleListTenants(scope, {}, '@kishibashi3');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.error).toBe('forbidden');
    });

    it('named tenant の @admin からは forbidden (operator は default の @admin のみ)', async () => {
      const scope = scopeToTenant(db, 'acme');
      const r = await handleListTenants(scope, {}, '@admin');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.error).toBe('forbidden');
    });
  });

  describe('get_tenant', () => {
    it('default の @admin から呼ぶと named tenant の詳細が返る', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleGetTenant(scope, { domain: 'acme' }, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.domain).toBe('acme');
      expect(body.owner).toBe('kishibashi');
      expect(body.message_count).toBe(1);
      expect(body.team_count).toBe(0);
      expect(body.participants).toHaveLength(2);
      const names = body.participants.map(
        (p: { name: string }) => p.name
      );
      expect(names).toContain('@admin');
      expect(names).toContain('@bob');
      // owner / mode も含まれる
      const adminP = body.participants.find(
        (p: { name: string }) => p.name === '@admin'
      );
      expect(adminP.owner).toBe('kishibashi');
    });

    it('default tenant 自体も get できる (owner=NULL)', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleGetTenant(scope, { domain: 'default' }, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.domain).toBe('default');
      expect(body.owner).toBeNull();
      expect(body.participants.length).toBeGreaterThan(0);
    });

    it('存在しない tenant は 404 相当', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleGetTenant(scope, { domain: 'ghost' }, '@admin');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.message).toContain("'ghost'");
    });

    it('default tenant の非 @admin からは forbidden', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleGetTenant(
        scope,
        { domain: 'acme' },
        '@kishibashi3'
      );
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.error).toBe('forbidden');
    });

    it('named tenant の @admin からは forbidden', async () => {
      const scope = scopeToTenant(db, 'acme');
      const r = await handleGetTenant(scope, { domain: 'acme' }, '@admin');
      expect(r.isError).toBe(true);
    });
  });

  describe('delete_tenant', () => {
    it('default tenant の @admin として named tenant を削除できる', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleDeleteTenant(
        scope,
        { domain: 'acme', confirm: true },
        '@admin'
      );
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.deleted).toBe('acme');

      // tenants table から消えている
      const exists = db
        .prepare("SELECT 1 FROM tenants WHERE domain = 'acme'")
        .get();
      expect(exists).toBeUndefined();

      // tenant 内データも cascade 削除
      const participants = db
        .prepare("SELECT COUNT(*) as c FROM participants WHERE tenant_id = 'acme'")
        .get() as { c: number };
      expect(participants.c).toBe(0);
      const messages = db
        .prepare("SELECT COUNT(*) as c FROM messages WHERE tenant_id = 'acme'")
        .get() as { c: number };
      expect(messages.c).toBe(0);
    });

    it('default tenant は削除不可', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleDeleteTenant(
        scope,
        { domain: 'default', confirm: true },
        '@admin'
      );
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.message).toContain('default tenant');
    });

    it('confirm=true 必須', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleDeleteTenant(scope, { domain: 'acme' }, '@admin');
      expect(r.isError).toBe(true);
    });

    it('存在しない tenant は削除できない', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleDeleteTenant(
        scope,
        { domain: 'ghost', confirm: true },
        '@admin'
      );
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.message).toContain("'ghost'");
    });

    it('default tenant の非 @admin からは forbidden', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleDeleteTenant(
        scope,
        { domain: 'acme', confirm: true },
        '@kishibashi3'
      );
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.error).toBe('forbidden');
    });

    it('named tenant の @admin からは forbidden', async () => {
      const scope = scopeToTenant(db, 'acme');
      const r = await handleDeleteTenant(
        scope,
        { domain: 'acme', confirm: true },
        '@admin'
      );
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.error).toBe('forbidden');
    });

    it('domain バリデーション: 不正な文字を弾く', async () => {
      const scope = scopeToTenant(db, 'default');
      const r = await handleDeleteTenant(
        scope,
        { domain: 'acme/../etc', confirm: true },
        '@admin'
      );
      expect(r.isError).toBe(true);
    });
  });
});
