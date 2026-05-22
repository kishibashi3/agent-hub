# Edition モデル — Professional Edition

> **責務**: agent-hub の Professional Edition の設計正本。Community Edition (~10 人) と Enterprise Edition (1000+ 人) の間を埋める、チーム・組織向けエディション (~100 人) の設計根拠。  
> **関連設計 doc**: [`edition-model.md`](./edition-model.md) — CE / PE の設計正本  
> **上位 issue**: [#10 3-edition strategy](https://github.com/kishibashi3/agent-hub/issues/10) / [#133 Professional Edition](https://github.com/kishibashi3/agent-hub/issues/133)

---

## 1. なぜ Professional Edition が必要か

CE と仮称 Enterprise の間には構造的なギャップがある:

| | Community Edition | Professional Edition | Enterprise Edition |
|---|---|---|---|
| **対象規模** | ~10 participants | **~100 participants** | 1000+ participants |
| **DB** | SQLite (single file) | **PostgreSQL** | PostgreSQL + Kafka |
| **Pub/Sub** | なし (in-process) | **Redis** | Kafka |
| **認証** | GitHub PAT | **OIDC** | OIDC + SCIM |
| **HA** | single instance | **multi instance 可** | HA 必須 |
| **SCIM** | なし | なし | **あり** |
| **想定** | OSS dev チーム | 社内チーム・部署 | 会社全体 |

CE の SQLite + in-process SSE は ~10 人規模では十分だが、~100 人になると:

- **SQLite の write 競合**: 並行 write が増え、SQLite WAL の限界に近づく
- **SSE の単一プロセス境界**: 複数 server instance を起動すると peer の SSE 接続が別 instance に張られ、push が届かない
- **GitHub PAT 依存**: 会社環境では GitHub アカウント不要で、IdP (Okta / Azure AD) で統一管理したい

Professional Edition はこの 3 つの問題を解決する **最小構成の組織向け tier** として設計する。

---

## 2. Edition 一覧 (更新版)

| Edition | `AGENT_HUB_EDITION` | 認証 | DB | Pub/Sub | ステータス |
|---|---|---|---|---|---|
| Private Edition | `private` | なし (trust) | SQLite | なし | 実装済み |
| Community Edition | `community` | GitHub PAT | SQLite | なし | 実装済み |
| **Professional Edition** | **`professional`** | **OIDC** | **PostgreSQL** | **Redis** | 本 doc |
| Enterprise Edition | `enterprise` | OIDC + SCIM | PostgreSQL | Kafka | 将来 (#10 Phase 3) |

---

## 3. CE との差分サマリー

```
Community Edition          Professional Edition
─────────────────────      ─────────────────────────────
auth:  GitHub PAT     →    OIDC (Okta / Azure AD / 任意 IdP)
db:    SQLite         →    PostgreSQL
push:  in-process     →    Redis pub/sub (multi instance 対応)
scale: single inst.   →    N instances (stateless server)
admin: @admin TOFU    →    @admin TOFU (CE 互換、identity は OIDC sub)
```

### 3-1. DB: SQLite → PostgreSQL

| 観点 | CE (SQLite) | Professional (PostgreSQL) |
|---|---|---|
| 接続方式 | file path (`better-sqlite3`) | connection string (`DATABASE_URL`) |
| 並行 write | WAL (limited) | MVCC (concurrent-safe) |
| レプリケーション | 不可 | streaming replication 可 |
| スキーマ | schema v9 (現行) | **同じスキーマ** (migration で移植) |
| ORM / driver | `better-sqlite3` (sync) | `pg` / `node-postgres` (async) |

DB アクセス層を abstraction layer で包み、SQLite / PostgreSQL を runtime に切り替える実装が必要になる。これは Professional Edition 実装の最大の難所 (= 同期 API → 非同期 API の全面変更)。

### 3-2. Pub/Sub: Redis 追加

CE では SSE push が in-process の `EventEmitter` (または equivalent) で完結している。複数 server instance が起動すると peer の SSE 接続がどの instance に張られているか不明なため、Redis pub/sub を中継層として追加する。

詳細は §5 (スケーラビリティ設計) 参照。

### 3-3. 認証: OIDC 追加

CE では `GITHUB_PAT` を `Authorization: Bearer` で送り、GitHub API (`/user`) で `githubLogin` を検証する。Professional では OIDC provider が発行した JWT (Access Token or ID Token) を直接検証する。

詳細は §6 (OIDC 認証フロー) 参照。

---

## 4. アーキテクチャ図

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Professional Edition                              │
│                                                                       │
│  peer A        peer B         bridge-claude         operator         │
│   │              │                 │                    │            │
│   └──────────────┴─────────────────┴────────────────────┘           │
│                           ↕ MCP (HTTP + SSE)                        │
│                                                                       │
│   ┌───────────────┐   ┌───────────────┐                             │
│   │ agent-hub     │   │ agent-hub     │  ... N instances             │
│   │ server inst 1 │   │ server inst 2 │     (stateless)              │
│   └───────┬───────┘   └───────┬───────┘                             │
│           │ publish           │ subscribe                            │
│           └──────────┬────────┘                                      │
│                      ↕                                               │
│              ┌───────────────┐                                       │
│              │    Redis      │  ← SSE inbox pub/sub                  │
│              │  (pub/sub)    │                                       │
│              └───────────────┘                                       │
│                      ↕ (別経路)                                       │
│              ┌───────────────┐                                       │
│              │  PostgreSQL   │  ← messages / participants / tenants  │
│              │     DB        │                                       │
│              └───────────────┘                                       │
│                                                                       │
│   ┌─────────────────────────────┐                                    │
│   │  OIDC Provider              │  ← Okta / Azure AD / Google /      │
│   │  (外部)                     │    Keycloak 等                     │
│   └─────────────────────────────┘                                    │
└─────────────────────────────────────────────────────────────────────┘
```

**server instances は stateless**: セッション・キャッシュ・SSE 接続情報のみ in-process。永続状態はすべて PostgreSQL か Redis に委譲。

---

## 5. スケーラビリティ設計 — Redis pub/sub による SSE スケールアウト

### 5-1. 問題: SSE と multi instance の不整合

CE では `send_message` 受信時に in-process イベントで peer に SSE push する:

```
peer A が send_message → server (inst 1) → in-process event → peer B の SSE 接続
```

Multi instance では:
```
peer A が send_message → server (inst 1) が DB に書く
                ↓
peer B の SSE は server (inst 2) に張られている
                ↓
inst 1 は inst 2 にイベントを届ける手段がない → push が届かない ❌
```

### 5-2. 解法: Redis pub/sub fan-out

```
1. peer A が send_message (→ server inst 1 がリクエストを受ける)
2. inst 1 が PostgreSQL にメッセージを INSERT
3. inst 1 が Redis channel `inbox:{peer_b_id}` に publish
4. inst 2 が Redis channel `inbox:{peer_b_id}` を subscribe 中
5. inst 2 が subscribe callback を受け、peer B の SSE 接続に push
```

**channel 命名規則**:
```
inbox:{participant_id}   # participant への inbox push 通知
team:{team_id}           # team メッセージの fan-out
```

**payload 設計** (最小): push 通知は "新着あり" のシグナルのみ。メッセージ本体は peer が `get_messages` で取得する (= Redis に本体を持たせない → CE との実装差異を最小化)。

```json
{ "type": "new_message", "recipientId": "peer_b_id", "messageId": "msg_xxx" }
```

### 5-3. Redis 障害時の fallback

Redis が落ちた場合、SSE push は届かないが `get_messages` による polling は動作する。peer は `get_messages` で取得できるため、**push の遅延はあってもメッセージは失われない**。

Redis は **push のオプティミゼーション層** と位置づけ、永続性の保証は PostgreSQL に任せる。

### 5-4. Connection 管理

各 server instance は:
- 起動時: `REDIS_URL` に接続、subscriber client を初期化
- SSE 接続確立時: 対象 participant の channel を subscribe
- SSE 接続切断時: channel を unsubscribe (GC)
- 終了時: 全 subscription を cleanup

---

## 6. OIDC 認証フロー

### 6-1. CE との対比

| | Community Edition | Professional Edition |
|---|---|---|
| token 形式 | GitHub PAT (opaque) | OIDC JWT (Access Token or ID Token) |
| 検証方法 | GitHub API `/user` call | JWKS エンドポイントで署名検証 |
| identity | `githubLogin` (string) | OIDC `sub` claim (string) |
| handle 導出 | PAT owner の GitHub login | OIDC `preferred_username` or `email` |
| revocation | PAT 削除 | IdP 側でトークン revoke |

### 6-2. 認証フロー

```
1. peer が MCP リクエストを送る
   Authorization: Bearer <OIDC Access Token or ID Token>

2. agent-hub server が OIDC provider の JWKS エンドポイントを取得
   (= `OIDC_ISSUER/.well-known/openid-configuration` から `jwks_uri` を発見)

3. JWT の署名・有効期限・audience を検証

4. `sub` claim を participant identity として使用
   (= CE の `githubLogin` に相当)

5. handle 解決 (優先順):
   a. `preferred_username` claim → handle として使用
   b. `email` から `@` 前の部分を取得
   c. `sub` を hashed prefix として使用 (fallback)

6. `register` 時に初回 TOFU bind: handle ↔ `sub` を DB に記録
   以降の接続は `sub` で participant を特定する
```

### 6-3. 環境変数

| 変数 | 説明 | 例 |
|---|---|---|
| `OIDC_ISSUER` | OIDC provider の issuer URL | `https://accounts.google.com` |
| `OIDC_AUDIENCE` | JWT の `aud` claim の期待値 | `agent-hub-prod` |
| `OIDC_JWKS_CACHE_TTL_SEC` | JWKS キャッシュ TTL (default: 3600) | `3600` |
| `OIDC_CLAIM_HANDLE` | handle に使う claim 名 (default: `preferred_username`) | `preferred_username` |

### 6-4. @admin と OIDC

CE の deployment init gate はそのまま Professional にも適用する。OIDC で最初に `register` を呼んだ participant が `@admin` として TOFU bind される設計は CE 互換。

- CE: `sub = githubLogin`
- Professional: `sub = OIDC sub claim`

`@admin` の identity 管理は外部 IdP 側で行う (= Okta/Azure AD で admin role を割り当てた user が先に register すれば admin になる)。

---

## 7. Docker Compose 構成

### 7-1. 全体構成

```yaml
# docker-compose.professional.yml
version: '3.9'

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: agent_hub
      POSTGRES_USER: agent_hub
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agent_hub"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --requirepass ${REDIS_PASSWORD}
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  agent-hub:
    image: ghcr.io/kishibashi3/agent-hub:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      AGENT_HUB_EDITION: professional
      DATABASE_URL: postgresql://agent_hub:${POSTGRES_PASSWORD}@postgres:5432/agent_hub
      REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
      OIDC_ISSUER: ${OIDC_ISSUER}
      OIDC_AUDIENCE: ${OIDC_AUDIENCE}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

volumes:
  postgres_data:
  redis_data:
```

### 7-2. .env.professional.example

```bash
# Required
AGENT_HUB_EDITION=professional
POSTGRES_PASSWORD=change_me_strong_password
REDIS_PASSWORD=change_me_strong_password

# OIDC (IdP 依存)
OIDC_ISSUER=https://your-idp.example.com
OIDC_AUDIENCE=agent-hub-prod

# Optional
OIDC_CLAIM_HANDLE=preferred_username
OIDC_JWKS_CACHE_TTL_SEC=3600
AGENT_HUB_DISABLE_DEFAULT_TENANT=1  # default tenant を制限 (CE 互換)
```

### 7-3. 起動手順

```bash
# 1. 設定
cp .env.professional.example .env
# .env を編集 (POSTGRES_PASSWORD / REDIS_PASSWORD / OIDC_ISSUER 等)

# 2. 起動
docker-compose -f docker-compose.professional.yml up -d

# 3. 確認
docker-compose -f docker-compose.professional.yml ps
curl http://localhost:3000/health
# → { "edition": "professional", "auth_mode": "oidc", ... }

# 4. CE と同様に bridge + operator setup
export AGENT_HUB_URL=http://localhost:3000/mcp
# (PAT の代わりに OIDC access token を AGENT_HUB_TOKEN に設定)
scripts/start.sh all
```

---

## 8. Edition 判別 — `src/edition.ts` への変更

### 8-1. 型定義の拡張

```ts
// src/edition.ts (Professional 追加)
export type Edition = 'community' | 'private' | 'professional';
export type AuthMode = 'trust' | 'pat' | 'oidc';

export interface EditionConfig {
  edition: Edition;
  authMode: AuthMode;
  allowsNamedTenant: boolean;
  enforcesDefaultTenantRestriction: boolean;
  enforcesDeploymentInitGate: boolean;
  exposesCeAdminTools: boolean;
  // Professional Edition 追加フラグ
  requiresPostgres: boolean;   // true → SQLite を拒否して PostgreSQL を必須化
  requiresRedis: boolean;      // true → Redis pub/sub を有効化
}
```

### 8-2. 解決規則の追加

```ts
// resolveEdition() 内に professional branch を追加
if (edition === 'professional') {
  // OIDC 必須: AUTH_MODE=oidc が暗黙の default
  // AUTH_MODE が明示されて 'oidc' 以外ならエラー
  if (authModeExplicit && authModeExplicit !== 'oidc') {
    throw new EditionConfigError(
      `AGENT_HUB_EDITION=professional では AUTH_MODE='${authModeExplicit}' は使用できません。`
        + ' OIDC 認証のみサポートします (AUTH_MODE 指定を削除するか AUTH_MODE=oidc を指定してください)。'
    );
  }
  // DATABASE_URL が未指定の場合は startup で fail-fast
  if (!env.DATABASE_URL) {
    throw new EditionConfigError(
      'AGENT_HUB_EDITION=professional では DATABASE_URL (PostgreSQL) が必須です。'
    );
  }
  // REDIS_URL が未指定の場合は WARN (single instance では fallback 可能)
  if (!env.REDIS_URL) {
    console.warn(
      '[professional] REDIS_URL が未設定です。SSE push は single instance 内でのみ動作します。'
        + ' multi instance 構成では REDIS_URL を設定してください。'
    );
  }
  return {
    edition: 'professional',
    authMode: 'oidc',
    allowsNamedTenant: true,
    enforcesDefaultTenantRestriction: env.AGENT_HUB_DISABLE_DEFAULT_TENANT !== '0',
    enforcesDeploymentInitGate: true,
    exposesCeAdminTools: true,
    requiresPostgres: true,
    requiresRedis: !!env.REDIS_URL,
  };
}
```

### 8-3. Fail-fast validation (Professional 固有)

| 条件 | v1 挙動 |
|---|---|
| `AGENT_HUB_EDITION=professional` + `AUTH_MODE=pat` | `EditionConfigError` で即 reject |
| `AGENT_HUB_EDITION=professional` + `AUTH_MODE=trust` | `EditionConfigError` で即 reject |
| `AGENT_HUB_EDITION=professional` + `DATABASE_URL` 未設定 | `EditionConfigError` で即 reject |
| `AGENT_HUB_EDITION=professional` + `REDIS_URL` 未設定 | WARN-only (single instance は動作する) |
| `AGENT_HUB_EDITION=professional` + `OIDC_ISSUER` 未設定 | `EditionConfigError` で即 reject |

> `AGENT_HUB_EDITION` 値に `'enterprise'` を指定すると現在の実装では未知の値として `EditionConfigError` になる。Enterprise Edition 実装時に追加する。

### 8-4. discriminated union 化の検討トリガー

`edition.ts` の `Out of scope` (edition-model.md §Out of scope) に記録された通り、3 edition 目 (Professional) 追加のタイミングが **discriminated union 化を検討する trigger**。`requiresPostgres` / `requiresRedis` が CE / PE では常に `false` になり、型上 "無意味な組合せ" が成立してしまう。

**本 PR では union 化は行わない** (= 変更コスト > メリットと判断)。Enterprise 投入時に `CommunityConfig | PrivateConfig | ProfessionalConfig | EnterpriseConfig` への refactor を別 issue として起票する。

---

## 9. CE からの Migration Path

### 9-1. 概要

CE → Professional の移行は **DB の乗り換えが最大の作業**。認証 (PAT → OIDC) も切り替えが必要だが、@admin TOFU 概念は CE 互換のため構造変更は不要。

| ステップ | 作業 | 所要時間 |
|---|---|---|
| 1. PostgreSQL + Redis 用意 | docker-compose で立ち上げ | 30分 |
| 2. CE データを dump | SQLite → SQL dump | 5分 |
| 3. PostgreSQL に import | スキーマ変換 + import | 30〜60分 |
| 4. OIDC provider 設定 | Okta / Azure AD 等で client 作成 | 30〜60分 |
| 5. AGENT_HUB_EDITION 切替 | env 変更 + 再起動 | 5分 |
| 6. 動作確認 | `/health` + `get_participants` | 10分 |

### 9-2. Step by Step

#### Step 1: PostgreSQL + Redis を起動

```bash
# docker-compose.professional.yml を使って PostgreSQL + Redis を先に起動
docker-compose -f docker-compose.professional.yml up postgres redis -d
```

#### Step 2: CE の SQLite データを dump

```bash
# CE の SQLite DB から SQL を export
sqlite3 ~/.agent-hub/data/agent_hub.db .dump > ce_data.sql
```

#### Step 3: PostgreSQL にスキーマを作成 + データを import

```bash
# スキーマ作成 (Professional 用の migration script を実行)
docker-compose -f docker-compose.professional.yml exec postgres \
  psql -U agent_hub -d agent_hub -f /migrations/schema_v9.sql

# SQLite dump の SQL を PostgreSQL 向けに変換
# (SQLite と PostgreSQL の SQL 方言の差を吸収する変換スクリプトが必要)
./scripts/sqlite_to_pg.sh ce_data.sql | \
  docker-compose -f docker-compose.professional.yml exec -T postgres \
  psql -U agent_hub -d agent_hub
```

> **注意**: SQLite → PostgreSQL の SQL 変換は方言差 (boolean 型 / TEXT affinity / AUTOINCREMENT 等) のため、変換スクリプトの整備が実装 PR の scope に入る。

#### Step 4: OIDC provider を設定

各 IdP ごとの設定 (= 別途 OIDC configuration guide が必要):

- **Okta**: Application → Web → Authorization Code with PKCE
- **Azure AD**: App registration → Expose API → scope 設定
- **Google Workspace**: OAuth2 client (API Console)
- **Keycloak**: Realm → Client → client_id 設定

`OIDC_ISSUER` / `OIDC_AUDIENCE` を取得して `.env` に設定する。

#### Step 5: AGENT_HUB_EDITION を切替

```bash
# .env を編集
AGENT_HUB_EDITION=professional
DATABASE_URL=postgresql://agent_hub:password@localhost:5432/agent_hub
REDIS_URL=redis://:password@localhost:6379
OIDC_ISSUER=https://your-idp.example.com
OIDC_AUDIENCE=agent-hub-prod

# agent-hub server を Professional edition で起動
docker-compose -f docker-compose.professional.yml up agent-hub -d
```

#### Step 6: 動作確認

```bash
curl -s http://localhost:3000/health | python3 -m json.tool
# → { "edition": "professional", "auth_mode": "oidc", ... }
```

### 9-3. PAT 認証 peer の対応

CE の peer bridge は `GITHUB_PAT` で認証していたが、Professional では OIDC token が必要。bridge 側で token 取得方法を設定変更:

```bash
# bridge 用の OIDC token を取得 (IdP の client credentials flow)
export AGENT_HUB_TOKEN=$(fetch_oidc_token ...)  # IdP 依存の取得方法
# GITHUB_PAT は不要 (unset 可)
```

> bridge の OIDC token 自動更新 (= token 期限切れ対応) は実装 PR の scope として別途設計が必要。

### 9-4. Rollback

Professional → CE への rollback は PostgreSQL データを SQLite に戻す必要があるため、**移行前の CE SQLite backup は必ず保持する**こと。

```bash
# 移行前に必ず backup
cp ~/.agent-hub/data/agent_hub.db ~/.agent-hub/data/agent_hub_ce_backup_$(date +%Y%m%d).db
```

---

## 10. スコープ外 — Enterprise との境界

以下は Professional Edition のスコープ**外**であり、Enterprise Edition で扱う:

| 機能 | 理由 |
|---|---|
| **SCIM provisioning** | IdP からの自動 user sync は ~100人規模では不要、管理コスト > メリット |
| **Kafka** | ~100人では Redis pub/sub で十分。Kafka は 1000+ 人 / 高 throughput が前提 |
| **Audit log export** | SOC2 / GDPR コンプライアンスは Enterprise 要件 |
| **RBAC** | Professional は operator / user の 2 ロールで十分 |
| **HA / active-active** | active-standby (= single primary) で ~100人は十分 |
| **SLA / paid support** | Commercial license 対象 |

---

## 11. 変更が入る code path

| ファイル / 箇所 | 変更内容 |
|---|---|
| `src/edition.ts` | `Edition` 型に `'professional'` 追加、`AuthMode` に `'oidc'` 追加、`EditionConfig` に `requiresPostgres` / `requiresRedis` 追加、`resolveEdition` に professional branch 追加 |
| `src/db/*.ts` | DB アクセス層を interface で抽象化し、SQLite / PostgreSQL を実装として差し替え可能にする |
| `src/mcp/server.ts` | `authenticateUser` の OIDC path 追加 (JWKS 検証)、`EditionConfig.requiresRedis` に基づく Redis pub/sub 有効化 |
| `src/pubsub/redis.ts` | 新規: Redis pub/sub adapter (subscribe / publish / unsubscribe) |
| `src/auth/oidc.ts` | 新規: OIDC JWT 検証 module (JWKS fetch + 署名検証 + claim 抽出) |
| `docker-compose.professional.yml` | 新規: PostgreSQL + Redis + agent-hub の全部入り構成 |
| `.env.professional.example` | 新規: Professional Edition 用 env テンプレート |
| `docs/edition-model.md` | Edition 一覧表に Professional を追加 |

---

## 12. Test 戦略

### unit (edition resolution)

- `AGENT_HUB_EDITION=professional` + `OIDC_ISSUER` + `DATABASE_URL` → 正常解決
- `AGENT_HUB_EDITION=professional` + `AUTH_MODE=pat` → `EditionConfigError`
- `AGENT_HUB_EDITION=professional` + `AUTH_MODE=trust` → `EditionConfigError`
- `AGENT_HUB_EDITION=professional` + `DATABASE_URL` 未設定 → `EditionConfigError`
- `AGENT_HUB_EDITION=professional` + `REDIS_URL` 未設定 → WARN-only、正常解決
- `requiresPostgres: true` / `requiresRedis: true (when REDIS_URL set)` の flag 確認

### unit (OIDC 検証)

- 正常 JWT (valid sig + aud + exp) → participant identity 解決成功
- 署名不正 JWT → 401
- 有効期限切れ JWT → 401
- `aud` 不一致 JWT → 401
- `preferred_username` あり → handle として使用
- `preferred_username` なし + `email` あり → email prefix を handle として使用

### unit (Redis pub/sub)

- `send_message` 後に Redis channel に publish されること
- Redis 未設定時は in-process fallback で動作すること

### 手動確認 (operator 環境)

- `AGENT_HUB_EDITION=professional` + PostgreSQL + Redis で起動し、`/health` が `edition: professional` を返す
- 2 server instance 起動時に inst 1 で send した message が inst 2 接続の peer に SSE 届く
- CE から migration した DB でメッセージ履歴が参照できる

---

## 13. 実装 PR シーケンス (案)

本 doc は設計 doc であり実装を含まない。実装は以下の 3 段階 PR に分割することを推奨する:

| PR | 内容 | 分類 |
|---|---|---|
| Step 1: edition.ts 拡張 | `Edition` / `AuthMode` 型追加、resolveEdition professional branch | L0 (型定義 + fail-fast) |
| Step 2: DB 抽象化 + PostgreSQL | DB interface 追加、`pg` driver 実装、migration script | L1 (DB schema 変更) |
| Step 3: OIDC 認証 + Redis pub/sub | `src/auth/oidc.ts` / `src/pubsub/redis.ts` 追加、server wiring | L1 (auth 変更) |

---

## 関連

- [edition-model.md](./edition-model.md) — CE / PE 設計正本
- [design-ce-tenant-setup.md](./design-ce-tenant-setup.md) — CE tenant 初回 setup フロー
- [issue #133 Professional Edition](https://github.com/kishibashi3/agent-hub/issues/133)
- [issue #10 3-edition strategy](https://github.com/kishibashi3/agent-hub/issues/10)
