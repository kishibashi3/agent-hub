import type { Database } from 'better-sqlite3';
import { getUnreadMessages } from '../../db/messages.js';
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
  db: Database,
  _args: unknown,
  userId: string
): Promise<CallToolResult> {
  try {
    // userId は authenticateUser middleware が canonical `@<name>` でセット済
    const messages = getUnreadMessages(db, userId);

    // レスポンス形式に変換
    const formattedMessages = messages.map((msg) => ({
      id: msg.id,
      from: msg.sender,
      to: msg.recipient,
      message: msg.body,
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
