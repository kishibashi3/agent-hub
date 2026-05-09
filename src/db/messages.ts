import type { Database } from 'better-sqlite3';
import type { Message, SendMessageInput, GetHistoryInput } from '../types/schema.js';
import { randomUUID } from 'crypto';

/**
 * メッセージを送信する
 * - DM: to が個人名の場合
 * - チーム: to がチーム名の場合、メンバー全員に配信（送信者自身は除く）
 */
export function sendMessage(
  db: Database,
  input: SendMessageInput,
  sender: string
): Message {
  const senderName = sender.startsWith('@') ? sender : `@${sender}`;
  const recipientName = input.to.startsWith('@') ? input.to : `@${input.to}`;

  // 自分宛メッセージは禁止
  if (senderName === recipientName) {
    throw new Error('自分宛にメッセージを送信することはできません');
  }

  // 送信者が登録済みか確認
  const senderExists = db
    .prepare('SELECT name FROM participants WHERE name = ?')
    .get(senderName);
  if (!senderExists) {
    throw new Error(`送信者 ${senderName} は登録されていません`);
  }

  // 宛先の存在確認（個人またはチーム）
  const recipientIsParticipant = db
    .prepare('SELECT name FROM participants WHERE name = ?')
    .get(recipientName);
  const recipientIsTeam = db
    .prepare('SELECT name FROM teams WHERE name = ?')
    .get(recipientName);

  if (!recipientIsParticipant && !recipientIsTeam) {
    throw new Error(`宛先 ${recipientName} は存在しません`);
  }

  // チーム宛の場合、送信者がメンバーか確認
  if (recipientIsTeam) {
    const isMember = db
      .prepare('SELECT 1 FROM team_members WHERE team_name = ? AND member_name = ?')
      .get(recipientName, senderName);
    if (!isMember) {
      throw new Error(`チーム ${recipientName} に送信できるのはメンバーのみです`);
    }
  }

  // メッセージを作成
  const messageId = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO messages (id, sender, recipient, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(messageId, senderName, recipientName, input.message, now);

  const message = db
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(messageId) as Message;

  return message;
}

/**
 * メッセージIDで特定のメッセージを取得する
 * @param db データベースインスタンス
 * @param messageId メッセージID
 * @param requester リクエスター名（@ プレフィックス付き）
 * @returns メッセージ情報
 * @throws メッセージが存在しない、または閲覧権限がない場合
 */
export function getMessage(
  db: Database,
  messageId: string,
  requester: string
): Message {
  const requesterName = requester.startsWith('@') ? requester : `@${requester}`;

  // リクエスターが登録済みか確認
  const requesterExists = db
    .prepare('SELECT name FROM participants WHERE name = ?')
    .get(requesterName);
  if (!requesterExists) {
    throw new Error(`${requesterName} は登録されていません`);
  }

  // メッセージを取得
  const message = db
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(messageId) as Message | undefined;

  if (!message) {
    throw new Error(`メッセージ ${messageId} は存在しません`);
  }

  // 閲覧権限の確認
  const isSender = message.sender === requesterName;
  const isRecipient = message.recipient === requesterName;
  const isTeamMember = db
    .prepare('SELECT 1 FROM team_members WHERE team_name = ? AND member_name = ?')
    .get(message.recipient, requesterName);

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
  reader: string
): Message[] {
  const readerName = reader.startsWith('@') ? reader : `@${reader}`;

  // 読者が登録済みか確認
  const readerExists = db
    .prepare('SELECT name FROM participants WHERE name = ?')
    .get(readerName);
  if (!readerExists) {
    throw new Error(`${readerName} は登録されていません`);
  }

  const messages = db
    .prepare(
      `SELECT m.*
       FROM messages m
       LEFT JOIN read_receipts rr
         ON m.id = rr.message_id AND rr.reader = ?
       WHERE rr.message_id IS NULL
         AND (
           m.recipient = ?                          -- DM 宛
           OR m.recipient IN (                        -- チーム宛
             SELECT team_name FROM team_members WHERE member_name = ?
           )
         )
         AND m.sender != ?                          -- 自分の送信は除外
       ORDER BY m.created_at ASC`
    )
    .all(readerName, readerName, readerName, readerName) as Message[];

  return messages;
}

/**
 * 会話履歴を取得する
 * - 特定の相手/チームとの会話を送受信両方含めて時系列で返す
 * - DM: 当事者のみ閲覧可能
 * - チーム: メンバーのみ閲覧可能
 */
export function getHistory(
  db: Database,
  input: GetHistoryInput,
  requester: string
): Message[] {
  const requesterName = requester.startsWith('@') ? requester : `@${requester}`;
  const targetName = input.to.startsWith('@') ? input.to : `@${input.to}`;

  // リクエスターが登録済みか確認
  const requesterExists = db
    .prepare('SELECT name FROM participants WHERE name = ?')
    .get(requesterName);
  if (!requesterExists) {
    throw new Error(`${requesterName} は登録されていません`);
  }

  // 宛先の存在確認
  const targetIsParticipant = db
    .prepare('SELECT name FROM participants WHERE name = ?')
    .get(targetName);
  const targetIsTeam = db
    .prepare('SELECT name FROM teams WHERE name = ?')
    .get(targetName);

  if (!targetIsParticipant && !targetIsTeam) {
    throw new Error(`宛先 ${targetName} は存在しません`);
  }

  // 権限確認
  if (targetIsTeam) {
    // チームの場合: メンバーのみ閲覧可能
    const isMember = db
      .prepare('SELECT 1 FROM team_members WHERE team_name = ? AND member_name = ?')
      .get(targetName, requesterName);
    if (!isMember) {
      throw new Error(`チーム ${targetName} の履歴を閲覧できるのはメンバーのみです`);
    }
  } else {
    // DM の場合: 当事者のみ閲覧可能
    // 自分が送信者または受信者である会話のみ取得
  }

  // 履歴を取得
  let query: string;
  let params: any[];

  if (targetIsTeam) {
    // チームの場合: チーム宛のメッセージ
    query = `
      SELECT * FROM messages
      WHERE recipient = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`;
    params = [targetName, input.limit];
  } else {
    // DM の場合: 双方向の会話
    query = `
      SELECT * FROM messages
      WHERE (sender = ? AND recipient = ?)
         OR (sender = ? AND recipient = ?)
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`;
    params = [requesterName, targetName, targetName, requesterName, input.limit];
  }

  const messages = db.prepare(query).all(...params) as Message[];

  return messages;
}

/**
 * メッセージを既読にする
 * - 自分宛のメッセージのみ既読可能
 * - 重複した既読登録は無視（INSERT OR IGNORE）
 */
export function markAsRead(
  db: Database,
  messageId: string,
  reader: string
): { read: true } {
  const readerName = reader.startsWith('@') ? reader : `@${reader}`;

  // 読者が登録済みか確認
  const readerExists = db
    .prepare('SELECT name FROM participants WHERE name = ?')
    .get(readerName);
  if (!readerExists) {
    throw new Error(`${readerName} は登録されていません`);
  }

  // メッセージの存在確認
  const message = db
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(messageId) as Message | undefined;

  if (!message) {
    throw new Error(`メッセージ ${messageId} は存在しません`);
  }

  // 権限確認: 自分宛のメッセージか？
  const isRecipient = message.recipient === readerName;
  const isTeamMember = db
    .prepare('SELECT 1 FROM team_members WHERE team_name = ? AND member_name = ?')
    .get(message.recipient, readerName);

  if (!isRecipient && !isTeamMember) {
    throw new Error(`メッセージ ${messageId} を既読にできるのは受信者のみです`);
  }

  // 既読を記録（重複は無視）
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO read_receipts (message_id, reader, read_at) VALUES (?, ?, ?)'
  ).run(messageId, readerName, now);

  return { read: true };
}
