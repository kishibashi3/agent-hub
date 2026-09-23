import type { Database } from 'better-sqlite3';
import type { Message, SendMessageInput, GetHistoryInput, GetThreadInput } from '../types/schema.js';
import { randomUUID } from 'crypto';

/**
 * メッセージを送信する
 * - DM: to が個人名の場合
 * - チーム: to がチーム名の場合、メンバー全員に配信（送信者自身は除く）
 *
 * @param senderLogin - auth login (PAT owner、forensic audit 用、issue #127)。
 *   production server は non-null を渡す。
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

  // 自分宛メッセージは禁止（@* ブロードキャストは自分も含むため除外）
  if (recipientName !== '@*' && senderName === recipientName) {
    throw new Error('自分宛にメッセージを送信することはできません');
  }

  // 送信者が登録済みか確認
  const senderExists = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, senderName);
  if (!senderExists) {
    throw new Error(`送信者 ${senderName} は登録されていません`);
  }

  // @* ブロードキャストは宛先存在確認・メンバー確認をスキップ
  // (mode=global チェックは handler 層 send_message.ts で実施済み)
  if (recipientName !== '@*') {
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
  const isBroadcast = message.recipient === '@*';
  const isTeamMember = db
    .prepare(
      'SELECT 1 FROM team_members WHERE tenant_id = ? AND team_name = ? AND member_name = ?'
    )
    .get(tenantId, message.recipient, requesterName);

  if (!isSender && !isRecipient && !isBroadcast && !isTeamMember) {
    throw new Error(`メッセージ ${messageId} を閲覧する権限がありません`);
  }

  return message;
}

/**
 * 未読取得の keyset cursor 位置 (issue #388)。
 *
 * `ORDER BY m.created_at ASC, m.rowid ASC` の並びにおいて、この位置より「後ろ」だけを
 * 返す。`created_at` は ms 精度で同値衝突しうるため、tie-break が要る。
 *
 * tie-break に `id` (UUID) ではなく `rowid` を使う理由: UUID 順は挿入順と無関係なので、
 * 同一 ms に届いた複数メッセージの返却順が実質ランダムになり、従来 (tie-break なし =
 * 実際には rowid 順) の配信順を壊す。`rowid` なら挿入順が保たれ、かつ keyset として
 * 安定する。
 *
 * 既知の制約: SQLite の暗黙 rowid は `VACUUM` で振り直されうる。本 repo は `VACUUM` を
 * 実行しないため実害はないが、導入する場合は進行中の cursor が無効化される点に注意。
 * 主動線は cursor ではなく ack-as-cursor (`mark_as_read` して再取得) であり、そちらは
 * rowid に依存しない。
 */
export interface UnreadCursor {
  createdAt: string;
  rowId: number;
}

/**
 * 未読メッセージ 1 件。keyset cursor 生成用に `rowid` を伴う (issue #388)。
 */
export type UnreadMessage = Message & { row_id: number };

/**
 * 未読取得の paging オプション (issue #388)。
 *
 * 両方省略時は従来どおり「未読を全件・先頭から」返す (= 既存呼び出しの挙動不変)。
 */
export interface UnreadPageOptions {
  /** 返す件数の上限。省略時は上限なし */
  limit?: number;
  /** この位置より後ろの未読だけを返す。省略時は未読の先頭から */
  after?: UnreadCursor;
}

/**
 * 未読メッセージ共通の WHERE 条件。
 *
 * `getUnreadMessages()` (行取得) と `countUnreadMessages()` (残件カウント) で
 * 同一の未読集合を指すことを保証するため、条件文と bind パラメータの組み立てを
 * ここ 1 箇所に集約する。ずれると `has_more` / `remaining` が嘘をつく。
 */
function buildUnreadFilter(
  tenantId: string,
  readerName: string,
  after?: UnreadCursor
): { sql: string; params: unknown[] } {
  const params: unknown[] = [
    readerName, // rr.reader
    tenantId,
    readerName, // m.recipient
    tenantId, // team_members サブクエリ
    readerName, // team_members.member_name
    readerName, // m.sender !=
  ];

  let sql = `WHERE m.tenant_id = ?
         AND rr.message_id IS NULL
         AND (
           m.recipient = ?
           OR m.recipient = '@*'
           OR m.recipient IN (
             SELECT team_name FROM team_members
             WHERE tenant_id = ? AND member_name = ?
           )
         )
         AND m.sender != ?`;

  if (after) {
    // keyset 比較: (created_at, rowid) > (after.createdAt, after.rowId)
    sql += `
         AND (m.created_at > ? OR (m.created_at = ? AND m.rowid > ?))`;
    params.push(after.createdAt, after.createdAt, after.rowId);
  }

  return { sql, params };
}

/**
 * 未読メッセージを取得する
 * - DM: 自分宛のメッセージ
 * - チーム: 所属チーム宛のメッセージ
 * - 自分が送信したメッセージは除外
 * - 既読済みは除外
 *
 * `options` (issue #388) で件数上限と keyset cursor を指定できる。省略時は
 * 全件を先頭から返すため、既存の呼び出し側 (flush 系 / mark_as_read all 等) の
 * 挙動は変わらない。
 *
 * 並び順は `created_at ASC, rowid ASC`。tie-break の `rowid` は issue #388 で追加した。
 * 従来は `created_at ASC` のみで、同一 `created_at` の行の順序が SQL 上は未定義だった
 * (実際には rowid 順) ため、cursor で「次のページ」を安定して指せなかった。明示的に
 * rowid で tie-break することで、従来の配信順を保ったまま keyset paging を成立させる。
 */
