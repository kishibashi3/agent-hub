import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handleCreateTeam } from '../create_team.js';
import { registerParticipant } from '../../../db/participants.js';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';

describe('create_team ツール', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);

    // テスト用参加者を登録
    registerParticipant(db, 'default', { name: 'alice', display_name: 'Alice' });
    registerParticipant(db, 'default', { name: 'bob', display_name: 'Bob' });
    registerParticipant(db, 'default', { name: 'carol', display_name: 'Carol' });
  });

  it('正常系: チームを作成できる', async () => {
    const result = await handleCreateTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-alpha', members: ['bob', 'carol'] },
      'alice'
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe('@team-alpha');
    expect(data.owner).toBe('@alice');
    expect(data.members).toContain('@alice'); // オーナーは自動追加
    expect(data.members).toContain('@bob');
    expect(data.members).toContain('@carol');
  });

  it('正常系: members に自分を含めなくても自動追加される', async () => {
    const result = await handleCreateTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-beta', members: ['bob'] },
      'alice'
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.members).toContain('@alice');
  });

  it('正常系: @ プレフィックスは自動付与される', async () => {
    const result = await handleCreateTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-gamma', members: ['@bob', 'carol'] },
      '@alice'
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe('@team-gamma');
    expect(data.members).toContain('@bob');
    expect(data.members).toContain('@carol');
  });

  it('エラー: 登録されていない参加者はチームを作成できない', async () => {
    const result = await handleCreateTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-delta', members: ['bob'] },
      'unknown'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('create_team failed');
    expect(data.message).toContain('登録されていません');
  });

  it('エラー: 存在しないメンバーを含むチームは作成できない', async () => {
    const result = await handleCreateTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-epsilon', members: ['bob', 'nonexistent'] },
      'alice'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('create_team failed');
    expect(data.message).toContain('登録されていません');
  });

  it('エラー: 同名のチームは作成できない', async () => {
    await handleCreateTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-zeta', members: ['bob'] },
      'alice'
    );

    const result = await handleCreateTeam(
      scopeToTenant(db, 'default'),
      { name: 'team-zeta', members: ['carol'] },
      'bob'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('create_team failed');
    expect(data.message).toContain('既に存在します');
  });

  it('エラー: バリデーションエラー（name が空）', async () => {
    const result = await handleCreateTeam(
      scopeToTenant(db, 'default'),
      { name: '', members: ['bob'] },
      'alice'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('create_team failed');
  });
});
