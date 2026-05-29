import type { TenantScope } from '../../db/tenant-scope.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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
    '自分宛の未読メッセージを取得する。DM と所属チーム宛のメッセージが含まれる。日常のポーリング用。',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * get_messages ツールのハンドラー
 * 
 * @param db - データベースインスタンス
 * @param args - ツール引数（なし）
 * @param userId - リクエスターのユーザーID（X-User-Id ヘッダーから取得）
 * @returns MCP CallToolResult
 */
export async function handleGetMessages(
  scope: TenantScope,
  _args: unknown,
  userId: string
): Promise<CallToolResult> {
  try {
    // productive activity 観察 (= issue #26)、 inbox 消費は active engagement
    // (= empty fetch も polling-style active check を兼ねるため update する)
    scope.updateLastActiveAt(userId);

    // userId は authenticateUser middleware が canonical `@<name>` でセット済
    const messages = scope.getUnreadMessages(userId);

    // レスポンス形式に変換
    const formattedMessages = messages.map((msg) => ({
      id: msg.id,
      from: msg.sender,
      to: msg.recipient,
      message: msg.body,
      caused_by: msg.caused_by ?? null,
      timestamp: msg.created_at,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(formattedMessages, null, 2),
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
