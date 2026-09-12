import type { TenantScope } from '../../db/tenant-scope.js';
import { flushMessagesInputSchema } from '../../types/schema.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * flush_messages ツール定義（issue #336）
 *
 * 指定 participant の未読（DM + ブロードキャストのみ、チーム宛は対象外）を
 * 一括既読化する。operator がメンテ目的で他 participant の inbox backlog を
 * クリアするための tool。
 *
 * 権限: 呼び出し元 (userId) の mode が global（operator）であることを要求する
 * （send_message.ts の broadcast (@*) gate と同型）。
 *
 * スコープ: DM + ブロードキャストのみ。チーム宛メッセージは対象外
 * （getQueueDepths が person 宛のみをカウントする scope と揃える）。
 */
export const flushMessagesTool = {
  name: 'flush_messages',
  description:
    '指定 participant の未読（DM + ブロードキャストのみ、チーム宛は対象外）を一括既読化する。mode=global の peer のみ実行可能。',
  inputSchema: {
    type: 'object',
    properties: {
      participant: {
        type: 'string',
        description: '未読を一括既読化する対象の participant 名（@ 付き）',
      },
    },
    required: ['participant'],
  },
};

/**
 * flush_messages ツールのハンドラー
 *
 * @param scope - テナントスコープ付き DB ハンドル
 * @param args - ツール引数（participant）
 * @param userId - 呼び出し元のユーザーID（X-Participant-Id ヘッダーから取得）
 * @returns MCP CallToolResult
 */
export function handleFlushMessages(
  scope: TenantScope,
  args: unknown,
  userId: string
): CallToolResult {
  try {
    const input = flushMessagesInputSchema.parse(args);

    const caller = scope.getParticipantByName(userId);
    if (caller?.mode !== 'global') {
      throw new Error('flush_messages は mode=global の peer のみ許可されています');
    }

    const targetName = input.participant.startsWith('@')
      ? input.participant
      : `@${input.participant}`;
    const target = scope.getParticipantByName(targetName);
    if (!target) {
      throw new Error(`participant が見つかりません: ${targetName}`);
    }

    scope.updateLastActiveAt(userId);

    const unread = scope.getUnreadDmBroadcastMessages(target.name);
    scope.db.transaction(() => {
      for (const message of unread) {
        scope.markAsRead(message.id, target.name, userId);
      }
    })();

    return {
      content: [{ type: 'text', text: JSON.stringify({ cleared: unread.length }, null, 2) }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'flush_messages failed', message: errorMessage }, null, 2),
        },
      ],
      isError: true,
    };
  }
}
