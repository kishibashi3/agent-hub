# Edition モデル — Community Edition と Private Edition

> **責務**: agent-hub の deployment edition を区別する設計の正本。「同一コードベースで複数の deployment 形態を支える」立て付けと、各 edition で何が変わるかの根拠。

## 思想: なぜ edition を分けるのか

agent-hub は 3 つの異なる利用層を想定している (issue #10、3-edition strategy):

- **個人 1 人、LAN 内、認証不要** — 自宅 PC / personal VPS / embedded
- **OSS dev、招待制、PAT 認証** — community 開発、複数 user
- **会社・組織、OIDC/SCIM、SOC2** — Enterprise (将来)

これらを 1 つの code path で混ぜると attack surface と認知負荷が両方膨らむ:

- LAN PE で「@admin claim / deployment init gate / named tenant TOFU」の説明が必要になる (= 利用者には無関係な複雑性)
- CE で「認証なしの trust mode」が選べると、本番運用で誤って公開する事故が起きる (= secure-by-default の崩れ)

そこで **edition を 1 つの軸として明示分離** し、code path はそのまま共有しつつ「edition でしか到達しない振る舞い」を deployment-time に閉じる。

## Edition 一覧

| Edition | スコープ | ステータス |
|---|---|---|
| **Community Edition (CE)** | OSS dev、招待制、PAT 認証、multi-tenant | 既存実装、edition 化で codify |
| **Private Edition (PE)** | 個人 1 人、LAN 内、認証なし | **本 doc の主対象**、新規 |
| Enterprise Edition | 会社・組織、OIDC/SCIM | #10 Phase 3、本 doc では言及のみ |

## CE vs PE 振る舞い差分

| | Community Edition (CE、default) | Private Edition (PE) |
|---|---|---|
| `AGENT_HUB_EDITION` | `community` (or 未指定) | `private` |
| 認証 | PAT 必須 (`AUTH_MODE=pat`) | 認証なし (`AUTH_MODE=trust` 固定) |
| tenant | named tenant 作成可 (TOFU claim) | default のみ (named は 400 で reject) |
| 想定ネットワーク境界 | インターネット公開可 | 完全 LAN 内 |
| `@admin` 概念 | あり (deployment init gate あり) | なし |
| CE-operator tools (`list_tenants` / `get_tenant` / `delete_tenant`) | ListTools で露出 | 非露出 + CallTool でも reject |
| `AGENT_HUB_DISABLE_DEFAULT_TENANT` | honor (default `1` = restricted) | 無視 (default 1 つしか無いので意味を持たない)。設定されていれば startup で **WARN log** を 1 行出して「効かない」ことを明示 |
| `admin.ts` tools (`delete_user` / `get_user_history`) | `@admin` 専用、tenant 不問の `ensureAdmin` ガード | PE では `@admin` = default tenant の正規 user なので **そのまま呼べる** (= ガード自体は edition 非依存、`@admin` の概念が deployment init 由来でない PE では「最初の registered user が事実上 admin」になる挙動) |

## Single source of truth: `src/edition.ts`

env を直接 `process.env.AUTH_MODE` 等で読む code path を増やすと、「PE 固有の振る舞い」が散らばって追跡しづらくなる。本設計では env を 1 箇所だけで読む:

```ts
// src/edition.ts
export type Edition = 'community' | 'private';
export type AuthMode = 'trust' | 'pat';

export interface EditionConfig {
  edition: Edition;
  authMode: AuthMode;
  allowsNamedTenant: boolean;
  enforcesDefaultTenantRestriction: boolean;
  enforcesDeploymentInitGate: boolean;
  exposesCeAdminTools: boolean;
}

export function resolveEdition(env: NodeJS.ProcessEnv): EditionConfig;
```

`MCPServer.start()` で `resolveEdition(process.env)` を 1 度だけ呼んで module-level singleton として cache する。auth / tenant gate / tool list / health endpoint の全レイヤは env を直接読まず、resolve 済 config の boolean フラグを参照する。

→ 「PE では @admin が無い」「PE では named tenant が無い」等の振る舞いを 1 箇所で導出。Enterprise tier (#10 Phase 3) を足すときも `Edition` 型に variant を 1 つ追加 + `EditionConfig` 解決規則を 1 つ追加するだけで全 code path に伝播する。

### Testability — module-level singleton の差し替え API

`activeEditionConfig` を module-level singleton にすると test から差し替えにくくなるので、 **test 用 escape を design 段で確定** する:

```ts
// src/edition.ts (test-only API)
export function setEditionConfigForTesting(config: EditionConfig): void;
export function resetEditionConfigForTesting(): void;
```

- `setEditionConfigForTesting`: test で任意 `EditionConfig` を inject。複数 edition を 1 test ファイル内で切り替えるユースケースを許容
- `resetEditionConfigForTesting`: test の `afterEach` で初期状態 (= `undefined`) に戻す。test 間で state が漏れない設計

production code は `getEditionConfig()` のみを参照、test 用 API は `// @internal` JSDoc tag + lint で production import を禁止する想定。

## Fail-fast validation

startup で env の妥当性 + edition との整合性を検証する。**「ただちに reject すべき矛盾」** と **「v1 では migration 猶予として WARN、v2 で reject に格上げする破壊的変更」** を **明示的に区別する** 立て付け。

### v1 = hard reject (= 設計矛盾、誤起動防止)

以下は **どの release でも常に reject**:

- `AGENT_HUB_EDITION` 不正値 (`enterprise` 等) → `EditionConfigError`
- `AUTH_MODE` 不正値 → `EditionConfigError`
- PE + `AUTH_MODE=pat` の組合せ → conflict、`EditionConfigError` (= PE は trust 固定が前提、pat 指定は設計の取り違え)

### v1 = WARN-only + v2 = hard reject (= 破壊的変更の段階移行)

- **CE + `AUTH_MODE=trust` の組合せ** — 旧版で `AUTH_MODE=trust` だけで LAN 運用していた既存 deployment を v1 で「明示的に起動失敗」させると、突然 startup が壊れる体験になる。これは `AGENT_HUB_DISABLE_DEFAULT_TENANT` の secure-by-default flip (commit `1394c38`) と同型の H3 breaking change pattern なので、 **v1 では WARN-only に留め、v2 で reject へ格上げ** する。
  - **v1 挙動**: `console.warn` で「CE で `AUTH_MODE=trust` は次バージョンで reject されます」と migration hint を出す。**起動自体は許可**
  - **延命 opt-in**: env `AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1` を明示設定した deployment は v2 でも WARN-only で延命可能 (= 利用者が明示判断したことを log と env で audit 可能にする)
  - **v2 挙動**: 上記 opt-in env が無ければ `EditionConfigError` で起動失敗

### error message 例 — 両方向の migration hint を必ず添える

ユーザーが「どちらの edition に migrate するか」を自明に選べる文言を選ぶ。

CE + trust の組合せ (v1 WARN、v2 reject 時):

> `AGENT_HUB_EDITION=community で AUTH_MODE=trust は次バージョン (v2) から reject されます。`
> `LAN 専用運用なら AGENT_HUB_EDITION=private を、`
> `PAT 認証で公開運用なら AUTH_MODE=pat を指定してください。`
> `現バージョン中の延命が必要な場合は AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1 を設定 (opt-in)。`

PE + pat の組合せ (常時 reject 時):

> `AGENT_HUB_EDITION=private で AUTH_MODE=pat は使用できません。`
> `LAN 専用運用なら AUTH_MODE 指定を削除 (PE は trust 固定)、`
> `PAT 認証で公開運用なら AGENT_HUB_EDITION=community を指定してください。`

**hint は「方向性 (= 公開 / LAN)」と「対応する edition / AUTH_MODE」を 1 対 1 で示す** 形に統一する。

### 1d 判断の根拠 (= 設計判断 audit)

CE+trust を「v1 WARN-only + v2 hard reject」とする決定は @reviewer の review (PR #23 archive `2026-05-17-PR-23-edition-model-design.md` の `judgment 1d`) で 3 案 ((A) v1 hard reject / (B) v1 WARN + v2 hard reject / (C) env 名 path) を提示し、operator が (B) を採用。理由:

- H3 ルール (= 移行猶予なしの breaking flip 禁止) との整合
- 既存 self-host deployment への migration cost が「env 1 つ削除 or `_LEGACY_` flag 設定」で済む
- v2 で hard reject に格上げするタイミング (= 1 minor release 後を想定) で再度 release notes 公告できる

## 変更が入る code path

実装は edition 解決を中心に最小限の wiring で済む:

- **新規**: `src/edition.ts` — edition 解決 module
- **修正**: `src/mcp/server.ts`
  - module-level singleton `activeEditionConfig` と `getEditionConfig()` getter
  - `resolveTenant`: PE では `X-Tenant-Id != 'default'` を 400 で reject、deployment init gate を edition gate
  - `checkDeploymentInitGate`: PE では no-op
  - `authenticateUser`: `AUTH_MODE` を edition から取得 (env を直接読まない)
  - `createMcpServer`: ListTools / CallTool を edition-driven 化
  - `/health`: edition と auth_mode を露出
  - 起動 log を edition 別に整理
  - 既存 `:106-138` の **access policy ASCII 図解** (現在 CE 前提の 5 ルール) を **edition 別 / 共通の 2 段構成** に書き換え (= PE で「named tenant 不可」「deployment init gate なし」を別ブロックで表現)
- **修正**: `README.md` — アーキテクチャ section に edition、環境変数 section に `AGENT_HUB_EDITION`、Migration section を追加
- **修正**: `.env.example` — `AGENT_HUB_EDITION` を主、`AUTH_MODE` は省略可に整理

`createMcpServer` 内の ListTools 生成は `getAvailableTools(EditionConfig)` という pure function に切り出して unit test 可能にする (= closure に閉じ込めると edition × tool list の組合せが test しにくい)。

## Test 戦略

- **unit (edition resolution)**: 解決ロジック / conflict / default 採用 / 大文字空白許容 etc. ~15 件
- **unit (tool list filter)**: `getAvailableTools(EditionConfig)` の edition × ListTools 組合せ ~4 件
- **unit (PE boundary、新規 4 件)** — PE 固有の振る舞いが production code path を抜けて反映されているかの境界 test:
  - **(a) PE + `X-Tenant-Id: foo` → 400 BadRequest** — `resolveTenant` の named tenant reject パスを実装 PR で確認
  - **(b) PE + fresh DB + 任意 handle → `deployment_not_initialized` 503 が *発生しない*** — `checkDeploymentInitGate` が PE で no-op 化されていることを inverse 側で確認 (= CE の同 test が 503 を返すのと対になる)
  - **(c) CE + `AGENT_HUB_EDITION` 未指定 → default community で起動成功** — default 採用ロジックが env 未指定パスで正しく community に解決されることを確認
  - **(d) PE + `AUTH_MODE=pat` → `EditionConfigError` で起動失敗** — Fail-fast validation の `v1 = hard reject` ルールの実装側を確認 (= 1d の inverse 側、PE+pat は v1 でも常に reject される設計)
- **unit (1d v1 WARN 路、新規)** — CE + `AUTH_MODE=trust` で `console.warn` が呼ばれ、`AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1` 設定時に v1 で起動成功することを確認 (= 後の v2 で hard reject に格上げするときに本 test を反転させる、test 自体が migration anchor)
- **手動確認** (= operator 環境で見るほうが確実な分):
  - `AGENT_HUB_EDITION=private npm run mcp:start` で LAN 接続 (`X-User-Id=alice`) が動作
  - `AGENT_HUB_EDITION=private` + `X-Tenant-Id: foo` で 400 が返る
  - deploy 後 `/health` が `{edition, auth_mode}` を返す

## Migration (= 既存利用者向け案内)

### 旧 LAN 運用 (= `AUTH_MODE=trust` 単独) からの移行

旧版で `AUTH_MODE=trust` だけで LAN 運用していた deployment は、新版では **`AGENT_HUB_EDITION=private` の明示** が **強く推奨** (= v1 では未明示でも WARN-only で起動するが、v2 で reject に格上げされる):

```bash
# 旧: AUTH_MODE=trust だけで起動
# 新 (推奨): AGENT_HUB_EDITION=private を明示
export AGENT_HUB_EDITION=private
npm run mcp:start
```

### v1 中の延命 opt-in (= `AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1`)

事情があって CE + trust の組合せを **v1 中だけ** そのまま使い続けたい deployment は、 **opt-in env で延命可能**:

```bash
# CE + trust を v1 中だけ明示的に許容 (v2 では reject される、要 audit log)
export AUTH_MODE=trust
export AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1
npm run mcp:start
```

この env を設定した起動は startup log に「**legacy CE+trust mode running under explicit opt-in**」を残し、運用側が「自分が legacy 経路を選んだ」事実を audit 可能にする。v2 release 時には本 env も無効化されて hard reject に切り替わる予定 (= release notes で別途公告)。

### PAT 運用は変更不要

PAT 運用していた deployment は変更不要 (= CE がデフォルト、`AUTH_MODE=pat` も従来通り受理)。

### Migration 一覧表

| 旧 deployment | 推奨される新 config | v1 挙動 | v2 挙動 |
|---|---|---|---|
| `AUTH_MODE=trust` のみ (LAN) | `AGENT_HUB_EDITION=private` 明示 | WARN log で migration hint、起動成功 | hard reject、要 migration |
| `AUTH_MODE=pat` のみ (PAT 公開) | 変更不要 (= CE default) | 変更なし | 変更なし |
| 旧 LAN を v1 中だけ延命したい | `AGENT_HUB_ALLOW_LEGACY_CE_TRUST=1` 追加 | opt-in WARN、起動成功、audit log 出力 | env 無効化、要 migration |
| 新規 LAN deployment | `AGENT_HUB_EDITION=private` を最初から明示 | 起動成功 | 起動成功 |
| 新規 PAT deployment | `AUTH_MODE=pat` (CE default、明示は任意) | 起動成功 | 起動成功 |

### default 採用: `community`

`AGENT_HUB_EDITION` 未指定時のデフォルトは `community` を採用する。理由:

- **secure-by-default**: 「うっかり trust mode で公開」事故を消すには、CE が default のほうが安全
- **trajectory との一致**: `AGENT_HUB_DISABLE_DEFAULT_TENANT` も secure-by-default に flip された経緯 (commit `1394c38`) と同じ方向性
- **migration cost**: 旧 trust 運用者は env 1 つ足すだけ (= `AGENT_HUB_EDITION=private`)、低コスト

代案として「未指定で startup fail (= 明示必須)」も検討したが、localhost dev の体験が悪化するため見送り。

## Out of scope (= 本 doc で扱わない論点)

- **#21 `messages.sender_github_login` audit 列追加** — CE 固有の audit gap、本 doc とは独立に進む security 改善
- **#10 Phase 3 Enterprise tier (OIDC + SCIM + audit log)** — 本 doc の Edition モデルを拡張する形で別 doc を起こす
- **#19 / #20 collaboration-model follow-up** — 本 doc とは独立
- **`/health` への `version` 露出** — bridge 側で「自分が話している hub のバージョン」判定の utility 用、本 doc scope 外で別 issue 候補
- **`EditionConfig` boolean フラグの discriminated union 化検討** — 将来 Enterprise tier 投入で `3 edition × N flag` の組合せが膨らみ、無意味な組合せ (= CE + SCIM 等) も型上成立してしまう explosion 懸念がある。**本 PR では構造変更不要** だが、 **「3 edition 目を入れる時点」で discriminated union 化を検討する trigger** として記録 (= `EditionConfig` を `CommunityConfig | PrivateConfig | EnterpriseConfig` の union で表現し、edition ごとに有効な flag のみ型で許す形)

## 関連

- 上位 strategy: [issue #10 `3-edition strategy`](https://github.com/kishibashi3/agent-hub/issues/10)
- 本 doc を実装する issue: [issue #18 `feat: Private Edition (PE)`](https://github.com/kishibashi3/agent-hub/issues/18)
- 認証ルールの参照元: [`README.md` のアーキテクチャ section](../README.md#アーキテクチャ)
- persona 責務分担: [`collaboration-model.md` の Merge protocol section](./collaboration-model.md#merge-protocol-pr-レビュー時の-persona-責務分担)
