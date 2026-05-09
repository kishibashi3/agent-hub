import type { Database } from 'better-sqlite3';
import { registerInputSchema } from '../../types/schema.js';
import {
  registerParticipant,
  getParticipantByName,
  claimOwnerIfUnowned,
  updateParticipantMode,
} from '../../db/participants.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * register ツール定義
 *
 * 新規参加者を agent-hub に登録する。
 * - name: 参加者の識別子（@ プレフィックスなし）
 * - display_name: オプションの表示名
 * - mode: peer の worker type 宣言（stateful/stateless/global）。任意。
 *
 * 権限:
 * - 認証された GitHub login (= owner) で claim する
 * - 既に同じ owner なら mode のみ更新可能（display_name は最小実装で更新しない）
 * - 未claimed なら TOFU で claim、他人所有なら 409
 */
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
 * @param db - データベースインスタンス
 * @param args - ツール引数（name, display_name?）
 * @param userId - 現在のセッションのハンドル（参考情報）
 * @param githubLogin - PAT で検証された GitHub login。新規登録時の owner として使う
 * @returns MCP CallToolResult
 */
export async function handleRegister(
  db: Database,
  args: unknown,
  _userId: string,
  githubLogin: string
): Promise<CallToolResult> {
  try {
    const input = registerInputSchema.parse(args);
    const handleName = `@${input.name}`;

    const existing = getParticipantByName(db, handleName);

    // Bootstrap gate: until @admin exists, only the @admin handle can register.
    // After @admin exists, anyone can register normally. This prevents the hub
    // from being usable before its operator has claimed the admin role.
    const adminExists = getParticipantByName(db, '@admin') !== null;
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
      // 新規登録（owner = githubLogin）
      participant = registerParticipant(db, input, githubLogin);
    } else if (existing.owner === githubLogin) {
      // 自分が既に所有 → mode のみ更新可能（display_name は最小実装で更新しない）
      if (input.mode !== undefined && input.mode !== existing.mode) {
        updateParticipantMode(db, handleName, input.mode);
        participant = getParticipantByName(db, handleName)!;
      } else {
        participant = existing;
      }
    } else if (existing.owner === null) {
      // 未claimed → claim、mode も指定があれば反映
      claimOwnerIfUnowned(db, handleName, githubLogin);
      if (input.mode !== undefined) {
        updateParticipantMode(db, handleName, input.mode);
      }
      participant = getParticipantByName(db, handleName)!;
    } else {
      // 他人所有
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
