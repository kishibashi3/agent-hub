import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { getDatabase } from '../db/index.js';
import { getUnreadMessages } from '../db/messages.js';
import {
  getParticipantByName,
  getParticipantByNameIncludingDeleted,
  registerParticipant,
  claimOwnerIfUnowned,
  reviveParticipant,
} from '../db/participants.js';
import {
  fetchUserInfo,
  fetchUserOrgs,
  verifyOrgMembership,
  type GithubUser,
} from '../auth/github-oauth.js';
import { getHistoryTool, handleGetHistory } from './tools/get_history.js';
import { sendMessageTool, handleSendMessage } from './tools/send_message.js';
import { getMessagesTool, handleGetMessages } from './tools/get_messages.js';
import { markAsReadTool, handleMarkAsRead } from './tools/mark_as_read.js';
import { registerTool, handleRegister } from './tools/register.js';
import { getParticipantsTool, handleGetParticipants } from './tools/get_participants.js';
import { createTeamTool, handleCreateTeam } from './tools/create_team.js';
import { updateTeamTool, handleUpdateTeam } from './tools/update_team.js';
import { deleteTeamTool, handleDeleteTeam } from './tools/delete_team.js';
import {
  deleteUserTool,
  handleDeleteUser,
  getUserHistoryTool,
  handleGetUserHistory,
} from './tools/admin.js';

/**
 * セッション情報
 *
 * stateful Streamable HTTP では sessionId 単位で transport / server / 認証ユーザー /
 * 購読中の resource を保持する。`extra.sessionId` から `sessions.get(sid)` で
 * userId を引けるため、AsyncLocalStorage は不要になった。
 */
interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  userId: string;          // 動作中のハンドル（例: '@alice' or '@kishibashi3'）
  githubLogin: string;     // PAT で検証された GitHub login。trust モードでは userId と同じ
  subscribedUris: Set<string>;
}

const sessions = new Map<string, Session>();

/**
 * 認証ミドルウェア
 *
 * AUTH_MODE 環境変数で挙動を切り替える:
 * - `trust` (デフォルト): localhost 互換モード。X-User-Id ヘッダーをそのまま信頼。
 *   **インターネット公開禁止**（任意の人が任意のヘッダー値でなりすませる）
 * - `pat`: Authorization: Bearer <github-pat> を受け取り、GitHub API で検証して userId を解決
 *
 * `pat` モードでは、ユーザーが GitHub Settings → Developer settings →
 * Personal access tokens で発行した token を `.mcp.json` の Authorization
 * ヘッダーに載せる。必要 scope は `read:user`（+ Org 制限する場合は `read:org`）。
 *
 * Org 制限は `AGENT_HUB_GITHUB_ORG` 環境変数で指定（任意）。
 */

/** PAT → user info の短期キャッシュ（毎回 GitHub API を叩かないため）*/
interface PatCacheEntry {
  user: GithubUser;
  fetchedAt: number;
}
const patCache = new Map<string, PatCacheEntry>();
const PAT_CACHE_TTL_MS = 5 * 60_000; // 5 分

