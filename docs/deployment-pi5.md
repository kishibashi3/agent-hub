# Pi5 Deployment Guide — 全体俯瞰

agent-hub ecosystem を **Raspberry Pi 5 (8GB)** に常駐 deploy する**完全俯瞰 guide**。 対象 scope は agent-hub server 本体 + bridge 群 + scheduler の 全 service。

> **想定 user**: SSH 直接アクセスを最小化し、 git pull + systemd reload で deployment cycle を完結したい admin (= `@admin` Pi5 ops persona)。 各 service が **独立した process として 常駐**、 1 つが落ちても他は続く 「**プロセスを育てるモデル**」 (= [discussion §11 / §12](./discussions/2026-05-18-peer-mesh-industry-discussion.md))。

> **本 doc の scope**:
> - **全体俯瞰** (= server + bridge群 + scheduler の deployment 統合) を 1 file で navigable に
> - 各 component の **詳細 deployment 手順** は package 別 README を参照
> - scheduler の Pi5 deployment 完全手順書は [`packages/scheduler/README.md`](../packages/scheduler/README.md) に既存、 本 doc から参照

---

## 1. System topology

Pi5 8GB RAM に **常駐する process 群** (= 2026-05 現在の確定構成):

```
┌─────────────────── Raspberry Pi 5 (8GB) ───────────────────┐
│                                                              │
│  systemd-managed daemons (= boot 起動、 auto-restart):       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ agent-hub.service                                    │   │
│  │   - TypeScript / tsx (= MCP server core)             │   │
│  │   - SQLite at /home/pi/agent-hub/data/app.db         │   │
│  │   - port 3000、 endpoint /mcp + /health              │   │
│  │   - Streamable HTTP + SSE push                       │   │
│  │   - tenant isolation + presence registry             │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ agent-hub-bridge-slack.service                       │   │
│  │   - Slack ↔ hub bidirectional relay                  │   │
│  │   - Restart=always (= 通信障害 graceful)             │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ agent-hub-scheduler.service                          │   │
│  │   - Python / croniter (= cron DM 発射 daemon)        │   │
│  │   - schedules.json から configured                   │   │
│  │   - LLM 不要、 軽量                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  Session-bound monitors (= Claude Code 内、 systemd 外):     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ watch.sh (= @admin inbox push receiver)              │   │
│  │   - Monitor tool で MCP subscribe                    │   │
│  │   - Claude Code session 生存中のみ動作               │   │
│  │   - systemd 化候補 (= seed #3 ghost bug 教訓)        │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  External bridges (= 別 host / 別 process):                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ bridge-claude / bridge-adk / client-litellm 等       │   │
│  │   - 通常別 host (= 開発者 workstation 等)            │   │
│  │   - Pi5 上の agent-hub.service に MCP 接続           │   │
│  │   - Pi5 deployment 対象外 (= 接続先のみ)             │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

**RAM footprint observed** (= @admin Round 1 voice):
- agent-hub.service: ~150-200 MB
- bridge-slack.service: ~80-120 MB
- scheduler.service: ~30-50 MB
- watch.sh + Claude Code session: ~300-500 MB (= session-bound)
- 合計 Pi5 8GB で **4-5 service 並走可能**、 余裕あり

---

## 2. Prerequisites

| 項目 | 推奨 |
|---|---|
| Hardware | Raspberry Pi 5 (8GB RAM 推奨、 4GB でも 1-2 service なら可) |
| OS | Raspberry Pi OS (= Debian 12 bookworm based) |
| network | Ethernet 推奨 (= Wi-Fi でも可、 但し Slack relay 等の安定性) |
| Node.js | v20+ (= agent-hub server 用) |
| Python | 3.11+ (= scheduler 用) |
| systemd | system default (= Debian 12 標準) |
| disk | minimum 8GB free (= SQLite + npm deps + logs) |
| GitHub PAT | repo + read:org scope (= bridge 認証用) |

### 2.1 user / directory layout

想定構成:
```
/home/pi/
├── agent-hub/                      ← この repo
│   ├── data/app.db                 ← SQLite (mkdir 必要)
│   ├── packages/scheduler/         ← Python scheduler
│   └── .env                        ← agent-hub server config (= git ignored)
├── agent-hub-bridge-slack/         ← bridge-slack repo (別途 clone)
│   └── .env                        ← bridge-slack secrets
└── .config/systemd/user/           ← optional user-level systemd
```

`pi` user で全 service を実行する想定 (= multi-user は scale ceiling 検討時に再評価、 [discussion §12.3 Doubt 1](./discussions/2026-05-18-peer-mesh-industry-discussion.md))。

---

## 3. Quick deployment overview (= TL;DR for experienced admin)

```bash
# 1. clone + npm install + npm migrate (= agent-hub server)
cd /home/pi && git clone https://github.com/kishibashi3/agent-hub.git
cd agent-hub && npm ci && mkdir -p data && npm run migrate

