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
    '登録済みの全参加者を取得する。name, type (person/team), display_name, mode (peer の worker type), is_online (= 自分の inbox を SSE subscribe 中かどうか) を含む。',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * handle 名 → online 判定の callback (issue #1 depth A)。
 *
 * server.ts 側で sessions Map を closure に閉じ込めて渡す。
 * 単体テスト / 過去の呼び出し互換のため optional にし、未指定なら
 * 「全員 offline」(= subscribe 経路がない状態) として扱う。
 */
export type IsOnlineFn = (handleName: string) => boolean;

/**
 * get_participants ツールのハンドラー
 *
 * @param scope - tenant scoped DB ハンドル
 * @param _args - ツール引数（なし）
 * @param _userId - X-User-Id ヘッダーから取得したユーザーID（未使用）
 * @param isOnline - 各 participant が online (= SSE 在席中) かを判定するコールバック。
 *                   未指定なら全員 offline を返す (DB 単独テスト用フォールバック)。
 * @returns MCP CallToolResult
 */
export async function handleGetParticipants(
  scope: TenantScope,
  _args: unknown,
  _userId: string,
  isOnline: IsOnlineFn = () => false
): Promise<CallToolResult> {
  try {
    const participants = scope.getParticipants();

    // TODO: チーム情報も取得して統合する（現時点では participants のみ）
    const result = participants.map((p) => ({
      name: p.name,
      type: 'person' as const,
      display_name: p.display_name,
      mode: p.mode,
      is_online: isOnline(p.name),
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