async function authenticateUser(req: Request, res: Response, next: NextFunction) {
  const mode = (process.env.AUTH_MODE || 'trust').toLowerCase();

  if (mode === 'trust') {
    const userId = req.headers['x-user-id'];
    if (typeof userId !== 'string' || userId.trim() === '') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'AUTH_MODE=trust: X-User-Id header is required',
      });
    }
    // canonical 形に正規化: 常に `@<name>` で下流に渡す。
    // PAT モード (下記) と契約を揃え、各 tool の defensive normalization を不要化。
    const trimmed = userId.trim();
    const handleName = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
    req.userId = handleName;
    // trust モードでは PAT がないので handle (の @ 抜き) と同じにする
    req.githubLogin = handleName.slice(1);
    return next();
  }

  if (mode === 'pat') {
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="agent-hub"');
      return res.status(401).json({
        error: 'Unauthorized',
        message:
          'AUTH_MODE=pat: Authorization: Bearer <github-pat> required. ' +
          'Issue a token at https://github.com/settings/tokens with scope read:user',
      });
    }
    const pat = auth.slice(7).trim();
    let githubLogin: string;
    try {
      // キャッシュで GitHub API 呼び出しを抑制
      const cached = patCache.get(pat);
      let user: GithubUser;
      if (cached && Date.now() - cached.fetchedAt < PAT_CACHE_TTL_MS) {
        user = cached.user;
      } else {
        user = await fetchUserInfo(pat);
        const requiredOrg = process.env.AGENT_HUB_GITHUB_ORG;
        if (requiredOrg) {
          const orgs = await fetchUserOrgs(pat);
          if (!verifyOrgMembership(orgs, requiredOrg)) {
            return res.status(403).json({
              error: 'Forbidden',
              message: `not a member of GitHub Org "${requiredOrg}"`,
            });
          }
        }
        patCache.set(pat, { user, fetchedAt: Date.now() });
      }
      githubLogin = user.login; // GitHub login (例: "kishibashi3")
    } catch (err) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: `invalid PAT: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // X-User-Id が指定されていればハンドル override（マルチペルソナ用）。
    // 無ければデフォルトで github_login をハンドルとして使う。
    const overrideHeader = req.headers['x-user-id'];
    const override =
      typeof overrideHeader === 'string'
        ? overrideHeader.trim().replace(/^@/, '')
        : '';
    const handleBase = override || githubLogin;
    const handleName = `@${handleBase}`;

    try {
      const db = getDatabase();
      const existing = getParticipantByName(db, handleName);
      if (!existing) {
        // active な行が無い → soft-deleted 行を確認して revive 判定
        const deleted = getParticipantByNameIncludingDeleted(db, handleName);
        if (deleted && deleted.deleted_at !== null) {
          // 同じ owner なら蘇生 (UNIQUE constraint も守られる)、別人なら拒否
          if (deleted.owner === githubLogin) {
            reviveParticipant(db, handleName, githubLogin);
          } else {
            return res.status(403).json({
              error: 'Forbidden',
              message: `handle ${handleName} は削除済で別ユーザー所有のため再利用不可`,
            });
          }
        } else {
          // 完全に新規 → auto-register（owner=自分）
          registerParticipant(db, { name: handleBase }, githubLogin);
        }
      } else if (existing.owner === null) {
        // v2 から移行した既存ハンドル → TOFU で claim
        claimOwnerIfUnowned(db, handleName, githubLogin);
      } else if (existing.owner !== githubLogin) {
        return res.status(403).json({
          error: 'Forbidden',
          message: `handle ${handleName} は他のユーザー所有です`,
        });
      }
      req.userId = handleName;
      req.githubLogin = githubLogin;
      return next();
    } catch (err) {
      return res.status(500).json({
        error: 'InternalServerError',
        message: `failed to resolve handle ${handleName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
  }

  return res.status(500).json({
    error: 'ServerMisconfigured',
    message: `unknown AUTH_MODE: ${mode}. Use 'trust' or 'pat'.`,
  });
}

/** `inbox://[@]<name>` 形式の URI から name を取り出す。返り値は @ 無し */
function uriToInboxOwner(uri: string): string | null {
  const m = uri.match(/^inbox:\/\/@?(.+)$/);
  if (!m) return null;
  return m[1] ?? null;
}

/**
 * Inbox URI の canonical 形 (`inbox://<name>`、@ 無し)。
 *
 * pydantic AnyUrl 系のクライアント (Python MCP SDK 等) が URI の userinfo
 * 部分の `@` を strip するため、`inbox://@<name>` で subscribe させると
 * 受信側で `inbox://<name>` に正規化されて URI mismatch 発生。
 * server 側で常に canonical 形を使えば、クライアント実装に依存しない。
 */
function canonicalizeInboxUri(uri: string): string {
  const owner = uriToInboxOwner(uri);
  if (!owner) return uri;
  return `inbox://${owner}`;
}

/** ユーザー名（@有り無しどちらでも）を canonical Inbox URI に正規化 */
export function inboxUriFor(name: string): string {
  const stripped = name.startsWith('@') ? name.slice(1) : name;
  return `inbox://${stripped}`;
}

/**
 * 指定 resource を購読している全 session に `notifications/resources/updated` を流す。
 * send_message ハンドラ等から呼び出される。
 *
 * - 例外送信元 (except) があれば除外（送信者本人への通知を抑制したい場合）
 * - notification の発火は best-effort、エラーが出ても他 session の通知は止めない
 */
export function notifyResourceUpdated(uri: string, except?: string): void {
  for (const [sid, session] of sessions) {
    if (sid === except) continue;
    if (!session.subscribedUris.has(uri)) continue;
    try {
      void session.server.notification({
        method: 'notifications/resources/updated',
        params: { uri },
      });
    } catch (err) {
      console.error(`[MCP] notify failed for sid=${sid}:`, err);
    }
  }
}

