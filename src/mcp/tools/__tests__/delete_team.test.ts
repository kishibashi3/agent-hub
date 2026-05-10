import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handleDeleteTeam } from '../delete_team.js';
import { handleCreateTeam } from '../create_team.js';
import { registerParticipant } from '../../../db/participants.js';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';

describe('delete_team ツール', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);

    // テスト用参加者を登録
    registerParticipant(db, 'default', { name: 'alice', display_name: 'Alice' });
    registerParticipant(db, 'default', { name: 'bob', display_name: 'Bob' });
    registerParticipant(db, 'default', { name: 'carol', display_name: 'Carol' });

    // テスト用チームを作成
    handleCreateTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-alpha', members: ['bob', 'carol'] },
      'alice'
    );
  });

  it('正常系: チームを削除できる', async () => {
    const result = await handleDeleteTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-alpha' },
      'alice'
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.deleted).toBe(true);

    // teams テーブルから削除されている
    const team = db
      .prepare('SELECT name FROM teams WHERE tenant_id = ? AND name = ?')
      .get('default', '@team-alpha');
    expect(team).toBeUndefined();

    // team_members テーブルからも削除されている（CASCADE）
    const members = db
      .prepare('SELECT * FROM team_members WHERE tenant_id = ? AND team_name = ?')
      .all('default', '@team-alpha');
    expect(members.length).toBe(0);
  });

  it('正常系: @ プレフィックスは自動付与される', async () => {
    const result = await handleDeleteTeam(
      scopeToTenant(db, 'default'),
      { name: '@team-alpha' },
      '@alice'
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.deleted).toBe(true);
  });

  it('エラー: オーナー以外は削除できない', async () => {
    const result = await handleDeleteTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-alpha' },
      'bob'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('delete_team failed');
    expect(data.message).toContain('オーナー');
  });

  it('エラー: 存在しないチームは削除できない', async () => {
    const result = await handleDeleteTeam(
      scopeToTenant(db, 'default'),
      { name: 'nonexistent' },
      'alice'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('delete_team failed');
    expect(data.message).toContain('存在しません');
  });

  it('エラー: バリデーションエラー（name が空）', async () => {
    const result = await handleDeleteTeam(
      scopeToTenant(db, 'default'),
      { name: '' },
      'alice'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('delete_team failed');
  });

  it('正常系: メッセージは削除されずに残る', async () => {
    // チーム宛にメッセージを送信
    db.prepare(
      `INSERT INTO messages (tenant_id, id, sender, recipient, body, created_at)
       VALUES (?, 'msg_001', '@alice', '@team-alpha', 'test message', datetime('now'))`
    ).run('default');

    // チームを削除
    await handleDeleteTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-alpha' },
      'alice'
    );

    // メッセージは残っている
    const message = db
      .prepare('SELECT * FROM messages WHERE tenant_id = ? AND id = ?')
      .get('default', 'msg_001');
    expect(message).toBeDefined();
  });
});
