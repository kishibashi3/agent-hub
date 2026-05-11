import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';
import { handleGetParticipants } from '../get_participants.js';
import { registerParticipant } from '../../../db/participants.js';

describe('get_participants ツール', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);
  });

  it('参加者がいない場合は空配列を返す', async () => {
    const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');

    expect(result.isError).toBeUndefined();
    const participants = JSON.parse(result.content[0].text);
    expect(participants).toEqual([]);
  });

  it('複数の参加者を取得できる', async () => {
    // 直接 DB に登録（register ツールを経由しないテスト）
    registerParticipant(db, 'default', { name: 'alice' });
    registerParticipant(db, 'default', { name: 'bob', display_name: 'ボブ' });
    registerParticipant(db, 'default', { name: 'charlie' });

    const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');
    expect(result.isError).toBeUndefined();

    const participants = JSON.parse(result.content[0].text);
    expect(participants).toHaveLength(3);

    // 作成日時の降順（最新が先）
    expect(participants[0].name).toBe('@charlie');
    expect(participants[1].name).toBe('@bob');
    expect(participants[1].display_name).toBe('ボブ');
    expect(participants[2].name).toBe('@alice');

    // 全員 type: person
    participants.forEach((p: any) => {
      expect(p.type).toBe('person');
    });
  });

  it('display_name が null の場合も正しく返す', async () => {
    registerParticipant(db, 'default', { name: 'alice' });

    const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');
    const participants = JSON.parse(result.content[0].text);

    expect(participants[0].display_name).toBeNull();
  });

  it('isOnline コールバック未指定なら全員 is_online: false (後方互換)', async () => {
    // issue #1: 既存呼び出しコード (callback 渡さない) を壊さないこと。
    registerParticipant(db, 'default', { name: 'alice' });
    registerParticipant(db, 'default', { name: 'bob' });

    const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'system');
    const participants = JSON.parse(result.content[0].text);

    expect(participants).toHaveLength(2);
    participants.forEach((p: any) => {
      expect(p.is_online).toBe(false);
    });
  });

  it('isOnline コールバックの結果が is_online フィールドに反映される', async () => {
    // issue #1: server.ts 側で sessions Map から組み立てた closure を渡される。
    registerParticipant(db, 'default', { name: 'alice' });
    registerParticipant(db, 'default', { name: 'bob' });
    registerParticipant(db, 'default', { name: 'charlie' });

    // @alice だけ online、他は offline と判定するモック
    const isOnline = (handle: string) => handle === '@alice';

    const result = await handleGetParticipants(
      scopeToTenant(db, 'default'),
      {},
      'system',
      isOnline
    );
    const participants = JSON.parse(result.content[0].text);

    const byName = Object.fromEntries(
      participants.map((p: any) => [p.name, p])
    );
    expect(byName['@alice'].is_online).toBe(true);
    expect(byName['@bob'].is_online).toBe(false);
    expect(byName['@charlie'].is_online).toBe(false);
  });
});