/**
 * sessionId に紐づく Server インスタンスを生成。
 * setRequestHandler のクロージャで sessions Map を参照することで、tools/call から userId を引ける。
 */
function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'agent-hub',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true },
      },
    },
  );

  // ツール一覧
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      registerTool,
      getParticipantsTool,
      createTeamTool,
      updateTeamTool,
      deleteTeamTool,
      sendMessageTool,
      getMessagesTool,
      getHistoryTool,
      markAsReadTool,
      // admin tools (only callable by @admin)
      deleteUserTool,
      getUserHistoryTool,
    ],
  }));

  // ツール実行
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const db = getDatabase();

    const sid = extra.sessionId;
    const session = sid ? sessions.get(sid) : undefined;
    const userId = session?.userId;
    const githubLogin = session?.githubLogin;
    if (!userId || !githubLogin) {
      throw new Error('session is not authenticated (sessionId missing or session expired)');
    }

    switch (name) {
      case 'register':
        return await handleRegister(db, args, userId, githubLogin);
      case 'get_participants':
        return await handleGetParticipants(db, args, userId);
      case 'create_team':
        return await handleCreateTeam(db, args, userId);
      case 'update_team':
        return await handleUpdateTeam(db, args, userId);
      case 'delete_team':
        return await handleDeleteTeam(db, args, userId);
      case 'send_message':
        return await handleSendMessage(db, args, userId);
      case 'get_messages':
        return await handleGetMessages(db, args, userId);
      case 'get_history':
        return await handleGetHistory(db, args, userId);
      case 'mark_as_read':
        return await handleMarkAsRead(db, args, userId);
      case 'delete_user':
        return await handleDeleteUser(db, args, userId);
      case 'get_user_history':
        return await handleGetUserHistory(db, args, userId);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // 利用可能 resource 一覧（その session の自分宛て inbox を 1 件露出）
  server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => {
    const sid = extra.sessionId;
    const userId = sid ? sessions.get(sid)?.userId : undefined;
    if (!userId) {
      throw new Error('session not found');
    }
    return {
      resources: [
        {
          uri: inboxUriFor(userId),
          name: `Inbox for @${userId}`,
          description: '自分宛ての未読メッセージ（DM + 所属チーム宛）の受信箱。subscribe で更新通知を受け取れる。',
          mimeType: 'application/json',
        },
      ],
    };
  });

  // resource の中身を返す。inbox://<name> なら getUnreadMessages の結果を JSON で返す
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const sid = extra.sessionId;
    const userId = sid ? sessions.get(sid)?.userId : undefined;
    if (!userId) {
      throw new Error('session not found');
    }
    const uri = request.params.uri;
    const owner = uriToInboxOwner(uri);
    if (!owner) {
      throw new Error(`unsupported resource uri: ${uri}`);
    }
    // 自分の inbox しか読めない (userId は authenticateUser middleware が常に
    // canonical `@<name>` 形式でセットする契約)
    const ownerHandle = owner.startsWith('@') ? owner : `@${owner}`;
    if (ownerHandle !== userId) {
      throw new Error(`forbidden: cannot read another user's inbox`);
    }
    const messages = getUnreadMessages(getDatabase(), userId);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(messages, null, 2),
        },
      ],
    };
  });

  // 購読: その session の subscribedUris に追加するだけ
  server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
    const sid = extra.sessionId;
    const session = sid ? sessions.get(sid) : undefined;
    if (!session) {
      throw new Error('session not found');
    }
    const canonical = canonicalizeInboxUri(request.params.uri);
    session.subscribedUris.add(canonical);
    console.log(`[MCP] subscribe: sid=${sid} uri=${request.params.uri} (canonical=${canonical})`);
    return {};
  });

  // 購読解除
  server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) => {
    const sid = extra.sessionId;
    const session = sid ? sessions.get(sid) : undefined;
    if (session) {
      session.subscribedUris.delete(canonicalizeInboxUri(request.params.uri));
      console.log(`[MCP] unsubscribe: sid=${sid} uri=${request.params.uri}`);
    }
    return {};
  });

  return server;
}

/**
 * MCP Server クラス
 *
 * agent-hub の中核：メッセージの保管・配信を担う通信ハブ
 * - HTTP（Streamable HTTP, stateful）で複数クライアントを同時接続
 * - X-User-Id ヘッダーでユーザー認証、sessionId 単位で保持
 * - DB 接続を初期化して永続化層を提供
 */
