import type { Database } from 'better-sqlite3';
import type { Message, SendMessageInput, GetHistoryInput } from '../types/schema.js';
import { randomUUID } from 'crypto';

/**
 * メッセージを送信する
 * - DM: to が個人名の場合
 * - チーム: to がチーム名の場合、メンバー全員に配信（送信者自身は除く）
 *
 * @param senderLogin - auth login (PAT owner 等、forensic audit 用、issue #127)。
 *   production server は PAT/trust 両 mode で non-null を渡す (trust mode: handle name = login)。
 *   省略 or null の場合は NULL として記録される (= migration 前の既存 row との互換保持)。
 */
export function sendMessage(
  db: Database,
  tenantId: string,
  input: SendMessageInput,
  sender: string,
  senderLogin?: string | null
): Message {
  const senderName = sender.startsWith('@') ? sender : `@${sender}`;
  const recipientName = input.to.startsWith('@') ? input.to : `@${input.to}`;

  // 自分宛メッセージは禁止
  if (senderName === recipientName) {
    throw new Error('自分宛にメッセージを送信することはできません');
  }

  // 送信者が登録済みか確認
  const senderExists = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, senderName);
  if (!senderExists) {
    throw new Error(`送信者 ${senderName} は登録されていません`);
  }

  // 宛先の存在確認（個人またはチーム）
  const recipientIsParticipant = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, recipientName);
  const recipientIsTeam = db
    .prepare('SELECT name FROM teams WHERE tenant_id = ? AND name = ?')
    .get(tenantId, recipientName);

  if (!recipientIsParticipant && !recipientIsTeam) {
    throw new Error(`宛先 ${recipientName} は存在しません`);
  }

  // チーム宛の場合、送信者がメンバーか確認
  if (recipientIsTeam) {
    const isMember = db
      .prepare(
        'SELECT 1 FROM team_members WHERE tenant_id = ? AND team_name = ? AND member_name = ?'
      )
      .get(tenantId, recipientName, senderName);
    if (!isMember) {
      throw new Error(`チーム ${recipientName} に送信できるのはメンバーのみです`);
    }
  }

  // メッセージを作成
  const messageId = randomUUID();
  const now = new Date().toISOString();
  const login = senderLogin ?? null;

  db.prepare(
    'INSERT INTO messages (tenant_id, id, sender, recipient, body, sender_login, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(tenantId, messageId, senderName, recipientName, input.message, login, now);

  const message = db
    .prepare('SELECT * FROM messages WHERE tenant_id = ? AND id = ?')
    .get(tenantId, messageId) as Message;

  return message;
}

/**
 * メッセージIDで特定のメッセージを取得する
 */
export function getMessage(
  db: Database,
  tenantId: string,
  messageId: string,
  requester: string
): Message {
  const requesterName = requester.startsWith('@') ? requester : `@${requester}`;

  const requesterExists = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, requesterName);
  if (!requesterExists) {
    throw new Error(`${requesterName} は登録されていません`);
  }

  const message = db
    .prepare('SELECT * FROM messages WHERE tenant_id = ? AND id = ?')
    .get(tenantId, messageId) as Message | undefined;

  if (!message) {
    throw new Error(`メッセージ ${messageId} は存在しません`);
  }

  const isSender = message.sender === requesterName;
  const isRecipient = message.recipient === requesterName;
  const isTeamMember = db
    .prepare(
      'SELECT 1 FROM team_members WHERE tenant_id = ? AND team_name = ? AND member_name = ?'
    )
    .get(tenantId, message.recipient, requesterName);

  if (!isSender && !isRecipient && !isTeamMember) {
    throw new Error(`メッセージ ${messageId} を閲覧する権限がありません`);
  }

  return message;
}

/**
 * 未読メッセージを取得する
 * - DM: 自分宛のメッセージ
 * - チーム: 所属チーム宛のメッセージ
 * - 自分が送信したメッセージは除外
 * - 既読済みは除外
 */
export function getUnreadMessages(
  db: Database,
  tenantId: string,
  reader: string
): Message[] {
  const readerName = reader.startsWith('@') ? reader : `@${reader}`;

  const readerExists = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, readerName);
  if (!readerExists) {
    throw new Error(`${readerName} は登録されていません`);
  }

  const messages = db
    .prepare(
      `SELECT m.*
       FROM messages m
       LEFT JOIN read_receipts rr
         ON m.tenant_id = rr.tenant_id AND m.id = rr.message_id AND rr.reader = ?
       WHERE m.tenant_id = ?
         AND rr.message_id IS NULL
         AND (
           m.recipient = ?
           OR m.recipient IN (
             SELECT team_name FROM team_members
             WHERE tenant_id = ? AND member_name = ?
           )
         )
         AND m.sender != ?
       ORDER BY m.created_at ASC`
    )
    .all(readerName, tenantId, readerName, tenantId, readerName, readerName) as Message[];

  return messages;
}

