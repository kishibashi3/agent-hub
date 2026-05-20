# Docker bundle + dashboard (= issue #95 + 2026-05-20 dashboard sidecar)

agent-hub の **hub server + scheduler + dashboard** を Docker で起動するための image 群です。 `docker run` 1 コマンド (bundle のみ) または `docker-compose up -d` (bundle + dashboard) で minimal-installer flow の step 3 が完結します。

## image source

agent-hub の 公開 Docker image は **2 種類**:

| image | 内容 | port |
|---|---|---|
| `ghcr.io/kishibashi3/agent-hub:latest` | **bundle** (= MCP server + Python scheduler、 supervisord で並走) | 3000 (/mcp, /health) |
| `ghcr.io/kishibashi3/agent-hub-dashboard:latest` | **dashboard sidecar** (= message traffic visualizer、 SQLite DB を read-only mount) | 8080 (/) |

両 image とも:
- default tag: `:latest` (= main branch push 時に自動更新)
- version tag: `:v1.2.3` (= semver tag push 時に併設、 rollback 用)
- commit tag: `:main-<sha7>` (= main 各 commit 用 rollback tag)

## 構成

| process | runtime | role |
|---|---|---|
| `agent-hub-server` | Node.js 20 | MCP HTTP endpoint (= `:3000/mcp`, `:3000/health`) |
| `agent-hub-scheduler` | Python 3 (venv) | cron-based DM scheduler + inbox commands listener |
| `supervisord` | PID 1 | 上記 2 process の lifecycle / restart 管理 |

server と scheduler は **同 storage volume** (= `/app/data`) を共有し、 SQLite DB + `schedules.json` を保持。

## 起動方法

### 方式 1: `docker run` (= 最小コマンド)

```bash
docker run -d \
  --name agent-hub \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e GITHUB_PAT=ghp_xxx \
  ghcr.io/kishibashi3/agent-hub:latest
```

### 方式 2: `docker-compose` (= 推奨、 environment 管理が楽)

repo に同梱の `docker-compose.yml` を使用:

```bash
# .env ファイルに認証情報を記載
cat > .env <<EOF
GITHUB_PAT=ghp_xxx
AGENT_HUB_TENANT=mytenant
AGENT_HUB_EDITION=community
AUTH_MODE=pat
EOF

# 起動
docker-compose up -d

# log tail
docker-compose logs -f

# 停止
docker-compose down
```

## 環境変数

| 変数 | default | scope | 用途 |
|---|---|---|---|
| `GITHUB_PAT` | (unset) | scheduler 認証 | GitHub PAT (read:user) — pat mode 推奨 |
| `AGENT_HUB_USER` | (unset) | scheduler 認証 | handle override (trust mode は localhost only) |
| `AGENT_HUB_TENANT` | (unset → default) | scheduler + client | CE multi-tenant の tenant 識別子 |
| `AGENT_HUB_URL` | `http://localhost:3000/mcp` | scheduler client | server endpoint (= bundle 内 default、 通常不変) |
| `AGENT_HUB_EDITION` | `community` | server | `community` / `private` / `enterprise` |
| `AUTH_MODE` | `pat` (= edition 依存) | server | `pat` / `trust` (= trust は localhost only) |
| `AGENT_HUB_GITHUB_ORG` | (unset) | server | pat mode で GitHub Org membership 検証 |
| `MCP_PORT` | `3000` | server | server listen port (= 通常不変) |
| `DB_PATH` | `/app/data/app.db` | server | SQLite DB file path (= 通常不変、 volume mount 側で永続化) |
| `SCHEDULER_CONFIG` | `/app/data/schedules.json` | scheduler | schedules.json path (= 通常不変) |

## health check

container 内蔵の HEALTHCHECK は `:3000/health` を 30 秒間隔で叩きます。 `docker ps` で `(healthy)` 表示。

```bash
curl http://localhost:3000/health
# → {"status":"ok","service":"agent-hub","edition":"community","auth_mode":"pat",...}
```

`edition` / `auth_mode` の `null` は redline #1 の signal (= server 起動時 edition resolve 失敗、 buggy build の可能性)。 詳細は `docs/edition-model.md` 参照。

## scheduler 操作 (= 一度起動後)

bundle 内 scheduler は agent-hub server に自身を peer として `register` し、 inbox の DM コマンドに応答します:

```
# DM via Claude Code MCP client or curl:
ping        → pong (scheduler alive, N schedules total)
list        → sender's entries 一覧
list all    → 全 entries (= cross-owner、 issue #85)
add ...     → cyclic schedule 追加
run_at ...  → one-shot schedule 追加
run_in ...  → one-shot (= 相対時間)
delete <name>  → 自身の entry 削除
run now <name> → 即時 fire
```

詳細は `packages/scheduler/README.md` 参照。

## persistent data

`/app/data` を host volume にマウントしてください:

- `/app/data/app.db` — SQLite DB (= participants / messages / teams / read_receipts)
- `/app/data/schedules.json` — scheduler の cron schedule 設定 + sender 単位 ownership

