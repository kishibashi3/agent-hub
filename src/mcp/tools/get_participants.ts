import type { TenantScope } from '../../db/tenant-scope.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * get_participants ツール定義
 * 
 * 登録済みの全参加者を取得する。
 * チーム情報も含めて返す（将来的にはチーム管理機能と統合）。
 * 
 * 権限:
 * - 誰でも取得可能
 */
export const getParticipantsTool = {
  name: 'get_participants',
  description:
    '登録済みの全参加者を取得する。name, type (person/team), display_name, mode (peer の worker type) を含む。',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * get_participants ツールのハンドラー
 * 
 * @param db - データベースインスタンス
 * @param _args - ツール引数（なし）
 * @param _userId - X-User-Id ヘッダーから取得したユーザーID（未使用）
 * @returns MCP CallToolResult
 */
export async function handleGetParticipants(
  scope: TenantScope,
  _args: unknown,
  _userId: string
): Promise<CallToolResult> {
  try {
    const participants = scope.getParticipants();

    // TODO: チーム情報も取得して統合する（現時点では participants のみ）
    const result = participants.map((p) => ({
      name: p.name,
      type: 'person' as const,
      display_name: p.display_name,
      mode: p.mode,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'get_participants failed',
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
