import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { deleteTeam } from '../../db/teams.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * delete_team ツール引数スキーマ
 */
const deleteTeamInputSchema = z.object({
  name: z.string().min(1),
});

/**
 * delete_team ツール定義
 * 
 * チームを削除する。
 * - team_members は CASCADE で自動削除される
 * - メッセージは履歴として保持される（外部キー制約なし）
 * 
 * 権限:
 * - オーナーのみ削除可能
 */
export const deleteTeamTool = {
  name: 'delete_team',
  description:
    'チームを削除する。メンバー情報は削除されるが、過去のメッセージは履歴として残る。',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'チーム名（@ なしでも可）',
      },
    },
    required: ['name'],
  },
};

/**
 * delete_team ツールのハンドラー
 * 
 * @param db - データベースインスタンス
 * @param args - ツール引数（name）
 * @param userId - 実行者のユーザーID（X-User-Id ヘッダーから取得）
 * @returns MCP CallToolResult
 */
export async function handleDeleteTeam(
  db: Database,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  try {
    // 引数のバリデーション
    const input = deleteTeamInputSchema.parse(args);

    // userId は authenticateUser middleware が canonical `@<name>` でセット済
    const requester = userId;

    // チーム削除
    const result = deleteTeam(db, input.name, requester);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              deleted: result.deleted,
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
              error: 'delete_team failed',
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
