import type { Database } from 'better-sqlite3';
import type { Message, SendMessageInput, GetHistoryInput, GetThreadInput } from '../types/schema.js';
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

  // caused_by: 存在確認 → 無効な場合は null にフォールバック (サイレント degradation、issue #164)
  // メッセージングは非同期なので caused_by が無効でも送信をブロックしない。
  // 深さ上限チェック: 削除 (issue #164)。
  //   メッセージは時系列順に送受信されるため、因果関係に循環は原理的に発生しない。
  let causedBy = input.caused_by ?? null;
  if (causedBy !== null) {
    const causedByExists = db
      .prepare('SELECT 1 FROM messages WHERE tenant_id = ? AND id = ?')
      .get(tenantId, causedBy);
    if (!causedByExists) {
      // 存在しない ID は null にフォールバック（エラーにしない）
      causedBy = null;
    }
  }

  // メッセージID・タイムスタンプをトランザクション外で生成（副作用なし）
  const messageId = randomUUID();
  const now = new Date().toISOString();
  const login = senderLogin ?? null;

  // DB 書き込み: messages + message_causes をアトミックにコミット (issue #168)
  // messages INSERT と message_causes INSERT を同一トランザクションに包む。
  // hub クラッシュ時に「messages あり・message_causes なし」の中間状態が残らないことを保証する。
  // WAL モード + synchronous=NORMAL により、コミット後は hub プロセスのクラッシュから保護される。
  const message = db.transaction((): Message => {
    db.prepare(
      'INSERT INTO messages (tenant_id, id, sender, recipient, body, sender_login, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(tenantId, messageId, senderName, recipientName, input.message, login, now);

    // 因果リンクを message_causes に記録 (issue #162)
    // V1: position=0 のみ（単一 caused_by、Tree 構造）
    // root_message_id: caused_by の root_message_id を1回参照して計算 (issue #166)
    //   caused_by に root_message_id があればそれを引き継ぐ、なければ caused_by 自身がルート。
    //   挿入時1回で解決できるため WITH RECURSIVE 不要。
    if (causedBy !== null) {
      const parentCause = db
        .prepare(
          'SELECT root_message_id FROM message_causes WHERE tenant_id = ? AND message_id = ? AND position = 0'
        )
        .get(tenantId, causedBy) as { root_message_id: string | null } | undefined;
      const rootMessageId = parentCause?.root_message_id ?? causedBy;

      db.prepare(
        'INSERT INTO message_causes (tenant_id, message_id, caused_by_id, position, root_message_id) VALUES (?, ?, ?, 0, ?)'
      ).run(tenantId, messageId, causedBy, rootMessageId);
    }

    return db
      .prepare(
        `SELECT m.*, mc.caused_by_id AS caused_by
         FROM messages m
         LEFT JOIN message_causes mc
           ON m.tenant_id = mc.tenant_id AND m.id = mc.message_id AND mc.position = 0
         WHERE m.tenant_id = ? AND m.id = ?`
      )
      .get(tenantId, messageId) as Message;
  })();

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
    .prepare(
      `SELECT m.*, mc.caused_by_id AS caused_by
       FROM messages m
       LEFT JOIN message_causes mc
         ON m.tenant_id = mc.tenant_id AND m.id = mc.message_id AND mc.position = 0
       WHERE m.tenant_id = ? AND m.id = ?`
    )
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
      `SELECT m.*, mc.caused_by_id AS caused_by
       FROM messages m
       LEFT JOIN message_causes mc
         ON m.tenant_id = mc.tenant_id AND m.id = mc.message_id AND mc.position = 0
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
      SELECT m.*, mc.caused_by_id AS caused_by
      FROM messages m
      LEFT JOIN message_causes mc
        ON m.tenant_id = mc.tenant_id AND m.id = mc.message_id AND mc.position = 0
      WHERE m.tenant_id = ? AND m.recipient = ?`;
    params = [tenantId, targetName];
  } else {
    query = `
      SELECT m.*, mc.caused_by_id AS caused_by
      FROM messages m
      LEFT JOIN message_causes mc
        ON m.tenant_id = mc.tenant_id AND m.id = mc.message_id AND mc.position = 0
      WHERE m.tenant_id = ?
        AND ((m.sender = ? AND m.recipient = ?)
          OR (m.sender = ? AND m.recipient = ?))`;
    params = [tenantId, requesterName, targetName, targetName, requesterName];
  }

  // Filter parameter inject (issue #37、 設計 doc: docs/design-get-history-filter.md)
  // body の部分一致検索 (= LIKE %X%、 parameterized で SQL injection 防止)
  // case sensitivity: SQLite default = ASCII case-insensitive、 非 ASCII (= Japanese 等) は case-sensitive
  // 全角/半角 normalize / unicode case folding は別 issue scope 外、
  // future Japanese 検索 needs 顕在化時の expansion path = ICU collation / FTS5 unicode61 candidate (= 設計 doc §5.2 + §9)
  // 空文字列 = filter なしと同等扱い (= 設計 doc §3.2)
  if (input.filter && input.filter.length > 0) {
    query += `\n        AND m.body LIKE '%' || ? || '%'`;
    params.push(input.filter);
  }

  query += `\n      ORDER BY m.created_at DESC, m.rowid DESC\n      LIMIT ?`;
  params.push(input.limit);

  const messages = db.prepare(query).all(...params) as Message[];

  return messages;
}

