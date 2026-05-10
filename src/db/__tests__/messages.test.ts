import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  sendMessage,
  getMessage,
  getUnreadMessages,
  getHistory,
  markAsRead,
} from '../messages';
import type { SendMessageInput, GetHistoryInput } from '../../types/schema';

/**
 * テスト用の DB セットアップ
 */
function setupTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // スキーマを読み込んで実行
  const schemaPath = join(__dirname, '../schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  return db;
}

/**
 * テストデータのセットアップ
 */
function setupTestData(db: Database.Database) {
  // 参加者を登録
  db.prepare('INSERT INTO participants (tenant_id, name) VALUES (?, ?)').run('default', '@alice');
  db.prepare('INSERT INTO participants (tenant_id, name) VALUES (?, ?)').run('default', '@bob');
  db.prepare('INSERT INTO participants (tenant_id, name) VALUES (?, ?)').run('default', '@charlie');
  db.prepare('INSERT INTO participants (tenant_id, name) VALUES (?, ?)').run('default', '@dave');

  // チームを作成
  db.prepare('INSERT INTO teams (tenant_id, name, owner) VALUES (?, ?, ?)').run('default', '@team-alpha', '@alice');
  db.prepare('INSERT INTO team_members (tenant_id, team_name, member_name) VALUES (?, ?, ?)').run('default', '@team-alpha', '@alice');
  db.prepare('INSERT INTO team_members (tenant_id, team_name, member_name) VALUES (?, ?, ?)').run('default', '@team-alpha', '@bob');
  db.prepare('INSERT INTO team_members (tenant_id, team_name, member_name) VALUES (?, ?, ?)').run('default', '@team-alpha', '@charlie');
}

