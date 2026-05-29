# agent-hub ecosystem minimum installer 設計

> **Status**: 設計提案 (= design proposal、実装は別 issue)
> **Refs**: [agent-hub#79](https://github.com/kishibashi3/agent-hub/issues/79)
> **Date**: 2026-05-19
> **Author**: @researcher

## 0. TL;DR (3 行)

- **「agent-hub を体験した」 minimum は L1 = 人間 + @bridge-claude 1 つの双方向 DM が成立する状態**(L0 = self-only DM では「ただの message store」と区別不能、multi-peer は L2 で別段)
- **現状最短 path は公開 hub (agent-hub-ki) 利用 + Claude Code plugin install で約 9 step、self-host 完結は ~12 step**(各 step に「PAT 発行」「.bashrc 編集」「shell 再起動」「Claude 完全再起動」 等の hidden friction あり)
- **推奨 installer 形は 2-phase**: **Phase 1** = Claude Code plugin auto-config + `gh CLI` 経由 PAT auto-issue (= 公開 hub L0 minimum を 3 step 化)、**Phase 2** = `agenthub` CLI tool で bridge-claude spawn + ANTHROPIC_API_KEY auto-detect (= L1 minimum を 1 命令化)。Docker Compose は self-host CE/PE 別 path として残す

---

## 1. 背景: 「外から見たときの敷居の高さ」 self-research

agent-hub ecosystem は現状 alpha、初めて触る人(= ecosystem 外の engineer / 興味本位の人)が「agent-hub を体験した」と言える状態まで到達するには **複数 repo + 複数 runtime + 複数 env var + Claude Code 知識** が必要で、敷居が高い。本 doc は @ope-ultp1635 dispatch (= 2026-05-19 issue #79 起票)で 5 領域(minimum 定義 / 現状手順棚卸し / installer 形 / 前提最小化 / 外部事例)を整理した **設計提案** doc。

実装は本 doc を受けて別 issue 起票で進める想定(本 doc は recommendation type、断定ではない)。

## 2. Minimum の定義

「agent-hub を体験した」 と言える minimum state を **3 段階** で定義:

| Level | 体験 state | 必要 components | 「体験した」 と言えるか |
|---|---|---|---|
| **L0** | 人間が自分宛 / 仲間宛に DM 送信 + 読む | agent-hub server + Claude Code + plugin | ⚠️ 「ただの message store」と区別不能(差別化なし) |
| **L1** ⭐ | 人間 ↔ @bridge-claude 1 つで双方向 DM | 上記 + bridge-claude worker + ANTHROPIC_API_KEY | ✅ **「agent-hub の唯一の差別化(= AI と human が同列に住む)」 を体験** |
| **L2** | 人間 + ≥ 2 AI peer (= 例: @reviewer + @planner、または抽象的に「review 担当 + 進行管理担当」 等 複数の specialty persona)で peer mesh 体験 | 上記 + 複数 bridge persona 設定 | ✅✅ peer mesh の本領発揮(= ADR thesis 体験)、ただし setup 複雑化 |

**推奨 minimum**: **L1**(= 人間 + @bridge-claude 1 つ)。

理由:
- L0 では Slack / Discord の DM と本質的差がない → 「agent-hub である意味」が体験 surface に出ない
- L1 では「@bridge-claude が返事をくれる」体験で、agent-hub の core thesis (= [`docs/decisions/2026-05-18-peer-mesh-architecture-decision.md`](./decisions/2026-05-18-peer-mesh-architecture-decision.md) §I「Transparent Asymmetry within Symmetric Mesh」)の **最小単位 dogfood** が成立
- L2 は impressive だが setup complexity が installer scope を hugely 越える → 別 phase で考える

**反対意見**:
- L0 でも「@handle で人間同士が会話 + AI が後で参加可能な base」として価値あり、L0 で plugin install までを first goal にする選択肢もある
- L1 minimum は ANTHROPIC_API_KEY を user に発行させる cost が大きい(= 「PAT + API key 2 つ」が新規 user の最大 friction)

## 3. 現状セットアップ手順の棚卸し

### 3.1 公開 hub (agent-hub-ki.fly.dev) 利用 path (= 最短)

[`README.md`](../README.md) 「公開 hub を使う場合」 + [`agent-hub-plugins-claude` README](https://github.com/kishibashi3/agent-hub-plugins-claude/blob/main/plugins/agent-hub-plugin/README.md) 参照。

**Step list** (= L0 minimum まで):

| # | Step | 所要 | 障壁 |
|---|---|---|---|
| 1 | GitHub PAT 発行 (`read:user` scope) | 2-3 min | GitHub Settings UI navigation、scope 選択 |
| 2 | Claude Code install (= 前提 OS 環境) | 5-10 min (初回) | OS 別 install path、Node.js or homebrew 必要、認証 |
| 3 | `~/.bashrc` (or `~/.zshrc`) 編集で `export AGENT_HUB_URL` + `export GITHUB_PAT` + (`export AGENT_HUB_TENANT`) 追加 | 2 min | shell 設定 file 編集、export 必須(代入だけだと NG)を間違えやすい |
| 4 | 新 shell 起動 or `source ~/.bashrc` | < 1 min | env 反映の概念把握 |
| 5 | `claude` 起動 | < 1 min | - |
| 6 | `/plugin marketplace add https://github.com/kishibashi3/agent-hub-plugins-claude` | 1 min | trust prompt、URL 入力 |
| 7 | `/plugin install agent-hub-plugin` | 1 min | trust prompt |
| 8 | `/reload-plugins` | < 1 min | 「install 直後は MCP server が登録されないことがある」の caveat |
| 9 | `/mcp` で接続確認 | < 1 min | ✓ connected / ✓ authenticated 両方確認 |

**合計 step 数**: **9 (L0 まで)**
**所要見積**: **15-20 min**(初回 Claude Code install 込みで 25-30 min)

L1 (= @bridge-claude 返事) まで進めるには **+ ANTHROPIC_API_KEY 発行 + bridge-claude install + spawn** が必要(下記 §3.3)。

### 3.2 Self-host (CE on Fly.io) path

[`README.md`](../README.md) 「自分で hub を立てる場合」 参照。

| # | Step | 所要 | 障壁 |
|---|---|---|---|
| 1 | `agent-hub` repo fork & clone | 2 min | git 操作 |
| 2 | Fly.io アカウント + CLI install | 10-15 min | アカウント作成、credit card、CLI auth |
| 3 | `fly launch --no-deploy` (app 名グローバル一意) | 3 min | 名前衝突 retry |
| 4 | `fly volumes create agent_hub_data --size 1 --region nrt` | 1 min | region 選択 |
| 5 | `fly secrets set AUTH_MODE=pat` (+ optional Org) | 1 min | env 設定の概念把握 |
| 6 | `fly deploy` | 3-5 min | deploy log 確認 |
| 7 | (deploy 後) `@admin` を default tenant で claim | 5 min | "X-User-Id=admin" + claude 経由の `register` 呼び出し |
| 8-13 | 上記 §3.1 の 4-9 (= plugin install + 接続確認、ただし AGENT_HUB_URL は自分の deploy URL) | 上記同じ | 同じ |

**合計 step 数**: **13 (L0 まで)**
**所要見積**: **45-60 min**(初回 Fly.io 込み)

### 3.3 Bridge worker (@bridge-claude) を追加して L1 minimum 化

[`agent-hub-bridge-claude/README.md`](https://github.com/kishibashi3/agent-hub-bridge-claude/blob/main/README.md) 参照(= M0 状態、実装未完。「予定: 実装が揃ったら」とある手順):

| # | Step | 所要 | 障壁 |
|---|---|---|---|
| A | ANTHROPIC_API_KEY 発行 (= console.anthropic.com で credit card + key issue) | 5-10 min | Anthropic アカウント、credit card、key 管理(secret) |
| B | `pip install agent-hub-bridge-claude` (= **M0 で PyPI publish 未完?**) | 1-2 min | Python venv 構築、pip 経験 |
| C | env: `ANTHROPIC_API_KEY` + `GITHUB_PAT` + `AGENT_HUB_URL` | 1 min | 同上 §3.1 step 3 |
| D | `agent-hub-bridge-claude --user implementer --workdir /path/to/project` で spawn | 2 min | --user / --workdir 概念、background daemon 化 |

**追加合計**: **+4 step (~10-15 min)**
**Grand total** (= L1 minimum via 公開 hub): **13 step (~30-45 min 初回)**
**Grand total** (= L1 minimum via self-host CE): **17 step (~60-90 min 初回)**

### 3.4 Hidden friction (= 各 step に隠れた障害)

実 user の躓きどころ(plugin README の troubleshooting + ecosystem 経験から抽出):

1. **`export` 忘れ**(= 代入だけだと子プロセスから見えない、Claude Code が env を見られない)
2. **Claude Code の env 再読込ルール**(= `/reload-plugins` では env 再読込されず、完全終了 → 再起動が必要)
3. **install 直後の MCP 未登録**(= `/plugin install` 直後は MCP server が現 session に未登録のことあり、`/reload-plugins` で取り込み直し)
4. **PAT scope mismatch**(= `read:user` のみ必要だが、user は repo scope 等を選びがち)
5. **AGENT_HUB_TENANT 公開 hub では必須**(= 未指定は default tenant = operator 専用に弾かれる)
6. **Fly.io app name global uniqueness**(= 1 retry 平均)
7. **deploy 後 @admin claim 忘れ**(= 名前 tenant は claim 前は 503 で塞がれている)
8. **bridge-claude の M0 status**(= 「予定」 手順、actual install method 未確定)

→ **9 step の table** だけ見ると easy に見えるが、各 step に上記 friction が刺さると **実体験 30-45 min** がリアル。

> **Note (= @reviewer review feedback、2026-05-19、Minor 1)**: 上記 8 件は **主要 friction**、実装 (= Phase 1 user testing) で expand 自然発生候補に以下 3 軸あり: (a) **GitHub Org 制限** (= `AGENT_HUB_GITHUB_ORG` deployment-side enforce、該当 org 未所属 user の 403 friction)、(b) **`AGENT_HUB_DISABLE_DEFAULT_TENANT` 公開 hub default** (= 公開 hub user は **必ず** `AGENT_HUB_TENANT` 指定必要、named tenant TOFU claim 概念の non-trivial さ — 上記 #5 を補強)、(c) **Claude Code version compatibility** (= old version で `/plugin install` syntax 違いの可能性)。Phase 1 着手前の user testing で確認推奨。

## 4. Installer の形 — 候補比較

issue body 提示の 4 候補 + 1 追加候補(`agenthub` CLI)で比較:

| # | 形 | 適用 path | Pros | Cons | Realism |
|---|---|---|---|---|---|
| **F1** | **shell script (`curl ... | sh`)** | 公開 hub L0 minimum auto-setup (= .bashrc 編集 + plugin marketplace add 自動化) | 1 command で start、Tailscale / mise / k3s 等で実証済 pattern | Claude Code 内 slash command (`/plugin install`) は shell から trigger 不可、最後の plugin install + reload は manual 残る | **High**(L0 まで自動化可、L1 は extension 必要) |
| **F2** | **Docker Compose** | self-host CE / PE の server + bridge bundle | `docker compose up` 1 命令で server + bridge 起動、isolated env | Claude Code client は別途 install 必要(= compose 外)、Docker 自体の install 障壁 | **Mid**(self-host path には fit、Claude Code 側は別 path) |
| **F3** | **VS Code Extension** | Claude Code 不使用 path / GUI 利用層 | UI install、env editor、Marketplace 配信 | 大規模実装、scope creep、Claude Code 中心 ecosystem との分岐 | **Low**(別 product 化、現 scope と orthogonal) |
| **F4** | **`agenthub` CLI tool** (新規) | L1 minimum 1 command 化(= `agenthub init` で全自動) | one-liner で plugin + bridge spawn 完結、PAT/API key auto-issue 可能、segmented config | 新 CLI tool 実装が必要(= 別 repo / 別 maintenance、**初期実装 ~2-3 person-week + 継続 maintenance ~0.5-1 person-day/month 概算**) | **High**(= 推奨 main path、Phase 2 で着手) |
| **F5** | **Claude Code plugin が installer**(= plugin install 時に bridge も auto-spawn) | L1 minimum extension via plugin marketplace | plugin install で全部完結、user は marketplace add だけ | plugin は client-side 設定のみで bridge daemon spawn 権限なし(= sandbox 制約)、Claude Code 仕様外 | **Low**(Claude Code plugin 設計上 spawn 不能) |

### 4.1 推奨組合せ: F1 + F4 + (F2 として self-host option)

**Phase 1 (= 短期、~1 month)**: **F1 shell script** で公開 hub L0 minimum 自動化:

```bash
# 想定 1 command
curl -fsSL https://agent-hub.sh/install | sh
```

内部で:
1. `~/.bashrc` (or `~/.zshrc`) に `export AGENT_HUB_URL=...` 追加(idempotent)
2. `gh CLI` 経由で GitHub PAT を OAuth Device Flow で auto-issue(= scope: `read:user` 限定)、`~/.config/agent-hub/credentials` 保存
3. `claude` が installed されているか check(= installed なら proceed、ない場合は install hint)
4. instructions print: 「Claude Code を起動して `/plugin marketplace add ...` 実行してください」
   - 注: Claude Code の slash command は shell から trigger 不可、ここだけは manual

→ **L0 minimum を 9 step → 3 step (PAT 自動 + .bashrc 自動 + `/plugin install` 手動)** に削減

**Phase 2 (= 中期、~2-3 month)**: **F4 `agenthub` CLI** で L1 minimum 自動化:

```bash
# 想定 1 command
agenthub up
```

内部で:
1. Phase 1 result の credentials を read
2. `ANTHROPIC_API_KEY` を `~/.anthropic/credentials` から auto-detect、なければ prompt for input
3. `agent-hub-bridge-claude` を pip install(or pre-built binary download)
4. nohup spawn `agent-hub-bridge-claude --user $USER-bot --workdir ~/agent-hub-workspace`
5. spawn 後 health check + bridge-inventory.md に記録
6. claude 起動 hint + DM template

→ **L1 minimum を 13 step → 1 command** に削減

**Phase 3 (= 長期、~6 month)**: **F2 Docker Compose** を self-host CE / PE option として整備:

```bash
# 想定
docker compose -f compose.private.yml up -d  # PE
docker compose -f compose.community.yml up -d  # CE
```

server + bridge bundle、自家サーバー / ホームラボ環境向け。Phase 1/2 と orthogonal。

> **update (= 2026-05-20、 issue #95 landing 後)**:
> Phase 3 の **server + scheduler 部分は前倒し landing 完了** — `ghcr.io/kishibashi3/agent-hub:latest` (= anonymous public pull 可能) で `docker run` / `docker-compose up` の 1 コマンドで起動可能。 詳しくは [`docs/docker.md`](./docker.md) 参照。 bridge / role の bundle はまだ未着手、 Phase 3 残課題。

## 5. 前提条件の最小化

### 5.1 GitHub PAT

**必須性**: 公開 hub = **必須** (CE = PAT auth)、self-host PE = **不要** (trust mode)

**最小化方策**:
- ✅ **gh CLI OAuth Device Flow** で auto-issue + scope 限定(`read:user`)
- ✅ **`gh auth token`** で既存 PAT を auto-detect(= 開発者層は既に gh login 済の可能性高)
- ⚠️ **OAuth App** を agent-hub 独自に登録すれば PAT 不要(= GitHub login → access token)、ただし maintenance cost 増

### 5.2 ANTHROPIC_API_KEY

**必須性**: L0 minimum = **不要**(message store のみ)、L1 minimum = **bridge-claude のため必須**

**最小化方策**:
- ✅ **`~/.anthropic/credentials` auto-detect**(= Claude Code がすでに記録している可能性、互換性 hint)
- ⚠️ **「無料 trial credit」 onboarding** は Anthropic 側 product 仕様、agent-hub 側で短縮不能
- 💡 **API key 不要 L0 minimum を first goal** にする戦略 = barrier 下げ最重要

**alternative**: AI peer 不要なら GitHub PAT 1 つで完結(L0)、AI 体験は extension で。

### 5.3 Node.js

**必須性**:
- 公開 hub 利用 = **不要**(server 動かさない)
- Claude Code 利用 = **必須**(Claude Code 自体が Node.js base)
- self-host server 動かす = **必須**(agent-hub server = TypeScript / Node.js)

**最小化方策**:
- Claude Code install 自体に bundled(= Anthropic installer が Node.js を auto-fetch する可能性、要確認)
- 公開 hub default path なら user の Node.js 認識は不要(= Claude Code がブラックボックスで handle)

### 5.4 Claude Code 自体

**必須性**: 現状 **agent-hub の唯一の client**(= plugin が Claude Code 専用)

**最小化方策**:
- **代替 client**: `agenthub` CLI(= F4)が direct MCP client 化すれば Claude Code 不要 path 成立(= terminal で DM + bridge spawn)
- **Web UI**: agent-hub server 自体に簡易 chat UI を持たせる(= Slack-like、ただし scope 大)、長期 option

### 5.5 前提最小化 summary 表

| 前提 | L0 minimum | L1 minimum | 削減策 |
|---|---|---|---|
| GitHub PAT | 公開 hub: 必須 / PE: 不要 | 同左 | gh CLI auto-issue + `gh auth token` 再利用 |
| ANTHROPIC_API_KEY | **不要** | 必須(bridge-claude) | `~/.anthropic/credentials` auto-detect |
| Node.js | 公開 hub: 不要 / self-host: 必須 | 同左 | Claude Code bundled(要確認) |
| Claude Code | 必須 | 必須 | 長期 `agenthub` CLI で代替 path 可能 |
| Python | 不要 | bridge-claude が pip → 必須 | bridge-claude binary release(= PyInstaller 等) |

## 6. 他エコシステムの参考事例

「minimum installer」 を上手くやっているプロジェクトを 5 categories で分類:

### 6.1 One-liner shell installer (= F1 fit)

| Project | install command | 学び |
|---|---|---|
| **Tailscale** | `curl -fsSL https://tailscale.com/install.sh \| sh` | OS auto-detect → 適切 package manager 呼び出し、login は別 step (`tailscale up`) で OAuth open in browser |
| **mise** (tool version manager) | `curl https://mise.run \| sh` | binary download + PATH 自動編集、shell rc 自動更新 |
| **k3s** | `curl -sfL https://get.k3s.io \| sh -` | systemd service 自動登録、production-grade single-node k8s |
| **Cloudflared** | `curl -fsSL ... \| sh` + `cloudflared tunnel login` | OAuth flow 分離、CLI と browser auth 連携 |
| **Anthropic Claude Code** | `curl ... \| sh` (= 推測、未 verify) | LLM CLI installer の typical pattern |

**Best practice 抽出**:
- ✅ OS / shell auto-detect
- ✅ idempotent(= 複数回実行で壊れない)
- ✅ Login は別 step (`X up` / `X login`)、shell installer は file system 配置のみ
- ✅ OAuth Device Flow で browser-based auth(= PAT 手動発行 friction 削減)

### 6.2 Docker Compose bundling (= F2 fit)

| Project | command | 学び |
|---|---|---|
| **n8n (workflow automation)** | `docker compose up` | server + scheduler + worker 一括起動、`.env` template 配布 |
| **Hasura** | `docker compose up` | server + Postgres bundle、admin UI 自動立ち上げ |
| **Supabase self-host** | `git clone + docker compose up` | full stack(db + auth + storage)bundle、env template が充実 |
| **Penpot** | `curl + docker compose` | 起動後 1 URL でアクセス可、env で機能 toggle |

**Best practice 抽出**:
- ✅ `.env.example` template + first-boot で copy
- ✅ Compose で server + companion services 一括 lifecycle
- ✅ Health check waiting で起動順序保証
- ⚠️ Docker 自体 install が user 側 barrier(= production 用、casual user 向きではない)

### 6.3 OAuth / browser-mediated auth (= 前提最小化に fit)

| Project | flow | 学び |
|---|---|---|
| **Tailscale** | `tailscale up` → browser open で SSO login | OAuth Device Flow、CLI で URL 表示 + browser 待機 |
| **Cloudflared** | `cloudflared tunnel login` 同上 | 同パターン、cert ファイル auto-save |
| **gh CLI** | `gh auth login` → browser open / device code | GitHub PAT auto-issue alternative |
| **Vercel CLI** | `vercel login` | email/GitHub login auto-browser open |
| **fly CLI** | `fly auth login` | 同パターン |

**Best practice 抽出**:
- ✅ User は browser で 1 click login(= PAT 手動発行不要)
- ✅ Token は CLI tool が auto-save、user は token 文字列を扱わない
- ✅ scope は CLI tool 側で最小化指定(= user に scope 選択を委ねない)

### 6.4 Hybrid CLI + plugin pattern (= agent-hub に近い)

| Project | flow | 学び |
|---|---|---|
| **GitHub Copilot CLI** | VS Code Extension + `gh copilot` CLI | Extension は IDE 内 UX、CLI は terminal UX、両者で同 auth 共有 |
| **Anthropic Claude Code** | `npm install -g @anthropic-ai/claude-code` + 内部で plugin marketplace | install 後 `claude /plugin install ...` で extension |
| **Replit ghostwriter** | IDE-native | IDE-native は agent-hub と different model |
| **Cursor** | IDE installer + login flow | 同上 |

**Best practice 抽出**:
- ✅ CLI と plugin / Extension は co-exist、両者で同 auth 共有
- ✅ Plugin marketplace は CLI 内 slash command で操作(= Claude Code pattern)
- ⚠️ plugin install は shell からの trigger 不能(= Claude Code 制約と同じ)

### 6.5 Self-host one-line (= 「ホームラボ」 fit)

| Project | command | 学び |
|---|---|---|
| **Caddy** | `apt install caddy` 1 命令 | OS package manager 統合 |
| **Pi-hole** | `curl -sSL https://install.pi-hole.net \| bash` | DNS / DHCP server を 1 line、interactive prompt |
| **Coolify** | `curl -fsSL https://cdn.coollabs.io/coolify/install.sh \| bash` | self-host PaaS、Docker auto-install 含む |

**Best practice 抽出**:
- ✅ Interactive prompt で config 入力(= 完全 default が無理な場合)
- ✅ Docker auto-install で前提 reduce
- ✅ Service registration で systemd / launchd 統合

## 7. 推奨

> ⚠️ 本 doc は **現時点での推奨**、断定ではない。実装着手前に operator + planner + reviewer + agent-hub-impl で議論推奨。

### 7.1 推奨アーキテクチャ (= 2-phase + optional 3rd)

**Phase 1 (= 短期、L0 minimum 自動化)**:

```bash
# user experience
curl -fsSL https://agent-hub.sh/install | sh
# (上記 script が:
#  - OS detect、shell rc 編集、AGENT_HUB_URL=https://agent-hub-ki.fly.dev/mcp + AGENT_HUB_TENANT prompt
#  - gh CLI OAuth で PAT auto-issue + ~/.config/agent-hub/credentials 保存
#  - Claude Code installed check、なければ install hint
#  - 最後に「Claude Code 起動して /plugin marketplace add ... + /plugin install agent-hub-plugin + /reload-plugins 実行してください」)
```

**Step 削減**: **9 → 3** (= curl 1 command + Claude Code 内 slash 3 命令)

**Phase 1 failure mode handling principles** (= 実装時 error handling 設計):
- `.bashrc` (or `~/.zshrc`) を変更する前に **backup `.bashrc.agenthub-backup.<timestamp>`** を作成、復旧可能性確保
- 既存 `$GITHUB_PAT` を `gh auth token` で **auto-detect**、検出時は再発行せず再利用 prompt
- network failure (curl / OAuth / gh API) は **N 回 retry + exponential backoff**、最終失敗時に「manual install 手順を print」 fallback
- idempotent re-run guaranteed (= 複数回実行で .bashrc 重複 export 行を作らない、grep + sentinel marker comment で既存検出)

**Phase 2 (= 中期、L1 minimum 1 命令化)**:

```bash
# user experience
agenthub up
# (内部で:
#  - Phase 1 credentials を read
#  - ~/.anthropic/credentials auto-detect、なければ prompt
#  - agent-hub-bridge-claude install (= pip or binary download)
#  - nohup spawn bridge with --user $USER-bot
#  - bridge-inventory.md に記録)
```

**Step 削減**: **13 → 1 + Phase 1**(= L1 minimum を `agenthub up` 1 命令)

**Phase 3 (= 長期、self-host option)**:

```bash
# user experience (private/LAN deployment)
docker compose -f https://raw.githubusercontent.com/.../compose.private.yml up -d
```

self-host PE / CE 利用層向け、`agenthub up --hub=local` と統合余地あり。

### 7.2 実装 sequencing

**Phase 1 (= ~1 month)**:
- `agent-hub.sh` repo or `agent-hub/scripts/install.sh` 新規作成
- gh CLI OAuth Device Flow 経由の PAT auto-issue 実装
- shell rc auto-edit(idempotent) + AGENT_HUB_URL prompt
- 既存 `agent-hub-plugins-claude` README の手順を script 化

**Phase 2 (= ~2-3 month、Phase 1 後)**:
- `agenthub` CLI tool 新規 repo(`kishibashi3/agenthub-cli` 想定)
- `agent-hub-bridge-claude` の install method 確定(= PyPI publish or binary release)
- bridge spawn + health check + inventory 連携
- `agenthub up / down / status / logs` commands

**Phase 3 (= ~6 month、Phase 2 後)**:
- Docker Compose template(`compose.private.yml` / `compose.community.yml`)
- self-host doc 整備
- Pi5 / homelab 向け install one-liner

### 7.3 根拠

1. **L1 minimum target** が agent-hub の差別化体験(= AI と human の peer mesh)の最小単位、L0 では既存 chat tool と区別不能
2. **公開 hub default** で前提最小化(= Node.js / Docker / Fly.io 不要)、self-host は専用 path
3. **`agenthub` CLI 新規実装** は costly だが、L1 minimum を 1 命令化する value が large(= barrier 削減効果最大)
4. **shell installer + plugin install combo** は Tailscale / mise / k3s で実証済 pattern(`curl ... | sh` + `X up`)
5. **OAuth Device Flow による PAT auto-issue** = user に「PAT scope 選択」を委ねず最小 scope (`read:user`) 強制、security + UX 両立
6. **`~/.anthropic/credentials` reuse** で「API key 2 つ」 friction を「Claude Code 既存ユーザーは 0 個」に削減

### 7.4 反対意見 / 懸念

- **`agenthub` CLI 新規 repo の maintenance burden**: agent-hub-bridge-* 系の維持と並行で 1 repo 追加 = operator burden 増、bridge worker 内部に `--install-installer` flag で integrate する代案あり
- **OAuth Device Flow vs OAuth App**: Device Flow は user が PAT を意識せず token を obtain、ただし GitHub Apps を agent-hub 独自に登録すれば PAT 完全不要(= more proper、Phase 4 候補)
- **public hub への load**: 万人が `curl | sh` で easy onboard すると public hub agent-hub-ki への load 急増、operator 負担 → quota / rate limit / spam ガード 必要。**Launch rollout strategy 推奨**: Phase 1 は **invite-only beta** → **public beta** → **general availability** の 3 stage で段階 release、各 stage で operator load + spam 動向 monitor、必要なら rate limit を tune
- **bridge-claude の M0 status**: Phase 2 着手前に `agent-hub-bridge-claude` の M1 完了(= actual install method 確定)が前提、Phase 2 自体が bridge dev に依存
- **scope creep risk**: 「installer」が ecosystem dependency 全体を抱え込むと scope hugely 越える、各 phase で「何を install するか / 何を install しないか」明示 line 引き必要
- **alternative model**: 「`curl | sh` 排他で `docker run` only」 path 採用すれば前提統一(Docker のみ)、ただし Claude Code との連携設計が別途必要

### 7.4.1 Redline #1 compliance reminder (= @reviewer Suggestion 4 ⭐、2026-05-19)

**Phase 1 / Phase 2 implementation 時の redline #1 compliance check 必須**:

`~/.anthropic/credentials` auto-detect / `~/.bashrc` auto-edit / `~/.config/agent-hub/credentials` 保存等の **設定 fallback design** は、reviewer CLAUDE.md §1 redline #1 (= env var / 設定 未セット時の runtime fallback 禁止) の **「documented optional with default」 exception** に該当する設計判断が要る。

具体 implementation 時の guideline:
- **「未設定 → silently 推測 default 使用」** は redline 違反、`prompt for input` + 「default = X、Enter で accept」 形式が compliant pattern
- **既存 credentials 検出 → silently 上書き** は redline 違反、`detected existing config、override? (y/N)` confirmation 必須
- **shell rc auto-edit** は idempotent + sentinel marker (= `# >>> agent-hub install >>>` block) で **明示 explicit な write** とし、 silent prepend / append は redline 違反

これは ecosystem CLAUDE.md § redline #1 codifier (= @reviewer persona 領域) の guideline であり、Phase 1/2 implementer は実装着手前に reviewer CLAUDE.md §1 literal を読んで compliance verify 推奨。
本 doc が「documented optional with default」 exception を **explicitly invoke する設計** であることは設計 doc 段で明示 declared。

### 7.5 前提

- agent-hub server (= public hub agent-hub-ki) が継続運用される前提(operator @ope-ultp1635 maintained)
- Claude Code が agent-hub 唯一の client であり続ける期間内の設計(= 別 client 出現で見直し)
- gh CLI / Anthropic CLI / Docker 等の **3rd-party 前提 install** は user 側責務として acceptable(= installer 内で auto-install しない、推奨形のみ提示)

## 8. 未調査 / Follow-up 候補

- **Anthropic Claude Code installer 中の Node.js bundling**: 実際に Claude Code が bundled Node.js を持っているか未 verify(= Phase 1 設計時に確認)
- **gh CLI OAuth Device Flow による PAT issue 可否**: `gh auth refresh -h github.com -s read:user` で既存 token を scope 制限可能か(= 検証要)
- **agent-hub-bridge-claude の PyPI publish 計画**: bridge-claude impl peer (@bridge-claude-impl) との coordination 必要、PyPI publish vs binary release を design 段で確定
- **public hub の rate limit / spam 対策**: easy onboard 化で load 急増 → operator burden、別 issue 起票候補
- **CE/PE installer 分岐**: Phase 3 Docker Compose で `compose.community.yml` / `compose.private.yml` の env template 設計、edition-model.md と整合確認
- **PE は GitHub PAT 不要**: PE path は plugin auth が trust mode、Phase 1 installer は LAN PE deploy も別 flag で扱う(`agenthub init --edition=private`)
- **Claude Code 不使用 path (= terminal-only)**: 長期 `agenthub` CLI が direct MCP client 化、Claude Code 依存解消の長期計画(= 別 design doc)
- **5/24 mutual-review 議題候補**: 「minimum installer 設計」 を 5/24 議題に register(= researcher 担当 4 件目候補 = 「framing time-window」 と並列)
- **本 doc レビュー**: implement 着手前に @planner + @agent-hub-impl + @bridge-claude-impl + @reviewer での合議推奨

## 9. 参考資料

### 9.1 内部資料

- agent-hub issue #79: <https://github.com/kishibashi3/agent-hub/issues/79>
- agent-hub `README.md` 「使ってみる」 §「公開 hub を使う場合」 / §「自分で hub を立てる場合」
- agent-hub `docs/architecture.md` §1.2 layer 解説 + §9「始めるには」
- agent-hub `docs/edition-model.md`(CE / PE 区別)
- agent-hub `docs/deployment-pi5.md`(Pi5 deploy 詳細手順)
- `agent-hub-plugins-claude/plugins/agent-hub-plugin/README.md`(plugin setup)
- `agent-hub-bridge-claude/README.md`(bridge worker setup 「予定」)
- agent-hub ADR `docs/decisions/2026-05-18-peer-mesh-architecture-decision.md` §I(Transparent Asymmetry within Symmetric Mesh、minimum 体験の差別化根拠)
- agent-hub `docs/collaboration-model.md`(共在 co-presence operational mechanism)
- agent-hub `docs/landscape.md` §「Operational Features」 (= co-presence / 対等 primitive / MCP native / HITL 溶解)

### 9.2 外部資料 (= 他エコシステム参考事例)

- Tailscale install: <https://tailscale.com/install>
- mise install: <https://mise.run>
- k3s install: <https://docs.k3s.io/quick-start>
- Cloudflared: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/install-and-setup/tunnel-guide/local/>
- gh CLI auth: <https://cli.github.com/manual/gh_auth_login>
- GitHub OAuth Device Flow: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app>
- Anthropic Claude Code: <https://docs.claude.com/en/docs/claude-code>
- Supabase self-host: <https://supabase.com/docs/guides/self-hosting>
- Hasura Docker Compose: <https://hasura.io/docs/latest/getting-started/docker-simple/>
- Coolify install: <https://coolify.io/docs/installation>
- Pi-hole install: <https://docs.pi-hole.net/main/basic-install/>

---

**Refs**: kishibashi3/agent-hub#79
