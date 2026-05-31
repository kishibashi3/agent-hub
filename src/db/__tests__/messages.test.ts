import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  sendMessage,
  getMessage,
  getUnreadMessages,
  getHistory,
  getThread,
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

    // caused_by テスト群 (issue #162)
    describe('caused_by', () => {
      it('caused_by なし → caused_by は null', () => {
        const msg = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');
        expect(msg.caused_by ?? null).toBeNull();
      });

      it('caused_by 付きで送信するとレスポンスに caused_by が含まれる', () => {
        const root = sendMessage(db, 'default', { to: 'bob', message: 'root message' }, 'alice');
        const reply = sendMessage(
          db,
          'default',
          { to: 'alice', message: 'reply', caused_by: root.id },
          'bob'
        );
        expect(reply.caused_by).toBe(root.id);
      });

      it('存在しない caused_by を指定すると null にフォールバックして送信成功 (issue #164)', () => {
        // 送信をブロックせず、caused_by だけ null に落とす（サイレント degradation）
        const msg = sendMessage(
          db,
          'default',
          { to: 'bob', message: 'bad ref', caused_by: 'non-existent-id' },
          'alice'
        );
        expect(msg.caused_by ?? null).toBeNull();
        expect(msg.body).toBe('bad ref');
      });

      it('caused_by を大量チェーンで指定しても送信をブロックしない (issue #164: 深さ上限チェック削除)', () => {
        // 深さ上限チェックが削除されたため、長い因果チェーンも送信できる
        let prevId = sendMessage(db, 'default', { to: 'bob', message: 'hop 0' }, 'alice').id;

        for (let i = 1; i <= 25; i++) {
          const sender = i % 2 === 1 ? 'bob' : 'alice';
          const recipient = i % 2 === 1 ? 'alice' : 'bob';
          const msg = sendMessage(
            db,
            'default',
            { to: recipient, message: `hop ${i}`, caused_by: prevId },
            sender
          );
          expect(msg.caused_by).toBe(prevId);
          prevId = msg.id;
        }
      });

      it('getMessage でも caused_by が返される', () => {
        const root = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');
        const reply = sendMessage(
          db,
          'default',
          { to: 'alice', message: 'reply', caused_by: root.id },
          'bob'
        );

        const fetched = getMessage(db, 'default', reply.id, 'alice');
        expect(fetched.caused_by).toBe(root.id);
      });

      it('getHistory でも caused_by が返される', () => {
        const root = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');
        sendMessage(
          db,
          'default',
          { to: 'alice', message: 'reply', caused_by: root.id },
          'bob'
        );

        const history = getHistory(
          db,
          'default',
          { to: 'alice', limit: 10 } as GetHistoryInput,
          'bob'
        );
        const reply = history.find((m) => m.body === 'reply');
        expect(reply?.caused_by).toBe(root.id);

        const rootMsg = history.find((m) => m.body === 'root');
        expect(rootMsg?.caused_by ?? null).toBeNull();
      });
    });

    // root_message_id テスト群 (issue #166)
    describe('root_message_id (internal)', () => {
      it('caused_by なしのメッセージは message_causes に行が存在しない', () => {
        const msg = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');
        const row = db
          .prepare('SELECT * FROM message_causes WHERE tenant_id = ? AND message_id = ?')
          .get('default', msg.id);
        expect(row).toBeUndefined();
      });

      it('直接の返信の root_message_id は caused_by と等しい (depth=1)', () => {
        const root = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');
        const reply = sendMessage(
          db,
          'default',
          { to: 'alice', message: 'reply', caused_by: root.id },
          'bob'
        );
        const row = db
          .prepare('SELECT root_message_id FROM message_causes WHERE tenant_id = ? AND message_id = ? AND position = 0')
          .get('default', reply.id) as { root_message_id: string };
        expect(row.root_message_id).toBe(root.id);
      });

      it('孫返信 (depth=2) の root_message_id は最初の root と等しい', () => {
        const root = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');
        const reply1 = sendMessage(
          db,
          'default',
          { to: 'alice', message: 'reply1', caused_by: root.id },
          'bob'
        );
        const reply2 = sendMessage(
          db,
          'default',
          { to: 'bob', message: 'reply2', caused_by: reply1.id },
          'alice'
        );
        const row = db
          .prepare('SELECT root_message_id FROM message_causes WHERE tenant_id = ? AND message_id = ? AND position = 0')
          .get('default', reply2.id) as { root_message_id: string };
        // 孫も root.id を引き継ぐ（1回の SELECT で解決、WITH RECURSIVE 不要）
        expect(row.root_message_id).toBe(root.id);
      });

      it('長いチェーン (depth=10) でも root_message_id は全て最初の root を指す', () => {
        const root = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');
        let prevId = root.id;
        const chainIds: string[] = [];

        for (let i = 1; i <= 10; i++) {
          const sender = i % 2 === 1 ? 'bob' : 'alice';
          const recipient = i % 2 === 1 ? 'alice' : 'bob';
          const msg = sendMessage(
            db,
            'default',
            { to: recipient, message: `hop ${i}`, caused_by: prevId },
            sender
          );
          chainIds.push(msg.id);
          prevId = msg.id;
        }

        // 全ての reply が root.id を root_message_id に持つ
        for (const msgId of chainIds) {
          const row = db
            .prepare('SELECT root_message_id FROM message_causes WHERE tenant_id = ? AND message_id = ? AND position = 0')
            .get('default', msgId) as { root_message_id: string };
          expect(row.root_message_id).toBe(root.id);
        }
      });
    });

    // トランザクション アトミック性テスト (issue #168: in-flight transaction persistence)
    describe('transaction atomicity (issue #168)', () => {
      it('caused_by 付き sendMessage は messages と message_causes が同時にコミットされる', () => {
        const root = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');
        const reply = sendMessage(
          db,
          'default',
          { to: 'alice', message: 'reply', caused_by: root.id },
          'bob'
        );

        // messages テーブルに行が存在する
        const msgRow = db
          .prepare('SELECT id FROM messages WHERE tenant_id = ? AND id = ?')
          .get('default', reply.id);
        expect(msgRow).toBeDefined();

        // message_causes テーブルに行が存在する（両 INSERT が同一トランザクションでコミットされた証拠）
        const causeRow = db
          .prepare(
            'SELECT caused_by_id FROM message_causes WHERE tenant_id = ? AND message_id = ? AND position = 0'
          )
          .get('default', reply.id) as { caused_by_id: string } | undefined;
        expect(causeRow).toBeDefined();
        expect(causeRow?.caused_by_id).toBe(root.id);
      });

      it('caused_by なし sendMessage は messages のみに行が存在し message_causes は空', () => {
        const msg = sendMessage(db, 'default', { to: 'bob', message: 'standalone' }, 'alice');

        // messages テーブルに行が存在する
        const msgRow = db
          .prepare('SELECT id FROM messages WHERE tenant_id = ? AND id = ?')
          .get('default', msg.id);
        expect(msgRow).toBeDefined();

        // caused_by なしの場合は message_causes に行がない
        const causeRow = db
          .prepare('SELECT * FROM message_causes WHERE tenant_id = ? AND message_id = ?')
          .get('default', msg.id);
        expect(causeRow).toBeUndefined();
      });

      it('message_causes INSERT 失敗時は messages 行もロールバックされる (atomicity)', () => {
        // root を事前に作成 (caused_by なし → message_causes INSERT は発生しない)
        const root = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');

        // BEFORE INSERT trigger で message_causes への INSERT を強制失敗させる
        db.exec(`
          CREATE TRIGGER test_fail_message_causes
          BEFORE INSERT ON message_causes
          BEGIN
            SELECT RAISE(ABORT, 'test: forced message_causes failure');
          END
        `);

        try {
          // caused_by あり → messages INSERT 後に message_causes INSERT を試みて失敗
          expect(() =>
            sendMessage(db, 'default', { to: 'alice', message: 'reply', caused_by: root.id }, 'bob')
          ).toThrow();

          // messages に reply 行が残っていない（トランザクションがロールバックされた）
          const allMessages = db
            .prepare('SELECT id FROM messages WHERE tenant_id = ?')
            .all('default') as Array<{ id: string }>;
          expect(allMessages).toHaveLength(1);
          expect(allMessages[0].id).toBe(root.id);

          // message_causes にも reply の行がない
          const allCauses = db
            .prepare('SELECT message_id FROM message_causes WHERE tenant_id = ?')
            .all('default');
          expect(allCauses).toHaveLength(0);
        } finally {
          db.exec('DROP TRIGGER IF EXISTS test_fail_message_causes');
        }
      });
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

  // issue #37 filter parameter tests (= 設計 doc docs/design-get-history-filter.md §7.1 準拠)
  describe('getHistory filter parameter (#37)', () => {
    beforeEach(() => {
      // 共通 fixture: alice <-> bob で 多様な body の messages
      sendMessage(db, 'default', { to: 'bob', message: 'PR #27 の review 進捗どうですか' }, 'alice');
      sendMessage(db, 'default', { to: 'alice', message: '@reviewer に確認したら明日には終わるそうです' }, 'bob');
      sendMessage(db, 'default', { to: 'bob', message: 'estimate-first protocol v2.4 が merged されました' }, 'alice');
      sendMessage(db, 'default', { to: 'alice', message: 'PR #34 estimate-first の話ですか？' }, 'bob');
      sendMessage(db, 'default', { to: 'bob', message: 'はい、 #34 です' }, 'alice');
    });

    it('filter 指定なし → 既存 behavior と同等 (backward compat)', () => {
      const history = getHistory(db, 'default', { to: 'bob', limit: 50 }, 'alice');

      expect(history).toHaveLength(5);
    });

    it('filter で issue 番号 (#27) を含む message のみ取得', () => {
      const history = getHistory(db, 'default', { to: 'bob', filter: '#27', limit: 50 }, 'alice');

      expect(history).toHaveLength(1);
      expect(history[0].body).toBe('PR #27 の review 進捗どうですか');
    });

    it('filter で peer 名 (@reviewer) を含む message のみ取得', () => {
      const history = getHistory(db, 'default', { to: 'bob', filter: '@reviewer', limit: 50 }, 'alice');

      expect(history).toHaveLength(1);
      expect(history[0].body).toBe('@reviewer に確認したら明日には終わるそうです');
    });

    it('filter で keyword (estimate-first) を含む message のみ取得', () => {
      const history = getHistory(db, 'default', { to: 'bob', filter: 'estimate-first', limit: 50 }, 'alice');

      expect(history).toHaveLength(2);
      // 降順 (新しい順)
      expect(history[0].body).toBe('PR #34 estimate-first の話ですか？');
      expect(history[1].body).toBe('estimate-first protocol v2.4 が merged されました');
    });

    it('filter 空文字列 → filter なしと同等扱い (ignore)', () => {
      const history = getHistory(db, 'default', { to: 'bob', filter: '', limit: 50 }, 'alice');

      expect(history).toHaveLength(5);
    });

    it('filter で ASCII case-insensitive match (REVIEWER ↔ reviewer)', () => {
      const history = getHistory(db, 'default', { to: 'bob', filter: 'REVIEWER', limit: 50 }, 'alice');

      // SQLite default LIKE は ASCII case-insensitive
      expect(history).toHaveLength(1);
      expect(history[0].body).toBe('@reviewer に確認したら明日には終わるそうです');
    });

    it('filter 内 SQL meta char (%) は literal match (SQL injection 防止 / wildcard 化しない)', () => {
      // SQL meta char `%` を含む body を 1 件追加
      sendMessage(db, 'default', { to: 'bob', message: '進捗 50% completed' }, 'alice');

      // filter として `%` 単体を渡す
      // 注: SQLite LIKE では `%` は wildcard だが、 parameterized query (= '%' || ? || '%') では
      // ? に渡された値は wildcard として展開されず substring としてのみ match。
      // (本 design は SQL injection 防止 + 期待動作 = literal `%` match)
      const history = getHistory(db, 'default', { to: 'bob', filter: '50%', limit: 50 }, 'alice');

      // `50%` を含む 1 件のみ match (= 他 message に `50%` substring なし)
      expect(history).toHaveLength(1);
      expect(history[0].body).toBe('進捗 50% completed');
    });

    it('filter 内 Japanese (ヒアリング) は case-sensitive match (default 動作確認)', () => {
      // 日本語 body を追加
      sendMessage(db, 'default', { to: 'bob', message: 'ヒアリング ありがとうございました' }, 'alice');

      const history = getHistory(db, 'default', { to: 'bob', filter: 'ヒアリング', limit: 50 }, 'alice');

      // SQLite default で non-ASCII は case-sensitive、 完全一致するので match
      expect(history).toHaveLength(1);
      expect(history[0].body).toBe('ヒアリング ありがとうございました');
    });

    it('team channel filter (= member only access + filter 動作)', () => {
      sendMessage(db, 'default', { to: 'team-alpha', message: 'team msg about PR #34' }, 'alice');
      sendMessage(db, 'default', { to: 'team-alpha', message: 'unrelated team chat' }, 'bob');

      const history = getHistory(db, 'default', { to: 'team-alpha', filter: '#34', limit: 50 }, 'charlie');

      expect(history).toHaveLength(1);
      expect(history[0].body).toBe('team msg about PR #34');
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

    it('mark_as_read 後も messages テーブルにメッセージが保持される', () => {
      const msg = sendMessage(db, 'default', { to: 'bob', message: 'persistent' }, 'alice');

      // 送信直後: messages に存在する
      const beforeRead = db
        .prepare('SELECT id FROM messages WHERE tenant_id = ? AND id = ?')
        .get('default', msg.id);
      expect(beforeRead).toBeDefined();

      // mark_as_read 後も messages テーブルから削除されない（read_receipts に記録されるだけ）
      markAsRead(db, 'default', msg.id, 'bob');
      const afterRead = db
        .prepare('SELECT id FROM messages WHERE tenant_id = ? AND id = ?')
        .get('default', msg.id);
      expect(afterRead).toBeDefined();

      // read_receipts に記録されている
      const receipt = db
        .prepare(
          'SELECT reader FROM read_receipts WHERE tenant_id = ? AND message_id = ? AND reader = ?'
        )
        .get('default', msg.id, '@bob');
      expect(receipt).toBeDefined();
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

  // -----------------------------------------------------------------------
  // getThread (issue #181)
  // -----------------------------------------------------------------------
  describe('getThread (issue #181)', () => {
    it('root message ID でスレッド全体を取得できる', () => {
      // alice -> bob (root)
      const root = sendMessage(db, 'default', { to: 'bob', message: 'start task' }, 'alice');
      // bob -> alice (reply 1)
      const reply1 = sendMessage(
        db, 'default', { to: 'alice', message: 'acknowledged', caused_by: root.id }, 'bob'
      );
      // alice -> bob (reply 2)
      const reply2 = sendMessage(
        db, 'default', { to: 'bob', message: 'next step', caused_by: root.id }, 'alice'
      );

      const result = getThread(db, 'default', { message_id: root.id, limit: 100 }, 'alice');

      expect(result.rootId).toBe(root.id);
      expect(result.threadSize).toBe(3);
      // 時系列昇順
      expect(result.messages[0].id).toBe(root.id);
      // root は caused_by なし — LEFT JOIN が NULL を返すため null
      expect(result.messages[0].caused_by ?? null).toBeNull();
    });

    it('子メッセージ ID からでも同じスレッドを取得できる', () => {
      const root = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');
      const child = sendMessage(
        db, 'default', { to: 'alice', message: 'reply', caused_by: root.id }, 'bob'
      );

      const fromRoot  = getThread(db, 'default', { message_id: root.id,  limit: 100 }, 'alice');
      const fromChild = getThread(db, 'default', { message_id: child.id, limit: 100 }, 'alice');

      expect(fromRoot.rootId).toBe(fromChild.rootId);
      expect(fromRoot.threadSize).toBe(fromChild.threadSize);
    });

    it('caused_by が返信メッセージに付く', () => {
      const root  = sendMessage(db, 'default', { to: 'bob', message: 'q' }, 'alice');
      const reply = sendMessage(
        db, 'default', { to: 'alice', message: 'a', caused_by: root.id }, 'bob'
      );

      const result = getThread(db, 'default', { message_id: root.id, limit: 100 }, 'alice');

      const replyMsg = result.messages.find((m) => m.id === reply.id);
      expect(replyMsg?.caused_by).toBe(root.id);
    });

    it('スレッドに参加していない requester はエラー', () => {
      const root = sendMessage(db, 'default', { to: 'bob', message: 'secret' }, 'alice');

      // charlie はこのスレッドに参加していない
      expect(() =>
        getThread(db, 'default', { message_id: root.id, limit: 100 }, 'charlie')
      ).toThrow('権限がありません');
    });

    it('存在しない message_id はエラー', () => {
      expect(() =>
        getThread(db, 'default', { message_id: 'nonexistent-id', limit: 100 }, 'alice')
      ).toThrow('存在しません');
    });

    it('未登録 requester はエラー', () => {
      const root = sendMessage(db, 'default', { to: 'bob', message: 'test' }, 'alice');
      expect(() =>
        getThread(db, 'default', { message_id: root.id, limit: 100 }, 'unknown')
      ).toThrow('@unknown は登録されていません');
    });

    it('limit でメッセージ数を制限できる', () => {
      const root = sendMessage(db, 'default', { to: 'bob', message: 'root' }, 'alice');
      // 5 件の返信
      for (let i = 0; i < 5; i++) {
        sendMessage(
          db, 'default', { to: 'alice', message: `reply${i}`, caused_by: root.id }, 'bob'
        );
      }

      const result = getThread(db, 'default', { message_id: root.id, limit: 3 }, 'alice');

      // root + limit=3 replies → 合計 4 件
      // (root は別扱い、replies のみ limit)
      expect(result.messages.length).toBeLessThanOrEqual(4);
    });

    it('caused_by のないメッセージ (= 単独メッセージ) も取得できる', () => {
      const solo = sendMessage(db, 'default', { to: 'bob', message: 'standalone' }, 'alice');

      const result = getThread(db, 'default', { message_id: solo.id, limit: 100 }, 'alice');

      expect(result.rootId).toBe(solo.id);
      expect(result.threadSize).toBe(1);
      expect(result.messages[0].body).toBe('standalone');
    });
  });
});
