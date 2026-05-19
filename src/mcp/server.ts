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
import {
  DEFAULT_TENANT,
  isValidTenantDomain,
  getTenant,
  claimTenantIfMissing,
  isDeploymentInitialized,
} from '../db/tenants.js';
import { scopeToTenant } from '../db/tenant-scope.js';
import {
  getParticipantByName,
  findOtherTenantsForHandleAndOwner,
} from '../db/participants.js';
import { BoundedInMemoryEventStore } from './event-store.js';
import { resolveEdition, type EditionConfig } from '../edition.js';
import { getVersionInfo } from './version-info.js';
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
import {
  listTenantsTool,
  handleListTenants,
  getTenantTool,
  handleGetTenant,
  deleteTenantTool,
  handleDeleteTenant,
} from './tools/ce_admin.js';

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
  tenantDomain: string;    // X-Tenant-Id (未指定なら 'default')。session 中は固定
  subscribedUris: Set<string>;
}

const sessions = new Map<string, Session>();

/**
 * Ghost-session detection の WARN を rate-limit するための per-(owner,handle) cache。
 *
 * issue #28 (= watch.sh の AGENT_HUB_TENANT 未伝播 「見えない幽霊」 bug、 server-side
 * Path B observability) の対応。 同 (owner, handle) tuple について **GHOST_WARN_COOLDOWN_MS
 * (= 60s)** 以内の重複 WARN は出さない (= log 洪水を防ぐ)。
 *
 * cache size は **session 寿命より長い必要なし** + 高々 deployment 全 user 数程度なので
 * unbounded Map で OK (= 実運用で爆発する size ではない)。
 */
const GHOST_WARN_COOLDOWN_MS = 60_000;
const ghostWarnCache = new Map<string, number>();

/**
 * Ghost-session detection: default tenant への session 着地時、 同 (owner, handle) が
 * named tenant に存在すれば 「AGENT_HUB_TENANT 伝播失敗かも?」 を WARN log する。
 *
 * 対象外条件:
 * - tenantDomain !== DEFAULT_TENANT (= named tenant 着地時は正規 path、 warn 不要)
 * - handleName === '@admin' (= operator が default tenant で activities するのは正規 use case)
 * - 該当 named tenant 登録が 0 件 (= ghost ではなく真の default-only user)
 * - cooldown 内 (= 既に 60s 以内に同 WARN 出してる)
 *
 * **副作用**: `console.warn` のみ。 session 自体は通常通り進行する (= warn は diagnostic
 * 用途で session を block しない)。
 *
 * `export` してあるのは unit test から直接呼ぶため (= db を引数化することで auth middleware
 * の HTTP 経路を通さずに WARN behavior を検証可能にする)。
 *
 * issue #28 origin: @admin (Pi5 ops) 報告 = is_online false のまま稼働続ける「見えない幽霊」状態
 * Refs #28 (= L1 batch operator GO 取得済の server-side Path B、 plugin Path A は別 repo PR 済)
 */
export function maybeWarnGhostSession(
  db: import('better-sqlite3').Database,
  handleName: string,
  tenantDomain: string,
  githubLogin: string
): void {
  if (tenantDomain !== DEFAULT_TENANT) return;
  // operator の default tenant 活動は正規 (= @admin は cross-tenant management role)、
  // ghost detection の noise になるので skip
  if (handleName === '@admin') return;

  const namedTenants = findOtherTenantsForHandleAndOwner(
    db,
    handleName,
    githubLogin,
    DEFAULT_TENANT
  );
  if (namedTenants.length === 0) return;

  const cacheKey = `${githubLogin}::${handleName}`;
  const now = Date.now();
  const lastWarn = ghostWarnCache.get(cacheKey);
  if (lastWarn !== undefined && now - lastWarn < GHOST_WARN_COOLDOWN_MS) return;
  ghostWarnCache.set(cacheKey, now);

  console.warn(
    `[ghost-session-detect] handle ${handleName} (owner=${githubLogin}) connected to default tenant ` +
      `but is also registered in named tenant(s): [${namedTenants.join(', ')}]. ` +
      `Possible env propagation issue (AGENT_HUB_TENANT not reaching the client?). ` +
      `If you intended to connect to a named tenant, abort and verify X-Tenant-Id header. ` +
      `Refs issue #28.`
  );
}

