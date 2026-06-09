import type { TenantScope } from '../../db/tenant-scope.js';
import { sendMessageInputSchema } from '../../types/schema.js';
import { notifyResourceUpdated, inboxUriFor } from '../server.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * send_message ツール定義
 *
 * DM またはチーム宛にメッセージを送信する。
 * - DM: to が @個人名 の場合、1対1のメッセージ
 * - チーム: to が @チーム名 の場合、メンバー全員に配信（送信者自身は除く）
 * - ブロードキャスト: to が @* の場合、tenant 内全参加者に配信（mode=global のみ許可）
 *
 * 権限:
 * - DM: 登録済みなら誰でも送信可能
 * - チーム: メンバーのみ送信可能
 * - @* ブロードキャスト: mode=global の peer のみ許可
 */
export const sendMessageTool = {
  name: 'send_message',
  description:
    'DM またはチーム宛にメッセージを送信する。to が @個人名 なら DM、@チーム名 ならチーム全体に配信される。' +
    'to に @* を指定すると tenant 内全参加者にブロードキャスト送信（mode=global の peer のみ許可）。',
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: '宛先（@個人名、@チーム名、または @* でブロードキャスト）',
      },
      message: {
        type: 'string',
        description: '送信するメッセージ本文',
      },
      caused_by: {
        type: 'string',
        description:
          '(optional) このメッセージを引き起こした元メッセージの ID。因果チェーン追跡用 (issue #162)。' +
          '省略または null = chain の root（自発的メッセージ・新規タスク開始等）。' +
          'V1: 単一 ID のみ指定可。V2 で DAG に拡張予定。',
      },
    },
    required: ['to', 'message'],
  },
};

/**
 * send_message ツールのハンドラー
 *
 * @param scope - テナントスコープ付き DB ハンドル
 * @param args - ツール引数（to, message）
 * @param userId - 送信者のユーザーID（X-User-Id ヘッダーから取得）
 * @param githubLogin - 認証済み login (forensic audit 用、issue #127)。senderLogin として DB に記録される。
 *   production server は PAT/trust 両 mode で non-null を渡す (trust mode: handle name = githubLogin)。
 *   省略 or null の場合は NULL として記録される (= migration 前の既存 row との互換保持用)。
 * @returns MCP CallToolResult
 */
export async function handleSendMessage(
  scope: TenantScope,
  args: unknown,
  userId: string,
  githubLogin?: string | null
): Promise<CallToolResult> {
  try {
    // 引数のバリデーション
    const input = sendMessageInputSchema.parse(args);

    // userId は authenticateUser middleware が canonical `@<name>` でセット済
    const sender = userId;

    // @* ブロードキャスト: mode=global のみ許可 (issue #275)
    if (input.to === '@*') {
      const senderParticipant = scope.getParticipantByName(sender);
      if (senderParticipant?.mode !== 'global') {
        throw new Error('broadcast (@*) は mode=global の peer のみ許可されています');
      }
    }

    // productive activity 観察 (= issue #26)、 send は確実に productive
    scope.updateLastActiveAt(sender);

    // メッセージ送信
    const message = scope.sendMessage(input, sender, githubLogin);

    // リアルタイム通知発火（best-effort、失敗しても送信自体は成功扱い）
    // Inbox URI に tenant 識別子は載せず、dispatch 側で scope.tenantId と
    // session.tenantDomain を突き合わせて tenant leak を防ぐ (issue #7)。
    try {
      let notifyTargets: string[];
      if (message.recipient === '@*') {
        // ブロードキャスト: 全参加者（送信者除く）に通知
        notifyTargets = scope.getParticipants()
          .map((p) => p.name)
          .filter((n) => n !== sender);
      } else {
        const teamMembers = scope.getTeamMembers(message.recipient);
        notifyTargets =
          teamMembers.length > 0
            ? teamMembers.filter((m) => m !== sender) // チーム宛: メンバー全員（送信者除く）
            : [message.recipient]; // DM 宛
      }
      for (const r of notifyTargets) {
        notifyResourceUpdated(inboxUriFor(r), scope.tenantId);
      }
    } catch (notifyErr) {
      console.error('[send_message] notify failed (non-fatal):', notifyErr);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              id: message.id,
              from: message.sender,
              to: message.recipient,
              message: message.body,
              caused_by: message.caused_by ?? null,
              timestamp: message.created_at,
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
              error: 'send_message failed',
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
