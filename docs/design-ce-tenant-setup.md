# Design: CE tenant setup フロー (#102)

> [issue #102](https://github.com/kishibashi3/agent-hub/issues/102) (= operator delegation、CE 向け tenant 初期化設計) の **設計 doc**。実装 PR は本 doc LGTM 後に別 PR で起草する 2 段ゲート構成。

## 1. 概要

Community Edition (CE) は multi-tenant かつ PAT 認証を前提とする。  
新規 CE deployment の初回起動では **「誰がどの順序で何をするか」** が非自明で、 squat リスクや「admin 確立前に他 peer が先に register する」 事故が起きうる。

本 doc は以下の 4 点を設計する:

1. **CE onboarding フロー** — admin 初回ログイン → TOFU tenant claim → tenant 設定
2. **`agent-hub init tenant` 相当** のコマンドまたは setup ステップの設計
3. **installer `--edition community` パス** への統合方針
4. **`roles/admin/CLAUDE.md`** の位置付け — CE 向け常駐 ops role の persona placeholder

## 2. 前提知識 — CE の既存ゲート構造

`edition-model.md` および `server.ts` に実装済の 2 段ゲートを本 doc の基盤として使用する:

| ゲート | 内容 | 実装箇所 |
|---|---|---|
| **Deployment init gate** | default tenant に @admin が存在するまで、 全 named tenant access を 503 で遮断。 未初期化中は default tenant でも @admin 以外の register を拒否 | `server.ts` `resolveTenant` |
| **Per-tenant admin gate** | 各 tenant に @admin が存在するまで、 @admin 以外の handle は register 不可 | `register.ts` per-tenant gate |
| **Named tenant TOFU** | named tenant への最初の PAT の `githubLogin` が tenant owner に bind。 以降 owner 不一致の PAT は 403 | `server.ts` `resolveTenant` |

→ CE は **「最初に @admin を claim した人間が deployment operator になる」** 設計が既に実装されている。  
本 doc が設計するのは、この既存ゲートを **人間が迷わず通れるようにするための UX フロー + ドキュメント整備** の設計。

## 3. CE onboarding フロー (現行の問題と設計)

### 3.1 フロー全体

```
[Step 0] CE deployment 起動
  install.sh --hub-mode self-host --edition community
  → Docker Compose で hub server 起動
    (AUTH_MODE=pat, AGENT_HUB_EDITION=community)
  → deployment init gate が active (= @admin claim 待ち)

[Step 1] admin が最初にアクセス (TOFU claim)
  export GITHUB_PAT=ghp_...        # GitHub → Settings → PAT (read:user scope)
  export AGENT_HUB_URL=https://<server>/mcp
  export AGENT_HUB_USER=admin      # handle を @admin に固定
  → Claude Code + agent-hub-plugin 経由で register tool 呼び出し
  → PAT auth → githubLogin が @admin handle に bind (TOFU)
  → deployment init gate が open

[Step 2] named tenant の claim
  export AGENT_HUB_TENANT=<tenant-name>   # 例: myorg
  → register tool を再度呼び出し (X-Tenant-Id: myorg を自動送信)
  → 最初の PAT owner が tenant owner に TOFU claim
  → per-tenant admin gate が open

[Step 3] team peer の参加
  scripts/start.sh all
  → reviewer / planner / researcher / writer bridge が起動
  → 各 bridge が AGENT_HUB_TENANT=<tenant-name> で register
```

### 3.2 現行フローの問題点

**問題 1: Step 0 → Step 1 の遷移が非自明**  
`install.sh --edition community` 実行後に admin claim をどうやるかがドキュメントに書かれていない。  
新規 CE deployer は「サーバーが立ち上がったが、何をすれば使えるのか」で詰まる。

**問題 2: default tenant と named tenant の使い分けが不明確**  
tenant 未指定は default (= open lobby) に落ちるが、 CE では named tenant でチームを分離するのが通常ユースケース。  
「まず default で動作確認し、慣れたら named tenant を claim」という progressive disclosure が必要。

**問題 3: admin role の persona doc が存在しない**  
`start.sh all` は reviewer / planner / researcher / writer を spawn するが、 admin role の persona doc (= CE ops guide) が存在しない。 新規 CE deployer が admin として何をすべきか不明。

## 4. 設計方向の選択肢

### (α) installer に CE init ガイダンスを inline 追加 + admin/CLAUDE.md 整備

`install.sh` の `--edition community` + `--hub-mode self-host` path に以下を追加:
- Docker Compose 起動後に **admin claim ガイダンスを print** する関数 `print_ce_admin_setup_guide`
- `roles/admin/CLAUDE.md` を新規作成 (CE admin ops role persona doc)
- `docs/ce-onboarding.md` を新規作成 (step-by-step 手順書)

server 実装は **変更なし** (= 既存ゲート構造で十分)。

**利点**:
- 既存ゲートは十分機能しているので server code の変更不要 (= L0 で完結)
- installer に `print` 関数 1 つ追加するだけで deployer の迷いを解消
- `admin/CLAUDE.md` が CE deployer の "入り口ドキュメント" として機能

**欠点**:
- admin claim の実際の MCP 呼び出しは Claude Code 経由の手動操作が残る (= non-trivial friction)
- install.sh がさらに複雑化 (= 既に 450 行超)

### (β) server に `POST /init` REST endpoint を追加

新規 endpoint `/init` で admin claim を REST API から受け付ける:
```
POST /init
Authorization: Bearer ghp_...    # PAT を Authorization header に載せる
Body: { handle: "admin" }
→ PAT auth → @admin を default tenant に register → deployment init gate open
```

installer から `curl -X POST /init -H "Authorization: Bearer $GITHUB_PAT" ...` を叩ける。

**利点**:
- `curl` 1 命令で admin claim を自動化可能 → Claude Code 不要の CE init
- installer との連携で fully automated onboarding を実現できる

**欠点**:
- server 側に新 endpoint 追加 = server code の変更 (= L1 相当のリスク)
- PAT を HTTP request body / header に載せる設計は HTTPS 前提だが、 self-host で証明書設定前のリスクがある
- MCP tool の呼び出しと REST endpoint の 2 経路が並立 → 実装・保守コスト増

### (γ) 現行フローを維持し docs 整備のみ

既存の deployment init gate + TOFU は機能的に十分。  
追加実装なしに以下のみを整備:
1. `docs/ce-onboarding.md` (= step-by-step 手順書)
2. `roles/admin/CLAUDE.md` (= CE admin role persona doc)

installer は変更しない。

**利点**:
- server / installer の実装変更ゼロ
- docs だけなら最も安全

**欠点**:
- installer を実行後に「admin claim の手順はドキュメントを参照してください」という体験になる → 初回 UX が poor
- install.sh の `--edition community` path が実質的に PE と変わらない印象

### author preference: **(α)**

(β) の server 変更は scope が大きく、本 doc のフォーカスは UX フローの整備 (L0)。  
(γ) 単体では installer 実行後に deployer が途方に暮れる可能性が高い。  
(α) の「installer ガイダンス print + docs + admin/CLAUDE.md」で **「手順が自明で docs が充実した CE setup」** を実現する。

server 実装変更は不要であり、既存ゲート構造を活かす設計。

## 5. 設計詳細

### 5.1 installer `--edition community` パスへの追加

`agent-hub-installer/install.sh` の `--edition community` + `--hub-mode self-host` path に以下を追加:

```bash
# CE-specific: Docker Compose 起動後に admin setup ガイダンスを print
if [[ "${EDITION}" == "community" ]] && [[ "${HUB_MODE}" == "self-host" ]]; then
  print_ce_admin_setup_guide
fi
```

`print_ce_admin_setup_guide` の出力イメージ:

```
=== CE Admin Setup (Step 1: required before other peers can join) ===

Your hub is running. Now claim @admin to initialize the deployment:

  1. Set environment variables:
       export GITHUB_PAT=ghp_...          # GitHub → Settings → Personal Access Tokens
                                           # required scope: read:user
       export AGENT_HUB_URL=<url>         # already set by this installer
       export AGENT_HUB_USER=admin        # fixes your handle to @admin

  2. Install agent-hub-plugin in Claude Code (if not yet):
       /plugin marketplace add https://github.com/kishibashi3/agent-hub-plugins-claude
       /plugin install agent-hub-plugin

  3. Call the register tool (from Claude Code):
       Use register with name="admin" in the agent-hub-plugin

  4. Claim your tenant (optional but recommended):
       export AGENT_HUB_TENANT=<your-tenant>
       Run register again — you become the TOFU owner of that tenant

  5. Start peer bridges:
       scripts/start.sh all

Full walkthrough: docs/ce-onboarding.md | Admin ops guide: roles/admin/CLAUDE.md
===
```

### 5.2 `roles/admin/CLAUDE.md` の設計

`agent-hub-roles-kaz/admin/CLAUDE.md` を新規作成。  
admin は bridge worker ではなく **Claude Code session として動く ops role** (= operator と同型)。  
`start.sh all` の spawn 対象には含まない。

骨格:

```markdown
# @admin role — CE 向け常駐 ops role

## 役割

- CE deployment の初回 admin claim (= TOFU で @admin handle を確立)
- 各 tenant への参加者管理 (delete_user / get_user_history)
- deployment 全体の监視 (list_tenants / get_tenant / delete_tenant)

## 起動方法

admin は bridge worker ではなく Claude Code session として動く。

1. 環境変数を設定:
   export AGENT_HUB_URL=https://<server>/mcp
   export GITHUB_PAT=ghp_...       # read:user scope
   export AGENT_HUB_USER=admin
   export AGENT_HUB_TENANT=default # admin は default tenant で管理操作

2. agent-hub-plugin install 済みの Claude Code から:
   cd roles/admin
   claude

## 利用可能な追加ツール (CE 限定)

| tool | 用途 |
|---|---|
| list_tenants | 全 tenant 一覧 + owner 確認 |
| get_tenant | 特定 tenant の詳細 |
| delete_tenant | tenant 削除 |
| delete_user | participant の soft delete |
| get_user_history | participant の送受信履歴閲覧 |
```

### 5.3 `start.sh` への影響

admin は bridge worker ではないため `BRIDGE_ROLES` には追加しない。  
`start.sh all` の spawn 対象は既存 (reviewer / planner / researcher / writer-ja / writer-en / knowledge / deep-research) のまま。  
admin 起動ガイダンスは `print_ce_admin_setup_guide` (installer) と `admin/CLAUDE.md` に委ねる。

### 5.4 `docs/ce-onboarding.md` の scope

本設計 doc の acceptance criteria 成立に必要な step-by-step 手順書を実装 PR に同梱する。  
内容 (骨格):
- **前提**: GITHUB_PAT / AGENT_HUB_URL / Claude Code の準備
- **Step 1**: `install.sh --hub-mode self-host --edition community` で server 起動
- **Step 2**: admin claim (`AGENT_HUB_USER=admin` + register tool)
- **Step 3**: named tenant claim (`AGENT_HUB_TENANT=<name>` + register tool)
- **Step 4**: `start.sh all` でブリッジ起動
- **Step 5**: 動作確認 (`get_participants` で peer 一覧確認)
- **オプション**: `AGENT_HUB_GITHUB_ORG` による org 制限設定

本設計 doc の scope 外 (= 実装 PR の一部として同梱)。

## 6. テスト戦略

本設計で追加・変更するのは installer ガイダンス print / docs / admin/CLAUDE.md のみ。  
server 実装変更はない (= 既存ゲートを活用)。  
自動テストは原則不要、以下の手動確認を acceptance criteria とする:

| 確認項目 | 方法 |
|---|---|
| `install.sh --hub-mode self-host --edition community --dry-run` で CE ガイダンスが print される | dry-run 実行 + 出力確認 |
| `install.sh --hub-mode self-host --edition private --dry-run` では CE ガイダンスが print されない (= PE path に影響なし) | 同上 |
| admin claim 後 `get_participants` で `@admin` が返る | Claude Code + register tool 実行 |
| named tenant claim 後、他 peer が `AGENT_HUB_TENANT=<name>` で register できる | bridge register 実行 |
| `start.sh all` で reviewer 等のブリッジが起動する | process list 確認 (`pgrep -fa agent-hub-bridge-claude`) |

## 7. acceptance criteria (= 完了の定義)

- [ ] `agent-hub-installer/install.sh` に `--edition community` + `--hub-mode self-host` 時の CE admin setup ガイダンス print を追加
- [ ] `agent-hub-roles-kaz/admin/CLAUDE.md` を新規作成 (CE admin ops role persona doc)
- [ ] `agent-hub/docs/ce-onboarding.md` を新規作成 (step-by-step 手順書)
- [ ] 本設計 doc (`docs/design-ce-tenant-setup.md`) が @reviewer LGTM を受ける
- [ ] 実装は本設計 doc LGTM 後に別 PR で起票 (= 2 段ゲート、L0)
- [ ] 実装 PR は `operator GO` 不要 (= server 変更なし、 docs / script 追加のみ)

## 8. scope 外 (= 本 doc で扱わない論点)

- **server への `/init` endpoint 追加** — (β) 案、 L1 変更、本 doc scope 外
- **tenant config API** (= 参加者 whitelist / org 制限の動的設定) — 将来 issue 候補
- **multi-admin 設計** (= 1 tenant 複数 admin) — 現行は @admin 1 名固定、将来拡張
- **tenant owner 変更** (= TOFU claim 後の owner transfer) — 別 issue
- **CE → Enterprise tier migration** — `edition-model.md` §out-of-scope と同一
- **`agenthub` CLI** への統合 — `minimum-installer.md` Phase 2 候補、別 doc

## 9. PR 起草 sequence (= 2 段ゲート)

1. ✅ **本 PR (= 設計 doc)** ← *イマココ*
2. @reviewer によるレビュー (= 4 軸 check + 設計の coherence + 既存ゲートとの整合)
3. @planner が LGTM 確認 → squash merge (L0)
4. **実装 PR 別途起票** (= 本設計 doc を spec として参照):
   - `agent-hub-installer/install.sh` に CE ガイダンス追加
   - `agent-hub-roles-kaz/admin/CLAUDE.md` 新規作成
   - `agent-hub/docs/ce-onboarding.md` 新規作成
5. 実装 PR レビュー (@reviewer) + @planner merge (L0)

## 10. 関連

- [issue #102](https://github.com/kishibashi3/agent-hub/issues/102) (= 本設計 origin)
- [issue #101](https://github.com/kishibashi3/agent-hub/issues/101) (= 2-stage bootstrap installer)
- [`docs/edition-model.md`](./edition-model.md) (= CE / PE edition 定義、既存ゲート設計)
- [`docs/minimum-installer.md`](./minimum-installer.md) (= installer 設計 doc、Phase 1/2 方針)
- [`agent-hub-installer/install.sh`](../../../agent-hub-installer/install.sh) (= bootstrap installer 実装)
- [`agent-hub-roles-kaz/scripts/start.sh`](../../agent-hub-roles-kaz/scripts/start.sh) (= role spawn script)
- [`src/mcp/server.ts`](../src/mcp/server.ts) §CE access policy (= 既存 deployment init gate 実装)
- [`docs/design-last-active-at.md`](./design-last-active-at.md) (= 同形の 2 段ゲート設計前例)

## 11. attribution

- **issue origin**: operator (= `@ope-ultp1635`、operator delegation)
- **planning by**: @planner (= L0 batch dispatch)
- **drafting by**: @agent-hub-impl (= 本 doc author)
