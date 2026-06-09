import { registerInputSchema } from '../../types/schema.js';
import type { PeerMode } from '../../types/schema.js';
import type { TenantScope } from '../../db/tenant-scope.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const registerTool = {
  name: 'register',
  description:
    '新規参加者を agent-hub に登録する。name は英数字とハイフンのみ。mode は X-Agent-Hub-Client ヘッダーからサーバーが自動決定する。登録後は get_participants の一覧に表示される。',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: '参加者名（@ なし、英数字とハイフンのみ）',
      },
      display_name: {
        type: 'string',
        description: 'オプションの表示名',
      },
    },
    required: ['name'],
  },
};

/**
 * X-Agent-Hub-Client ヘッダー値から peer mode を推論する (issue #276)。
 *
 * prefix マッピング:
 *   agent-hub-plugin/<handle>  → global
 *   agent-hub-bridge/<type>    → stateful
 *   agent-hub-client/<type>    → stateless
 *   agent-hub-dashboard2       → global
 *   agenthubctl                → global
 *   null / 不明               → null (モード未宣言のまま)
 */
export function inferModeFromClientType(clientType: string | null): PeerMode | null {
  if (!clientType) return null;
  if (clientType.startsWith('agent-hub-plugin/')) return 'global';
  if (clientType.startsWith('agent-hub-bridge/')) return 'stateful';
  if (clientType.startsWith('agent-hub-client/')) return 'stateless';
  if (clientType === 'agent-hub-dashboard2') return 'global';
  if (clientType === 'agenthubctl') return 'global';
  return null;
}

/**
 * register ツールのハンドラー
 *
 * @param scope - tenant scoped DB ハンドル
 * @param args - ツール引数（name, display_name?）
 * @param _userId - 現在のセッションのハンドル（参考情報）
 * @param githubLogin - PAT で検証された GitHub login。新規登録時の owner として使う
 * @param clientType - X-Agent-Hub-Client ヘッダー値。mode 自動決定に使用
 */
export async function handleRegister(
  scope: TenantScope,
  args: unknown,
  _userId: string,
  githubLogin: string,
  clientType: string | null = null
): Promise<CallToolResult> {
  try {
    const input = registerInputSchema.parse(args);
    const handleName = `@${input.name}`;
    const inferredMode = inferModeFromClientType(clientType);

    const existing = scope.getParticipantByName(handleName);

    // Bootstrap gate: until @admin exists, only the @admin handle can register.
    const adminExists = scope.getParticipantByName('@admin') !== null;
    if (!existing && !adminExists && input.name !== 'admin') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'hub_not_initialized',
                message:
                  'agent-hub is not initialized. The first registrant must claim the @admin handle.',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    let participant;
    if (!existing) {
      participant = scope.registerParticipant(input, githubLogin);
      if (inferredMode !== null) {
        scope.updateParticipantMode(handleName, inferredMode);
        participant = scope.getParticipantByName(handleName)!;
      }
    } else if (existing.owner === githubLogin) {
      // 自分が既に所有 → mode / display_name を更新可能
      let changed = false;
      if (inferredMode !== null && inferredMode !== existing.mode) {
        scope.updateParticipantMode(handleName, inferredMode);
        changed = true;
      }
      if (
        input.display_name !== undefined &&
        input.display_name !== existing.display_name
      ) {
        scope.updateParticipantDisplayName(handleName, input.display_name);
        changed = true;
      }
      participant = changed ? scope.getParticipantByName(handleName)! : existing;
    } else if (existing.owner === null) {
      scope.claimOwnerIfUnowned(handleName, githubLogin);
      if (inferredMode !== null) {
        scope.updateParticipantMode(handleName, inferredMode);
      }
      if (input.display_name !== undefined) {
        scope.updateParticipantDisplayName(handleName, input.display_name);
      }
      participant = scope.getParticipantByName(handleName)!;
    } else {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'register failed',
                message: `参加者 '${handleName}' は他のユーザー所有です`,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    // productive activity 観察 (= issue #26)、 register は spawn / re-register signal
    // ("いま起き上がった") として update する。 失敗 path より後ろに置くことで
    // 「実際に登録 / 更新が完了した時点」 を意味するようにする。
    scope.updateLastActiveAt(handleName);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              name: participant.name,
              type: 'person',
              display_name: participant.display_name,
              owner: participant.owner,
              mode: participant.mode,
              created_at: participant.created_at,
            },
            null,
            2
          ),
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
            { error: 'register failed', message: errorMessage },
            null,
            2
          ),
        },
      ],
    isError: true,
    };
  }
}
