import type { TenantScope } from '../../db/tenant-scope.js';
import { getThreadInputSchema } from '../../types/schema.js';

/**
 * get_thread ツール (issue #181)
 *
 * caused_by チェーンで構成されたスレッドを全件取得する。
 * 任意のメッセージ ID (root でも返信メッセージでも可) から
 * root_message_id を解決し、スレッド全体を時系列順で返す。
 *
 * ユースケース:
 *   - agent が自分の受信メッセージが何のスレッドに属するかを辿る
 *   - タスク chain 全体を一覧して文脈を把握する
 *   - ダッシュボード読みページと同等の情報を MCP client で取得する
 *
 * 権限: スレッド内に自分が sender/recipient として参加していれば閲覧可。
 * @admin は全スレッドにアクセス可能。
 */
export const getThreadTool = {
  name: 'get_thread',
  description:
    'caused_by チェーンで構成されたスレッド全体を時系列順で取得します。' +
    ' message_id には root メッセージ ID または返信メッセージ ID のどちらでも指定可能です。' +
    ' スレッドに参加している（sender または recipient として含まれる）場合のみ閲覧できます。',
  inputSchema: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description:
          'スレッド内の任意のメッセージ ID（root でも返信でも可）。' +
          ' root_message_id に解決してスレッド全体を返します。',
      },
      limit: {
        type: 'number',
        description: '取得する最大メッセージ数（デフォルト: 100）',
        default: 100,
      },
    },
    required: ['message_id'],
  },
};

/**
 * get_thread ツールのハンドラー
 */
export async function handleGetThread(
  scope: TenantScope,
  args: unknown,
  userId: string
): Promise<{
  content: Array<{
    type: 'text';
    text: string;
  }>;
}> {
  try {
    const input = getThreadInputSchema.parse(args);

    // 活動記録 (= issue #26)
    scope.updateLastActiveAt(userId);

    const result = scope.getThread(input, userId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              root_id: result.rootId,
              thread_size: result.threadSize,
              messages: result.messages.map((msg) => ({
                id: msg.id,
                from: msg.sender,
                to: msg.recipient,
                message: msg.body,
                caused_by: msg.caused_by ?? null,
                timestamp: msg.created_at,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : '不明なエラーが発生しました';

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: errorMessage }, null, 2),
        },
      ],
    };
  }
}