/**
 * スレッドの全メッセージを取得する (issue #181)
 *
 * 任意のメッセージ ID (root / 子どちらでも可) を受け取り、
 * message_causes.root_message_id を経由してスレッド全体を返す。
 *
 * 権限: 自分が sender または recipient のメッセージを含むスレッドのみ取得可能。
 * （スレッド内に1件でも自分のメッセージがあれば全件返す — agent-hub の
 *  原則「同一スレッド参加者は文脈共有」に合致する）
 * admin (@admin) は全スレッドを取得可能。
 *
 * @returns { rootId, threadSize, messages }
 */
export function getThread(
  db: Database,
  tenantId: string,
  input: GetThreadInput,
  requester: string
): { rootId: string; threadSize: number; messages: Message[] } {
  const requesterName = requester.startsWith('@') ? requester : `@${requester}`;

  // requester の存在確認
  const requesterExists = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, requesterName);
  if (!requesterExists) {
    throw new Error(`${requesterName} は登録されていません`);
  }

  // message_id から root_message_id を解決する
  // (1) message_causes に entry があれば root_message_id を取得
  // (2) なければ message_id 自体が root (= caused_by を持たない)
  let rootId: string;

  const causeRow = db
    .prepare(
      'SELECT root_message_id FROM message_causes WHERE tenant_id = ? AND message_id = ? AND position = 0'
    )
    .get(tenantId, input.message_id) as { root_message_id: string } | undefined;

  if (causeRow) {
    rootId = causeRow.root_message_id;
  } else {
    // message_id 自体が root candidate — messages テーブルに存在するか確認
    const rootMsg = db
      .prepare('SELECT id FROM messages WHERE tenant_id = ? AND id = ?')
      .get(tenantId, input.message_id);
    if (!rootMsg) {
      throw new Error(`メッセージ ${input.message_id} は存在しません`);
    }
    // root message 自体は message_causes に entry を持たないため、
    // root message の子孫が存在するかを確認してスレッド有無を判断する。
    // 子なし = スレッドでなく単独メッセージ → 単件を返す。
    rootId = input.message_id;
  }

  // 権限チェック: requester がスレッドに参加しているか
  // (@admin は全スレッドにアクセス可能)
  const isAdmin = requesterName === '@admin';
  if (!isAdmin) {
    const participates = db
      .prepare(
        `SELECT 1 FROM messages
         WHERE tenant_id = ?
           AND (id = ? OR id IN (
             SELECT message_id FROM message_causes
             WHERE tenant_id = ? AND root_message_id = ? AND position = 0
           ))
           AND (sender = ? OR recipient = ?)
         LIMIT 1`
      )
      .get(tenantId, rootId, tenantId, rootId, requesterName, requesterName);
    if (!participates) {
      throw new Error(`スレッド ${rootId} を閲覧する権限がありません`);
    }
  }

  // root message を取得
  const rootMsg = db
    .prepare(
      `SELECT m.*, mc.caused_by_id AS caused_by
       FROM messages m
       LEFT JOIN message_causes mc
         ON m.tenant_id = mc.tenant_id AND m.id = mc.message_id AND mc.position = 0
       WHERE m.tenant_id = ? AND m.id = ?`
    )
    .get(tenantId, rootId) as Message | undefined;

  if (!rootMsg) {
    throw new Error(`スレッドのルートメッセージ ${rootId} が見つかりません`);
  }

  // スレッド内全メッセージ (root 以外) を時系列で取得
  const replies = db
    .prepare(
      `SELECT m.*, mc.caused_by_id AS caused_by
       FROM message_causes mc
       JOIN messages m ON m.id = mc.message_id AND m.tenant_id = mc.tenant_id
       WHERE mc.tenant_id = ? AND mc.root_message_id = ? AND mc.position = 0
       ORDER BY m.created_at ASC
       LIMIT ?`
    )
    .all(tenantId, rootId, input.limit) as Message[];

  // root + replies を時系列でマージ
  const allMessages: Message[] = [rootMsg, ...replies].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
  );

  return {
    rootId,
    threadSize: allMessages.length,
    messages: allMessages,
  };
}

