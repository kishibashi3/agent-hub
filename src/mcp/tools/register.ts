import { registerInputSchema } from '../../types/schema.js';
import type { TenantScope } from '../../db/tenant-scope.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const registerTool = {
  name: 'register',
  description:
    '新規参加者を agent-hub に登録する。name は英数字とハイフンのみ。mode で peer の worker type (stateful/stateless/global) を宣言できる。登録後は get_participants の一覧に表示される。',
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
      mode: {
        type: 'string',
        enum: ['stateful', 'stateless', 'global'],
        description:
          'peer の worker type 宣言（任意）: stateful=peer 別文脈保持、stateless=単発、global=共有場',
      },
    },
    required: ['name'],
  },
};

/**
 * register ツールのハンドラー
 *
 * @param scope - tenant scoped DB ハンドル
 * @param args - ツール引数（name, display_name?, mode?）
 * @param _userId - 現在のセッションのハンドル（参考情報）
 * @param githubLogin - PAT で検証された GitHub login。新規登録時の owner として使う
 */
export async function handleRegister(
  scope: TenantScope,
  args: unknown,
  _userId: string,
  githubLogin: string
): Promise<CallToolResult> {
  try {
    const input = registerInputSchema.parse(args);
    const handleName = `@${input.name}`;

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
    } else if (existing.owner === githubLogin) {
      if (input.mode !== undefined && input.mode !== existing.mode) {
        scope.updateParticipantMode(handleName, input.mode);
        participant = scope.getParticipantByName(handleName)!;
      } else {
        participant = existing;
      }
    } else if (existing.owner === null) {
      scope.claimOwnerIfUnowned(handleName, githubLogin);
      if (input.mode !== undefined) {
        scope.updateParticipantMode(handleName, input.mode);
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
