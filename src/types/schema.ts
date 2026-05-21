import { z } from 'zod';

// --- Participants ---

/**
 * peer の worker type 宣言。詳細は agent-hub-bridge-adk README 参照。
 * - stateful: peer ごとに文脈保持（personal assistant 系、cloud LLM 推奨）
 * - stateless: 単発処理（翻訳・要約 等の specialty worker）
 * - global: 全員が 1 session 共有（議事録・司会・場の管理人）
 */
export const peerModeSchema = z.enum(['stateful', 'stateless', 'global']);
export type PeerMode = z.infer<typeof peerModeSchema>;

export const participantSchema = z.object({
  name: z.string().regex(/^@[\w-]+$/, '名前は @英数字ハイフン 形式'),
  display_name: z.string().nullable(),
  owner: z.string().nullable(),
  mode: peerModeSchema.nullable(),
  deleted_at: z.string().nullable(),
  last_active_at: z.string().nullable(),
  created_at: z.string(),
});

export type Participant = z.infer<typeof participantSchema>;

export const registerInputSchema = z.object({
  name: z.string().min(1).regex(/^[\w-]+$/, '英数字とハイフンのみ'),
  display_name: z.string().optional(),
  mode: peerModeSchema.optional(),
});

export type RegisterInput = z.infer<typeof registerInputSchema>;

// --- Teams ---

export const teamSchema = z.object({
  name: z.string().regex(/^@[\w-]+$/),
  owner: z.string(),
  created_at: z.string(),
});

export type Team = z.infer<typeof teamSchema>;

export const createTeamInputSchema = z.object({
  name: z.string().min(1).regex(/^[\w-]+$/, '英数字とハイフンのみ'),
  members: z.array(z.string()).min(0),
});

export type CreateTeamInput = z.infer<typeof createTeamInputSchema>;

export const updateTeamInputSchema = z.object({
  name: z.string(),
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
});

export type UpdateTeamInput = z.infer<typeof updateTeamInputSchema>;

// --- Messages ---

export const messageSchema = z.object({
  id: z.string(),
  sender: z.string(),
  recipient: z.string(),
  body: z.string(),
  // v8: PAT owner の GitHub login。NULL = migration 前の既存 row のみ (issue #21 Fix 1)
  // production server は PAT/trust 両 mode で non-null を書き込む (trust mode: githubLogin = handle name)
  sender_github_login: z.string().nullable(),
  created_at: z.string(),
});

export type Message = z.infer<typeof messageSchema>;

export const sendMessageInputSchema = z.object({
  to: z.string().min(1),
  message: z.string().min(1),
});

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const getHistoryInputSchema = z.object({
  to: z.string().min(1),
  filter: z.string().optional(),
  limit: z.number().int().positive().optional().default(50),
});

export type GetHistoryInput = z.infer<typeof getHistoryInputSchema>;

// --- Read Receipts ---

export const readReceiptSchema = z.object({
  message_id: z.string(),
  reader: z.string(),
  read_at: z.string(),
});

export type ReadReceipt = z.infer<typeof readReceiptSchema>;

export const markAsReadInputSchema = z.object({
  message_id: z.string().min(1),
});

export type MarkAsReadInput = z.infer<typeof markAsReadInputSchema>;