export class MCPServer {
  private app: express.Application;
  private port: number;

  constructor(port = 3000) {
    this.port = port;
    this.app = express();

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    this.app.use(express.json());
    this.app.use('/mcp', authenticateUser);
  }

  private setupRoutes() {
    // ヘルスチェック（認証不要）。auth_mode と sessions 数も返す。
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        service: 'agent-hub',
        auth_mode: (process.env.AUTH_MODE || 'trust').toLowerCase(),
        sessions: sessions.size,
      });
    });

    // POST /mcp: リクエスト受信エンドポイント
    // - mcp-session-id ヘッダーがあれば既存 session に dispatch
    // - 無くて initialize なら新規 session 作成
    // - それ以外は 400
    this.app.post('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      // authenticateUser middleware が必ずセットしている契約。型安全のため明示確認。
      if (!req.userId || !req.githubLogin) {
        res
          .status(401)
          .json({ error: 'Unauthorized', message: 'authentication middleware did not set userId' });
        return;
      }
      const userId = req.userId;
      const githubLogin = req.githubLogin;

      try {
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
          return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
          // 新規 session 作成
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              sessions.set(sid, {
                transport,
                server,
                userId,
                githubLogin,
                subscribedUris: new Set(),
              });
              console.log(
                `[MCP] session opened: ${sid} userId=${userId} githubLogin=${githubLogin}`
              );
            },
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && sessions.has(sid)) {
              sessions.delete(sid);
              console.log(`[MCP] session closed: ${sid}`);
            }
          };

          const server = createMcpServer();
          // SDK の Transport 型と StreamableHTTPServerTransport の onclose 型が
          // exactOptionalPropertyTypes 下で噛み合わないため広めにキャスト
          await server.connect(transport as Parameters<typeof server.connect>[0]);
          await transport.handleRequest(req, res, req.body);
          return;
        }

        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: missing/invalid session or method',
          },
          id: req.body?.id ?? null,
        });
      } catch (error) {
        console.error('[MCP] POST handleRequest error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: req.body?.id ?? null,
          });
        }
      }
    });

    // GET /mcp: SSE long-lived ストリーム（クライアント主導の通知受信）
    this.app.get('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'mcp-session-id required for GET /mcp' },
          id: null,
        });
        return;
      }
      try {
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
      } catch (error) {
        console.error('[MCP] GET handleRequest error:', error);
        if (!res.headersSent) res.status(500).end();
      }
    });

    // DELETE /mcp: session 明示終了
    this.app.delete('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(400).end();
        return;
      }
      try {
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
      } catch (error) {
        console.error('[MCP] DELETE handleRequest error:', error);
        if (!res.headersSent) res.status(500).end();
      }
    });

    // 404 ハンドラー
    this.app.use((_req: Request, res: Response) => {
      res.status(404).json({ error: 'Not Found' });
    });
  }

  /** DB 初期化（getDatabase() の初回呼び出しで applyMigrations が走る） */
  async initDatabase(): Promise<void> {
    getDatabase();
    console.log('✅ Database initialized');
  }

  /** サーバー起動 */
  async start(): Promise<void> {
    await this.initDatabase();

    return new Promise((resolve) => {
      this.app.listen(this.port, '0.0.0.0', () => {
        const mode = (process.env.AUTH_MODE || 'trust').toLowerCase();
        const org = process.env.AGENT_HUB_GITHUB_ORG;
        console.log(`🚀 agent-hub MCP Server listening on http://0.0.0.0:${this.port}`);
        console.log(`📡 MCP endpoint: http://localhost:${this.port}/mcp`);
        console.log(`💊 Health check: http://localhost:${this.port}/health`);
        if (mode === 'trust') {
          console.log(`🔓 AUTH_MODE=trust  X-User-Id 信頼ネットワーク前提（インターネット公開禁止）`);
        } else if (mode === 'pat') {
          console.log(
            `🔐 AUTH_MODE=pat    GitHub PAT 検証${org ? ` / Org=${org}` : ''}`
          );
        } else {
          console.log(`⚠️  AUTH_MODE=${mode} (unknown)`);
        }
        resolve();
      });
    });
  }

  /** テスト用：Express app を取得 */
  getApp(): express.Application {
    return this.app;
  }
}