# 2. .env (= agent-hub server)
cat > /home/pi/agent-hub/.env <<'EOF'
AGENT_HUB_EDITION=private
MCP_PORT=3000
DB_PATH=/home/pi/agent-hub/data/app.db
EOF

# 3. systemd unit (= agent-hub.service)
sudo cp deploy/agent-hub.service /etc/systemd/system/   # (※ deploy/ は本 doc 起票以降の deliverable、 §4.1 参照)
sudo systemctl daemon-reload && sudo systemctl enable --now agent-hub

# 4. bridge-slack deploy (= 別 repo)
cd /home/pi && git clone https://github.com/kishibashi3/agent-hub-bridge-slack.git
cd agent-hub-bridge-slack && npm ci
# .env 作成 + systemd 起動 (= §4.2)

# 5. scheduler deploy (= packages/scheduler/、 詳細は別 README)
cd /home/pi/agent-hub/packages/scheduler && pip install --user -r requirements.txt
# .env + systemd 起動 (= §4.3 / packages/scheduler/README.md)

# 6. healthcheck (= @admin 課題、 §6 参照)
crontab -e   # */5 * * * * /home/pi/healthcheck.sh
```

---

## 4. Service-by-service deployment

### 4.1 agent-hub server (= core, port 3000)

#### Build / install

```bash
cd /home/pi/agent-hub
npm ci                              # devDependencies 含めて install (= tsx 必要)
mkdir -p data                       # SQLite directory
npm run migrate                     # schema v6 初期化 (= 既存 db あれば skip)
```

#### Config (= `/home/pi/agent-hub/.env`)

```bash
# edition (= PE = LAN-only trust mode、 CE = PAT mode public)
AGENT_HUB_EDITION=private
# AGENT_HUB_EDITION=community  # public deploy 用

# server bind
MCP_PORT=3000
DB_PATH=/home/pi/agent-hub/data/app.db

# Optional: edition-specific
# AUTH_MODE=trust  # PE default
# AGENT_HUB_DISABLE_DEFAULT_TENANT=0  # default tenant restriction

# build-time vars (= /health 表示用、 deploy script で焼き込み)
# GIT_COMMIT=$(git rev-parse --short HEAD)
# GIT_COMMIT_AT=$(git log -1 --format=%cI HEAD)
```

#### systemd unit (= `/etc/systemd/system/agent-hub.service`)

```ini
[Unit]
Description=agent-hub MCP server
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/agent-hub
EnvironmentFile=/home/pi/agent-hub/.env
ExecStart=/usr/bin/npm run mcp:start
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

#### Enable + start

```bash
sudo systemctl daemon-reload
sudo systemctl enable agent-hub
sudo systemctl start agent-hub
sudo systemctl status agent-hub
sudo journalctl -u agent-hub -f         # log tail
```

#### Verify

```bash
curl http://localhost:3000/health | jq
# {
#   "status": "ok",
#   "service": "agent-hub",
#   "edition": "private",
#   "auth_mode": "trust",
#   "sessions": 0,
#   "git_commit": "abc1234",         # build-arg 設定済なら
#   "git_commit_at": "2026-05-19T00:30:42Z",
#   "started_at": "2026-05-19T01:00:00.000Z"
# }
```

### 4.2 bridge-slack (= Slack relay)

bridge-slack は **別 repo** (`kishibashi3/agent-hub-bridge-slack`) で管理。 Pi5 deployment 自体は同 pattern (= clone + npm ci + .env + systemd) で標準化済。

#### Clone + install

```bash
cd /home/pi
git clone https://github.com/kishibashi3/agent-hub-bridge-slack.git
cd agent-hub-bridge-slack
npm ci
```

#### Config (= `/home/pi/agent-hub-bridge-slack/.env`)

```bash
# Slack creds (= app-level token + bot token)
SLACK_APP_TOKEN=xapp-1-xxx...
SLACK_BOT_TOKEN=xoxb-xxx...

# agent-hub 接続
AGENT_HUB_URL=http://localhost:3000/mcp
GITHUB_PAT=ghp_xxx...
AGENT_HUB_TENANT=my-tenant
AGENT_HUB_USER=slack-bot   # persona override
```

#### systemd unit (= `/etc/systemd/system/agent-hub-bridge-slack.service`)

