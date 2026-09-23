import type { TenantScope } from '../../db/tenant-scope.js';
import type { UnreadCursor, UnreadPageOptions } from '../../db/messages.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EnvConfigError } from '../server.js';

/**
 * 1 レスポンスの `messages` 配列の直列化サイズ上限 (bytes) の既定値 (issue #388)。
 *
 * 現存する client 側の行長上限のうち最も狭かったのは Go SDK の 128 KiB
 * (`bufio.Scanner`、agent-hub-sdk#60。#62 で `bufio.Reader` 化され解消済み)。
 * その半分を既定に取り、再発時のマージンを持たせる。
 */
export const GET_MESSAGES_MAX_BYTES = 65_536;

/** `AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES` の許容最小値。1 件も通らない極小値を弾く */
export const GET_MESSAGES_MAX_BYTES_MIN = 1_024;

/** `AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES` の許容最大値 (16 MiB)。事実上の無制限を防ぐ */
export const GET_MESSAGES_MAX_BYTES_MAX = 16 * 1_024 * 1_024;

/** `limit` 引数 / `AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT` の許容最小値 */
export const GET_MESSAGES_LIMIT_MIN = 1;

/** `limit` 引数 / `AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT` の許容最大値 */
export const GET_MESSAGES_LIMIT_MAX = 1_000;

/**
 * 整数 env を解決する (issue #388)。
 *
 * env 未設定 / 空文字は `undefined` を返す (= 呼び出し側が既定値を決める)。
 * set されているのに解釈できない値は `EnvConfigError` を throw する。
 * 既定値への無言 fall back はしない (= issue #384 で統一した fail-fast 方針)。
 */
function resolveIntEnvOrThrow(
  name: string,
  raw: string | undefined,
  min: number,
  max: number
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new EnvConfigError(
      `[MCP] invalid ${name}: ${JSON.stringify(raw)} — expected integer ${min}..${max}. ` +
        `env が明示的に set されているため既定値への fall back は行わない (issue #384)。` +
        `値を修正するか、既定値を使う場合は env 自体を unset すること`
    );
  }
  return parsed;
}

/**
 * `messages` 配列の byte budget の実効値を返す (issue #388)。
 *
 * `AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES` が set されていればその値で上書きする。
 * 呼び出しのたびに env を読む点は `isPingLoopDisabled()` (= issue #91 / #363) と同 pattern
 * で、テストから env を差し替えて検証できる (module reload 不要)。
 */
export function getGetMessagesMaxBytes(): number {
  return (
    resolveIntEnvOrThrow(
      'AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES',
      process.env.AGENT_HUB_MCP_GET_MESSAGES_MAX_BYTES,
      GET_MESSAGES_MAX_BYTES_MIN,
      GET_MESSAGES_MAX_BYTES_MAX
    ) ?? GET_MESSAGES_MAX_BYTES
  );
}

/**
 * `limit` 引数なしで呼ばれたときに適用する既定 limit を返す (issue #388)。
 *
 * **未設定 = `null` = 上限なし = 現行挙動**。段階的 deprecation の段を進めるための
 * つまみであり、Phase 1 (本実装) では未設定のまま deploy する。Phase 3 で
 * `AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT=50` を設定すると、引数なし呼び出しも
 * envelope + limit になる。事故時は env を消すだけで即ロールバックできる (再 deploy 不要)。
 */
export function getGetMessagesDefaultLimit(): number | null {
  return (
    resolveIntEnvOrThrow(
      'AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT',
      process.env.AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT,
      GET_MESSAGES_LIMIT_MIN,
      GET_MESSAGES_LIMIT_MAX
    ) ?? null
  );
}

/**
 * keyset cursor を opaque string へ符号化する (issue #388)。
 *
 * 中身は `base64url(created_at + "|" + rowid)`。client には構造を解釈させない
 * (= 将来 keyset の構成要素を変えても client を壊さないため)。実際、設計時点の案は
 * `id` (UUID) を tie-break に使うものだったが、同一 ms のメッセージの配信順が
 * 挿入順から崩れるため `rowid` に変更した。opaque なので client 側の変更は要らない。
 */
