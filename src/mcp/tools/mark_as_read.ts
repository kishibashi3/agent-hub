import type { Database } from 'better-sqlite3';
import { markAsReadInputSchema } from '../../types/schema.js';
import { markAsRead, getMessage } from '../../db/messages.js';
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
    'メッセージを既読にする。自分宛のメッセージ（DM またはチーム）のみ既読可能。',
  inputSchema: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: '既読にするメッセージの ID（UUID 形式）',
      },
    },
    required: ['message_id'],
  },
};

/**
 * mark_as_read ツールのハンドラー
 * 
 * @param db - データベースインスタンス
 * @param args - ツール引数（message_id）
 * @param userId - リクエスターのユーザーID（X-User-Id ヘッダーから取得）
 * @returns MCP CallToolResult
 */
export async function handleMarkAsRead(
  db: Database,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  try {
    // 引数のバリデーション
    const input = markAsReadInputSchema.parse(args);

    // UUID 形式の検証
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(input.message_id)) {
      throw new Error('message_id は UUID 形式である必要があります');
    }

    // userId は authenticateUser middleware が canonical `@<name>` でセット済
    const reader = userId;

    // メッセージの存在と権限を確認（getMessage で検証）
    getMessage(db, input.message_id, reader);

    // 既読を記録
    const result = markAsRead(db, input.message_id, reader);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message_id: input.message_id,
              reader: reader,
              read: result.read,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    // バリデーションエラーまたはビジネスロジックエラー
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'mark_as_read failed',
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
