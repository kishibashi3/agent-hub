import type { Database } from 'better-sqlite3';
import { updateTeamInputSchema } from '../../types/schema.js';
import { updateTeam } from '../../db/teams.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * update_team ツール定義
 * 
 * チームのメンバーを追加・削除する。
 * - add: メンバーを追加（冪等性確保）
 * - remove: メンバーを削除（冪等性確保）
 * - オーナー自身の削除は拒否
 * - 最低1人のメンバーが必要（オーナーを含む）
 * 
 * 権限:
 * - オーナーのみ実行可能
 */
export const updateTeamTool = {
  name: 'update_team',
  description:
    'チームのメンバーを追加・削除する。add と remove は配列で指定。オーナー自身の削除は不可。',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'チーム名（@ なしでも可）',
      },
      add: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: '追加するメンバーの参加者名リスト',
      },
      remove: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: '削除するメンバーの参加者名リスト',
      },
    },
    required: ['name'],
  },
};

/**
 * update_team ツールのハンドラー
 * 
 * @param db - データベースインスタンス
 * @param args - ツール引数（name, add?, remove?）
 * @param userId - 実行者のユーザーID（X-User-Id ヘッダーから取得）
 * @returns MCP CallToolResult
 */
export async function handleUpdateTeam(
  db: Database,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  try {
    // 引数のバリデーション
    const input = updateTeamInputSchema.parse(args);

    // userId は authenticateUser middleware が canonical `@<name>` でセット済
    const requester = userId;

    // チーム更新
    const result = updateTeam(db, input, requester);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              name: result.name,
              members: result.members,
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
              error: 'update_team failed',
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
