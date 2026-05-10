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

// ---- delete_user ------------------------------------------------------------

const deleteUserInput = z.object({
  name: z.string().min(1, 'name required'),
});

export const deleteUserTool = {
  name: 'delete_user',
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

export async function handleDeleteUser(
  scope: TenantScope,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  const denied = ensureAdmin(userId);
  if (denied) return denied;

  let input: z.infer<typeof deleteUserInput>;
  try {
    input = deleteUserInput.parse(args);
  } catch (error) {
    return errorResult(
      'delete_user failed',
      error instanceof Error ? error.message : String(error)
    );
  }

  const handleName = input.name.startsWith('@') ? input.name : `@${input.name}`;

  if (handleName === '@admin') {
    return errorResult('delete_user failed', '@admin は削除できません');
  }

  const participant = scope.getParticipantByName(handleName);
  if (!participant) {
    return errorResult(
      'delete_user failed',
      `participant '${handleName}' が見つかりません`
    );
  }

  const removed = scope.softDeleteParticipant(handleName);
  if (!removed) {
    return errorResult(
      'delete_user failed',
      `soft delete に失敗 (既に削除済 or 行なし)`
    );
  }

  return ok({ deleted: handleName, mode: 'soft' });
}

// ---- get_user_history -------------------------------------------------------

const getUserHistoryInput = z.object({
  name: z.string().min(1, 'name required'),
  limit: z.number().int().positive().max(500).optional(),
});

export const getUserHistoryTool = {
  name: 'get_user_history',
  description:
    '[admin] 指定した peer が送受信した全メッセージを時系列で取得する。@admin だけが他人の履歴を覗ける。',
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

export async function handleGetUserHistory(
  scope: TenantScope,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  const denied = ensureAdmin(userId);
  if (denied) return denied;

  let input: z.infer<typeof getUserHistoryInput>;
  try {
    input = getUserHistoryInput.parse(args);
  } catch (error) {
    return errorResult(
      'get_user_history failed',
      error instanceof Error ? error.message : String(error)
    );
  }

  const handleName = input.name.startsWith('@') ? input.name : `@${input.name}`;
  const limit = input.limit ?? 50;

  const participant = scope.getParticipantByName(handleName);
  if (!participant) {
    return errorResult(
      'get_user_history failed',
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

  return ok({ user: handleName, count: messages.length, messages });
}