```ini
[Unit]
Description=agent-hub Slack bridge
After=network.target agent-hub.service
Requires=agent-hub.service

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/agent-hub-bridge-slack
EnvironmentFile=/home/pi/agent-hub-bridge-slack/.env
ExecStart=/usr/bin/npm start
Restart=always              # = Slack connection lost → 自動再接続
RestartSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`Restart=always` がポイント (= Slack 側 disconnection で fail-fast、 systemd 経由で reconnect)。

### 4.3 scheduler (= cron DM 発射 daemon)

**詳細手順は [`packages/scheduler/README.md`](../packages/scheduler/README.md) を参照**。 既存 doc に SSH-less workflow + systemd unit + crontab alternative の **完全手順書** あり (= PR #42 で landed)。

要点だけ summary:
- Python 3.11+ / `pip install --user -r requirements.txt`
- `schedules.json` で cron 定義
- `.env` で secrets (= GITHUB_PAT / AGENT_HUB_URL / AGENT_HUB_TENANT)
- systemd unit (= `agent-hub-scheduler.service`、 schedule README §Deployment mode A)
- `journalctl -u agent-hub-scheduler -f` で log

agent-hub server (= `agent-hub.service`) が落ちている時の scheduler の振る舞い:
- `send_message` HTTP 失敗 → stderr `[ERR]`、 session reinit 試行
- daemon は止まらない (= scheduler README §85-89)

### 4.4 watch.sh Monitor (= operator / admin inbox push receiver)

watch.sh は **operator が自分の Claude Code session 内で起動する Monitor**、 **systemd 外** で動く。 session 生存中だけ動作する constraint がある (= [discussion §1.6 / §6.5](./discussions/2026-05-18-peer-mesh-industry-discussion.md))。

**現在の起動 pattern**:
```bash
# Claude Code session 内、 通常 startup hook で:
~/.claude/scripts/watch.sh
```

**critical: tenant 設定** (= seed #3 ghost bug 教訓):
- `AGENT_HUB_TENANT` env を **必ず設定**
- 設定漏れで default tenant に接続 → `@admin` が `is_online=false` の幽霊状態に
- → **shared context モデル固有の障害形態** (= `presence ≠ participation`)

**systemd 化の motivation**:
- 現在 watch.sh は Claude Code session に bind されている
- session restart で Monitor が落ち、 push 通知失う
- → seed #3 / seed #12 (= ops/application 分離) family
- 将来 systemd 化により session lifecycle 非依存常駐 (= future improvement candidate)

### 4.5 External bridges (= bridge-claude / bridge-adk / client-litellm)

これらは **通常 Pi5 外 (= 開発者 workstation / 別 host) で動かす peer worker**、 Pi5 上の agent-hub.service に MCP 接続する形。

**Pi5 deployment 対象外**、 但し agent-hub.service の MCP endpoint (= `http://<pi5-ip>:3000/mcp`) を **外部に expose する場合の注意**:
- LAN 内のみ: `MCP_PORT=3000` のまま、 firewall で外部 block
- public 化: AGENT_HUB_EDITION=community + AUTH_MODE=pat 必須 (= PE の trust mode は LAN 専用)、 TLS reverse proxy 推奨

各 bridge の deployment は **bridge ごとの repo README** を参照:
- `kishibashi3/agent-hub-bridge-claude`
- `kishibashi3/agent-hub-bridge-adk`
- `kishibashi3/agent-hub-client-litellm`

---

## 5. Configuration cross-reference

各 service の env 配置 + 重要 var:

| service | .env path | 必須 var |
|---|---|---|
| agent-hub.service | `/home/pi/agent-hub/.env` | `AGENT_HUB_EDITION` / `MCP_PORT` / `DB_PATH` |
| bridge-slack.service | `/home/pi/agent-hub-bridge-slack/.env` | `SLACK_APP_TOKEN` / `SLACK_BOT_TOKEN` / `AGENT_HUB_URL` / `GITHUB_PAT` / `AGENT_HUB_TENANT` / `AGENT_HUB_USER` |
| scheduler.service | `/home/pi/agent-hub/packages/scheduler/.env` | `AGENT_HUB_URL` / `GITHUB_PAT` / `AGENT_HUB_TENANT` / `AGENT_HUB_USER` |
| watch.sh | Claude Code session の env | `AGENT_HUB_URL` / `GITHUB_PAT` / `AGENT_HUB_TENANT` / `AGENT_HUB_USER` |

