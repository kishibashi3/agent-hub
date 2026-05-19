# Docker bundle (= issue #95)

agent-hub の **hub server + scheduler** を 1 つの container で起動するための bundle image です。 `docker run` 1 コマンドで minimal-installer flow の step 3 が完結します。

## image source

- registry: `ghcr.io/kishibashi3/agent-hub`
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

## existing fly.io Dockerfile との関係

- `Dockerfile` (= repo root) = **fly.io 向け server-only image**、 既存 deployment 用、 変更なし
- `Dockerfile.bundle` (= 本 file)  = **all-in-one bundle**、 ghcr.io publish 用、 新規追加

backward compat 完全保持、 fly.io deployment は引き続き `flyctl deploy` で動作します。

## 関連

- issue #95 = 本 Docker 化の dispatch origin
- minimal-installer flow (= bridges + roles fork) は `docs/minimum-installer.md` 参照
- bridges / roles は **Docker 外** (= Claude Code session context が必要、 用途別 plugin として host 側 install)