/**
 * 会話履歴を取得する
 */
export function getHistory(
  db: Database,
  tenantId: string,
  input: GetHistoryInput,
  requester: string
): Message[] {
  const requesterName = requester.startsWith('@') ? requester : `@${requester}`;
  const targetName = input.to.startsWith('@') ? input.to : `@${input.to}`;

  const requesterExists = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, requesterName);
  if (!requesterExists) {
    throw new Error(`${requesterName} は登録されていません`);
  }

  const targetIsParticipant = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, targetName);
  const targetIsTeam = db
    .prepare('SELECT name FROM teams WHERE tenant_id = ? AND name = ?')
    .get(tenantId, targetName);

  if (!targetIsParticipant && !targetIsTeam) {
    throw new Error(`宛先 ${targetName} は存在しません`);
  }

  if (targetIsTeam) {
    const isMember = db
      .prepare(
        'SELECT 1 FROM team_members WHERE tenant_id = ? AND team_name = ? AND member_name = ?'
      )
      .get(tenantId, targetName, requesterName);
    if (!isMember) {
      throw new Error(`チーム ${targetName} の履歴を閲覧できるのはメンバーのみです`);
    }
  }

  // Build base WHERE clause + params (= team / DM 分岐)
  let query: string;
  let params: unknown[];

  if (targetIsTeam) {
    query = `
      SELECT * FROM messages
      WHERE tenant_id = ? AND recipient = ?`;
    params = [tenantId, targetName];
  } else {
    query = `
      SELECT * FROM messages
      WHERE tenant_id = ?
        AND ((sender = ? AND recipient = ?)
          OR (sender = ? AND recipient = ?))`;
    params = [tenantId, requesterName, targetName, targetName, requesterName];
  }

  // Filter parameter inject (issue #37、 設計 doc: docs/design-get-history-filter.md)
  // body の部分一致検索 (= LIKE %X%、 parameterized で SQL injection 防止)
  // case sensitivity: SQLite default = ASCII case-insensitive、 非 ASCII (= Japanese 等) は case-sensitive
  // 全角/半角 normalize / unicode case folding は別 issue scope 外、
  // future Japanese 検索 needs 顕在化時の expansion path = ICU collation / FTS5 unicode61 candidate (= 設計 doc §5.2 + §9)
  // 空文字列 = filter なしと同等扱い (= 設計 doc §3.2)
  if (input.filter && input.filter.length > 0) {
    query += `\n        AND body LIKE '%' || ? || '%'`;
    params.push(input.filter);
  }

  query += `\n      ORDER BY created_at DESC, rowid DESC\n      LIMIT ?`;
  params.push(input.limit);

  const messages = db.prepare(query).all(...params) as Message[];

  return messages;
}

/**
 * メッセージを既読にする
 */
export function markAsRead(
  db: Database,
  tenantId: string,
  messageId: string,
  reader: string
): { read: true } {
  const readerName = reader.startsWith('@') ? reader : `@${reader}`;

  const readerExists = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, readerName);
  if (!readerExists) {
    throw new Error(`${readerName} は登録されていません`);
  }

  const message = db
    .prepare('SELECT * FROM messages WHERE tenant_id = ? AND id = ?')
    .get(tenantId, messageId) as Message | undefined;

  if (!message) {
    throw new Error(`メッセージ ${messageId} は存在しません`);
  }

  const isRecipient = message.recipient === readerName;
  const isTeamMember = db
    .prepare(
      'SELECT 1 FROM team_members WHERE tenant_id = ? AND team_name = ? AND member_name = ?'
    )
    .get(tenantId, message.recipient, readerName);

  if (!isRecipient && !isTeamMember) {
    throw new Error(`メッセージ ${messageId} を既読にできるのは受信者のみです`);
  }

  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO read_receipts (tenant_id, message_id, reader, read_at) VALUES (?, ?, ?, ?)'
  ).run(tenantId, messageId, readerName, now);

  return { read: true };
}