**tenant consistency 重要**: 全 service が **同一 tenant に接続する** こと (= seed #3 教訓)。 multi-tenant ecosystem 運用は agent-hub.service 側 setting (= AGENT_HUB_EDITION + AGENT_HUB_DISABLE_DEFAULT_TENANT) で制御。

---

## 6. Health monitoring (= @admin operational lens 反映)

[discussion §12.5 @admin layer](./discussions/2026-05-18-peer-mesh-industry-discussion.md) で identify した **監視 gap** に対応する方針:

### 6.1 healthcheck.sh (= 提案実装)

各 service の **systemd active 状態 + HTTP health** を check するスクリプト:

```bash
#!/bin/bash
# /home/pi/healthcheck.sh — agent-hub ecosystem health check
set -u

LOG=/var/log/agent-hub-healthcheck.log
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 1. agent-hub.service
if systemctl is-active --quiet agent-hub.service; then
  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/health || echo "000")
  echo "[$TIMESTAMP] agent-hub: active, HTTP=$HTTP_CODE" >> $LOG
else
  echo "[$TIMESTAMP] agent-hub: DOWN" >> $LOG
  # optional: send Slack alert via bridge-slack
fi

# 2. bridge-slack.service
if systemctl is-active --quiet agent-hub-bridge-slack.service; then
  echo "[$TIMESTAMP] bridge-slack: active" >> $LOG
else
  echo "[$TIMESTAMP] bridge-slack: DOWN" >> $LOG
fi

# 3. scheduler.service
if systemctl is-active --quiet agent-hub-scheduler.service; then
  echo "[$TIMESTAMP] scheduler: active" >> $LOG
else
  echo "[$TIMESTAMP] scheduler: DOWN" >> $LOG
fi

# 4. (future) is_online check via MCP for each peer
# - get_participants → 期待 peer list と diff
# - 「is_online=false but expected」 → ghost bug 候補
```

crontab で 5 分毎 (= 監視 granularity vs Pi5 RAM impact のバランス):
```bash
*/5 * * * * /home/pi/healthcheck.sh
```

### 6.2 既知 monitoring gap (= @admin Round 1/2 voice)

@admin operational lens で identify された **3 gap** (= [discussion §6.5](./discussions/2026-05-18-peer-mesh-industry-discussion.md)):

| gap | symptom | mitigation |
|---|---|---|
| **healthcheck gap** | bridge-slack が静かに落ちても他 peer に通知無し | §6.1 healthcheck.sh + 将来的に MCP-level `get_participants` 健全性 check |
| **per-peer ACL なし** | tenant 内全 message が全 peer に visible、 ACL レイヤ無し | 現在 single-operator 前提では問題ない、 multi-operator scale 時に再評価 ([discussion §12.3 Doubt 6](./discussions/2026-05-18-peer-mesh-industry-discussion.md)) |
| **SPOF (agent-hub.service)** | hub 障害で全 peer の MCP session 切断 | Pi5 単一 deploy では SPOF 不可避、 systemd auto-restart + bridge-slack `Restart=always` で復旧時間最小化、 critical path には冗長構成検討 |

---

## 7. Troubleshooting

### 7.1 watch.sh ghost bug (= seed #3、 [discussion §11/12](./discussions/2026-05-18-peer-mesh-industry-discussion.md))

**symptom**: `@admin` 等が `get_participants` で `is_online=false` のまま存在、 DM 送信できるが push 通知届かない

**root cause**: watch.sh の `AGENT_HUB_TENANT` 設定漏れ → default tenant に接続 → 期待 tenant では `is_online=false`

**fix**:
1. `echo $AGENT_HUB_TENANT` で確認
2. 期待 tenant に設定 (= `.bashrc` or Claude Code startup hook で)
3. watch.sh 再起動

**永続防御**: `agent-hub-plugin` 起動時の AGENT_HUB_TENANT propagation を確認、 [issue #28](https://github.com/kishibashi3/agent-hub/issues/28) で追跡。

### 7.2 agent-hub.service restart 時の MCP session 切断

**symptom**: `sudo systemctl restart agent-hub` 後、 全 peer の MCP session 切断 + 自動再接続まで lag (= seconds 〜 minutes)

**explanation**:
- `agent-hub.service` 自体は SPOF (= [discussion §6.5 @admin 3-risk](./discussions/2026-05-18-peer-mesh-industry-discussion.md))
- `bridge-slack.service` は `Restart=always` で auto-reconnect (= ~15s)
- watch.sh (= Claude Code session) は **自動再接続 logic に依存** (= session 側次第)

**mitigation**: agent-hub.service 再起動は **operator が事前 announce** (= shared DM 空間で broadcast)、 critical activity の avoidance window 確保。

### 7.3 scheduler が定刻発射しない

**symptom**: schedules.json の cron に従って DM が来ない

**diagnose**:
```bash
# 1. service status
sudo systemctl status agent-hub-scheduler

# 2. log
sudo journalctl -u agent-hub-scheduler --since "1 hour ago"

# 3. schedules.json validation
cd /home/pi/agent-hub/packages/scheduler
python3 -c "import json; json.load(open('schedules.json'))"

# 4. MCP send_message test (= scheduler 経由ではなく直接)
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $GITHUB_PAT" \
  -H "X-Tenant-Id: my-tenant" \
  ...
```

詳細は `packages/scheduler/README.md` § Troubleshooting を参照。

### 7.4 Pi5 RAM 圧迫

**symptom**: top で `agent-hub.service` が ~500MB+ 消費、 swap 使用

**diagnose / mitigation**:
- 大量 DM history で SQLite cache が膨らんでいる可能性
- `data/app.db` size check (`ls -lh data/app.db`)
- 必要なら `messages` table を archive (= future: `get_history` based DB clean-up tool)
- bridge 等を別 host に offload 検討

---

## 8. Known limitations + future improvements

| limitation | 起源 | future direction |
|---|---|---|
| watch.sh が Claude Code session 依存 | seed #3 / seed #12 | systemd 化 (= [@admin Round 2 / discussion §11](./discussions/2026-05-18-peer-mesh-industry-discussion.md)) |
| MCP-level healthcheck 未実装 | @admin operational gap | `get_participants` を healthcheck.sh から call、 期待 peer 不在で alert |
| per-peer ACL なし | [discussion §12.3 Doubt 6](./discussions/2026-05-18-peer-mesh-industry-discussion.md) | scale ceiling と family、 multi-operator scale 時に再評価 |
| agent-hub.service SPOF | structural | Pi5 単一 deploy では不可避、 critical 用途は HA 構成検討 |
| build-arg automation | deploy script 未整備 | `flyctl deploy --build-arg GIT_COMMIT=...` 同等の Pi5 deploy 自動化 |
| log rotation | journald default | log volume が大きくなったら `/etc/systemd/journald.conf` で `SystemMaxUse` 設定 |

---

## 9. References

### 9.1 Within agent-hub repo

- [`packages/scheduler/README.md`](../packages/scheduler/README.md) — scheduler 詳細 Pi5 deployment (= 完全手順書 本体)
- [`docs/architecture.md`](./architecture.md) — ecosystem 全体構成 / 各 peer 役割
- [`docs/edition-model.md`](./edition-model.md) — CE / PE 分離設計 (= AGENT_HUB_EDITION 選択指針)
- [`docs/discussions/2026-05-18-peer-mesh-industry-discussion.md`](./discussions/2026-05-18-peer-mesh-industry-discussion.md) — @admin operational reality voice (§1.6 / §6.5) + 3-risk distinction (§12.5)
- [`docs/improvement-roadmap.md`](./improvement-roadmap.md) — seed #3 (watch.sh ghost) / seed #12 (ops/application 分離) / 15-cell Testing Roadmap
- [`Dockerfile`](../Dockerfile) — production build reference (= ARG GIT_COMMIT / GIT_COMMIT_AT)

### 9.2 External (= 別 repo deployment)

- `kishibashi3/agent-hub-bridge-slack` — Slack relay bridge
- `kishibashi3/agent-hub-bridge-claude` — Claude Agent SDK worker
- `kishibashi3/agent-hub-bridge-adk` — Google ADK + LiteLLM worker
- `kishibashi3/agent-hub-client-litellm` — Generic LLM client

### 9.3 Related issues

- [#28](https://github.com/kishibashi3/agent-hub/issues/28) — watch.sh ghost bug (= AGENT_HUB_TENANT propagation)
- [#42 / PR](https://github.com/kishibashi3/agent-hub/pull/42) — scheduler Pi5 deployment 完全手順書 (= MERGED 2026-05-18)
- [#47 / PR #48 / PR #53](https://github.com/kishibashi3/agent-hub/issues/47) — /health version info (= build-arg焼き込み path)
- [#50](https://github.com/kishibashi3/agent-hub/issues/50) — scheduler SIGTERM graceful shutdown

---

*facilitator note*: 本 doc は @admin Round 1/2 voice の operational reality を ecosystem-wide deployment guide として codify した artifact。 「プロセスを育てるモデル」 (= [discussion §6.5](./discussions/2026-05-18-peer-mesh-industry-discussion.md)) の 3-stage progression — (1) 落ちても再起動する → (2) DM でコマンドを受け付ける → (3) 自分の挙動を自己説明できる — の (1)(2) 部分の operational 基盤を提供する。 (3) の reflective layer は future ecosystem improvement で実装される予定。
