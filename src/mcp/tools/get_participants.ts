import type { TenantScope } from '../../db/tenant-scope.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * get_participants ツール定義
 *
 * 登録済みの全参加者 (person) とチーム (team) を 1 つの一覧で返す。
 * 返却値は type フィールドで判別可能な discriminated union:
 *
 *   - type: 'person' → { name, type, display_name, mode, is_online }
 *   - type: 'team'   → { name, type, owner, members, created_at }
 *
 * 並び順は person → team の固定 order (UI 側の重複ソートを避けるため)。
 * person はこれまで通り created_at 降順、team は created_at 降順 (teams.ts 既定)。
 *
 * 権限:
 * - 誰でも取得可能 (同 tenant 内に限る; tenant 境界は TenantScope が enforce)
 */
export const getParticipantsTool = {
  name: 'get_participants',
  description:
    '登録済みの全参加者 (person) とチーム (team) を返す。' +
    'person は name, type, display_name, mode (peer の worker type), is_online (= 自分の inbox を SSE subscribe 中) を持ち、' +
    'team は name, type, owner, members (= @handle 配列), created_at を持つ。' +
    'type フィールドで person/team を判別する。',
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
 * get_participants の返却 entry。
 *
 * person と team で持つフィールドが異なるため discriminated union として表現する。
 * `type` でナローイング可能。
 */
export type ParticipantEntry =
  | {
      name: string;
      type: 'person';
      display_name: string | null;
      mode: string | null;
      is_online: boolean;
    }
  | {
      name: string;
      type: 'team';
      owner: string;
      members: string[];
      created_at: string;
    };

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
    const teams = scope.getTeams();

    const personEntries: ParticipantEntry[] = participants.map((p) => ({
      name: p.name,
      type: 'person' as const,
      display_name: p.display_name,
      mode: p.mode,
      is_online: isOnline(p.name),
    }));

    // 各 team について members を都度 fetch する。
    // 件数が増えたら N+1 が問題になるが、CE alpha 段階ではチーム数も
    // 高々数十件 / tenant 想定なので素朴に実装する (将来 JOIN 化候補)。
    const teamEntries: ParticipantEntry[] = teams.map((t) => ({
      name: t.name,
      type: 'team' as const,
      owner: t.owner,
      members: scope.getTeamMembers(t.name),
      created_at: t.created_at,
    }));

    const result: ParticipantEntry[] = [...personEntries, ...teamEntries];

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
