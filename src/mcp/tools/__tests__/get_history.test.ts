import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { scopeToTenant } from '../../../db/tenant-scope.js';
import { handleGetHistory } from '../get_history.js';
import { registerParticipant } from '../../../db/participants.js';
import { createTeam } from '../../../db/teams.js';
import { sendMessage } from '../../../db/messages.js';

describe('get_history ツール', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);
  });

  describe('正常系', () => {
    it('DM の履歴を取得できる', async () => {
      // 参加者登録
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });

      // メッセージ送信(双方向)
      sendMessage(db, 'default', { to: 'bob', message: 'Hello Bob' }, 'alice');
      sendMessage(db, 'default', { to: 'alice', message: 'Hi Alice' }, 'bob');
      sendMessage(db, 'default', { to: 'bob', message: 'How are you?' }, 'alice');

      // Alice が Bob との履歴を取得
      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'bob', limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);

      expect(response.to).toBe('@bob');
      expect(response.count).toBe(3);
      expect(response.messages).toHaveLength(3);
      expect(response.messages[0].from).toBe('@alice');
      expect(response.messages[0].message).toBe('How are you?'); // 降順
      expect(response.messages[2].from).toBe('@alice');
      expect(response.messages[2].message).toBe('Hello Bob');
    });

    it('チームの履歴を取得できる(メンバーのみ)', async () => {
      // 参加者登録
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });
      registerParticipant(db, 'default', { name: 'charlie' });

      // チーム作成
      createTeam(db, 'default', { name: 'dev-team', members: ['bob', 'charlie'] }, 'alice');

      // チームへメッセージ送信
      sendMessage(db, 'default', { to: 'dev-team', message: 'Meeting at 3pm' }, 'alice');
      sendMessage(db, 'default', { to: 'dev-team', message: 'Got it!' }, 'bob');

      // Bob(メンバー)がチーム履歴を取得
      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'dev-team', limit: 10 },
        'bob'
      );

      const response = JSON.parse(result.content[0].text);

      expect(response.to).toBe('@dev-team');
      expect(response.count).toBe(2);
      expect(response.messages).toHaveLength(2);
      expect(response.messages[0].to).toBe('@dev-team');
      expect(response.messages[1].to).toBe('@dev-team');
    });

    it('@ プレフィックス付きの名前でも取得できる', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });

      sendMessage(db, 'default', { to: 'bob', message: 'Test' }, 'alice');

      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: '@bob', limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.to).toBe('@bob');
      expect(response.count).toBe(1);
    });

    it('limit パラメータで取得件数を制限できる', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });

      // 5件送信
      for (let i = 1; i <= 5; i++) {
        sendMessage(db, 'default', { to: 'bob', message: `Message ${i}` }, 'alice');
      }

      // limit=2 で取得
      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'bob', limit: 2 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.count).toBe(2);
      expect(response.messages).toHaveLength(2);
      expect(response.messages[0].message).toBe('Message 5'); // 最新から2件
    });

    it('履歴がない場合は空配列を返す', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });

      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'bob', limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.count).toBe(0);
      expect(response.messages).toEqual([]);
    });
  });

  describe('異常系', () => {
    it('未登録のリクエスターはエラー', async () => {
      registerParticipant(db, 'default', { name: 'bob' });

      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'bob', limit: 10 },
        'unknown'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toContain('登録されていません');
    });

    it('存在しない宛先はエラー', async () => {
      registerParticipant(db, 'default', { name: 'alice' });

      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'nonexistent', limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toContain('存在しません');
    });

    it('チームのメンバーでない場合はエラー', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });
      registerParticipant(db, 'default', { name: 'outsider' });

      createTeam(db, 'default', { name: 'private-team', members: ['bob'] }, 'alice');

      // outsider(非メンバー)が履歴取得を試みる
      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'private-team', limit: 10 },
        'outsider'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toContain('メンバーのみ');
    });

    it('DM で当事者でない場合は空配列を返す', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });
      registerParticipant(db, 'default', { name: 'charlie' });

      sendMessage(db, 'default', { to: 'bob', message: 'Private message' }, 'alice');

      // Charlie が Alice-Bob の DM 履歴を取得しようとする
      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'bob', limit: 10 },
        'charlie'
      );

      const response = JSON.parse(result.content[0].text);
      // DM の場合、当事者以外は何も見えない(空配列)
      expect(response.count).toBe(0);
      expect(response.messages).toEqual([]);
    });

    it('不正な limit (負の数) はバリデーションエラー', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });

      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'bob', limit: -1 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toBeDefined();
    });

    it('to が空文字列の場合はバリデーションエラー', async () => {
      registerParticipant(db, 'default', { name: 'alice' });

      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: '', limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toBeDefined();
    });
  });

  // issue #37 filter parameter integration tests (= 設計 doc §7.2 準拠 3 件)
  describe('filter parameter (#37)', () => {
    it('MCP tool filter 経由で正しく filtered messages を返却', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });

      // 多様な body
      sendMessage(db, 'default', { to: 'bob', message: 'PR #34 estimate-first review' }, 'alice');
      sendMessage(db, 'default', { to: 'alice', message: '@reviewer に依頼済み' }, 'bob');
      sendMessage(db, 'default', { to: 'bob', message: 'PR #38 design doc landing' }, 'alice');

      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'bob', filter: '#34', limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);

      expect(response.count).toBe(1);
      expect(response.messages).toHaveLength(1);
      expect(response.messages[0].message).toBe('PR #34 estimate-first review');
    });

    it('不正 input (filter 非 string) → input schema validation error', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });

      sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');

      // filter に number を渡す (= z.string().optional() で validation error)
      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'bob', filter: 123 as unknown as string, limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toBeDefined();
    });

    it('filter applied 後 limit が正しく適用 (= filter で件数 > limit な場合)', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });

      // 5 件 estimate-first 関連 + 2 件 unrelated
      for (let i = 1; i <= 5; i++) {
        sendMessage(db, 'default', { to: 'bob', message: `estimate-first message ${i}` }, 'alice');
      }
      sendMessage(db, 'default', { to: 'bob', message: 'unrelated 1' }, 'alice');
      sendMessage(db, 'default', { to: 'bob', message: 'unrelated 2' }, 'alice');

      // filter で 5 件 candidate、 limit=2 で 2 件のみ返却
      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'bob', filter: 'estimate-first', limit: 2 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.count).toBe(2);
      expect(response.messages).toHaveLength(2);
      // 降順 (最新 estimate-first 2 件) - 5 件中の最新 2 件 = message 5 / 4
      expect(response.messages[0].message).toBe('estimate-first message 5');
      expect(response.messages[1].message).toBe('estimate-first message 4');
    });

    // 設計 doc §7.3 tenant isolation verify
    it('tenant isolation: tenant A の filter query が tenant B の messages を漏らさない', async () => {
      // tenant A セットアップ
      // (注: initDatabase は default tenant のみ自動 pre-create、 別 tenant は manual create が必要)
      db.prepare('INSERT INTO tenants (domain, owner) VALUES (?, ?)').run('tenant-a', null);
      db.prepare('INSERT INTO tenants (domain, owner) VALUES (?, ?)').run('tenant-b', null);

      // tenant A: alice / bob、 message body に "PR #34" 含む
      registerParticipant(db, 'tenant-a', { name: 'alice' });
      registerParticipant(db, 'tenant-a', { name: 'bob' });
      sendMessage(db, 'tenant-a', { to: 'bob', message: 'tenant A: PR #34 secret data' }, 'alice');

      // tenant B: alice (= 同名だが別 tenant) / charlie、 message body に同じ "PR #34" 含む
      registerParticipant(db, 'tenant-b', { name: 'alice' });
      registerParticipant(db, 'tenant-b', { name: 'charlie' });
      sendMessage(db, 'tenant-b', { to: 'charlie', message: 'tenant B: PR #34 separate data' }, 'alice');

      // tenant A の alice が filter で "PR #34" 検索
      const resultA = await handleGetHistory(
        scopeToTenant(db, 'tenant-a'),
        { to: 'bob', filter: 'PR #34', limit: 10 },
        'alice'
      );

      const responseA = JSON.parse(resultA.content[0].text);
      // tenant A の message のみ取得、 tenant B の同 keyword 含む message は漏れない
      expect(responseA.count).toBe(1);
      expect(responseA.messages[0].message).toBe('tenant A: PR #34 secret data');
      expect(responseA.messages[0].message).not.toContain('tenant B');
    });
  });

  describe('レスポンス形式の一貫性', () => {
    it('メッセージフィールドは get_messages と同じ構造を返す', async () => {
      registerParticipant(db, 'default', { name: 'alice' });
      registerParticipant(db, 'default', { name: 'bob' });

      sendMessage(db, 'default', { to: 'bob', message: 'Test message' }, 'alice');

      const result = await handleGetHistory(
        scopeToTenant(db, 'default'),
        { to: 'bob', limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      const msg = response.messages[0];

      // get_messages と同じフィールド名を使用
      expect(msg).toHaveProperty('id');
      expect(msg).toHaveProperty('from');
      expect(msg).toHaveProperty('to');
      expect(msg).toHaveProperty('message');
      expect(msg).toHaveProperty('timestamp');

      expect(msg.from).toBe('@alice');
      expect(msg.to).toBe('@bob');
      expect(msg.message).toBe('Test message');
    });
  });
});
