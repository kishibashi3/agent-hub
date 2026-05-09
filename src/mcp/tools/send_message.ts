import type { Database } from 'better-sqlite3';
import { sendMessageInputSchema } from '../../types/schema.js';
import { sendMessage } from '../../db/messages.js';
import { getTeamMembers } from '../../db/teams.js';
import { notifyResourceUpdated, inboxUriFor } from '../server.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * send_message ツール定義
 * 
 * DM またはチーム宛にメッセージを送信する。
 * - DM: to が @個人名 の場合、1対1のメッセージ
 * - チーム: to が @チーム名 の場合、メンバー全員に配信（送信者自身は除く）
 * 
 * 権限:
 * - DM: 登録済みなら誰でも送信可能
 * - チーム: メンバーのみ送信可能
 */
export const sendMessageTool = {
  name: 'send_message',
  description:
    'DM またはチーム宛にメッセージを送信する。to が @個人名 なら DM、@チーム名 ならチーム全体に配信される。',
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: '宛先（@個人名 または @チーム名）',
      },
      message: {
        type: 'string',
        description: '送信するメッセージ本文',
      },
    },
    required: ['to', 'message'],
  },
};

/**
 * send_message ツールのハンドラー
 * 
 * @param db - データベースインスタンス
 * @param args - ツール引数（to, message）
 * @param userId - 送信者のユーザーID（X-User-Id ヘッダーから取得）
 * @returns MCP CallToolResult
 */
export async function handleSendMessage(
  db: Database,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  try {
    // 引数のバリデーション
    const input = sendMessageInputSchema.parse(args);

    // userId は authenticateUser middleware が canonical `@<name>` でセット済
    const sender = userId;

    // メッセージ送信
    const message = sendMessage(db, input, sender);

    // リアルタイム通知発火（best-effort、失敗しても送信自体は成功扱い）
    try {
      const teamMembers = getTeamMembers(db, message.recipient);
      const recipients =
        teamMembers.length > 0
          ? teamMembers.filter((m) => m !== sender) // チーム宛: メンバー全員（送信者除く）
          : [message.recipient]; // DM 宛
      for (const r of recipients) {
        notifyResourceUpdated(inboxUriFor(r));
      }
    } catch (notifyErr) {
      console.error('[send_message] notify failed (non-fatal):', notifyErr);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              id: message.id,
              from: message.sender,
              to: message.recipient,
              message: message.body,
              timestamp: message.created_at,
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
              error: 'send_message failed',
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
