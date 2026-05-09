import type { Database } from 'better-sqlite3';
import { createTeamInputSchema } from '../../types/schema.js';
import { createTeam } from '../../db/teams.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * create_team ツール定義
 * 
 * チームを作成する。
 * - 作成者は自動的にオーナーかつメンバーになる
 * - members に自分を含めなくても自動追加される
 * - @ プレフィックスは自動付与
 * 
 * 権限:
 * - 登録済みの参加者であれば誰でも作成可能
 */
export const createTeamTool = {
  name: 'create_team',
  description:
    'チームを作成する。作成者は自動的にオーナーかつメンバーになる。members に自分を含めなくても自動追加される。',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'チーム名（@ なし、英数字とハイフンのみ）',
      },
      members: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'メンバーの参加者名リスト（@ なしでも可）',
      },
    },
    required: ['name', 'members'],
  },
};

/**
 * create_team ツールのハンドラー
 * 
 * @param db - データベースインスタンス
 * @param args - ツール引数（name, members）
 * @param userId - 作成者のユーザーID（X-User-Id ヘッダーから取得）
 * @returns MCP CallToolResult
 */
export async function handleCreateTeam(
  db: Database,
  args: unknown,
  userId: string
): Promise<CallToolResult> {
  try {
    // 引数のバリデーション
    const input = createTeamInputSchema.parse(args);

    // userId は authenticateUser middleware が canonical `@<name>` でセット済
    const requester = userId;

    // チーム作成
    const team = createTeam(db, input, requester);

    // メンバー一覧を取得
    const members = db
      .prepare('SELECT member_name FROM team_members WHERE team_name = ? ORDER BY joined_at')
      .all(team.name) as { member_name: string }[];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              name: team.name,
              owner: team.owner,
              members: members.map(m => m.member_name),
              created_at: team.created_at,
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
              error: 'create_team failed',
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
