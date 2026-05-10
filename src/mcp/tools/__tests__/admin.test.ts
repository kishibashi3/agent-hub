import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';
import { handleRegister } from '../register.js';
import { handleDeleteUser, handleGetUserHistory } from '../admin.js';
import { handleSendMessage } from '../send_message.js';
import { handleCreateTeam } from '../create_team.js';

describe('admin ツール', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    initDatabase(db);
    // bootstrap: @admin と一般 peer を作る
    await handleRegister(scopeToTenant(db, 'default'), { name: 'admin' }, 'admin', 'kishibashi');
    await handleRegister(scopeToTenant(db, 'default'), { name: 'alice' }, 'alice', 'alice-gh');
    await handleRegister(scopeToTenant(db, 'default'), { name: 'bob' }, 'bob', 'bob-gh');
  });

  describe('権限チェック (共通)', () => {
    it('@admin 以外は delete_user を呼べない', async () => {
      const r = await handleDeleteUser(scopeToTenant(db, 'default'), { name: 'alice' }, 'bob');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.error).toBe('forbidden');
    });

    it('@admin 以外は get_user_history を呼べない', async () => {
      const r = await handleGetUserHistory(scopeToTenant(db, 'default'), { name: 'alice' }, 'bob');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.error).toBe('forbidden');
    });
  });

  describe('delete_user', () => {
    it('admin として peer を soft delete できる', async () => {
      const r = await handleDeleteUser(scopeToTenant(db, 'default'), { name: 'alice' }, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.deleted).toBe('@alice');
      expect(body.mode).toBe('soft');

      // 行は残っているが deleted_at がセットされている
      const row = db
        .prepare(
          'SELECT name, deleted_at FROM participants WHERE tenant_id = ? AND name = ?'
        )
        .get('default', '@alice') as { name: string; deleted_at: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row?.deleted_at).not.toBeNull();
    });

    it('@admin 自身は削除できない', async () => {
      const r = await handleDeleteUser(scopeToTenant(db, 'default'), { name: 'admin' }, '@admin');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.message).toContain('@admin');
    });

    it('存在しない peer は削除できない', async () => {
      const r = await handleDeleteUser(scopeToTenant(db, 'default'), { name: 'ghost' }, '@admin');
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text as string);
      expect(body.message).toContain("'@ghost'");
    });

    it('チームを所有していても soft delete できる (FK 残存)', async () => {
      // alice が team を作成
      await handleCreateTeam(
        scopeToTenant(db, 'default'),
        { name: 'project-x', members: ['alice'] },
        'alice'
      );

      const r = await handleDeleteUser(scopeToTenant(db, 'default'), { name: 'alice' }, '@admin');
      expect(r.isError).toBeUndefined();

      // チーム自体は残る (FK 制約のため row は消えない、運用で別 admin が引き継ぐ前提)
      const team = db
        .prepare('SELECT name FROM teams WHERE tenant_id = ? AND name = ?')
        .get('default', '@project-x');
      expect(team).toBeDefined();
    });

    it('soft delete 後も送信済メッセージは残る (FK 整合)', async () => {
      // alice が bob にメッセージ送信
      await handleSendMessage(
        scopeToTenant(db, 'default'),
        { to: 'bob', message: 'hello bob' },
        'alice'
      );

      const r = await handleDeleteUser(scopeToTenant(db, 'default'), { name: 'alice' }, '@admin');
      expect(r.isError).toBeUndefined();

      // soft delete では messages は残る (audit のため)
      const afterMsgs = db
        .prepare('SELECT COUNT(*) as c FROM messages WHERE tenant_id = ? AND sender = ?')
        .get('default', '@alice') as { c: number };
      expect(afterMsgs.c).toBe(1);
    });

    it('name バリデーション: 空は拒否', async () => {
      const r = await handleDeleteUser(scopeToTenant(db, 'default'), { name: '' }, '@admin');
      expect(r.isError).toBe(true);
    });

    it('@ 付き / なし両方受け付ける', async () => {
      const r = await handleDeleteUser(scopeToTenant(db, 'default'), { name: '@bob' }, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.deleted).toBe('@bob');
    });
  });

  describe('get_user_history', () => {
    beforeEach(async () => {
      // alice → bob, bob → alice の DM を仕込む
      await handleSendMessage(scopeToTenant(db, 'default'), { to: 'bob', message: 'hi bob' }, 'alice');
      await handleSendMessage(scopeToTenant(db, 'default'), { to: 'alice', message: 'hi alice' }, 'bob');
      await handleSendMessage(scopeToTenant(db, 'default'), { to: 'admin', message: 'cc admin' }, 'alice');
    });

    it('admin として peer の履歴 (sent + received) を取得できる', async () => {
      const r = await handleGetUserHistory(scopeToTenant(db, 'default'), { name: 'alice' }, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.user).toBe('@alice');
      // alice が sender か recipient のメッセージ全部 (3 件)
      expect(body.count).toBe(3);
    });

    it('limit を効かせられる', async () => {
      const r = await handleGetUserHistory(scopeToTenant(db, 'default'), { name: 'alice', limit: 1 }, '@admin');
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(r.content[0].text as string);
      expect(body.count).toBe(1);
    });

    it('存在しない peer は拒否', async () => {
      const r = await handleGetUserHistory(scopeToTenant(db, 'default'), { name: 'ghost' }, '@admin');
      expect(r.isError).toBe(true);
    });

    it('limit > 500 は zod で拒否', async () => {
      const r = await handleGetUserHistory(scopeToTenant(db, 'default'), { name: 'alice', limit: 9999 }, '@admin');
      expect(r.isError).toBe(true);
    });
  });
});
