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
import { getThreadTool, handleGetThread } from './tools/get_thread.js';
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
  listSessionsByUserTool,
  handleListSessionsByUser,
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
  clientType: string | null; // X-Agent-Hub-Client ヘッダー値 (issue #276)。未送信なら null
  subscribedUris: Set<string>;
  // issue #114 (= notify dedup): 同 (tenant, userId, uri) の複数 session が存在する場合、
  // 最 recent 1 session のみに push する dedup の **tie-breaker** に使用。
  // session 作成時に Date.now() で固定、 以降不変。 last_active_at (= participants table)
  // 同値時の secondary order として使う (= 「同一 user の中で最も最近 created な session」 を
  // 「現用 instance」 と推定)。
  createdAt: number;
  // POST /mcp を受けるたびに更新。resources/subscribe を持たない SDK (Go bridge-tmux 等) が
  // orphan eviction に誤って引っかかるのを防ぐ。
  // → subscribedUris.size === 0 でも lastActivityAt が新しければ正常 session と判断。
  lastActivityAt: number;
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
  // TODO(future): multi-operator 化時に role-based skip list へ refactor 余地 (= reviewer Suggestion 1)
  if (handleName === '@admin') return;

  // cooldown check を **SQL 前** に置く (= reviewer Minor 1 反映)。
  // persistent ghost 状態 (= default 着地 + non-admin + named match あり) の user は
  // every MCP request で middleware を通るが、 60s cooldown 内は SQL も log も full skip
  // することで unnecessary scan を避ける。 cache key は (owner, handle) tuple のみで決まり
  // SQL 不要のため、 早期判定可能。
  const cacheKey = `${githubLogin}::${handleName}`;
  const now = Date.now();
  const lastWarn = ghostWarnCache.get(cacheKey);
  if (lastWarn !== undefined && now - lastWarn < GHOST_WARN_COOLDOWN_MS) return;

  const namedTenants = findOtherTenantsForHandleAndOwner(
    db,
    handleName,
    githubLogin,
    DEFAULT_TENANT
  );
  if (namedTenants.length === 0) return;

  // 実際に WARN を出す path に到達したら cache update (= 「ghost と判定 + warn 発火」 を記録)。
  // 上の cooldown check より後ろに置くことで、 「named match なし」 で skip した case は
  // cache に記録されず、 次回 request も SQL check し直す (= 新規 ghost state の検出能力を保持)。
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
 * Test-only: sessions Map に任意の Session を注入する (issue #155 orphan eviction test 用)。
 * `_resetGhostWarnCacheForTests` / `setEditionConfigForTesting` と同 pattern。
 * production コードでは呼ばない。
 */
export function _addSessionForTesting(sid: string, session: unknown): void {
  sessions.set(sid, session as Session);
}

/**
 * Test-only: sessions Map を全件 clear する (issue #155 orphan eviction test 用)。
 * afterEach で呼んで test isolation を保証する。
 */
export function _clearSessionsForTesting(): void {
  sessions.clear();
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
 * `notifications/resources/updated` replay フィルタ (= issue #117 fix) の
 * rollback path (= `AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED` 環境変数)。
 *
 * **binary semantic** (= PR #105 / #116 と同 convention):
 * - unset / empty (default, new behavior): resource update 通知は replay しない
 *   (= issue #117 fix 有効、replay フィルタ ON)
 * - set: 旧動作に戻す (= 全 event を replay、フィルタ OFF)
 *
 * `notifications/resources/updated` は「新着あり」hint に過ぎず、replay しても
 * client が ack 前の同一メッセージを再処理するだけ (= double dispatch)。
 * 実 message は `get_unread()` で取れるため hint の再送は不要。
 * SDK safety-net poll (30s) が取りこぼしをカバーする。
 */
export function isResourceNotifyFilterDisabled(): boolean {
  return process.env.AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED !== undefined &&
    process.env.AGENT_HUB_MCP_RESOURCE_NOTIFY_FILTER_DISABLED !== '';
}

/**
 * SSE 通知 resumability 用の process-wide event store.
 * StreamableHTTPServerTransport の eventStore option に渡す。
 *
 * - GET 切断中の通知を保持 (= 再接続時 replay)
 * - bound: stream あたり 200 件 / TTL 10 分
 * - 永続化なし (= server restart で全消失、それで OK な前提)
 * - `notifications/resources/updated` は replay フィルタで除外 (= issue #117 fix)
 */
const notificationEventStore = isResourceNotifyFilterDisabled()
  ? new BoundedInMemoryEventStore()
  : new BoundedInMemoryEventStore({
      replayFilter: (msg) =>
        !('method' in msg && msg.method === 'notifications/resources/updated'),
    });

/**
 * 認証ミドルウェア
 *
 * AGENT_HUB_AUTH_MODE 環境変数で挙動を切り替える:
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

/** X-Agent-Hub-Client ヘッダーを正規化して返す。未送信 or 空文字なら null (issue #276)。 */
function resolveClientType(req: Request): string | null {
  const h = req.headers['x-agent-hub-client'];
  if (typeof h !== 'string') return null;
  const trimmed = h.trim();
  return trimmed === '' ? null : trimmed;
}

async function authenticateUser(req: Request, res: Response, next: NextFunction) {
  // edition-driven auth mode (= startup resolved、env を直接読まない)
  const mode = getEditionConfig().authMode;

  if (mode === 'trust') {
    const userId = req.headers['x-user-id'];
    if (typeof userId !== 'string' || userId.trim() === '') {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'AGENT_HUB_AUTH_MODE=trust: X-User-Id header is required',
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
    req.clientType = resolveClientType(req);
    return next();
  }

  if (mode === 'pat') {
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="agent-hub"');
      return res.status(401).json({
        error: 'Unauthorized',
        message:
          'AGENT_HUB_AUTH_MODE=pat: Authorization: Bearer <github-pat> required. ' +
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

    // Fix 3 (issue #21): cross-persona override を WARN log で記録。
    // 同一 PAT を持つ複数 process がそれぞれ異なる persona で接続している場合の
    // 監視 visibility を提供する (= schema 変更不要の cheap mitigation)。
    if (override !== '' && override !== githubLogin) {
      console.warn(
        `[auth] cross-persona override: PAT owner=${githubLogin} → handle=@${override}` +
          ` (tenant=${tenantDomain})`
      );
    }

    // Fix 2 (issue #21): strict handle ownership mode。
    // `AGENT_HUB_STRICT_HANDLE_OWNERSHIP` が set の場合、cross-persona override を拒否。
    // 単一 persona deployment で意図せぬ persona switch を構造的に防止する。
    if (override !== '' && override !== githubLogin && isStrictHandleOwnershipEnabled()) {
      return res.status(403).json({
        error: 'Forbidden',
        message:
          `AGENT_HUB_STRICT_HANDLE_OWNERSHIP: cross-persona override is not allowed. ` +
          `PAT owner=${githubLogin} cannot connect as @${override}. ` +
          `Unset X-User-Id to connect as @${githubLogin}, or disable strict mode.`,
      });
    }

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
      req.clientType = resolveClientType(req);
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
    message: `unknown AGENT_HUB_AUTH_MODE: ${_unreachable}. Use 'trust' or 'pat'.`,
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

// ============================================================
// Active ping-based presence (= issue #91)
// ============================================================

/**
 * Active ping presence loop constants。
 *
 * spec (= issue #91):
 * - 30 秒ごとに全 session に ping
 * - PING_TIMEOUT_MS 以内に pong なし → timeout
 * - timeout → retry 2 回 (= 計 3 attempts) → 全 fail なら disconnect
 *
 * 数字は protocol level の MCP ping (= SDK 内蔵)、 round-trip latency を見ているので
 * 通常応答 << 1 秒に対して充分 conservative。
 * PING_TIMEOUT_MS は元々 5_000 だったが、voice-gateway 等の重量クライアントが
 * 低速環境で誤 timeout を起こす問題 (issue #240) を受けて 10_000 に緩和した。
 */
const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000; // issue #240: 5_000 → 10_000 (voice-gateway 等低速環境の誤検知緩和)
const PING_MAX_RETRIES = 2;

/**
 * Orphan session の idle TTL (= issue #155)。
 *
 * `initialize` 完了後に `subscribe` を送らないまま本値を超えた session を
 * ping cycle 末尾で強制 evict する。
 *
 * 正常系の bridge は `initialize` → `subscribe` を MCP init シーケンス内で
 * 同期実施 (= 通常 < 5 秒)。5 分は安全マージンとして十分。
 * これを超える未 subscribe は起動失敗と等価とみなして良い。
 */
const ORPHAN_IDLE_TTL_MS = 5 * 60_000;

/**
 * SSE keepalive コメント送出間隔 (issue #240)。
 *
 * GET /mcp ストリームに本間隔で `: keepalive\n\n` を書き込み、
 * HTTP プロキシ (fly.io 等) の idle timeout をリセットする。
 * SSE comment はクライアントが無視するため MCP プロトコルへの影響なし。
 */
export const SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * SSE レスポンスに keepalive コメントを書き込む (issue #240)。
 *
 * `res.writableEnded` が true の場合は書き込みをスキップする (接続クローズ race 対策)。
 */
export function writeSseKeepalive(res: {
  writableEnded: boolean;
  write: (chunk: string) => boolean;
}): void {
  if (!res.writableEnded) {
    res.write(': keepalive\n\n');
  }
}

/**
 * Feature flag: `AGENT_HUB_MCP_PING_LOOP_DISABLED` env が set されていれば active ping loop 無効化
 * (= rollback safety + 既存 SSE-only presence に倒す)。
 *
 * 「unset = 新 behavior (= active ping)」 が default、 「set = 旧 behavior (= subscribe-only)」 が opt-out。
 * 値の中身は問わない (= binary signal、 redline #1 整合)。 `AGENT_HUB_MCP_AUTO_REISSUE_DISABLED` (= #68) と
 * 同 pattern。
 */
export function isPingLoopDisabled(): boolean {
  return process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED !== undefined &&
    process.env.AGENT_HUB_MCP_PING_LOOP_DISABLED !== '';
}

/** PING_TIMEOUT_MS の現在値を返す (テスト・ログ参照用)。issue #240 */
export function getPingTimeoutMs(): number {
  return PING_TIMEOUT_MS;
}

/**
 * Session の MCP ping を timeout 付きで実行し、 pong 受信したら true、 timeout / error なら false。
 *
 * MCP SDK `server.ping()` は protocol-level ping (= spec.modelcontextprotocol.io の Ping utility)、
 * 標準的な client (= SDK M4 CommandRouter 経由 bridge / Claude Code 内蔵 client / scheduler) は
 * 自動応答する。 「inbox listener がバグで応答不能」 等の zombie state (= issue #91 motivation)
 * を MCP-level で detect。
 */
async function pingSessionWithTimeout(
  session: Session,
  timeoutMs: number = PING_TIMEOUT_MS
): Promise<boolean> {
  try {
    await Promise.race([
      session.server.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('ping timeout')), timeoutMs)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single session に対して retry 付き ping (= issue #91 spec の retry M 回)。
 *
 * 全 attempt fail なら false (= session を disconnect すべき signal)、
 * いずれか 1 回でも success なら true。
 */
async function pingSessionWithRetry(session: Session): Promise<boolean> {
  for (let attempt = 0; attempt <= PING_MAX_RETRIES; attempt++) {
    const alive = await pingSessionWithTimeout(session);
    if (alive) return true;
  }
  return false;
}

/**
 * Active ping loop の cleanup handle (= 「停止 function」)。 future test 用 / graceful
 * shutdown 用に exposed。
 */
let activePingLoopInterval: NodeJS.Timeout | null = null;

/**
 * 全 session を一回り ping する (= 1 cycle)。 各 session を並列に処理 (= Promise.allSettled)、
 * 1 つの slow session が他を block しない。 timeout の retry 後も応答なければ session を
 * disconnect (= sessions.delete + transport.close)。
 *
 * 「**SSE は alive だが応答不能**」 zombie state (= issue #91 motivation: scheduler 2026-05-19
 * UTF-8 デコードバグの実例) を server-side で自動 cleanup。
 *
 * `is_online` (= `selectNotificationTargets` で session 存在 check) は本 cleanup により
 * 自動的に false に倒れる (= 別途 is_online flag を持つ必要なし)。
 */
export async function runOneActivePingCycle(): Promise<{
  total: number;
  alive: number;
  disconnected: number;
  orphansEvicted: number;
}> {
  // sessions Map の iteration 中の mutation は dangerous (= delete in loop)、 snapshot に take。
  const snapshot: Array<[string, Session]> = Array.from(sessions.entries());
  const results = await Promise.allSettled(
    snapshot.map(async ([sid, session]) => {
      const alive = await pingSessionWithRetry(session);
      return { sid, session, alive };
    })
  );

  let aliveCount = 0;
  let disconnectedCount = 0;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { sid, session, alive } = r.value;
    if (alive) {
      aliveCount++;
      continue;
    }
    // Disconnect: session が `sessions` から消えれば is_online は自動 false に。
    // transport.close() で SSE GET 側の long-lived connection も切断 (= bridge の reconnect loop が trigger される)。
    console.log(
      `[MCP] ping failed for session ${sid} (= ${session.userId}@${session.tenantDomain}) ` +
        `after ${PING_MAX_RETRIES + 1} attempts, disconnecting`
    );
    try {
      await session.transport.close();
    } catch (err) {
      console.error(`[MCP] transport.close failed for sid=${sid} (non-fatal):`, err);
    }
    // transport.onclose も sessions.delete を呼ぶが、 race 回避で明示削除
    if (sessions.has(sid)) {
      sessions.delete(sid);
    }
    disconnectedCount++;
  }

  // --- orphan session eviction (issue #155) ---
  //
  // `subscribe` を送らないまま ORPHAN_IDLE_TTL_MS を超えた「真の」orphan session を強制回収。
  //
  // root cause: bridge の kill → re-spawn 時に MCP initialize が短時間に複数発行される。
  // 各 initialize で sessions.set() される が、 subscribe に到達するのは最後の 1 session のみ。
  // 残りは subscribedUris=[] のまま残留し、 StreamableHTTP の接続が alive のため ping も
  // 成功し続ける → 上の ping フェーズでは回収されない。
  //
  // 正常系の TypeScript bridge は initialize → subscribe を数秒以内に実施するため、
  // 5 分 TTL は安全マージンとして十分。
  //
  // ただし Go SDK (bridge-tmux 等) は resources/subscribe を実装しておらず、
  // subscribedUris.size が常に 0 のまま正常稼働する。このため条件に
  // lastActivityAt (= POST /mcp を受けるたびに更新) を追加し、
  // 「unsubscribed かつ最近 POST 活動もない」 session のみを orphan と判定する。
  // bridge-tmux は 5 秒ごとに get_messages を POST するため eviction 対象外になる。
  let orphansEvicted = 0;
  const nowMs = Date.now();
  for (const [sid, session] of sessions) {
    if (
      session.subscribedUris.size === 0 &&
      nowMs - session.createdAt > ORPHAN_IDLE_TTL_MS &&
      nowMs - session.lastActivityAt > ORPHAN_IDLE_TTL_MS
    ) {
      console.log(
        `[MCP] orphan session evicted: ${sid} ` +
          `(userId=${session.userId} tenant=${session.tenantDomain} ` +
          `createdAt=${new Date(session.createdAt).toISOString()}, issue #155)`
      );
      try {
        await session.transport.close();
      } catch (err) {
        console.error(`[MCP] orphan evict transport.close failed for sid=${sid} (non-fatal):`, err);
      }
      // transport.onclose も sessions.delete を呼ぶが、 race 回避で明示削除
      if (sessions.has(sid)) {
        sessions.delete(sid);
      }
      orphansEvicted++;
    }
  }

  return { total: snapshot.length, alive: aliveCount, disconnected: disconnectedCount, orphansEvicted };
}

/**
 * Active ping loop を起動 (= MCPServer.start() で呼ぶ)。
 *
 * 既に起動中なら no-op。 stop function を返すので、 test 等で停止できる。
 * feature flag `AGENT_HUB_MCP_PING_LOOP_DISABLED` が set されていれば起動 skip。
 */
export function startActivePingLoop(): () => void {
  if (activePingLoopInterval) {
    return () => stopActivePingLoop();
  }
  if (isPingLoopDisabled()) {
    console.log('[MCP] active ping loop disabled (= AGENT_HUB_MCP_PING_LOOP_DISABLED env set)');
    return () => {};
  }
  console.log(
    `[MCP] active ping loop starting (= ${PING_INTERVAL_MS / 1000}s interval、 ` +
      `${PING_TIMEOUT_MS / 1000}s timeout、 ${PING_MAX_RETRIES} retries、 issue #91)`
  );
  activePingLoopInterval = setInterval(() => {
    void runOneActivePingCycle().then((stats) => {
      if (stats.disconnected > 0 || stats.orphansEvicted > 0) {
        console.log(
          `[MCP] ping cycle: total=${stats.total} alive=${stats.alive} ` +
            `disconnected=${stats.disconnected} orphansEvicted=${stats.orphansEvicted}`
        );
      }
    });
  }, PING_INTERVAL_MS);
  return () => stopActivePingLoop();
}

/** Active ping loop を停止 (= graceful shutdown 用)。 */
export function stopActivePingLoop(): void {
  if (activePingLoopInterval) {
    clearInterval(activePingLoopInterval);
    activePingLoopInterval = null;
    console.log('[MCP] active ping loop stopped');
  }
}

// ============================================================
// MCP session auto-reconnect (= issue #68、 PR #100 設計 doc 実装)
// ============================================================

/**
 * Feature flag: `AGENT_HUB_MCP_AUTO_REISSUE_DISABLED` env が set されていれば auto-reissue 無効化、
 * 旧 path (= 400 Bad Request) に倒す (= rollback safety、 PR #100 reviewer Suggestion (a))。
 *
 * 「unset = 新 behavior (= reissue)」 が default、 「set = 旧 behavior (= 400)」 が opt-out。
 * 値の中身は問わない (= binary signal、 redline #1 整合)。
 *
 * production rollback path:
 *   `docker run -e AGENT_HUB_MCP_AUTO_REISSUE_DISABLED=1 ...` で即時 disable。
 *
 * future PR 候補 (= prometheus counter / reissue 頻度監視) は本 PR scope 外、 comment defer。
 */
export function isAutoReissueDisabled(): boolean {
  return process.env.AGENT_HUB_MCP_AUTO_REISSUE_DISABLED !== undefined &&
    process.env.AGENT_HUB_MCP_AUTO_REISSUE_DISABLED !== '';
}

/**
 * Fix 2 (issue #21): strict handle ownership mode。
 *
 * `AGENT_HUB_STRICT_HANDLE_OWNERSHIP` が set (= 空文字以外) の場合、
 * PAT auth で `X-User-Id` override による cross-persona 接続を **拒否**。
 * override 元 githubLogin と override 先 handle の owner が一致しない場合は 403。
 *
 * 未設定 or 空文字 = 旧動作 (= override 許可、マルチペルソナ運用可能)。
 * `1` を設定する運用が推奨 (= single-persona deployment で意図せぬ cross-persona を防ぐ)。
 *
 * 「set = 新 feature (= strict) を有効化」 なので binary env var 規約 (= set → 有効)
 * と整合する。
 */
export function isStrictHandleOwnershipEnabled(): boolean {
  return process.env.AGENT_HUB_STRICT_HANDLE_OWNERSHIP !== undefined &&
    process.env.AGENT_HUB_STRICT_HANDLE_OWNERSHIP !== '';
}

/**
 * Dummy Express Response (= reissuance 時の synthetic initialize 用、 PR #100 設計 doc §3.3)。
 *
 * MCP SDK の `transport.handleRequest(req, res, body)` で body=initialize を実行する際、
 * 通常 res に response が書き出される。 reissuance では 「session を作る」 のが目的で、
 * 「response を返す」 のは目的ではない (= real res は元 request の処理に使う)。
 *
 * このため res の write / writeHead / end / setHeader 等を **silently absorb** する
 * 最小 stub を提供。 internal 状態は `headersSent: false` 固定 (= SDK が再書き込みを
 * 試みるかも) で statelessness 維持。
 *
 * §7.1 reviewer Minor 反映: **「dummy response が real response stream を汚染しない」**
 * 性質を test で verify (= ghost_session_warn の `vi.spyOn` pattern と同様、
 * spy で dummy への write 数を観察 + real res への write が独立であること確認)。
 */
function createDummyResponse(): Response {
  const dummy = {
    headersSent: false,
    statusCode: 200,
    locals: {},
    setHeader: (_name: string, _value: unknown) => dummy,
    getHeader: (_name: string) => undefined,
    removeHeader: (_name: string) => dummy,
    writeHead: (_status?: number, _headers?: unknown) => dummy,
    write: (_chunk?: unknown, _encoding?: unknown, _cb?: unknown) => true,
    end: (_chunk?: unknown, _encoding?: unknown, _cb?: unknown) => dummy,
    status: (code: number) => {
      dummy.statusCode = code;
      return dummy;
    },
    json: (_body: unknown) => dummy,
    send: (_body: unknown) => dummy,
    sendStatus: (code: number) => {
      dummy.statusCode = code;
      return dummy;
    },
    type: (_contentType: string) => dummy,
    on: (_event: string, _cb: unknown) => dummy,
    once: (_event: string, _cb: unknown) => dummy,
    emit: (_event: string, ..._args: unknown[]) => true,
    removeListener: (_event: string, _cb: unknown) => dummy,
    off: (_event: string, _cb: unknown) => dummy,
    flushHeaders: () => dummy,
    cork: () => dummy,
    uncork: () => dummy,
  };
  return dummy as unknown as Response;
}

/**
 * Stale session ID + valid auth + non-initialize request を受けて、
 * **新 session を auto-create + 元 request を新 session で process** する (= issue #68 core)。
 *
 * 設計 doc PR #100 §3.2-§3.3 に基づく 3-step flow:
 *   1. 新 transport / server を構築 (= 既存 initialize path と同等の構造)
 *   2. synthetic `initialize` + `notifications/initialized` を **dummy res** に送信
 *      (= SDK の MCP プロトコル整合性を満たし、 transport を ready 状態に)
 *   3. 元 request body を **real res** に送信 (= client に新 mcp-session-id header + 結果)
 *
 * client は response header `mcp-session-id` から新 session ID を取得、 以降は通常
 * dispatch path に乗る (= 1 request だけ reissuance path、 後続は既存 path)。
 *
 * security: auth context (= userId / githubLogin / tenantDomain) は **request 時** の値を
 * 使用。 旧 session の owner は無関係 (= §5.1 PAT 変更検出、 §5.2 tenant 変更検出 と整合)。
 */
async function reissueSessionAndDispatch(
  req: Request,
  res: Response,
  ctx: {
    staleSessionId: string;
    userId: string;
    githubLogin: string;
    tenantDomain: string;
    clientType: string | null;
  }
): Promise<void> {
  const { staleSessionId, userId, githubLogin, tenantDomain, clientType } = ctx;
  console.log(
    `[MCP] session ${staleSessionId} unknown (= server restart?), reissuing for ` +
      `userId=${userId} tenant=${tenantDomain}`
  );

  // Step 1: 新 transport + server (= 既存 initialize path と同等構造)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore: notificationEventStore,
    onsessioninitialized: (newSid) => {
      sessions.set(newSid, {
        transport,
        server,
        userId,
        githubLogin,
        tenantDomain,
        clientType,
        subscribedUris: new Set(),
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });
      console.log(
        `[MCP] session reissued: ${newSid} (replaces stale ${staleSessionId}) ` +
          `userId=${userId} tenant=${tenantDomain}`
      );
    },
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && sessions.has(sid)) {
      sessions.delete(sid);
      console.log(`[MCP] session closed: ${sid} (was reissued from ${staleSessionId})`);
    }
  };

  const server = createMcpServer();
  await server.connect(transport as Parameters<typeof server.connect>[0]);

  // Step 2: synthetic initialize + notifications/initialized (= dummy res、 SDK プロトコル整合性)
  const dummyRes = createDummyResponse();
  const syntheticInit = {
    jsonrpc: '2.0' as const,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agent-hub-reissue', version: '1.0' },
    },
    id: 'reissue-init-' + staleSessionId.slice(0, 8),
  };
  await transport.handleRequest(req, dummyRes, syntheticInit);

  const syntheticInitialized = {
    jsonrpc: '2.0' as const,
    method: 'notifications/initialized',
  };
  await transport.handleRequest(req, dummyRes, syntheticInitialized);

  // Step 3: 元 request を新 transport (= 新 session) で process、 real res に response
  // future PR 候補 (= prometheus counter):
  //   ここで reissue 回数 metric を increment する余地 (= PR #100 Suggestion (b) defer)。
  //   `reissue_counter.inc({tenant: tenantDomain})` 等で per-tenant 監視可能。
  await transport.handleRequest(req, res, req.body);
}

/**
 * notification dispatch に必要な session の最小 shape。
 * テストで実 Session を組み立てずに filter ロジックだけ検証するため。
 *
 * issue #114 (= notify dedup): `userId` + `createdAt` を含めて、 同 (tenant, userId,
 * uri) で複数 subscribers が存在する場合の dedup tie-breaker に使えるようにする。
 */
export interface NotifiableSession {
  tenantDomain: string;
  userId: string;
  subscribedUris: Set<string>;
  createdAt: number;
}

/**
 * issue #114 fix の rollback path (= `AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED` 環境変数)。
 *
 * **binary semantic**: set されていれば true (= 旧 「全 subscribers fanout」 path に倒す)、
 * unset / empty なら false (= 新 dedup 動作、 default)。 値の文字列 (`0`/`false` 等) は
 * 解釈しない (= PR #105 `AGENT_HUB_MCP_AUTO_REISSUE_DISABLED` と同 convention、 「set されたら
 * disable」 が rule)。
 *
 * deploy 後 production で異常 detect した operator が **環境変数 1 つで旧 behavior に
 * 即時 revert** できる safety mechanism。 revert 時は server restart で旧 fanout
 * (= 全 subscribers に push) に倒れる、 dedup invariant は disabled。
 */
export function isNotifyDedupDisabled(): boolean {
  return process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED !== undefined &&
    process.env.AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED !== '';
}

/**
 * dedup の selection criteria 用 callback。 同 (tenantDomain, userId) participant の
 * **`last_active_at` ISO timestamp** を返す (= participants table から lookup)。
 * 該当 row が存在しない / `last_active_at` が null の場合は `null` を返す。
 *
 * ISO 8601 timestamp は **lexicographic order = chronological order** が保証される
 * format (= 「2026-05-20T14:00:00.000」 < 「2026-05-20T14:30:00.000」 が string 比較で
 * 成り立つ) ので、 string 比較で sort 可能。
 */
export type LastActiveLookup = (tenantDomain: string, userId: string) => string | null;

/**
 * `(uri, tenantDomain)` 条件で notification を飛ばすべき session id を選び出す純粋関数。
 *
 * Inbox URI (`inbox://<name>`) は tenant 識別子を含まないため、同名 handle が
 * 複数 tenant に存在すると URI だけでの dispatch が tenant を超えて leak する
 * (issue #7)。subscribe 時の session.tenantDomain と送信元 tenant を突き合わせる
 * ことで、データ本体だけでなく「存在の side-channel」も tenant 境界に閉じ込める。
 *
 * Pre-filter (= 既存 logic):
 * - sid === except は除外（送信者本人の重複通知抑制用）
 * - session.tenantDomain が一致しなければ除外（tenant leak ガード）
 * - subscribedUris に uri が無ければ除外（そもそも subscribe していない）
 *
 * Dedup (= 新規 logic、 issue #114 fix):
 * - `options.lastActiveLookup` provided AND `isNotifyDedupDisabled()` false の場合のみ適用
 * - Pre-filter 後の candidates を `userId` で group、 各 group から 1 session 選択:
 *   - **primary order**: `last_active_at DESC` (= 最も最近 productive activity あった session)
 *   - **tie-breaker**: `createdAt DESC` (= 同 last_active_at なら最新 created session)
 *
 * > **実装上の注意**: `lastActiveLookup(tenantDomain, userId)` は `participants` テーブルの
 * > per-user 単一値を返す。そのため同一 user の group 内では全 session で `last_active_at`
 * > が同値となり `la !== lb` は常に `false` → **実効的には `createdAt DESC` のみが
 * > discriminator として機能する**。将来 per-session `last_active_at` が導入された場合は
 * > primary order が有効になる設計だが、現実装では tie-breaker が実体。
 *
 * - 同 user の N sessions から 1 session のみ採用 → 「1 user = 1 active subscriber per uri」
 *   structural invariant を強制 (= issue #114 root cause `notifyResourceUpdated` の
 *   per-user fanout 蓄積を構造的に排除)
 *
 * 詳細 design rationale + 観測 evidence: `docs/...` / issue #114。
 */
export function selectNotificationTargets<S extends NotifiableSession>(
  sessionEntries: Iterable<readonly [string, S]>,
  uri: string,
  tenantDomain: string,
  except?: string,
  options?: { lastActiveLookup?: LastActiveLookup }
): string[] {
  // Pre-filter (= 既存 tenant + URI + except gate)
  const candidates: Array<[string, S]> = [];
  for (const [sid, session] of sessionEntries) {
    if (sid === except) continue;
    if (session.tenantDomain !== tenantDomain) continue;
    if (!session.subscribedUris.has(uri)) continue;
    candidates.push([sid, session]);
  }

  // Dedup gate (= issue #114 fix、 lastActiveLookup 未提供 or 環境変数 disable で skip)
  if (!options?.lastActiveLookup || isNotifyDedupDisabled()) {
    return candidates.map(([sid]) => sid);
  }

  // Dedup: userId で group、 各 group から 1 session 選択 (= last_active_at DESC、
  // tie-breaker createdAt DESC)
  //
  // lastActiveLookup は per-user 単一値 (= participants.last_active_at) なので
  // 同一 userId への重複呼び出しは pure な無駄 round-trip。Map で memoize して
  // O(N sessions) → O(N distinct users) の DB アクセスに抑える。
  const lastActiveCache = new Map<string, string | null>();
  const cachedLookup = (userId: string): string | null => {
    if (!lastActiveCache.has(userId)) {
      lastActiveCache.set(userId, options.lastActiveLookup!(tenantDomain, userId));
    }
    return lastActiveCache.get(userId)!;
  };

  const byUser = new Map<string, Array<{ sid: string; lastActive: string | null; createdAt: number }>>();
  for (const [sid, session] of candidates) {
    const lastActive = cachedLookup(session.userId);
    const arr = byUser.get(session.userId) ?? [];
    arr.push({ sid, lastActive, createdAt: session.createdAt });
    byUser.set(session.userId, arr);
  }

  const targets: string[] = [];
  for (const arr of byUser.values()) {
    arr.sort((a, b) => {
      // last_active_at: null は 「最古」 扱い (= 「productive activity 未観測」 session は
      // 「より recently active な session」 に dedup 負ける、 直感的整合)。
      const la = a.lastActive ?? '';
      const lb = b.lastActive ?? '';
      if (la !== lb) return lb.localeCompare(la);  // DESC (= most recent first)
      // tie-breaker: createdAt DESC
      return b.createdAt - a.createdAt;
    });
    targets.push(arr[0]!.sid);  // arr は上の push で必ず 1 要素以上存在 → non-null safe
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
 *
 * **issue #114 fix**: 同 (tenant, userId, uri) で複数 sessions が subscribe している
 * 場合、 **最 recent 1 session のみ** に push する dedup を適用 (= production で観測
 * された 31x fanout を構造的に解消)。 dedup criteria は participants.last_active_at
 * DESC + session.createdAt DESC tie-breaker。 `AGENT_HUB_MCP_NOTIFY_DEDUP_DISABLED` 環境変数で
 * 旧 「全 subscribers fanout」 path に rollback 可能。
 */
export function notifyResourceUpdated(
  uri: string,
  tenantDomain: string,
  except?: string
): void {
  // issue #114 fix: last_active_at lookup を closure で wire-in (= per-call DB hit
  // 許容、 best-effort notification context で N session iteration の constant 倍 cost)。
  // 異常時 (= DB エラー等) は null 返却で 「未活動扱い」 にして fail-safe degradation。
  const lastActiveLookup: LastActiveLookup = (td, userId) => {
    try {
      const participant = scopeToTenant(getDatabase(), td).getParticipantByName(userId);
      return participant?.last_active_at ?? null;
    } catch (err) {
      console.error(`[MCP] lastActiveLookup failed for ${userId}@${td}:`, err);
      return null;
    }
  };

  const targets = selectNotificationTargets(sessions, uri, tenantDomain, except, {
    lastActiveLookup,
  });
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
    getThreadTool,
    markAsReadTool,
    // admin tools (only callable by @admin)
    deleteUserTool,
    getUserHistoryTool,
    listSessionsByUserTool,
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
    const sessionClientType = session?.clientType ?? null;
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
        return await handleRegister(scope, args, userId, githubLogin, sessionClientType, (handleName) =>
          isParticipantOnline(sessions, tenantDomain, handleName)
        );
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
        return await handleSendMessage(scope, args, userId, githubLogin);
      case 'get_messages':
        return await handleGetMessages(scope, args, userId);
      case 'get_history':
        return await handleGetHistory(scope, args, userId);
      case 'get_thread':
        return await handleGetThread(scope, args, userId);
      case 'mark_as_read':
        return await handleMarkAsRead(scope, args, userId);
      case 'delete_user':
        return await handleDeleteUser(scope, args, userId);
      case 'get_user_history':
        return await handleGetUserHistory(scope, args, userId);
      case 'list_sessions_by_user':
        return await handleListSessionsByUser(scope, args, userId, sessions);
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
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use('/mcp', authenticateUser);
  }

  private setupRoutes() {
    // ヘルスチェック（認証不要）。
    // 既存: edition / auth_mode / sessions 数
    // 追加 (issue #47): git_commit / git_commit_at / started_at で running build を外から識別可能にする
    // 修正 (issue #55、 redline #1): `?? 'unknown'` の string fallback を `?? null` に置換。
    //   `activeEditionConfig` が未初期化な状態 (= startup race or upstream bug) で
    //   `'unknown'` を返すと、 client は 「未対応サーバー (古い build)」 と 「edition 解決失敗
    //   (= server bug)」 を **区別不能**。 `null` 返却で TypeScript 型 + JSON 上で
    //   explicit signal とする (= redline #1: env/config 未設定時の string fallback 禁止)。
    this.app.get('/health', (_req: Request, res: Response) => {
      const editionConfig = activeEditionConfig;
      const version = getVersionInfo();
      res.json({
        status: 'ok',
        service: 'agent-hub',
        edition: editionConfig?.edition ?? null,
        auth_mode: editionConfig?.authMode ?? null,
        sessions: sessions.size,
        git_commit: version.git_commit,
        git_commit_at: version.git_commit_at,
        started_at: version.started_at,
      });
    });

    // POST /mcp: リクエスト受信エンドポイント
    // - mcp-session-id ヘッダーがあれば既存 session に dispatch
    // - 無くて initialize なら新規 session 作成
    // - **issue #68 (= PR #100 設計 doc)**: session ID set + 不在 + non-initialize + 認証 valid
    //   なら **server-side stateless session reissuance** で透過復帰 (= server restart 後の
    //   Claude Code session 維持)。 旧 path (= 400) は feature flag で opt-out 可能。
    // - 上記いずれにも該当しないなら 400
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
      const clientType = req.clientType ?? null;

      try {
        if (sessionId && sessions.has(sessionId)) {
          // POST /mcp が来るたびに lastActivityAt を更新。
          // resources/subscribe を実装しない SDK (Go bridge-tmux 等) が
          // orphan eviction で誤 evict されないようにする (issue #155 補完)。
          const existing = sessions.get(sessionId)!;
          existing.lastActivityAt = Date.now();
          await existing.transport.handleRequest(req, res, req.body);
          return;
        }

        // ★ issue #68 reissuance path: stale session ID + non-initialize + auth valid
        // (= server restart 後の client request を透過処理)。
        // 4 条件 (= 設計 doc §3.1):
        //   1. sessionId が設定済 (= client が session を持っている主張)
        //   2. sessions.has(sessionId) が false (= server 側に該当 session なし、 = stale)
        //   3. body が initialize でない (= 通常 tool call / resources/subscribe 等)
        //   4. authenticateUser middleware が auth pass 済 (= 上の req.userId 確認)
        // §3.4 edge case 「不在 session + initialize 同時」 は除外 (= 旧 400 path で対応、
        //   client の状態異常を fail-fast)、 idempotent fallback 性は 「不在 session = 再 reissue」
        //   で natural 担保 (= DELETE 後の next request は再度 reissuance path に着地)。
        if (
          sessionId &&
          !sessions.has(sessionId) &&
          !isInitializeRequest(req.body) &&
          !isAutoReissueDisabled()
        ) {
          await reissueSessionAndDispatch(req, res, {
            staleSessionId: sessionId,
            userId,
            githubLogin,
            tenantDomain,
            clientType,
          });
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
                clientType,
                subscribedUris: new Set(),
                createdAt: Date.now(),
                lastActivityAt: Date.now(),
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
    //
    // fly.io などの HTTP プロキシは per-request timeout で SSE 接続を切断することがある。
    // `Fly-Timeout-Kill-After: 0` レスポンスヘッダーで fly.io の request timeout を無効化し
    // SSE 接続を長時間維持する (= issue #157 対応)。他の環境では無視されるため副作用なし。
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
      // fly.io プロキシの request timeout を無効化して SSE 長時間接続を維持する。
      // ref: https://fly.io/docs/networking/request-headers/#fly-timeout-kill-after
      res.setHeader('Fly-Timeout-Kill-After', '0');
      // SSE keepalive: 15s 周期で `: keepalive\n\n` を送出し proxy idle timeout を防ぐ (issue #240)。
      // transport.handleRequest が SSE ヘッダーを送信したあとに動作するため、
      // 最初の送出は 15 秒後 = ヘッダーは確実に送信済み。
      const keepaliveTimer = setInterval(() => {
        writeSseKeepalive(res);
      }, SSE_KEEPALIVE_INTERVAL_MS);
      // 接続クローズ時に即時停止 (handleRequest resolve より先に close される場合がある)。
      // finally 節でも clearInterval を呼ぶが、clearInterval は clear 済み ID への呼び出しが
      // no-op のため二重 clear は安全・意図的 (= idempotent)。
      req.on('close', () => clearInterval(keepaliveTimer));
      try {
        await sessions.get(sessionId)!.transport.handleRequest(req, res);
      } catch (error) {
        // SSE 切断 → transport.onclose 未完了のレース中に reconnect が来た場合、
        // transport.handleRequest が throw する (issue #157)。
        // セッションをクリーンアップして 404 を返し、Claude Code に再 initialize を促す。
        // 500 を返すと client が "server error" と誤解し、不必要なアラートが出る。
        console.error('[MCP] GET handleRequest error (SSE reconnect race):', error);
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          // eviction パターン (active ping loop と同様): transport.close() → sessions.delete()。
          // transport.onclose も sessions.delete を呼ぶが race 回避で明示削除する。
          // close() は既にエラー状態の transport に対して throw する可能性があるため try/catch。
          try {
            await session.transport.close();
          } catch (_closeErr) {
            // transport は既にエラー状態 or 切断済み — 無視して delete に進む
          }
          if (sessions.has(sessionId)) {
            sessions.delete(sessionId);
          }
          console.log(`[MCP] session evicted after transport error: ${sessionId}`);
        }
        if (!res.headersSent) {
          res.status(404).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'session connection interrupted; please reinitialize',
            },
            id: null,
          });
        }
      } finally {
        // catch で throw しない場合も含め確実に interval を停止する
        clearInterval(keepaliveTimer);
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

    // Active ping loop 起動 (= issue #91、 server restart 後の即 cycle 開始)。
    // feature flag AGENT_HUB_MCP_PING_LOOP_DISABLED が set されていれば skip (= rollback path)。
    startActivePingLoop();

    return new Promise((resolve) => {
      // httpServer を捕捉して TCP keepalive / timeout を設定する (issue #269)。
      // this.app.listen() の戻り値は http.Server。
      const httpServer = this.app.listen(this.port, '0.0.0.0', () => {
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

      // TCP keepalive 設定 (issue #269):
      //
      // MCP HTTP Streamable Transport は POST (client→server) と GET/SSE (server→client) で
      // 別々の TCP 接続を使う。GET/SSE は SSE_KEEPALIVE_INTERVAL_MS (15s) の application-level
      // keepalive でカバー済みだが、POST 用 TCP persistent connection は tool call 間が idle になり
      // NAT entry (一般的なデフォルト: 30 分 = 1800s) が expire → RST が発生していた。
      //
      // socket.setKeepAlive(true, 60_000):
      //   OS レベルの TCP keepalive probe を 60 秒ごとに送出し NAT タイマーをリセット。
      //   application-level keepalive との二重保護となる。
      //
      // keepAliveTimeout = 620_000 (620s):
      //   サーバー側が idle な HTTP keep-alive 接続を閉じるまでの待機時間。
      //   Node.js デフォルト 5s は NAT timeout (1800s) より短く不整合が生じるため延長。
      //
      // headersTimeout = 630_000 (630s):
      //   Node.js 仕様で headersTimeout > keepAliveTimeout が必須。
      httpServer.keepAliveTimeout = 620_000;
      httpServer.headersTimeout = 630_000;
      httpServer.on('connection', (socket) => {
        socket.setKeepAlive(true, 60_000);
      });
    });
  }

  /** テスト用：Express app を取得 */
  getApp(): express.Application {
    return this.app;
  }
}
