import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';
import { handleRegister, inferModeFromClientType } from '../register.js';
import { handleGetParticipants } from '../get_participants.js';

describe('register ツール', () => {
  let db: Database.Database;

  beforeEach(async () => {
    // インメモリ DB で初期化
    db = new Database(':memory:');
    initDatabase(db);
    // bootstrap: 他テストが @admin 不在エラーで弾かれないよう先に admin を作る
    await handleRegister(scopeToTenant(db, 'default'), { name: 'admin' }, 'admin', 'kishibashi');
  });

  describe('正常系', () => {
    it('name のみで登録できる', async () => {
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'alice' },
        'alice', // X-User-Id
        'alice-gh'
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
        scopeToTenant(db, 'default'),
        { name: 'bob', display_name: 'ボブ' },
        'bob',
        'bob-gh'
      );

      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.name).toBe('@bob');
      expect(content.display_name).toBe('ボブ');
    });

    it('登録後に get_participants で取得できる', async () => {
      // 複数登録
      await handleRegister(scopeToTenant(db, 'default'), { name: 'alice' }, 'alice', 'alice-gh');
      await handleRegister(scopeToTenant(db, 'default'), { name: 'bob', display_name: 'ボブ' }, 'bob', 'bob-gh');

      // 取得
      const result = await handleGetParticipants(scopeToTenant(db, 'default'), {}, 'alice');
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

      const result = await handleRegister(scopeToTenant(freshDb, 'default'), { name: 'alice' }, 'alice', 'someone');
      expect(result.isError).toBe(true);

      const error = JSON.parse(result.content[0].text);
      expect(error.error).toBe('hub_not_initialized');
      expect(error.message).toContain('agent-hub is not initialized');
      expect(error.message).toContain('first registrant must claim the @admin handle');

      // インメモリ DB はテストフレームワークが自動クリーンアップするため close 不要
    });

    it('他人が claim 済みのハンドルは登録できない', async () => {
      // 1回目: kishibashi が alice を claim
      const first = await handleRegister(scopeToTenant(db, 'default'), { name: 'alice' }, 'alice', 'kishibashi');
      expect(first.isError).toBeUndefined();

      // 2回目: 別ユーザー (someone-else) が同じハンドルを取ろうとする → 拒否
      const second = await handleRegister(scopeToTenant(db, 'default'), { name: 'alice' }, 'alice', 'someone-else');
      expect(second.isError).toBe(true);

      const error = JSON.parse(second.content[0].text);
      expect(error.error).toBe('register failed');
      expect(error.message).toContain('他のユーザー所有');
    });

    it('空文字列は拒否される', async () => {
      const result = await handleRegister(scopeToTenant(db, 'default'), { name: '' }, '', 'someone');
      expect(result.isError).toBe(true);

      const error = JSON.parse(result.content[0].text);
      expect(error.error).toBe('register failed');
    });

    it('不正文字（スペース）は拒否される', async () => {
      const result = await handleRegister(scopeToTenant(db, 'default'), { name: 'alice bob' }, 'alice bob', 'someone');
      expect(result.isError).toBe(true);

      const error = JSON.parse(result.content[0].text);
      expect(error.message).toContain('英数字とハイフンのみ');
    });

    it('不正文字（@）は拒否される', async () => {
      const result = await handleRegister(scopeToTenant(db, 'default'), { name: '@alice' }, '@alice', 'someone');
      expect(result.isError).toBe(true);

      const error = JSON.parse(result.content[0].text);
      expect(error.message).toContain('英数字とハイフンのみ');
    });

    // 旧仕様の「X-User-Id と name が一致しない場合は拒否」はオーナー制ベースに
    // 移行したため削除（auth 層で hostname → handle のマッピングが行われる）。

    it('X-User-Id が @ 付きでも正規化して検証される', async () => {
      // @ 付き userId でも正規化されて検証される
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'alice' },
        '@alice', // @ 付き
        'alice-gh'
      );

      // 成功すべき
      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.name).toBe('@alice');
    });
  });

  describe('inferModeFromClientType (issue #276 案A)', () => {
    it('agent-hub-plugin/* → global', () => {
      expect(inferModeFromClientType('agent-hub-plugin/ope-ultp1635')).toBe('global');
      expect(inferModeFromClientType('agent-hub-plugin')).toBe('global');
    });

    it('agent-hub-bridge/* → stateful', () => {
      expect(inferModeFromClientType('agent-hub-bridge/claude')).toBe('stateful');
      expect(inferModeFromClientType('agent-hub-bridge/gemini')).toBe('stateful');
    });

    it('agent-hub-client/* → stateless', () => {
      expect(inferModeFromClientType('agent-hub-client/litellm')).toBe('stateless');
    });

    it('agent-hub-dashboard2 → global', () => {
      expect(inferModeFromClientType('agent-hub-dashboard2')).toBe('global');
    });

    it('agenthubctl → global', () => {
      expect(inferModeFromClientType('agenthubctl')).toBe('global');
    });

    it('null → null', () => {
      expect(inferModeFromClientType(null)).toBeNull();
    });

    it('未知のクライアント → null', () => {
      expect(inferModeFromClientType('some-unknown-client/1.0')).toBeNull();
    });

    it('大文字小文字を無視する', () => {
      expect(inferModeFromClientType('Agent-Hub-Bridge/Claude')).toBe('stateful');
    });
  });

  describe('clientType による mode 自動設定 (issue #276)', () => {
    it('clientType=agent-hub-bridge で register すると mode=stateful が返る', async () => {
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'bridge1' },
        'bridge1',
        'bridge1-gh',
        'agent-hub-bridge/claude'
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.mode).toBe('stateful');
    });

    it('clientType=agent-hub-plugin で register すると mode=global が返る', async () => {
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'pluginuser' },
        'pluginuser',
        'pluginuser-gh',
        'agent-hub-plugin/ope-ultp1635'
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.mode).toBe('global');
    });

    it('clientType=null なら mode=null（後方互換）', async () => {
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'legacyclient' },
        'legacyclient',
        'legacyclient-gh',
        null
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.mode).toBeNull();
    });

    it('re-register で clientType が変わると mode が更新される', async () => {
      // 初回: bridge として登録
      await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'actor' },
        'actor',
        'actor-gh',
        'agent-hub-bridge/claude'
      );

      // 再登録: plugin として接続し直す → mode が global に変わる
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'actor' },
        'actor',
        'actor-gh',
        'agent-hub-plugin/actor'
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.mode).toBe('global');
    });

    it('mode 引数を渡してもスキーマに mode フィールドがないため無視される', async () => {
      // mode フィールドを含む args を渡す（旧クライアントからの互換テスト）
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'oldclient', mode: 'global' } as unknown as Record<string, string>,
        'oldclient',
        'oldclient-gh',
        null
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      // mode は null（スキーマに mode がないので clientType=null → null）
      expect(body.mode).toBeNull();
    });
  });
});