/**
 * Test-only: ghost-warn cache を clear する。 unit test の isolation 用、
 * 同 (owner, handle) を複数 test 間で重複利用する場合に cooldown 影響を回避する。
 */
export function _resetGhostWarnCacheForTests(): void {
  ghostWarnCache.clear();
}

/**
 * Edition 設定 (= deployment-time singleton)。
 *
 * `MCPServer.start()` で `resolveEdition(process.env)` を 1 度だけ呼んで cache する。
 * 全ての request handler / tool handler はこの cache を参照することで、env を
 * 直接読まずに「PE か CE か」「named tenant 許可か」を判定する。
 *
 * server.start() より前に request が来ることはない (= express listen 前) ので
 * `null` 初期値で問題ない。万一 race 状態で null のままアクセスがあれば
 * `getEditionConfig()` が throw して fail-fast する。
 */
let activeEditionConfig: EditionConfig | null = null;

function getEditionConfig(): EditionConfig {
  if (!activeEditionConfig) {
    throw new Error(
      'edition not resolved yet — MCPServer.start() must be called before any request'
    );
  }
  return activeEditionConfig;
}

/**
 * test 用: edition config を inject する (Minor 3 反映、命名を `setEditionConfigForTesting`
 * に揃え、 reset 機能を `resetEditionConfigForTesting` に分離)。
 *
 * production code は `getEditionConfig()` のみを参照すること。 本関数は test escape
 * として export しているが、 production import は禁止 (= 将来 lint で機械的に禁止予定)。
 */
export function setEditionConfigForTesting(config: EditionConfig): void {
  activeEditionConfig = config;
}

/** test 用: edition config を reset (= null に戻す)。 `afterEach` での state cleanup に使う。 */
export function resetEditionConfigForTesting(): void {
  activeEditionConfig = null;
}

/**
 * @deprecated `setEditionConfigForTesting` / `resetEditionConfigForTesting` を使ってください。
 * 旧 API、 transient compat のため残存 (= 既存 test が更新されるまでの 1 release だけ delete を保留)。
 */
export function _setEditionConfigForTest(config: EditionConfig | null): void {
  activeEditionConfig = config;
}

/**
 * SSE 通知 resumability 用の process-wide event store.
 * StreamableHTTPServerTransport の eventStore option に渡す。
 *
 * - GET 切断中の通知を保持 (= 再接続時 replay)
 * - bound: stream あたり 200 件 / TTL 10 分
 * - 永続化なし (= server restart で全消失、それで OK な前提)
 */
const notificationEventStore = new BoundedInMemoryEventStore();

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

/**
 * ユーザー / tenant 追加ルール (CE 全体の access policy)
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ 1. deployment 初期化ゲート (= default tenant に @admin が claim される) │
 *   │    - 未初期化中は named tenant への access を全部 503 で塞ぐ        │
 *   │    - 未初期化中は default tenant でも @admin 以外の register を塞ぐ │
 *   │    - 「先に operator が確立される」を強制し、squat 防止             │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ 2. tenant 識別 (X-Tenant-Id header)                              │
 *   │    - 未指定 → 'default' (雑談室、open lobby)                      │
 *   │    - 'default' は常に open、tenants.owner=NULL                    │
 *   │    - named tenant は TOFU: 初回接続で owner=githubLogin claim     │
 *   │    - 以降 owner != githubLogin の PAT は 403                      │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ 3. handle (= participant 名) の追加                              │
 *   │    - handle base は X-User-Id (override)、無ければ githubLogin    │
 *   │    - 同 tenant 内でユニーク、別 tenant の同名は別エンティティ      │
 *   │    - active な行があれば owner 一致 (or null claim) チェック       │
 *   │    - soft-deleted で同 owner なら revive                          │
 *   │    - soft-deleted で別 owner なら 403                             │
 *   │    - 新規なら auto-register (owner=githubLogin)                  │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ 4. tenant 内 bootstrap (= 各 tenant の @admin claim 順序)         │
 *   │    - register tool の per-tenant gate: tenant に @admin が居ない  │
 *   │      限り、@admin 以外の handle は register できない               │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ 5. operator 権限 (= deployment 全体管理)                          │
 *   │    - default tenant の @admin = operator                          │
 *   │    - operator 専用 tool (今後追加: list_tenants 等) は             │
 *   │      `userId === '@admin' && tenantDomain === 'default'` でガード │
 *   │    - @admin は **どの tenant でも削除不可** (admin.ts で enforce)  │
 *   └─────────────────────────────────────────────────────────────────┘
 */