export function getUnreadMessages(
  db: Database,
  tenantId: string,
  reader: string,
  options?: UnreadPageOptions
): UnreadMessage[] {
  const readerName = reader.startsWith('@') ? reader : `@${reader}`;

  const readerExists = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, readerName);
  if (!readerExists) {
    throw new Error(`${readerName} は登録されていません`);
  }

  const filter = buildUnreadFilter(tenantId, readerName, options?.after);
  const params = [...filter.params];

  let limitClause = '';
  if (options?.limit !== undefined) {
    limitClause = `
       LIMIT ?`;
    params.push(options.limit);
  }

  const messages = db
    .prepare(
      `SELECT m.*, m.rowid AS row_id, mc.caused_by_id AS caused_by
       FROM messages m
       LEFT JOIN message_causes mc
         ON m.tenant_id = mc.tenant_id AND m.id = mc.message_id AND mc.position = 0
       LEFT JOIN read_receipts rr
         ON m.tenant_id = rr.tenant_id AND m.id = rr.message_id AND rr.reader = ?
       ${filter.sql}
       ORDER BY m.created_at ASC, m.rowid ASC${limitClause}`
    )
    .all(...params) as UnreadMessage[];

  return messages;
}

/**
 * 未読メッセージの件数を数える (issue #388)。
 *
 * `after` を渡すと「その位置より後ろに残っている未読の件数」になる。
 * `get_messages` が返す `remaining` の算出に使う。「無言で打ち切らない」
 * (= 残件を数で見せる) ための COUNT なので、`getUnreadMessages()` と
 * 同一の未読集合を指す必要がある (`buildUnreadFilter()` を共有する理由)。
 */
export function countUnreadMessages(
  db: Database,
  tenantId: string,
  reader: string,
  after?: UnreadCursor
): number {
  const readerName = reader.startsWith('@') ? reader : `@${reader}`;

  const readerExists = db
    .prepare('SELECT name FROM participants WHERE tenant_id = ? AND name = ?')
    .get(tenantId, readerName);
  if (!readerExists) {
    throw new Error(`${readerName} は登録されていません`);
  }

  const filter = buildUnreadFilter(tenantId, readerName, after);

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM messages m
       LEFT JOIN read_receipts rr
         ON m.tenant_id = rr.tenant_id AND m.id = rr.message_id AND rr.reader = ?
       ${filter.sql}`
    )
    .get(...filter.params) as { n: number };

  return row.n;
}

/**
 * 未読メッセージを取得する（DM + ブロードキャストのみ、チーム宛は除外）
 *
 * flush_messages (issue #336) 用。queue_depth (getQueueDepths) が person 宛
 * メッセージのみをカウントしているのと scope を揃えるため、team 宛は対象外とする。
 * - DM: 自分宛のメッセージ
 * - ブロードキャスト: @* 宛のメッセージ
 * - 自分が送信したメッセージ・既読済みは除外
 */
export function getUnreadDmBroadcastMessages(
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
         AND (m.recipient = ? OR m.recipient = '@*')
         AND m.sender != ?
       ORDER BY m.created_at ASC`
    )
    .all(readerName, tenantId, readerName, readerName) as Message[];

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
// caused_by root の long-running スレッド判定。
// DM アラート機能は issue #212 で削除。観測は dashboard の health 画面で行う。
// ============================================================

/** PPD 閾値 (issue #198): 同一 root_message_id のメッセージ数がこれに達したら PPD とみなす */
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
  const isBroadcast = message.recipient === '@*';
  const isTeamMember = db
    .prepare(
      'SELECT 1 FROM team_members WHERE tenant_id = ? AND team_name = ? AND member_name = ?'
    )
    .get(tenantId, message.recipient, readerName);

  if (!isRecipient && !isBroadcast && !isTeamMember) {
    throw new Error(`メッセージ ${messageId} を既読にできるのは受信者のみです`);
  }

  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO read_receipts (tenant_id, message_id, reader, read_at) VALUES (?, ?, ?, ?)'
  ).run(tenantId, messageId, readerName, now);

  return { read: true };
}

/**
 * 全参加者の未読メッセージ数をバッチ取得する (issue #234)。
 *
 * 未読 = messages.recipient に対応する read_receipts 行が存在しない。
 * 送信者 != 受信者 の条件は sendMessage が自分宛を禁止しているため冗長だが
 * 防御的に保持する。
 *
 * **スコープ**: recipient が個人名 (person) のメッセージのみをカウントする。
 * チーム宛メッセージ (recipient = @team-xxx) は各メンバーの queue_depth には
 * 含まれない。チーム宛未読は getUnreadMessages() で取得すること。
 *
 * @returns Map<participantName, queueDepth>。
 *          未読 0 の参加者はエントリを持たない (呼び出し側で ?? 0 を使うこと)。
 */
export function getQueueDepths(
  db: Database,
  tenantId: string
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT m.recipient AS participant_name, COUNT(*) AS depth
       FROM messages m
       LEFT JOIN read_receipts rr
         ON m.tenant_id = rr.tenant_id
         AND m.id = rr.message_id
         AND rr.reader = m.recipient
       WHERE m.tenant_id = ?
         AND rr.message_id IS NULL
         AND m.sender != m.recipient
       GROUP BY m.recipient`
    )
    .all(tenantId) as { participant_name: string; depth: number }[];

  return new Map(rows.map((r) => [r.participant_name, r.depth]));
}
