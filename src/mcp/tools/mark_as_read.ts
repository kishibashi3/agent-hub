import type { TenantScope } from '../../db/tenant-scope.js';
import { markAsReadInputSchema } from '../../types/schema.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * mark_as_read ツール定義
 * 
 * メッセージを既読にする。
 * - 自分宛のメッセージのみ既読可能
 * - DM: 受信者のみ
 * - チーム: メンバーのみ
 * - 重複した既読登録は無視される
 * 
 * 権限:
 * - 自分宛のメッセージのみ既読にできる
 * - チーム宛の場合、メンバーであれば既読可能
 */
export const markAsReadTool = {
  name: 'mark_as_read',
  description:
    'メッセージを既読にする。自分宛のメッセージ（DM またはチーム）のみ既読可能。message_id（単数）または message_ids（複数）のいずれかを指定すること。',
  inputSchema: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: '既読にするメッセージの ID（UUID 形式）。後方互換用。',
      },
      message_ids: {
        type: 'array',
        items: { type: 'string' },
        description: '既読にするメッセージの ID 一覧（UUID 形式）。複数件を 1 call で既読化する。',
      },
    },
  },
};

/**
 * mark_as_read ツールのハンドラー
 * 
 * @param db - データベースインスタンス
 * @param args - ツール引数（message_id）
 * @param userId - リクエスターのユーザーID（X-Participant-Id ヘッダーから取得）
 * @returns MCP CallToolResult
 */
export async function handleMarkAsRead(
  scope: TenantScope,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  try {
    const input = markAsReadInputSchema.parse(args);

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // 単数・複数を統合（重複除去）
    const ids: string[] = [];
    if (input.message_id !== undefined) {
      ids.push(input.message_id);
    }
    if (input.message_ids !== undefined) {
      for (const id of input.message_ids) {
        if (!ids.includes(id)) ids.push(id);
      }
    }

    // UUID 形式の検証（全件）
    for (const id of ids) {
      if (!uuidRegex.test(id)) {
        throw new Error(`message_id "${id}" は UUID 形式である必要があります`);
      }
    }

    // userId は authenticateUser middleware が canonical `@<name>` でセット済
    const reader = userId;

    // productive activity 観察 (= issue #26)、 mark_as_read は inbox triage = active engagement
    scope.updateLastActiveAt(reader);

    // 各メッセージの存在・権限確認と既読記録
    const results = ids.map((id) => {
      scope.getMessage(id, reader);
      const result = scope.markAsRead(id, reader);
      return { message_id: id, reader, read: result.read };
    });

    // 後方互換: message_id 単体指定（message_ids なし）の場合は旧レスポンス形式を維持
    if (input.message_id !== undefined && input.message_ids === undefined) {
      return {
        content: [{ type: 'text', text: JSON.stringify(results[0], null, 2) }],
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'mark_as_read failed', message: errorMessage }, null, 2),
        },
      ],
      isError: true,
    };
  }
}