/**
 * X-Tenant-Id を解決して tenant domain を返す。失敗時は null + res 送信。
 * 上記ルール 1 (deployment 初期化ゲート) と 2 (tenant 識別 + TOFU) を扱う。
 */
function resolveTenant(
  req: Request,
  res: Response,
  githubLogin: string
): string | null {
  const headerVal = req.headers['x-tenant-id'];
  const raw = typeof headerVal === 'string' ? headerVal.trim() : '';
  const domain = raw === '' ? DEFAULT_TENANT : raw;

  if (!isValidTenantDomain(domain)) {
    res.status(400).json({
      error: 'BadRequest',
      message: `invalid X-Tenant-Id '${domain}': must match [a-zA-Z0-9_-]{1,64}`,
    });
    return null;
  }

  const editionConfig = getEditionConfig();

  // Private Edition: default tenant のみ。X-Tenant-Id で named tenant を要求
  // されたら edition の前提に反するので 400 で弾く (= operator が誤って LAN PE に
  // multi-tenant client を向けた場合の早期検知)。@admin 概念も無いので
  // deployment init gate も適用しない。
  if (!editionConfig.allowsNamedTenant) {
    if (domain !== DEFAULT_TENANT) {
      res.status(400).json({
        error: 'named_tenant_not_supported',
        message:
          'AGENT_HUB_EDITION=private: named tenant は使用できません。' +
          ' X-Tenant-Id header を外して default tenant に接続してください。' +
          ' multi-tenant 運用が必要なら AGENT_HUB_EDITION=community に切り替えてください。',
      });
      return null;
    }
    return domain;
  }

  const db = getDatabase();

  // ルール 1: named tenant は deployment 初期化済みでないと触れない (CE only)
  if (
    editionConfig.enforcesDeploymentInitGate &&
    domain !== DEFAULT_TENANT &&
    !isDeploymentInitialized(db)
  ) {
    res.status(503).json({
      error: 'deployment_not_initialized',
      message:
        'default tenant の @admin (= deployment operator) が未登録です。' +
        '最初に default tenant (= X-Tenant-Id 未指定) で X-User-Id=admin として接続し、@admin を claim してください。',
    });
    return null;
  }

  if (domain === DEFAULT_TENANT) {
    // ルール 1b: default tenant への外部 access を operator に限定する。
    // CE のみ適用 (PE は default 1 つしか無いので restriction が無意味)。
    // **CE では既定で有効** (secure by default)。dev / localhost 用に
    // `AGENT_HUB_DISABLE_DEFAULT_TENANT=0` で明示 opt-out する。
    // bootstrap 中 (= @admin 未 claim) は除外して @admin 初期化を可能にする。
    if (
      editionConfig.enforcesDefaultTenantRestriction &&
      isDeploymentInitialized(db)
    ) {
      const admin = getParticipantByName(db, DEFAULT_TENANT, '@admin');
      if (admin && admin.owner !== githubLogin) {
        res.status(403).json({
          error: 'default_tenant_disabled',
          message:
            'default tenant access is restricted on this deployment. ' +
            'Specify X-Tenant-Id header to access a named (private) tenant. ' +
            '初回 access の場合、好きな名前で X-Tenant-Id を指定すれば TOFU で自分専用 tenant を claim できます。',
        });
        return null;
      }
    }
    return domain;
  }

  // ルール 2: named tenant は TOFU claim or owner 一致チェック
  const tenant = getTenant(db, domain);
  if (!tenant) {
    claimTenantIfMissing(db, domain, githubLogin);
  } else if (tenant.owner !== null && tenant.owner !== githubLogin) {
    res.status(403).json({
      error: 'Forbidden',
      message: `tenant '${domain}' is owned by another user`,
    });
    return null;
  }

  return domain;
}

