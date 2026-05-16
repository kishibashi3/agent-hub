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
| `AGENT_HUB_DISABLE_DEFAULT_TENANT` | honor (default `1` = restricted) | 無視 (default 1 つしか無いので意味を持たない) |

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

## Fail-fast validation

startup で env の妥当性 + edition との整合性を検証し、矛盾があれば **migration hint 付きの error message で起動失敗** する。実行時に「想定外の edition で動いている」事故を排除する。

検証規則:

- `AGENT_HUB_EDITION` 不正値 (`enterprise` 等) → `EditionConfigError`
- `AUTH_MODE` 不正値 → `EditionConfigError`
- CE + `AUTH_MODE=trust` の組合せ → conflict、`EditionConfigError`
- PE + `AUTH_MODE=pat` の組合せ → conflict、`EditionConfigError`

error message 例 (CE + trust の組合せ):

> `AGENT_HUB_EDITION=community では AUTH_MODE=trust は使用できません。LAN 専用運用なら AGENT_HUB_EDITION=private を指定してください。`

PE + pat の場合は inverse の hint を出す。**hint の方向性は「どちらの edition に migrate するか」が利用者から見て自明** になる文言を選ぶ。

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
- **修正**: `README.md` — アーキテクチャ section に edition、環境変数 section に `AGENT_HUB_EDITION`、Migration section を追加
- **修正**: `.env.example` — `AGENT_HUB_EDITION` を主、`AUTH_MODE` は省略可に整理

`createMcpServer` 内の ListTools 生成は `getAvailableTools(EditionConfig)` という pure function に切り出して unit test 可能にする (= closure に閉じ込めると edition × tool list の組合せが test しにくい)。

## Test 戦略

- **unit (edition resolution)**: 解決ロジック / conflict / default 採用 / 大文字空白許容 etc. ~15 件
- **unit (tool list filter)**: `getAvailableTools(EditionConfig)` の edition × ListTools 組合せ ~4 件
- **手動確認** (= operator 環境で見るほうが確実な分):
  - `AGENT_HUB_EDITION=private npm run mcp:start` で LAN 接続 (`X-User-Id=alice`) が動作
  - `AGENT_HUB_EDITION=private` + `X-Tenant-Id: foo` で 400 が返る
  - deploy 後 `/health` が `{edition, auth_mode}` を返す

## Migration (= 既存利用者向け案内)

旧版で `AUTH_MODE=trust` だけで LAN 運用していた deployment は、新版では **`AGENT_HUB_EDITION=private` の明示が必要**:

```bash
# 旧: AUTH_MODE=trust だけで起動
# 新: AGENT_HUB_EDITION=private を明示
export AGENT_HUB_EDITION=private
npm run mcp:start
```

PAT 運用していた deployment は変更不要 (= CE がデフォルト、`AUTH_MODE=pat` も従来通り受理)。

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

## 関連

- 上位 strategy: [issue #10 `3-edition strategy`](https://github.com/kishibashi3/agent-hub/issues/10)
- 本 doc を実装する issue: [issue #18 `feat: Private Edition (PE)`](https://github.com/kishibashi3/agent-hub/issues/18)
- 認証ルールの参照元: [`README.md` のアーキテクチャ section](../README.md#アーキテクチャ)
- persona 責務分担: [`collaboration-model.md` の Merge protocol section](./collaboration-model.md#merge-protocol-pr-レビュー時の-persona-責務分担)
