import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';
import { handleRegister, inferModeFromClientType } from '../register.js';
import { handleGetParticipants } from '../get_participants.js';

describe('inferModeFromClientType', () => {
  it('agent-hub-plugin/<handle> → global', () => {
    expect(inferModeFromClientType('agent-hub-plugin/ope-ultp1635')).toBe('global');
  });

  it('agent-hub-bridge/<type> → stateful', () => {
    expect(inferModeFromClientType('agent-hub-bridge/claude')).toBe('stateful');
    expect(inferModeFromClientType('agent-hub-bridge/gemini')).toBe('stateful');
  });

  it('agent-hub-client/<type> → stateless', () => {
    expect(inferModeFromClientType('agent-hub-client/python')).toBe('stateless');
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

  it('unknown value → null', () => {
    expect(inferModeFromClientType('some-unknown-client')).toBeNull();
  });
});

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

    it('X-Agent-Hub-Client: agent-hub-bridge/claude で mode=stateful が設定される', async () => {
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'bridge' },
        '@bridge',
        'bridge-gh',
        'agent-hub-bridge/claude'
      );

      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.mode).toBe('stateful');
    });

    it('X-Agent-Hub-Client: agent-hub-plugin/ope で mode=global が設定される', async () => {
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'ope' },
        '@ope',
        'ope-gh',
        'agent-hub-plugin/ope'
      );

      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.mode).toBe('global');
    });

    it('clientType なし（後方互換）で mode=null のまま', async () => {
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'legacy' },
        '@legacy',
        'legacy-gh'
      );

      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.mode).toBeNull();
    });

    it('re-register で mode が clientType から更新される', async () => {
      // 初回: ヘッダーなし → mode=null
      await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'worker' },
        '@worker',
        'worker-gh'
      );

      // 再登録: bridge ヘッダー付き → mode=stateful
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'worker' },
        '@worker',
        'worker-gh',
        'agent-hub-bridge/claude'
      );

      expect(result.isError).toBeUndefined();
      const content = JSON.parse(result.content[0].text);
      expect(content.mode).toBe('stateful');
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

  describe('is_online 警告 (issue #273)', () => {
    it('handle が is_online=true のとき warning フィールドが付く', async () => {
      // 先に alice を登録
      await handleRegister(scopeToTenant(db, 'default'), { name: 'alice' }, 'alice', 'alice-gh');

      // isOnline が true を返す状態で再 register
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'alice' },
        'alice',
        'alice-gh',
        () => true // is_online=true をシミュレート
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.name).toBe('@alice');
      expect(body.warning).toBe('handle_already_online');
      expect(body.warning_message).toContain('@alice');
    });

    it('handle が is_online=false のとき warning フィールドは付かない', async () => {
      await handleRegister(scopeToTenant(db, 'default'), { name: 'alice' }, 'alice', 'alice-gh');

      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'alice' },
        'alice',
        'alice-gh',
        () => false
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.warning).toBeUndefined();
    });

    it('新規登録時も is_online=true なら warning が付く', async () => {
      // 新規ハンドル bob を is_online=true 状態で登録（理論上 SSE 在席中で同時起動）
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'bob' },
        'bob',
        'bob-gh',
        (h) => h === '@bob'
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.warning).toBe('handle_already_online');
    });

    it('isOnline コールバック省略時は warning なし（後方互換）', async () => {
      await handleRegister(scopeToTenant(db, 'default'), { name: 'alice' }, 'alice', 'alice-gh');

      // 5引数目を渡さない（既存の呼び出し方）
      const result = await handleRegister(
        scopeToTenant(db, 'default'),
        { name: 'alice' },
        'alice',
        'alice-gh'
      );

      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.warning).toBeUndefined();
    });
  });
});
