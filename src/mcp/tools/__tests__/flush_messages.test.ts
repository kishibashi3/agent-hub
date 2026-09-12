import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import { handleFlushMessages } from '../flush_messages.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';

const MSG_DM = '11111111-1111-1111-1111-111111111111';
const MSG_BROADCAST = '22222222-2222-2222-2222-222222222222';
const MSG_TEAM = '33333333-3333-3333-3333-333333333333';

describe('flush_messages ツール（issue #336）', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');

    const schemaPath = join(process.cwd(), 'src', 'db', 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    db.prepare(
      'INSERT INTO participants (tenant_id, name, display_name, mode) VALUES (?, ?, ?, ?)'
    ).run('default', '@operator', 'Operator', 'global');
    db.prepare(
      'INSERT INTO participants (tenant_id, name, display_name, mode) VALUES (?, ?, ?, ?)'
    ).run('default', '@bob', 'Bob', null);
    db.prepare(
      'INSERT INTO participants (tenant_id, name, display_name, mode) VALUES (?, ?, ?, ?)'
    ).run('default', '@alice', 'Alice', null);

    db.prepare('INSERT INTO teams (tenant_id, name, owner) VALUES (?, ?, ?)').run(
      'default',
      '@team-alpha',
      '@alice'
    );
    db.prepare(
      'INSERT INTO team_members (tenant_id, team_name, member_name) VALUES (?, ?, ?)'
    ).run('default', '@team-alpha', '@bob');

    // DM (alice → bob)
    db.prepare(
      'INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)'
    ).run('default', MSG_DM, '@alice', '@bob', 'Hello Bob!');

    // ブロードキャスト (alice → @*)
    db.prepare(
      'INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)'
    ).run('default', MSG_BROADCAST, '@alice', '@*', 'Broadcast!');

    // チーム宛 (alice → team-alpha)
    db.prepare(
      'INSERT INTO messages (tenant_id, id, sender, recipient, body) VALUES (?, ?, ?, ?, ?)'
    ).run('default', MSG_TEAM, '@alice', '@team-alpha', 'Team announcement');
  });

  describe('正常系', () => {
    it('operator が他 participant の DM + ブロードキャスト未読を一括既読化できる', async () => {
      const result = await handleFlushMessages(
        scopeToTenant(db, 'default'),
        { participant: '@bob' },
        '@operator'
      );

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text as string);
      expect(response).toEqual({ cleared: 2 });

      const readIds = (
        db
          .prepare('SELECT message_id FROM read_receipts WHERE tenant_id = ? AND reader = ?')
          .all('default', '@bob') as { message_id: string }[]
      ).map((r) => r.message_id);
      expect(readIds).toContain(MSG_DM);
      expect(readIds).toContain(MSG_BROADCAST);
    });

    it('チーム宛メッセージは対象外（既読化されない）', async () => {
      await handleFlushMessages(scopeToTenant(db, 'default'), { participant: '@bob' }, '@operator');

      const receipt = db
        .prepare('SELECT * FROM read_receipts WHERE tenant_id = ? AND message_id = ? AND reader = ?')
        .get('default', MSG_TEAM, '@bob');
      expect(receipt).toBeUndefined();
    });

    it('対象未読 0 件の場合 { cleared: 0 } を返す（冪等）', async () => {
      await handleFlushMessages(scopeToTenant(db, 'default'), { participant: '@bob' }, '@operator');

      const result = await handleFlushMessages(
        scopeToTenant(db, 'default'),
        { participant: '@bob' },
        '@operator'
      );

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text as string);
      expect(response).toEqual({ cleared: 0 });
    });

    it('@ プレフィックスなしの participant 指定も受け付ける', async () => {
      const result = await handleFlushMessages(
        scopeToTenant(db, 'default'),
        { participant: 'bob' },
        '@operator'
      );

      expect(result.isError).toBeUndefined();
      const response = JSON.parse(result.content[0].text as string);
      expect(response).toEqual({ cleared: 2 });
    });
  });

  describe('権限チェック', () => {
    it('mode!=global の呼び出し元は拒否される', async () => {
      const result = await handleFlushMessages(
        scopeToTenant(db, 'default'),
        { participant: '@bob' },
        '@alice' // mode=null
      );

      expect(result.isError).toBe(true);
      const response = JSON.parse(result.content[0].text as string);
      expect(response.message).toContain('mode=global の peer のみ許可されています');

      // bob の未読は手付かず
      const receipts = db
        .prepare('SELECT * FROM read_receipts WHERE tenant_id = ? AND reader = ?')
        .all('default', '@bob');
      expect(receipts).toHaveLength(0);
    });
  });

  describe('異常系', () => {
    it('対象 participant が未登録の場合エラー', async () => {
      const result = await handleFlushMessages(
        scopeToTenant(db, 'default'),
        { participant: '@unknown' },
        '@operator'
      );

      expect(result.isError).toBe(true);
      const response = JSON.parse(result.content[0].text as string);
      expect(response.message).toContain('見つかりません');
    });

    it('participant が空文字の場合エラー', async () => {
      const result = await handleFlushMessages(
        scopeToTenant(db, 'default'),
        { participant: '' },
        '@operator'
      );

      expect(result.isError).toBe(true);
    });

    it('引数が不正な場合エラー', async () => {
      const result = await handleFlushMessages(
        scopeToTenant(db, 'default'),
        { wrong_field: 'value' },
        '@operator'
      );

      expect(result.isError).toBe(true);
      const response = JSON.parse(result.content[0].text as string);
      expect(response.error).toBe('flush_messages failed');
    });

    it('呼び出し元自体が未登録の場合エラー（mode 不一致とはメッセージを区別する、issue #349）', async () => {
      const result = await handleFlushMessages(
        scopeToTenant(db, 'default'),
        { participant: '@bob' },
        '@ghost'
      );

      expect(result.isError).toBe(true);
      const response = JSON.parse(result.content[0].text as string);
      expect(response.message).toContain('登録されていません');
      expect(response.message).not.toContain('mode=global');
    });
  });
});