// ============================================================
// PPD (Ping-Pong Detection) — issue #198
// caused_by root の long-running スレッド判定に改善。
// peer 間の往復カウント（旧方式）に代わり、同一 root_message_id の
// スレッドが閾値に達したら operator に通知する。
// ============================================================

/** PPD 閾値 (issue #198): 同一 root_message_id のメッセージ数がこれに達したら operator に通知 */
export const PPD_THREAD_THRESHOLD = 5;

/**
 * スレッドの現在のメッセージ数を返す (issue #198 PPD 用)。
 *
 * root message (message_causes entry なし) + replies を合算。
 * message_causes.COUNT(root_message_id) + 1 (root 1 件) で O(1) に計算する。
 *
 * @param rootMessageId - スレッドのルートメッセージ ID
 */
export function getThreadSize(db: Database, tenantId: string, rootMessageId: string): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS cnt FROM message_causes ' +
      'WHERE tenant_id = ? AND root_message_id = ? AND position = 0'
    )
    .get(tenantId, rootMessageId) as { cnt: number } | undefined;
  return (row?.cnt ?? 0) + 1; // replies + root 1 件
}

/**
 * PPD チェック: 新しいメッセージが属するスレッドが閾値に達したら operator にアラートを送る (issue #198)。
 *
 * 閾値到達時に 1 回だけ通知する (threadSize === PPD_THREAD_THRESHOLD)。
 * それ以降のメッセージでは重複通知しない。
 *
 * アラート送信者: '@hub' (participants 登録不要のシステム予約ハンドル、直接 INSERT)。
 * アラート受信者: `PPD_ALERT_RECIPIENT` 環境変数 (default: '@operator')。
 *   受信者が未登録の場合はサイレント skip (= サイレント degradation 原則)。
 *
 * @param newMessageId - 直前に挿入された新規メッセージの ID
 * @returns 通知を送った場合は alertRecipient (e.g. '@operator')、スキップした場合は null
 */
export function checkAndAlertPPD(
  db: Database,
  tenantId: string,
  newMessageId: string
): string | null {
  // caused_by なし (root message) はスレッドサイズ 1 → 閾値以下 → スキップ
  const causeRow = db
    .prepare(
      'SELECT root_message_id FROM message_causes ' +
      'WHERE tenant_id = ? AND message_id = ? AND position = 0'
    )
    .get(tenantId, newMessageId) as { root_message_id: string } | undefined;
  if (!causeRow) return null;

  const rootMessageId = causeRow.root_message_id;
  const threadSize = getThreadSize(db, tenantId, rootMessageId);

  // 閾値に初めて達した瞬間 (=== threshold) のみ通知。超過後は重複送信しない。
  if (threadSize !== PPD_THREAD_THRESHOLD) return null;

  const rawRecipient = process.env['PPD_ALERT_RECIPIENT'] ?? '@operator';
  const alertRecipient = rawRecipient.startsWith('@') ? rawRecipient : `@${rawRecipient}`;

  // 受信者未登録 → サイレント skip (サイレント degradation 原則)
  const recipientExists = db
    .prepare('SELECT 1 FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, alertRecipient);
  if (!recipientExists) return null;

  // root メッセージの送受信者を取得してアラート本文を構成
  const rootMsg = db
    .prepare('SELECT sender, recipient FROM messages WHERE tenant_id = ? AND id = ?')
    .get(tenantId, rootMessageId) as { sender: string; recipient: string } | undefined;

  const alertId = randomUUID();
  const now = new Date().toISOString();
  const shortRoot = rootMessageId.slice(0, 8);
  const body =
    `⚠️ [PPD] スレッド ${shortRoot}... が ${PPD_THREAD_THRESHOLD} 往復に達しました。\n` +
    `thread_size=${threadSize}  root: ${rootMsg?.sender ?? '?'} → ${rootMsg?.recipient ?? '?'}\n` +
    `root_message_id: ${rootMessageId}`;

  // '@hub' をシステム予約ハンドルとして participants に auto-register (INSERT OR IGNORE で冪等)。
  // FK (tenant_id, sender) → participants(tenant_id, name) を満たすために必要。
  db.prepare(
    'INSERT OR IGNORE INTO participants (tenant_id, name) VALUES (?, ?)'
  ).run(tenantId, '@hub');

  db.prepare(
    'INSERT INTO messages (tenant_id, id, sender, recipient, body, sender_login, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, NULL, ?)'
  ).run(tenantId, alertId, '@hub', alertRecipient, body, now);
  // caused_by なし (hub 自発のシステム通知)

  return alertRecipient;
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
