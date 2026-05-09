import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { handleUpdateTeam } from '../update_team.js';
import { handleCreateTeam } from '../create_team.js';
import { registerParticipant } from '../../../db/participants.js';
import { initDatabase } from '../../../db/migrations.js';

describe('update_team ツール', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);

    // テスト用参加者を登録
    registerParticipant(db, { name: 'alice', display_name: 'Alice' });
    registerParticipant(db, { name: 'bob', display_name: 'Bob' });
    registerParticipant(db, { name: 'carol', display_name: 'Carol' });
    registerParticipant(db, { name: 'dave', display_name: 'Dave' });

    // テスト用チームを作成
    handleCreateTeam(
      db,
      { name: 'team-alpha', members: ['bob'] },
      'alice'
    );
  });

  it('正常系: メンバーを追加できる', async () => {
    const result = await handleUpdateTeam(
      db,
      { name: 'team-alpha', add: ['carol'] },
      'alice'
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe('@team-alpha');
    expect(data.members).toContain('@carol');
  });

  it('正常系: メンバーを削除できる', async () => {
    const result = await handleUpdateTeam(
      db,
      { name: 'team-alpha', remove: ['bob'] },
      'alice'
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe('@team-alpha');
    expect(data.members).not.toContain('@bob');
    expect(data.members).toContain('@alice'); // オーナーは残る
  });

  it('正常系: 追加と削除を同時に実行できる', async () => {
    const result = await handleUpdateTeam(
      db,
      { name: 'team-alpha', add: ['carol', 'dave'], remove: ['bob'] },
      'alice'
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.members).toContain('@carol');
    expect(data.members).toContain('@dave');
    expect(data.members).not.toContain('@bob');
  });

  it('正常系: 冪等性 — 既にいるメンバーを追加しても変わらない', async () => {
    await handleUpdateTeam(
      db,
      { name: 'team-alpha', add: ['carol'] },
      'alice'
    );

    const result = await handleUpdateTeam(
      db,
      { name: 'team-alpha', add: ['carol'] },
      'alice'
    );

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.members.filter((m: string) => m === '@carol').length).toBe(1);
  });

  it('正常系: 冪等性 — いないメンバーを削除してもエラーにならない', async () => {
    const result = await handleUpdateTeam(
      db,
      { name: 'team-alpha', remove: ['dave'] },
      'alice'
    );

    expect(result.isError).toBeUndefined();
  });

  it('エラー: オーナー以外は更新できない', async () => {
    const result = await handleUpdateTeam(
      db,
      { name: 'team-alpha', add: ['carol'] },
      'bob'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('update_team failed');
    expect(data.message).toContain('オーナー');
  });

  it('エラー: オーナー自身は削除できない', async () => {
    const result = await handleUpdateTeam(
      db,
      { name: 'team-alpha', remove: ['alice'] },
      'alice'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('update_team failed');
    expect(data.message).toContain('削除できません');
  });

  it('エラー: オーナー自身は最後のメンバーでも削除できない', async () => {
    // bob を削除して alice (オーナー) だけにする
    await handleUpdateTeam(
      db,
      { name: 'team-alpha', remove: ['bob'] },
      'alice'
    );

    // alice (= オーナー自身) を削除しようとするとエラー
    const result = await handleUpdateTeam(
      db,
      { name: 'team-alpha', remove: ['alice'] },
      'alice'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('update_team failed');
    expect(data.message).toContain('オーナー');
  });

  it('エラー: 存在しないチームは更新できない', async () => {
    const result = await handleUpdateTeam(
      db,
      { name: 'nonexistent', add: ['carol'] },
      'alice'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('update_team failed');
    expect(data.message).toContain('存在しません');
  });

  it('エラー: 存在しない参加者を追加できない', async () => {
    const result = await handleUpdateTeam(
      db,
      { name: 'team-alpha', add: ['nonexistent'] },
      'alice'
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toBe('update_team failed');
    expect(data.message).toContain('登録されていません');
  });
});
