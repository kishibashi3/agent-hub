/**
 * admin tools — only callable by the user whose handle is "admin".
 *
 * The "admin" handle is the privileged peer; whoever first registers the
 * @admin handle becomes the operator (TOFU via PAT). Other peers cannot
 * register until @admin exists (see register.ts bootstrap gate).
 *
 * No schema changes — admin status IS the handle name. Authorization is a
 * simple `userId === "admin"` check at the top of each handler. PAT auth
 * already ensures the caller actually owns the @admin handle.
 */
import type { TenantScope } from '../../db/tenant-scope.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * list_sessions_by_participant ハンドラに渡す session の最小 shape。
 * Session interface (server.ts) から transport / server を除いた observable フィールドのみ。
 * テストでは実 Session を組み立てず純粋関数として検証できる (= PresenceSession と同じ設計方針)。
 */
export interface SessionView {
  tenantDomain: string;
  userId: string;
  githubLogin: string;
  subscribedUris: ReadonlySet<string>;
  createdAt: number; // Date.now() at session creation
}

const ADMIN_HANDLE = '@admin';

function ensureAdmin(userId: string): CallToolResult | null {
  // userId は authenticateUser middleware が canonical `@<name>` でセット済
  if (userId !== ADMIN_HANDLE) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { error: 'forbidden', message: 'admin tools require @admin' },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  return null;
}

function errorResult(error: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error, message }, null, 2) }],
    isError: true,
  };
}

function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

// ---- delete_participant ------------------------------------------------------------

const deleteParticipantInput = z.object({
  name: z.string().min(1, 'name required'),
});

export const deleteParticipantTool = {
  name: 'delete_participant',
  description:
    '[admin] participant を soft delete する (deleted_at をセット、行は残す)。これにより既存メッセージ / チーム / 既読の FK 制約は破られない。@admin は削除不可。所有チームがあっても拒否しない (削除後はそのチームを別 admin が引き継ぐ想定)。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '削除する participant 名 (@ あり/なし両方可)' },
    },
    required: ['name'],
  },
};

export async function handleDeleteParticipant(
  scope: TenantScope,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  const denied = ensureAdmin(userId);
  if (denied) return denied;

  let input: z.infer<typeof deleteParticipantInput>;
  try {
    input = deleteParticipantInput.parse(args);
  } catch (error) {
    return errorResult(
      'delete_participant failed',
      error instanceof Error ? error.message : String(error)
    );
  }

  const handleName = input.name.startsWith('@') ? input.name : `@${input.name}`;

  if (handleName === '@admin') {
    return errorResult('delete_participant failed', '@admin は削除できません');
  }

  const participant = scope.getParticipantByName(handleName);
  if (!participant) {
    return errorResult(
      'delete_participant failed',
      `participant '${handleName}' が見つかりません`
    );
  }

  const removed = scope.softDeleteParticipant(handleName);
  if (!removed) {
    return errorResult(
      'delete_participant failed',
      `soft delete に失敗 (既に削除済 or 行なし)`
    );
  }

  return ok({ deleted: handleName, mode: 'soft' });
}

// ---- get_participant_history -------------------------------------------------------

const getParticipantHistoryInput = z.object({
  name: z.string().min(1, 'name required'),
  limit: z.number().int().positive().max(500).optional(),
});

export const getParticipantHistoryTool = {
  name: 'get_participant_history',
  description:
    '[admin] 指定した participant が送受信した全メッセージを時系列で取得する。@admin だけが他人の履歴を覗ける。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '対象 participant 名 (@ あり/なし両方可)' },
      limit: {
        type: 'number',
        description: '取得件数上限 (default 50, max 500)',
      },
    },
    required: ['name'],
  },
};