describe('messages.ts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
    setupTestData(db);
  });

  describe('sendMessage', () => {
    it('DM を送信できる', () => {
      const input: SendMessageInput = {
        to: 'bob',
        message: 'Hello Bob!',
      };

      const message = sendMessage(db, 'default', input, 'alice');

      expect(message).toBeDefined();
      expect(message.sender).toBe('@alice');
      expect(message.recipient).toBe('@bob');
      expect(message.body).toBe('Hello Bob!');
      expect(message.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('チームにメッセージを送信できる（メンバーのみ）', () => {
      const input: SendMessageInput = {
        to: 'team-alpha',
        message: 'Team announcement',
      };

      const message = sendMessage(db, 'default', input, 'alice');

      expect(message.recipient).toBe('@team-alpha');
      expect(message.body).toBe('Team announcement');
    });

    it('未登録の送信者はエラー', () => {
      const input: SendMessageInput = {
        to: 'bob',
        message: 'test',
      };

      expect(() => sendMessage(db, 'default', input, 'unknown')).toThrow(
        '送信者 @unknown は登録されていません'
      );
    });

    it('存在しない宛先はエラー', () => {
      const input: SendMessageInput = {
        to: 'unknown',
        message: 'test',
      };

      expect(() => sendMessage(db, 'default', input, 'alice')).toThrow(
        '宛先 @unknown は存在しません'
      );
    });

    it('チームの非メンバーは送信できない', () => {
      const input: SendMessageInput = {
        to: 'team-alpha',
        message: 'test',
      };

      expect(() => sendMessage(db, 'default', input, 'dave')).toThrow(
        'チーム @team-alpha に送信できるのはメンバーのみです'
      );
    });

    it('自分宛にメッセージは送信できない', () => {
      const input: SendMessageInput = {
        to: 'alice',
        message: 'test',
      };

      expect(() => sendMessage(db, 'default', input, 'alice')).toThrow(
        '自分宛にメッセージを送信することはできません'
      );
    });

    it('@ プレフィックスなしでも動作する', () => {
      const input: SendMessageInput = {
        to: 'bob',
        message: 'test',
      };

      const message = sendMessage(db, 'default', input, 'alice');
      expect(message.sender).toBe('@alice');
      expect(message.recipient).toBe('@bob');
    });
  });

  describe('getMessage', () => {
    it('送信者はメッセージを取得できる', () => {
      const sent = sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');

      const message = getMessage(db, 'default', sent.id, 'alice');

      expect(message.id).toBe(sent.id);
      expect(message.body).toBe('test');
    });

    it('受信者はメッセージを取得できる', () => {
      const sent = sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');

      const message = getMessage(db, 'default', sent.id, 'bob');

      expect(message.id).toBe(sent.id);
      expect(message.body).toBe('test');
    });

    it('チームメンバーはチーム宛メッセージを取得できる', () => {
      const sent = sendMessage(db, 'default', { to: 'team-alpha', message: 'test' }, 'alice');

      const message = getMessage(db, 'default', sent.id, 'charlie');

      expect(message.id).toBe(sent.id);
      expect(message.body).toBe('test');
    });

    it('無関係な参加者は取得できない', () => {
      const sent = sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');

      expect(() => getMessage(db, 'default', sent.id, 'charlie')).toThrow(
        `メッセージ ${sent.id} を閲覧する権限がありません`
      );
    });

    it('存在しないメッセージはエラー', () => {
      expect(() => getMessage(db, 'default', 'invalid-id', 'alice')).toThrow(
        'メッセージ invalid-id は存在しません'
      );
    });

    it('未登録ユーザーはエラー', () => {
      const sent = sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');

      expect(() => getMessage(db, 'default', sent.id, 'unknown')).toThrow(
        '@unknown は登録されていません'
      );
    });
  });

  describe('getUnreadMessages', () => {
    it('未読メッセージを取得できる', () => {
      // alice -> bob へ送信
      sendMessage(db, 'default', { to: 'bob', message: 'msg1' }, 'alice');
      sendMessage(db, 'default', { to: 'bob', message: 'msg2' }, 'alice');

      const unread = getUnreadMessages(db, 'default', 'bob');

      expect(unread).toHaveLength(2);
      expect(unread[0].body).toBe('msg1');
      expect(unread[1].body).toBe('msg2');
    });

    it('自分が送信したメッセージは含まれない', () => {
      // alice -> bob
      sendMessage(db, 'default', { to: 'bob', message: 'to bob' }, 'alice');
      // bob -> alice
      sendMessage(db, 'default', { to: 'alice', message: 'to alice' }, 'bob');

      const aliceUnread = getUnreadMessages(db, 'default', 'alice');

      expect(aliceUnread).toHaveLength(1);
      expect(aliceUnread[0].body).toBe('to alice');
      expect(aliceUnread[0].sender).toBe('@bob');
    });

    it('既読メッセージは含まれない', () => {
      const msg1 = sendMessage(db, 'default', { to: 'bob', message: 'msg1' }, 'alice');
      sendMessage(db, 'default', { to: 'bob', message: 'msg2' }, 'alice');

      // msg1 を既読にする
      markAsRead(db, 'default', msg1.id, 'bob');

      const unread = getUnreadMessages(db, 'default', 'bob');

      expect(unread).toHaveLength(1);
      expect(unread[0].body).toBe('msg2');
    });

    it('チーム宛のメッセージも含まれる', () => {
      // alice -> team-alpha
      sendMessage(db, 'default', { to: 'team-alpha', message: 'team msg' }, 'alice');

      const bobUnread = getUnreadMessages(db, 'default', 'bob');
      const charlieUnread = getUnreadMessages(db, 'default', 'charlie');

      // bob と charlie はメンバーなので受信
      expect(bobUnread).toHaveLength(1);
      expect(bobUnread[0].body).toBe('team msg');
      expect(charlieUnread).toHaveLength(1);

      // dave は非メンバーなので受信しない
      const daveUnread = getUnreadMessages(db, 'default', 'dave');
      expect(daveUnread).toHaveLength(0);
    });

    it('チーム宛メッセージの送信者自身には届かない', () => {
      // alice -> team-alpha
      sendMessage(db, 'default', { to: 'team-alpha', message: 'team msg' }, 'alice');

      const aliceUnread = getUnreadMessages(db, 'default', 'alice');

      // alice 自身には届かない
      expect(aliceUnread).toHaveLength(0);
    });

    it('未登録ユーザーはエラー', () => {
      expect(() => getUnreadMessages(db, 'default', 'unknown')).toThrow(
        '@unknown は登録されていません'
      );
    });

    it('未読がない場合は空配列', () => {
      const unread = getUnreadMessages(db, 'default', 'alice');
      expect(unread).toEqual([]);
    });
  });

  describe('getHistory', () => {
    it('DM の履歴を取得できる', () => {
      // 双方向の会話
      sendMessage(db, 'default', { to: 'bob', message: 'msg1' }, 'alice');
      sendMessage(db, 'default', { to: 'alice', message: 'msg2' }, 'bob');
      sendMessage(db, 'default', { to: 'bob', message: 'msg3' }, 'alice');

      const historyForAlice = getHistory(db, 'default', { to: 'bob', limit: 50 }, 'alice');
      const historyForBob = getHistory(db, 'default', { to: 'alice', limit: 50 }, 'bob');

      // どちらも同じ会話が見える
      expect(historyForAlice).toHaveLength(3);
      expect(historyForBob).toHaveLength(3);

      // 降順（新しい順）
      expect(historyForAlice[0].body).toBe('msg3');
      expect(historyForAlice[1].body).toBe('msg2');
      expect(historyForAlice[2].body).toBe('msg1');
    });

    it('チームの履歴を取得できる（メンバーのみ）', () => {
      sendMessage(db, 'default', { to: 'team-alpha', message: 'msg1' }, 'alice');
      sendMessage(db, 'default', { to: 'team-alpha', message: 'msg2' }, 'bob');

      const history = getHistory(db, 'default', { to: 'team-alpha', limit: 50 }, 'charlie');

      expect(history).toHaveLength(2);
      expect(history[0].body).toBe('msg2');
      expect(history[1].body).toBe('msg1');
    });

    it('limit で件数を制限できる', () => {
      for (let i = 0; i < 10; i++) {
        sendMessage(db, 'default', { to: 'bob', message: `msg${i}` }, 'alice');
      }

      const history = getHistory(db, 'default', { to: 'bob', limit: 5 }, 'alice');

      expect(history).toHaveLength(5);
    });

    it('チームの非メンバーは履歴を閲覧できない', () => {
      sendMessage(db, 'default', { to: 'team-alpha', message: 'test' }, 'alice');

      expect(() => getHistory(db, 'default', { to: 'team-alpha', limit: 50 }, 'dave')).toThrow(
        'チーム @team-alpha の履歴を閲覧できるのはメンバーのみです'
      );
    });

    it('存在しない宛先はエラー', () => {
      expect(() => getHistory(db, 'default', { to: 'unknown', limit: 50 }, 'alice')).toThrow(
        '宛先 @unknown は存在しません'
      );
    });

    it('未登録ユーザーはエラー', () => {
      expect(() => getHistory(db, 'default', { to: 'bob', limit: 50 }, 'unknown')).toThrow(
        '@unknown は登録されていません'
      );
    });

    it('履歴がない場合は空配列', () => {
      const history = getHistory(db, 'default', { to: 'bob', limit: 50 }, 'alice');
      expect(history).toEqual([]);
    });
  });

  describe('markAsRead', () => {
    it('DM を既読にできる', () => {
      const msg = sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');

      const result = markAsRead(db, 'default', msg.id, 'bob');

      expect(result).toEqual({ read: true });

      // 未読から消える
      const unread = getUnreadMessages(db, 'default', 'bob');
      expect(unread).toHaveLength(0);
    });

    it('チーム宛メッセージを既読にできる', () => {
      const msg = sendMessage(db, 'default', { to: 'team-alpha', message: 'test' }, 'alice');

      markAsRead(db, 'default', msg.id, 'bob');

      const bobUnread = getUnreadMessages(db, 'default', 'bob');
      const charlieUnread = getUnreadMessages(db, 'default', 'charlie');

      // bob は既読にしたので未読から消える
      expect(bobUnread).toHaveLength(0);

      // charlie はまだ未読
      expect(charlieUnread).toHaveLength(1);
    });

    it('重複した既読登録は無視される', () => {
      const msg = sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');

      markAsRead(db, 'default', msg.id, 'bob');
      markAsRead(db, 'default', msg.id, 'bob'); // 2回目

      // エラーにならない
      const receipts = db
        .prepare('SELECT * FROM read_receipts WHERE tenant_id = ? AND message_id = ?')
        .all('default', msg.id);

      expect(receipts).toHaveLength(1);
    });

    it('自分宛でないメッセージは既読にできない', () => {
      const msg = sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');

      expect(() => markAsRead(db, 'default', msg.id, 'charlie')).toThrow(
        `メッセージ ${msg.id} を既読にできるのは受信者のみです`
      );
    });

    it('存在しないメッセージはエラー', () => {
      expect(() => markAsRead(db, 'default', 'invalid-id', 'alice')).toThrow(
        'メッセージ invalid-id は存在しません'
      );
    });

    it('未登録ユーザーはエラー', () => {
      const msg = sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');

      expect(() => markAsRead(db, 'default', msg.id, 'unknown')).toThrow(
        '@unknown は登録されていません'
      );
    });
  });

  describe('エッジケース', () => {
    it('limit=1 でも動作する', () => {
      sendMessage(db, 'default', { to: 'bob', message: 'msg1' }, 'alice');
      sendMessage(db, 'default', { to: 'bob', message: 'msg2' }, 'alice');

      const history = getHistory(db, 'default', { to: 'bob', limit: 1 }, 'alice');

      expect(history).toHaveLength(1);
      expect(history[0].body).toBe('msg2'); // 最新
    });

    it('@ プレフィックスありでもなしでも同じ動作', () => {
      const msg1 = sendMessage(db, 'default', { to: '@bob', message: 'test1' }, '@alice');
      const msg2 = sendMessage(db, 'default', { to: 'bob', message: 'test2' }, 'alice');

      const unread = getUnreadMessages(db, 'default', '@bob');
      expect(unread).toHaveLength(2);

      markAsRead(db, 'default', msg1.id, 'bob');
      markAsRead(db, 'default', msg2.id, '@bob');

      const unreadAfter = getUnreadMessages(db, 'default', 'bob');
      expect(unreadAfter).toHaveLength(0);
    });

    it('空文字列のメッセージでもバリデーションは schema.ts 側で行う', () => {
      // messages.ts は DB 操作のみ。バリデーションは上位層の責務
      const input: SendMessageInput = {
        to: 'bob',
        message: '', // 空文字
      };

      // この層では通す（上位で Zod が弾く想定）
      const msg = sendMessage(db, 'default', input, 'alice');
      expect(msg.body).toBe('');
    });

    it('getMessage で @ プレフィックスなしでも動作する', () => {
      const sent = sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');

      const message = getMessage(db, 'default', sent.id, 'bob');

      expect(message.id).toBe(sent.id);
    });
  });
});