container 再作成しても data が消えないように、 **必ず volume mount してください**。

## dashboard sidecar (= 2026-05-20 admin feature request + issue #103 expansion)

`agent-hub-dashboard` は **process monitor for peer mesh** (= top/ps/netstat 相当の runtime observability surface、 issue #103 framing)。 hub の SQLite DB を read-only mount で参照し、 **5 MVP views** を提供。 Python stdlib のみで動作 (= sqlite3 + http.server)、 外部 deps なし。

### 起動方法

`docker-compose.yml` に dashboard service が同梱されているので、 bundle と一緒に起動できます:

```bash
docker-compose up -d
# → agent-hub (port 3000) + agent-hub-dashboard (port 8080) 両方起動
```

ブラウザで `http://localhost:8080` を開くと、 上部の **nav bar が 2 group に分割** されて 5 view を提供 (= 2026-05-20 Mesh/Matrix 分離後):

```
nav-bar:  overview │ [Mesh]  [Matrix]  [Timeline]  [Link List]   ┃   drill-down │ [Agent Detail]
```

- **overview group** (= 全体構造を観察): mesh / matrix / timeline / link list の 4 view、 ecosystem を 4 つの異なる角度 (graph / heatmap / time / pair list) から把握
- **drill-down group** (= 個別観察): agent detail、 mesh / link list 上の handle click で navigate。 `?view=agent` を handle 無しで URL 直打ちした場合は default route (= Mesh) に **302 redirect** (= 「@unknown」 ghost page を表示しない)

#### Overview 1: Mesh (= default、 `/`)
- D3 force-directed network graph (= agents = 球体、 teams = ひし形、 edges = message count に比例した curved line + drift animation)
- header の **drift slider** で animation 強度調整 (= mesh view 専用、 他 view では auto hide)
- node を click すると Agent Detail (= drill-down) に navigate

#### Overview 2: Matrix (= `/?view=matrix`)
- sender × recipient メッセージ頻度 heatmap (= 上位 14 名)
- cell 色濃度が message count 比率、 hover で正確 count + from/to 表示
- 「誰と誰の DM が活発か」 を一覧把握

#### Overview 3: Timeline (= `/?view=timeline`)
- 時間軸 message volume の D3 bar chart
- range selector: 24h (hourly bucket) / 7d (hourly) / 30d (daily)
- tooltip で各 bucket の正確 count

#### Overview 4: Link List (= `/?view=links`)
- 強リンク ranking (= bidirectional aggregate、 top 50)
- `@planner ↔ @reviewer: 75` 形式表示 + 方向別内訳 (`a→b` / `b→a`)
- bar visualization + handle click で Agent Detail へ

#### Drill-down: Agent Detail (= `/?view=agent&agent=@<handle>`)
- 個別 agent の詳細 (= total / received in / sent out / distinct peers / type (= mode) / last active / tenants active in)
- Top peers list (= bidirectional message count、 click で同 detail page 遷移)
- Mesh view ノードや Link List から click で navigate (= handle 未指定で直接 navigation すると default route に 302 redirect、 nav bar 上は disabled state + tooltip 動線 hint)

### dashboard 用環境変数

| 変数 | default | 用途 |
|---|---|---|
| `DB_PATH` | `/app/data/app.db` | SQLite DB file path (= bundle と shared volume mount) |
| `PORT` | `8080` | dashboard listen port |
| `AGENT_HUB_TENANT` | (unset → **全 tenant aggregate**) | 特定 tenant のみ filter する場合に set。 unset で全 tenant 合算 view |

### dashboard 単独起動 (= bundle なしで他 hub に向ける場合)

```bash
docker run -d \
  -p 8080:8080 \
  -v /path/to/agent-hub/data:/app/data:ro \
  -e AGENT_HUB_TENANT=kaz \
  ghcr.io/kishibashi3/agent-hub-dashboard:latest
```

`:ro` mount で **dashboard が誤って書き込む可能性を eliminate**。 SQLite WAL mode で hub server (writer) と並行 read 安全。

## existing fly.io Dockerfile との関係

- `Dockerfile` (= repo root) = **fly.io 向け server-only image**、 既存 deployment 用、 変更なし
- `Dockerfile.bundle` = **all-in-one bundle** (= server + scheduler)、 ghcr.io publish 用
- `packages/dashboard/Dockerfile` = **dashboard sidecar**、 ghcr.io 別 image として publish

backward compat 完全保持、 fly.io deployment は引き続き `flyctl deploy` で動作します。

## 関連

- issue #95 = 本 Docker 化の dispatch origin
- dashboard sidecar = @admin (Pi5 ops) DM 起源 (= 2026-05-20)
- minimal-installer flow (= bridges + roles fork) は `docs/minimum-installer.md` 参照
- bridges / roles は **Docker 外** (= Claude Code session context が必要、 用途別 plugin として host 側 install)