export async function handleGetParticipantHistory(
  scope: TenantScope,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  const denied = ensureAdmin(userId);
  if (denied) return denied;

  let input: z.infer<typeof getParticipantHistoryInput>;
  try {
    input = getParticipantHistoryInput.parse(args);
  } catch (error) {
    return errorResult(
      'get_participant_history failed',
      error instanceof Error ? error.message : String(error)
    );
  }

  const handleName = input.name.startsWith('@') ? input.name : `@${input.name}`;
  const limit = input.limit ?? 50;

  const participant = scope.getParticipantByName(handleName);
  if (!participant) {
    return errorResult(
      'get_participant_history failed',
      `participant '${handleName}' が見つかりません`
    );
  }

  const messages = scope.db
    .prepare(
      `SELECT * FROM messages
       WHERE tenant_id = ? AND (sender = ? OR recipient = ?)
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`
    )
    .all(scope.tenantId, handleName, handleName, limit) as unknown[];

  return ok({ participant: handleName, count: messages.length, messages });
}

// ---- list_sessions_by_participant --------------------------------------------------

const listSessionsByParticipantInput = z.object({
  name: z.string().min(1, 'name required'),
  /**
   * tenant_id でフィルタ。 null / 省略 = 全 tenant を横断検索。
   * 指定する場合は X-Tenant-Id ヘッダー値 (例: 'default') と一致させる。
   */
  tenant: z.string().nullable().optional(),
});

export const listSessionsByParticipantTool = {
  name: 'list_sessions_by_participant',
  description:
    '[admin] 指定 participant の active session 一覧を返す。zombie session 蓄積の観測・issue #114 verify・incident response に使用。tenant 省略 = 全 tenant 横断。',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '対象 participant 名 (@ あり/なし両方可)',
      },
      tenant: {
        type: 'string',
        nullable: true,
        description: 'tenant_id でフィルタ (省略 / null = 全 tenant)',
      },
    },
    required: ['name'],
  },
};

/**
 * list_sessions_by_participant ハンドラ。
 *
 * @param scope          - テナントスコープ付き DB ハンドル (last_active_at lookup に使用)
 * @param args           - ツール引数 (name, tenant?)
 * @param userId         - 呼び出し元ユーザー ID (@ 付き canonical)
 * @param sessionEntries - sessions Map の Iterable (server.ts から渡す)。
 *                         SessionView の superset であれば型互換 (= 実 Session を直接渡せる)。
 */
export async function handleListSessionsByParticipant(
  scope: TenantScope,
  args: unknown,
  userId: string,
  sessionEntries: Iterable<readonly [string, SessionView]>
): Promise<CallToolResult> {
  const denied = ensureAdmin(userId);
  if (denied) return denied;

  let input: z.infer<typeof listSessionsByParticipantInput>;
  try {
    input = listSessionsByParticipantInput.parse(args);
  } catch (error) {
    return errorResult(
      'list_sessions_by_participant failed',
      error instanceof Error ? error.message : String(error)
    );
  }

  const handleName = input.name.startsWith('@') ? input.name : `@${input.name}`;
  const tenantFilter = input.tenant ?? null;

  const results: Array<{
    session_id: string;
    tenant_id: string;
    user: string;
    github_login: string;
    created_at: string;
    last_active_at: string | null;
    subscribed_uris: string[];
    is_alive: boolean;
  }> = [];

  for (const [sid, session] of sessionEntries) {
    if (session.userId !== handleName) continue;
    if (tenantFilter !== null && session.tenantDomain !== tenantFilter) continue;

    // participants.last_active_at を DB から直接 lookup (cross-tenant 対応のため scope.db を使用)
    const participantRow = scope.db
      .prepare(
        `SELECT last_active_at FROM participants WHERE tenant_id = ? AND name = ?`
      )
      .get(session.tenantDomain, session.userId) as
      | { last_active_at: string | null }
      | undefined;

    results.push({
      session_id: sid,
      tenant_id: session.tenantDomain,
      user: session.userId,
      github_login: session.githubLogin,
      created_at: new Date(session.createdAt).toISOString(),
      last_active_at: participantRow?.last_active_at ?? null,
      subscribed_uris: Array.from(session.subscribedUris),
      // sessions Map にある = SSE alive (= dead session は ping loop が Map から削除済み)
      is_alive: true,
    });
  }

  // created_at DESC (最近 create された session を先頭に)
  results.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return ok({ participant: handleName, tenant: tenantFilter, count: results.length, sessions: results });
}
