import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
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
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });

      // メッセージ送信（双方向）
      sendMessage(db, { to: 'bob', message: 'Hello Bob' }, 'alice');
      sendMessage(db, { to: 'alice', message: 'Hi Alice' }, 'bob');
      sendMessage(db, { to: 'bob', message: 'How are you?' }, 'alice');

      // Alice が Bob との履歴を取得
      const result = await handleGetHistory(
        db,
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

    it('チームの履歴を取得できる（メンバーのみ）', async () => {
      // 参加者登録
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });
      registerParticipant(db, { name: 'charlie' });

      // チーム作成
      createTeam(db, { name: 'dev-team', members: ['bob', 'charlie'] }, 'alice');

      // チームへメッセージ送信
      sendMessage(db, { to: 'dev-team', message: 'Meeting at 3pm' }, 'alice');
      sendMessage(db, { to: 'dev-team', message: 'Got it!' }, 'bob');

      // Bob（メンバー）がチーム履歴を取得
      const result = await handleGetHistory(
        db,
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
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });

      sendMessage(db, { to: 'bob', message: 'Test' }, 'alice');

      const result = await handleGetHistory(
        db,
        { to: '@bob', limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.to).toBe('@bob');
      expect(response.count).toBe(1);
    });

    it('limit パラメータで取得件数を制限できる', async () => {
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });

      // 5件送信
      for (let i = 1; i <= 5; i++) {
        sendMessage(db, { to: 'bob', message: `Message ${i}` }, 'alice');
      }

      // limit=2 で取得
      const result = await handleGetHistory(
        db,
        { to: 'bob', limit: 2 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.count).toBe(2);
      expect(response.messages).toHaveLength(2);
      expect(response.messages[0].message).toBe('Message 5'); // 最新から2件
    });

    it('履歴がない場合は空配列を返す', async () => {
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });

      const result = await handleGetHistory(
        db,
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
      registerParticipant(db, { name: 'bob' });

      const result = await handleGetHistory(
        db,
        { to: 'bob', limit: 10 },
        'unknown'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toContain('登録されていません');
    });

    it('存在しない宛先はエラー', async () => {
      registerParticipant(db, { name: 'alice' });

      const result = await handleGetHistory(
        db,
        { to: 'nonexistent', limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toContain('存在しません');
    });

    it('チームのメンバーでない場合はエラー', async () => {
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });
      registerParticipant(db, { name: 'outsider' });

      createTeam(db, { name: 'private-team', members: ['bob'] }, 'alice');

      // outsider（非メンバー）が履歴取得を試みる
      const result = await handleGetHistory(
        db,
        { to: 'private-team', limit: 10 },
        'outsider'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toContain('メンバーのみ');
    });

    it('DM で当事者でない場合は空配列を返す', async () => {
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });
      registerParticipant(db, { name: 'charlie' });

      sendMessage(db, { to: 'bob', message: 'Private message' }, 'alice');

      // Charlie が Alice-Bob の DM 履歴を取得しようとする
      const result = await handleGetHistory(
        db,
        { to: 'bob', limit: 10 },
        'charlie'
      );

      const response = JSON.parse(result.content[0].text);
      // DM の場合、当事者以外は何も見えない（空配列）
      expect(response.count).toBe(0);
      expect(response.messages).toEqual([]);
    });

    it('不正な limit（負の数）はバリデーションエラー', async () => {
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });

      const result = await handleGetHistory(
        db,
        { to: 'bob', limit: -1 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toBeDefined();
    });

    it('to が空文字列の場合はバリデーションエラー', async () => {
      registerParticipant(db, { name: 'alice' });

      const result = await handleGetHistory(
        db,
        { to: '', limit: 10 },
        'alice'
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.error).toBeDefined();
    });
  });

  describe('レスポンス形式の一貫性', () => {
    it('メッセージフィールドは get_messages と同じ構造を返す', async () => {
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });

      sendMessage(db, { to: 'bob', message: 'Test message' }, 'alice');

      const result = await handleGetHistory(
        db,
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
