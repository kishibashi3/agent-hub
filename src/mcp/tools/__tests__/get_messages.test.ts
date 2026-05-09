import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../../db/migrations.js';
import { registerParticipant } from '../../../db/participants.js';
import { createTeam } from '../../../db/teams.js';
import { sendMessage } from '../../../db/messages.js';
import { handleGetMessages } from '../get_messages.js';

describe('get_messages ツール', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('正常系', () => {
    it('自分宛の未読 DM を取得できる', async () => {
      // 参加者登録
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });

      // alice → bob にメッセージ送信
      sendMessage(db, { to: 'bob', message: 'こんにちは' }, 'alice');

      // bob が未読メッセージを取得
      const result = await handleGetMessages(db, {}, 'bob');

      expect(result.isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const messages = JSON.parse(result.content[0].text);
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('@alice');
      expect(messages[0].to).toBe('@bob');
      expect(messages[0].message).toBe('こんにちは');
    });

    it('チーム宛の未読メッセージを取得できる', async () => {
      // 参加者登録
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });
      registerParticipant(db, { name: 'carol' });

      // チーム作成（alice がオーナー、bob と carol がメンバー）
      createTeam(db, { name: 'team-x', members: ['bob', 'carol'] }, 'alice');

      // alice → team-x にメッセージ送信
      sendMessage(db, { to: 'team-x', message: 'チーム全体への連絡' }, 'alice');

      // bob が未読メッセージを取得（チーム宛メッセージが含まれる）
      const result = await handleGetMessages(db, {}, 'bob');

      expect(result.isError).toBeUndefined();
      const messages = JSON.parse(result.content[0].text);
      expect(messages).toHaveLength(1);
      expect(messages[0].from).toBe('@alice');
      expect(messages[0].to).toBe('@team-x');
      expect(messages[0].message).toBe('チーム全体への連絡');
    });

    it('既読メッセージは取得されない', async () => {
      // 参加者登録
      registerParticipant(db, { name: 'alice' });
      registerParticipant(db, { name: 'bob' });

      // alice → bob にメッセージ送信
      const message = sendMessage(db, { to: 'bob', message: 'テスト' }, 'alice');

      // bob が既読にする
      db.prepare(
        'INSERT INTO read_receipts (message_id, reader, read_at) VALUES (?, ?, ?)'
      ).run(message.id, '@bob', new Date().toISOString());

      // bob が未読メッセージを取得（既読済みなので0件）
      const result = await handleGetMessages(db, {}, 'bob');

      expect(result.isError).toBeUndefined();
      const messages = JSON.parse(result.content[0].text);
      expect(messages).toHaveLength(0);
    });
  });

  describe('異常系', () => {
    it('未登録の参加者はエラーになる', async () => {
      //未登録の bob が未読メッセージを取得しようとする
      const result = await handleGetMessages(db, {}, 'bob');

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);

      const error = JSON.parse(result.content[0].text);
      expect(error.error).toBe('get_messages failed');
      expect(error.message).toContain('登録されていません');
    });
  });
});