/**
 * deployment 初期化ゲートの second half: default tenant 内でも @admin 以外の
 * 接続は init 完了まで塞ぐ。これで「最初の handle 追加は default tenant の
 * @admin に限定」が完全に enforce される。
 */
function checkDeploymentInitGate(
  res: Response,
  tenantDomain: string,
  handleName: string
): boolean {
  // PE では @admin 概念が無いので gate 適用なし
  if (!getEditionConfig().enforcesDeploymentInitGate) return true;
  if (tenantDomain !== DEFAULT_TENANT) return true; // named は resolveTenant で処理済
  if (isDeploymentInitialized(getDatabase())) return true;
  if (handleName === '@admin') return true; // 初期化中の @admin claim は OK

  res.status(503).json({
    error: 'deployment_not_initialized',
    message:
      'default tenant の @admin が未登録です。先に X-User-Id=admin で接続して @admin を claim してください。',
  });
  return false;
}

async function authenticateUser(req: Request, res: Response, next: NextFunction) {
  // edition-driven auth mode (= startup resolved、env を直接読まない)
  const mode = getEditionConfig().authMode;

  if (mode === 'trust') {
    const userId = req.headers['x-user-id'];
    if (typeof userId !== 'string' || userId.trim() === '') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'AUTH_MODE=trust: X-User-Id header is required',
      });
    }
    const trimmed = userId.trim();
    const handleName = trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
    const githubLogin = handleName.slice(1);

    const tenantDomain = resolveTenant(req, res, githubLogin);
    if (tenantDomain === null) return;

    if (!checkDeploymentInitGate(res, tenantDomain, handleName)) return;

    // issue #28: 「見えない幽霊」 bug detection (= AGENT_HUB_TENANT 伝播失敗の signal)。
    // session block しない diagnostic only。
    maybeWarnGhostSession(getDatabase(), handleName, tenantDomain, githubLogin);

    req.userId = handleName;
    req.githubLogin = githubLogin;
    req.tenantDomain = tenantDomain;
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
      githubLogin = user.login;
    } catch (err) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: `invalid PAT: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const tenantDomain = resolveTenant(req, res, githubLogin);
    if (tenantDomain === null) return;

    // X-User-Id が指定されていればハンドル override（マルチペルソナ用）
    const overrideHeader = req.headers['x-user-id'];
    const override =
      typeof overrideHeader === 'string'
        ? overrideHeader.trim().replace(/^@/, '')
        : '';
    const handleBase = override || githubLogin;
    const handleName = `@${handleBase}`;

    if (!checkDeploymentInitGate(res, tenantDomain, handleName)) return;

    try {
      const scope = scopeToTenant(getDatabase(), tenantDomain);
      const existing = scope.getParticipantByName(handleName);
      if (!existing) {
        const deleted = scope.getParticipantByNameIncludingDeleted(handleName);
        if (deleted && deleted.deleted_at !== null) {
          if (deleted.owner === githubLogin) {
            scope.reviveParticipant(handleName, githubLogin);
          } else {
            return res.status(403).json({
              error: 'Forbidden',
              message: `handle ${handleName} は削除済で別ユーザー所有のため再利用不可`,
            });
          }
        } else {
          scope.registerParticipant({ name: handleBase }, githubLogin);
        }
      } else if (existing.owner === null) {
        scope.claimOwnerIfUnowned(handleName, githubLogin);
      } else if (existing.owner !== githubLogin) {
        return res.status(403).json({
          error: 'Forbidden',
          message: `handle ${handleName} は他のユーザー所有です`,
        });
      }

      // issue #28: 「見えない幽霊」 bug detection (= AGENT_HUB_TENANT 伝播失敗 signal)。
      // session block しない diagnostic only。 trust 経路と同じ judgement。
      maybeWarnGhostSession(getDatabase(), handleName, tenantDomain, githubLogin);

      req.userId = handleName;
      req.githubLogin = githubLogin;
      req.tenantDomain = tenantDomain;
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

  // edition resolver が AuthMode を 'trust' | 'pat' に narrow しているため
  // この分岐に来ることは無いが、型の網羅性 (exhaustiveness) のための fallback。
  // istanbul ignore next
  const _unreachable: never = mode;
  return res.status(500).json({
    error: 'ServerMisconfigured',
    message: `unknown AUTH_MODE: ${_unreachable}. Use 'trust' or 'pat'.`,
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
 * notification dispatch に必要な session の最小 shape。
 * テストで実 Session を組み立てずに filter ロジックだけ検証するため。
 */
export interface NotifiableSession {
  tenantDomain: string;
  subscribedUris: Set<string>;
}

/**
 * `(uri, tenantDomain)` 条件で notification を飛ばすべき session id を選び出す純粋関数。
 *
 * Inbox URI (`inbox://<name>`) は tenant 識別子を含まないため、同名 handle が
 * 複数 tenant に存在すると URI だけでの dispatch が tenant を超えて leak する
 * (issue #7)。subscribe 時の session.tenantDomain と送信元 tenant を突き合わせる
 * ことで、データ本体だけでなく「存在の side-channel」も tenant 境界に閉じ込める。
 *
 * - sid === except は除外（送信者本人の重複通知抑制用）
 * - session.tenantDomain が一致しなければ除外（tenant leak ガード）
 * - subscribedUris に uri が無ければ除外（そもそも subscribe していない）
 */
export function selectNotificationTargets<S extends NotifiableSession>(
  sessionEntries: Iterable<readonly [string, S]>,
  uri: string,
  tenantDomain: string,
  except?: string
): string[] {
  const targets: string[] = [];
  for (const [sid, session] of sessionEntries) {
    if (sid === except) continue;
    if (session.tenantDomain !== tenantDomain) continue;
    if (!session.subscribedUris.has(uri)) continue;
    targets.push(sid);
  }
  return targets;
}

/**
 * presence (online/offline) 判定のための session の最小 shape (issue #1)。
 *
 * 「online」= 同 tenant 内の自分 handle 用 session が、自分の inbox URI を
 * resource subscribe している状態。`Session` から `userId / tenantDomain /
 * subscribedUris` だけを抜き出した形なので、test では実 Session を組み立てず
 * 純粋関数として presence ロジックを検証できる。
 */
export interface PresenceSession {
  tenantDomain: string;
  userId: string;
  subscribedUris: Set<string>;
}

/**
 * `(tenantDomain, handleName)` の participant が現在 online か判定する純粋関数。
 *
 * Inbox URI は tenant 識別子を含まないため、tenantDomain が一致する session
 * かつ userId が一致する session の中で、canonical inbox URI を subscribe して
 * いるものが 1 つでもあれば online。
 *
 * 設計メモ (issue #1 depth A):
 * - `register` 直後で未 subscribe の participant は `false` を返す
 * - 同一 handle で複数 session があるケース (= multiple Claude Code 同時起動 等)
 *   は 1 つでも subscribe 中なら `true`
 * - SSE close 時には Session 自体が `sessions` Map から消えるため、自動で `false`
 *   に転ぶ (= 専用 close hook 不要)
 * - stateless peer は subscribe しないので常に `false` (issue 仕様として許容)
 */
export function isParticipantOnline<S extends PresenceSession>(
  sessionEntries: Iterable<readonly [string, S]>,
  tenantDomain: string,
  handleName: string
): boolean {
  const inboxUri = inboxUriFor(handleName);
  for (const [, session] of sessionEntries) {
    if (session.tenantDomain !== tenantDomain) continue;
    if (session.userId !== handleName) continue;
    if (session.subscribedUris.has(inboxUri)) return true;
  }
  return false;
}

/**
 * 指定 resource を購読している session に `notifications/resources/updated` を流す。
 * send_message ハンドラ等から呼び出される。
 *
 * - tenant 跨ぎは抑止する (issue #7): tenantDomain が一致する session のみ対象
 * - 例外送信元 (except) があれば除外（送信者本人への通知を抑制したい場合）
 * - notification の発火は best-effort、エラーが出ても他 session の通知は止めない
 */
export function notifyResourceUpdated(
  uri: string,
  tenantDomain: string,
  except?: string
): void {
  const targets = selectNotificationTargets(sessions, uri, tenantDomain, except);
  for (const sid of targets) {
    const session = sessions.get(sid);
    if (!session) continue;
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
 * Edition 設定から ListTools で露出すべき tool 定義一覧を導出する純粋関数。
 *
 * PE では list_tenants / get_tenant / delete_tenant (= CE-operator tools) を落とす。
 * CallTool 側でも edition gate を持つので、ListTools と CallTool で同じ edition
 * config を参照することで「list で隠れているのに call で通る」状態を排除する。
 *
 * 切り出し理由 (= test しやすさ): `createMcpServer` 内部の closure だと unit test
 * から触れない。pure function に出すことで edition × tool list の組合せが
 * 単体検証可能になる。
 */
export function getAvailableTools(editionConfig: EditionConfig): Array<unknown> {
  const baseTools: Array<unknown> = [
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
  ];
  if (editionConfig.exposesCeAdminTools) {
    baseTools.push(listTenantsTool, getTenantTool, deleteTenantTool);
  }
  return baseTools;
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

  // ツール一覧 (edition 依存で CE-operator tools を露出 / 非露出)
  // PE では list_tenants / get_tenant / delete_tenant が無意味 (= tenant が 1 つしかない)
  // なので ListTools から落とす。CallTool 側でも防御 (= 同名 call を error で reject)。
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getAvailableTools(getEditionConfig()),
  }));

  // ツール実行
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;

    const sid = extra.sessionId;
    const session = sid ? sessions.get(sid) : undefined;
    const userId = session?.userId;
    const githubLogin = session?.githubLogin;
    const tenantDomain = session?.tenantDomain;
    if (!userId || !githubLogin || !tenantDomain) {
      throw new Error('session is not authenticated (sessionId missing or session expired)');
    }

    const scope = scopeToTenant(getDatabase(), tenantDomain);

    // PE では CE-operator tools (list/get/delete tenant) は ListTools に無いが、
    // 直接 name 指定で call されるケースを defense-in-depth で塞ぐ。
    const editionConfig = getEditionConfig();
    if (
      !editionConfig.exposesCeAdminTools &&
      (name === 'list_tenants' || name === 'get_tenant' || name === 'delete_tenant')
    ) {
      throw new Error(
        `tool '${name}' is not available in AGENT_HUB_EDITION=${editionConfig.edition}`
      );
    }

    switch (name) {
      case 'register':
        return await handleRegister(scope, args, userId, githubLogin);
      case 'get_participants':
        return await handleGetParticipants(scope, args, userId, (handleName) =>
          isParticipantOnline(sessions, tenantDomain, handleName)
        );
      case 'create_team':
        return await handleCreateTeam(scope, args, userId);
      case 'update_team':
        return await handleUpdateTeam(scope, args, userId);
      case 'delete_team':
        return await handleDeleteTeam(scope, args, userId);
      case 'send_message':
        return await handleSendMessage(scope, args, userId);
      case 'get_messages':
        return await handleGetMessages(scope, args, userId);
      case 'get_history':
        return await handleGetHistory(scope, args, userId);
      case 'mark_as_read':
        return await handleMarkAsRead(scope, args, userId);
      case 'delete_user':
        return await handleDeleteUser(scope, args, userId);
      case 'get_user_history':
        return await handleGetUserHistory(scope, args, userId);
      case 'list_tenants':
        return await handleListTenants(scope, args, userId);
      case 'get_tenant':
        return await handleGetTenant(scope, args, userId);
      case 'delete_tenant':
        return await handleDeleteTenant(scope, args, userId);
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
    const session = sid ? sessions.get(sid) : undefined;
    if (!session) {
      throw new Error('session not found');
    }
    const { userId, tenantDomain } = session;
    const uri = request.params.uri;
    const owner = uriToInboxOwner(uri);
    if (!owner) {
      throw new Error(`unsupported resource uri: ${uri}`);
    }
    const ownerHandle = owner.startsWith('@') ? owner : `@${owner}`;
    if (ownerHandle !== userId) {
      throw new Error(`forbidden: cannot read another user's inbox`);
    }
    const scope = scopeToTenant(getDatabase(), tenantDomain);
    const messages = scope.getUnreadMessages(userId);
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
    // ヘルスチェック（認証不要）。
    // 既存: edition / auth_mode / sessions 数
    // 追加 (issue #47): git_commit / git_commit_at / started_at で running build を外から識別可能にする
    this.app.get('/health', (_req: Request, res: Response) => {
      const editionConfig = activeEditionConfig;
      const version = getVersionInfo();
      res.json({
        status: 'ok',
        service: 'agent-hub',
        edition: editionConfig?.edition ?? 'unknown',
        auth_mode: editionConfig?.authMode ?? 'unknown',
        sessions: sessions.size,
        git_commit: version.git_commit,
        git_commit_at: version.git_commit_at,
        started_at: version.started_at,
      });
    });

    // POST /mcp: リクエスト受信エンドポイント
    // - mcp-session-id ヘッダーがあれば既存 session に dispatch
    // - 無くて initialize なら新規 session 作成
    // - それ以外は 400
    this.app.post('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      // authenticateUser middleware が必ずセットしている契約。型安全のため明示確認。
      if (!req.userId || !req.githubLogin || !req.tenantDomain) {
        res
          .status(401)
          .json({ error: 'Unauthorized', message: 'authentication middleware did not set userId/tenantDomain' });
        return;
      }
      const userId = req.userId;
      const githubLogin = req.githubLogin;
      const tenantDomain = req.tenantDomain;

      try {
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
          return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
          // 新規 session 作成
          //
          // eventStore は SSE 通知の resumability に必須:
          // - GET 切断中に来た notifications は eventStore に保持される
          // - 再接続時に client が Last-Event-ID header で resume → server が
          //   replayEventsAfter() で取りこぼし分を再送
          // 渡さないと「切断中の push は完全に消失、再接続しても無音」になる。
          // process 全体で 1 つの BoundedInMemoryEventStore を共有 (= 後述)。
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore: notificationEventStore,
            onsessioninitialized: (sid) => {
              sessions.set(sid, {
                transport,
                server,
                userId,
                githubLogin,
                tenantDomain,
                subscribedUris: new Set(),
              });
              console.log(
                `[MCP] session opened: ${sid} userId=${userId} githubLogin=${githubLogin} tenant=${tenantDomain}`
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

  /**
   * サーバー起動。
   *
   * 起動時 step:
   *   1. edition を解決して singleton に cache (= 全 handler が参照)
   *      - env 不正 / conflict は EditionConfigError で fail-fast
   *   2. DB 初期化 (migration 適用)
   *   3. express listen
   *
   * edition 解決を listen より前に置くことで、後続 request が必ず resolved 済の
   * EditionConfig を見る (= activeEditionConfig が null になる窓を排除)。
   */
  async start(): Promise<void> {
    activeEditionConfig = resolveEdition(process.env);
    await this.initDatabase();

    return new Promise((resolve) => {
      this.app.listen(this.port, '0.0.0.0', () => {
        const cfg = activeEditionConfig!;
        const org = process.env.AGENT_HUB_GITHUB_ORG;
        console.log(`🚀 agent-hub MCP Server listening on http://0.0.0.0:${this.port}`);
        console.log(`📡 MCP endpoint: http://localhost:${this.port}/mcp`);
        console.log(`💊 Health check: http://localhost:${this.port}/health`);
        if (cfg.edition === 'private') {
          console.log(
            `🏠 AGENT_HUB_EDITION=private  LAN 専用 / trust mode 固定 / default tenant のみ`
          );
        } else {
          console.log(
            `🌐 AGENT_HUB_EDITION=community  PAT 認証${org ? ` / Org=${org}` : ''} / multi-tenant`
          );
          if (!cfg.enforcesDefaultTenantRestriction) {
            console.log(
              `⚠️  AGENT_HUB_DISABLE_DEFAULT_TENANT=0  default tenant 開放中 (dev/localhost 想定)`
            );
          }
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
