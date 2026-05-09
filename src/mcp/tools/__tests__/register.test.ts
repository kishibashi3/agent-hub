import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { handleRegister } from '../register.js';
import { handleGetParticipants } from '../get_participants.js';

describe('register ツール', () => {
  let db: Database.Database;

  beforeEach(async () => {
    // インメモリ DB で初期化
    db = new Database(':memory:');
    initDatabase(db);
    // bootstrap: 他テストが @admin 不在エラーで弾かれないよう先に admin を作る
    await handleRegister(db, { name: 'admin' }, 'admin', 'kishibashi');
  });

  describe('正常系', () => {
    it('name のみで登録できる', async () => {
      const result = await handleRegister(
        db,
        { name: 'alice' },
        'alice' // X-User-Id
      );

      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.name).toBe('@alice');
      expect(content.type).toBe('person');
      expect(content.display_name).toBeNull();
      expect(content.created_at).toBeDefined();
    });

    it('name + display_name で登録できる', async () => {
      const result = await handleRegister(
        db,
        { name: 'bob', display_name: 'ボブ' },
        'bob'
      );

      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.name).toBe('@bob');
      expect(content.display_name).toBe('ボブ');
    });

    it('登録後に get_participants で取得できる', async () => {
      // 複数登録
      await handleRegister(db, { name: 'alice' }, 'alice');
      await handleRegister(db, { name: 'bob', display_name: 'ボブ' }, 'bob');

      // 取得
      const result = await handleGetParticipants(db, {}, 'alice');
      expect(result.isError).toBeUndefined();

      const participants = JSON.parse(result.content[0].text);
      // beforeEach の bootstrap で @admin、その後 alice / bob を追加
      expect(participants).toHaveLength(3);

      // 作成日時の降順なので bob → alice → admin
      expect(participants[0].name).toBe('@bob');
      expect(participants[0].type).toBe('person');
      expect(participants[0].display_name).toBe('ボブ');

      expect(participants[1].name).toBe('@alice');
      expect(participants[1].display_name).toBeNull();
    });
  });

  describe('異常系', () => {
    it('@admin 不在時は admin 以外の登録が拒否される (hub_not_initialized)', async () => {
      // 既存テストの DB とは独立した新規 DB を作成
      const freshDb = new Database(':memory:');
      initDatabase(freshDb);
      // @admin を登録せず、空の状態で alice の登録を試みる

      const result = await handleRegister(freshDb, { name: 'alice' }, 'alice', 'someone');
      expect(result.isError).toBe(true);

      const error = JSON.parse(result.content[0].text);
      expect(error.error).toBe('hub_not_initialized');
      expect(error.message).toContain('agent-hub is not initialized');
      expect(error.message).toContain('first registrant must claim the @admin handle');

      // インメモリ DB はテストフレームワークが自動クリーンアップするため close 不要
    });

    it('他人が claim 済みのハンドルは登録できない', async () => {
      // 1回目: kishibashi が alice を claim
      const first = await handleRegister(db, { name: 'alice' }, 'alice', 'kishibashi');
      expect(first.isError).toBeUndefined();

      // 2回目: 別ユーザー (someone-else) が同じハンドルを取ろうとする → 拒否
      const second = await handleRegister(db, { name: 'alice' }, 'alice', 'someone-else');
      expect(second.isError).toBe(true);

      const error = JSON.parse(second.content[0].text);
      expect(error.error).toBe('register failed');
      expect(error.message).toContain('他のユーザー所有');
    });

    it('空文字列は拒否される', async () => {
      const result = await handleRegister(db, { name: '' }, '');
      expect(result.isError).toBe(true);

      const error = JSON.parse(result.content[0].text);
      expect(error.error).toBe('register failed');
    });

    it('不正文字（スペース）は拒否される', async () => {
      const result = await handleRegister(db, { name: 'alice bob' }, 'alice bob');
      expect(result.isError).toBe(true);

      const error = JSON.parse(result.content[0].text);
      expect(error.message).toContain('英数字とハイフンのみ');
    });

    it('不正文字（@）は拒否される', async () => {
      const result = await handleRegister(db, { name: '@alice' }, '@alice');
      expect(result.isError).toBe(true);

      const error = JSON.parse(result.content[0].text);
      expect(error.message).toContain('英数字とハイフンのみ');
    });

    // 旧仕様の「X-User-Id と name が一致しない場合は拒否」はオーナー制ベースに
    // 移行したため削除（auth 層で hostname → handle のマッピングが行われる）。

    it('X-User-Id が @ 付きでも正規化して検証される', async () => {
      // @ 付き userId でも正規化されて検証される
      const result = await handleRegister(
        db,
        { name: 'alice' },
        '@alice' // @ 付き
      );

      // 成功すべき
      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.name).toBe('@alice');
    });
  });
});
