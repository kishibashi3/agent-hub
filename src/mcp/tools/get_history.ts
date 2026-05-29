import type { TenantScope } from '../../db/tenant-scope.js';
import { getHistoryInputSchema } from '../../types/schema.js';

/**
 * get_history ツール
 * 
 * 特定の相手/チームとの会話履歴を取得する
 * - DM: 当事者のみ閲覧可能
 * - チーム: メンバーのみ閲覧可能
 * - 送受信両方を含めて時系列で返す
 */
export const getHistoryTool = {
  name: 'get_history',
  description:
    '特定の相手またはチームとの会話履歴を取得します。送受信両方を含めた時系列のスレッドを返します。' +
    ' filter parameter で keyword 検索可能 (= 部分一致、 case-insensitive ASCII)。',
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: '会話履歴を取得したい相手の名前（@付きまたは無し）。個人名またはチーム名',
      },
      filter: {
        type: 'string',
        description:
          'keyword フィルタ (optional)。 message body の部分一致 (= LIKE %X% 相当、' +
          ' case-insensitive ASCII)。 issue 番号 (`#27`) / peer 名 (`@reviewer`) / 任意 keyword (`estimate-first`) を受け入れる。',
      },
      limit: {
        type: 'number',
        description: '取得する最大メッセージ数（デフォルト: 50）',
        default: 50,
      },
    },
    required: ['to'],
  },
};

/**
 * get_history ツールのハンドラー
 */
export async function handleGetHistory(
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
    // 入力バリデーション
    const input = getHistoryInputSchema.parse(args);

    // productive activity 観察 (= issue #26)、 履歴閲覧は能動的な content consumption
    scope.updateLastActiveAt(userId);

    // DB から履歴を取得
    const messages = scope.getHistory(input, userId);

    // MCP レスポンス形式に変換
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              to: input.to.startsWith('@') ? input.to : `@${input.to}`,
              count: messages.length,
              limit: input.limit,
              messages: messages.map((msg) => ({
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
    // エラーハンドリング
    const errorMessage =
      error instanceof Error ? error.message : '不明なエラーが発生しました';

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: errorMessage,
            },
            null,
            2
          ),
        },
      ],
    };
  }
}