export function encodeCursor(cursor: UnreadCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.rowId}`, 'utf8').toString(
    'base64url'
  );
}

/**
 * opaque cursor を復号する (issue #388)。
 *
 * 解釈できない値は throw する。無言で「先頭から」に縮退させると、client からは
 * 「同じページが返り続ける」ようにしか見えず、原因が掴めなくなるため。
 */
export function decodeCursor(raw: string): UnreadCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new Error(`cursor を解釈できません: ${JSON.stringify(raw)}`);
  }
  const sep = decoded.indexOf('|');
  if (sep <= 0 || sep === decoded.length - 1) {
    throw new Error(`cursor を解釈できません: ${JSON.stringify(raw)}`);
  }
  const rowId = Number(decoded.slice(sep + 1));
  if (!Number.isInteger(rowId) || rowId < 0) {
    throw new Error(`cursor を解釈できません: ${JSON.stringify(raw)}`);
  }
  return {
    createdAt: decoded.slice(0, sep),
    rowId,
  };
}

/** レスポンスの 1 要素。`truncated` / `body_bytes` は body を切ったときだけ付く */
interface FormattedMessage {
  id: string;
  from: string;
  to: string;
  message: string;
  caused_by: string | null;
  timestamp: string;
  truncated?: true;
  body_bytes?: number;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * messages 配列を「1 メッセージ = 1 行」で直列化する (PR #400、operator 判断 (A))。
 *
 * pretty-print は応答を大きくし、compact (1 行) は text 全体が 1 行になって
 * Claude Code の退避ファイルが `Read` の offset/limit で読めなくなる。
 * メッセージ間だけを改行で区切り、メッセージの中は整形しないことで、最長行を
 * 最大の 1 件ぶんに抑えつつ parse 結果は従来と同じに保つ。
 *
 * 引数なし / envelope のどちらの経路もこの形を使う (形は 1 つ)。
 */
function stringifyMessages(items: FormattedMessage[]): string {
  if (items.length === 0) return '[]';
  return `[\n${items.map((m) => JSON.stringify(m)).join(',\n')}\n]`;
}

/**
 * 1 件だけで budget を超える message の body を budget まで切り詰める (issue #388)。
 *
 * 「1 件目だけで budget を超える場合は、その 1 件を必ず返す」ための処理。返さないと
 * 未読が永久に消化できず livelock が解けない。切った事実は `truncated` / `body_bytes`
 * (= 原寸 bytes) で明示し、無言では切らない。
 *
 * 直列化後のサイズは JSON escape や UTF-8 のマルチバイトで文字数と線形にならないため、
 * 「何文字まで残せるか」を code point 単位の二分探索で求める。サロゲートペアを割らない
 * ように `Array.from` で code point 配列にしてから切る。
 */
function truncateMessageToBudget(
  item: FormattedMessage,
  budget: number
): FormattedMessage {
  const bodyBytes = Buffer.byteLength(item.message, 'utf8');
  const chars = Array.from(item.message);

  const build = (charCount: number): FormattedMessage => ({
    ...item,
    message: chars.slice(0, charCount).join(''),
    truncated: true,
    body_bytes: bodyBytes,
  });

  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(build(mid)) <= budget) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  // lo === 0 でも budget を超えることがある (body 以外の固定部だけで超過する場合)。
  // その場合も「必ず 1 件返す」を優先し、body 空で返す。
  return build(lo);
}

/**
 * byte budget を適用して返す件数を決める (issue #388)。
 *
 * budget は `messages` 配列そのものの直列化サイズに対して効く。envelope の
 * 外枠 (`returned` / `has_more` / `remaining` / `next_cursor`) は固定長に近い
 * 数百 bytes の上乗せであり、budget には含めない。
 *
 * `limit` と budget は **先に当たった方が効く**。
 */
function applyByteBudget(
  items: FormattedMessage[],
  budget: number
): FormattedMessage[] {
  const included: FormattedMessage[] = [];
  // stringifyMessages() の外枠 `[\n` と `\n]` の 4 bytes ぶん
  let used = 4;

  for (const item of items) {
    // 2 件目以降は区切りの `,\n` 2 bytes ぶんを加算する
    const cost = byteLength(item) + (included.length > 0 ? 2 : 0);
    if (used + cost > budget) {
      if (included.length === 0) {
        // 1 件目だけで超過: body を切ってでも必ず 1 件返す
        included.push(truncateMessageToBudget(item, budget - 4));
      }
      break;
    }
    used += cost;
    included.push(item);
  }

  return included;
}

/**
 * get_messages ツール定義
 *
 * 自分宛の未読メッセージを取得する（受信箱）。
 * - DM: 自分宛のメッセージ
 * - チーム: 所属チーム宛のメッセージ
 * - 自分が送信したメッセージは除外
 * - 既読済みは除外
 *
 * 権限:
 * - 登録済みの参加者のみ
 */
export const getMessagesTool = {
  name: 'get_messages',
  description:
    '自分宛の未読メッセージを取得する。DM と所属チーム宛のメッセージが含まれる。日常のポーリング用。' +
    ' limit か cursor を指定すると { messages, returned, has_more, remaining, next_cursor } の' +
    ' envelope で返る (両方省略時は従来どおり配列を返す)。未読が多い場合は' +
    ' limit を付けて取得し、読んだぶんを mark_as_read することで次の呼び出しに前進する' +
    ' (既読になった分は未読集合から消えるため cursor は不要)。cursor は既読化せずに' +
    ' 先を覗く診断用途向け。既読化も cursor 送りもしないと同じページを取り続ける。' +
    ' 1 件で上限サイズを超えるメッセージは body を切り詰め、その要素に truncated: true と' +
    ' body_bytes (原寸) を付けて返す。切り詰められた本文の全文は' +
    ' get_thread { message_id } で取得できる。',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: GET_MESSAGES_LIMIT_MIN,
        maximum: GET_MESSAGES_LIMIT_MAX,
        description:
          '(optional) 1 回で返す最大件数。省略時は未読を全件返す。件数の上限であってサイズの上限ではないため、server 側の byte budget と先に当たった方が効く',
      },
      cursor: {
        type: 'string',
        description:
          '(optional) 前回応答の next_cursor。省略時は未読の先頭から。opaque な文字列であり、client 側で構造を解釈しないこと',
      },
    },
    required: [],
  },
};

/**
 * get_messages ツールのハンドラー
 *
 * @param scope - tenant scoped DB ハンドル
 * @param args - ツール引数（limit / cursor、いずれも optional）
 * @param userId - リクエスターのユーザーID（X-Participant-Id ヘッダーから取得）
 * @returns MCP CallToolResult
 */
export function handleGetMessages(
  scope: TenantScope,
  args: unknown,
  userId: string
): CallToolResult {
  try {
    // productive activity 観察 (= issue #26)、 inbox 消費は active engagement
    // (= empty fetch も polling-style active check を兼ねるため update する)
    scope.updateLastActiveAt(userId);

    const input = (args ?? {}) as { limit?: unknown; cursor?: unknown };

    let limit: number | null = null;
    const hasLimitArg = input.limit !== undefined && input.limit !== null;
    if (hasLimitArg) {
      const parsed = input.limit;
      if (
        typeof parsed !== 'number' ||
        !Number.isInteger(parsed) ||
        parsed < GET_MESSAGES_LIMIT_MIN ||
        parsed > GET_MESSAGES_LIMIT_MAX
      ) {
        throw new Error(
          `limit は ${GET_MESSAGES_LIMIT_MIN}..${GET_MESSAGES_LIMIT_MAX} の整数で指定してください (受信値: ${JSON.stringify(parsed)})`
        );
      }
      limit = parsed;
    }

    let after: UnreadCursor | undefined;
    const hasCursorArg = input.cursor !== undefined && input.cursor !== null;
    if (hasCursorArg) {
      if (typeof input.cursor !== 'string' || input.cursor === '') {
        throw new Error(
          `cursor は空でない文字列で指定してください (受信値: ${JSON.stringify(input.cursor)})`
        );
      }
      after = decodeCursor(input.cursor);
    }

    // envelope は opt-in。limit / cursor のどちらも無い呼び出しは、現行と同じ
    // 素の JSON 配列を返す (= 全既存 client は本 PR では壊れない)。
    // Phase 3 で AGENT_HUB_MCP_GET_MESSAGES_DEFAULT_LIMIT を設定すると、
    // 引数なし呼び出しも envelope + limit へ切り替わる。
    const defaultLimit = getGetMessagesDefaultLimit();
    if (limit === null) limit = defaultLimit;
    const useEnvelope = hasLimitArg || hasCursorArg || defaultLimit !== null;

    // userId は authenticateUser middleware が canonical `@<name>` でセット済
    const pageOptions: UnreadPageOptions = {};
    if (limit !== null) pageOptions.limit = limit;
    if (after) pageOptions.after = after;

    const messages = scope.getUnreadMessages(userId, pageOptions);

    // cursor の keyset は rowid ベースなので、レスポンスに載せない row_id を
    // 添えて持ち回る (露出すると client が opaque cursor を自作しかねないため
    // FormattedMessage 側には入れない)。
    const formattedMessages: FormattedMessage[] = messages.map((msg) => ({
      id: msg.id,
      from: msg.sender,
      to: msg.recipient,
      message: msg.body,
      caused_by: msg.caused_by ?? null,
      timestamp: msg.created_at,
    }));
    const rowIdByMessageId = new Map(messages.map((m) => [m.id, m.row_id]));

    const maxBytes = getGetMessagesMaxBytes();

    if (!useEnvelope) {
      const text = stringifyMessages(formattedMessages);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > maxBytes) {
        // Phase 1 では引数なし呼び出しを打ち切らない (挙動不変) 代わりに、
        // 「まだ移行していない consumer は誰か」を運用ログで見えるようにする。
        // Phase 2 はこの WARN が連続 7 日ゼロになることを次段の合格条件にする。
        console.warn(
          `[MCP] get_messages unbounded response exceeds byte budget: ` +
            `participant=${userId} bytes=${bytes} unread_count=${formattedMessages.length} ` +
            `budget=${maxBytes} — client 側に行長上限があると受信不能 livelock になる。` +
            `limit 付きの呼び出しへ移行すること (issue #388)`
        );
      }
      return { content: [{ type: 'text', text }] };
    }

    const page = applyByteBudget(formattedMessages, maxBytes);
    const last = page.length > 0 ? page[page.length - 1] : undefined;
    const lastRowId = last ? rowIdByMessageId.get(last.id) : undefined;
    const lastCursor: UnreadCursor | undefined =
      last && lastRowId !== undefined
        ? { createdAt: last.timestamp, rowId: lastRowId }
        : after;

    // 残件は「今回返した最後の 1 件より後ろ」で数える。page が空の場合
    // (= 未読なし、または cursor が終端) は要求位置のまま数えるので 0 になる。
    const remaining = lastCursor
      ? scope.countUnreadMessages(userId, lastCursor)
      : 0;
    const hasMore = remaining > 0;

    return {
      content: [
        {
          type: 'text',
          // messages だけを 1 メッセージ 1 行で埋め込み、外枠のフィールドは
          // 従来と同じ順で最終行に続ける
          text:
            `{"messages":${stringifyMessages(page)}` +
            `,"returned":${page.length}` +
            `,"has_more":${hasMore}` +
            `,"remaining":${remaining}` +
            `,"next_cursor":${JSON.stringify(
              hasMore && lastCursor ? encodeCursor(lastCursor) : null
            )}}`,
        },
      ],
    };
  } catch (error) {
    // ビジネスロジックエラー
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'get_messages failed',
              message: errorMessage,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}
