# agent-hub scheduler

cron-based DM scheduler as agent-hub package (= [issue #40](https://github.com/kishibashi3/agent-hub/issues/40))。 軽量 Python daemon、 `schedules.json` の cron 設定に従って agent-hub 参加者に DM を送る。

LLM 不要、 Pi5 で agent-hub server と並走想定。

## 使い方

### 1. install

```bash
cd packages/scheduler
pip install -r requirements.txt
```

依存:
- `croniter` (= cron 式評価)
- `requests` (= MCP HTTP client)

### 2. 設定

`schedules.json` を編集:

```json
[
  {
    "cron": "0 13 * * *",
    "to": "@planner",
    "message": "daily report を書いてください"
  },
  {
    "cron": "*/30 * * * *",
    "to": "@reviewer",
    "message": "新規 PR の queue を確認"
  }
]
```

- `cron`: 標準 cron 式 (= `分 時 日 月 曜日`)
- `to`: agent-hub 参加者 (`@handle`) or team (`@team-name`)
- `message`: DM 本文

`cron` 式は [croniter](https://github.com/kiorky/croniter) の syntax (= standard 5-field) を使用。

設定 file path は `$SCHEDULER_CONFIG` で override 可能 (= default `packages/scheduler/schedules.json`)。

### 3. 起動

```bash
# PAT mode (= 推奨、 production)
export AGENT_HUB_URL=http://localhost:3000/mcp
export GITHUB_PAT=ghp_xxx...
export AGENT_HUB_TENANT=my-tenant       # optional
python scheduler.py

# Trust mode (= localhost 開発用、 server-side AUTH_MODE=trust が前提)
export AGENT_HUB_URL=http://localhost:3000/mcp
export AGENT_HUB_USER=alice
python scheduler.py
```

## 環境変数

| 変数 | default | 用途 |
|---|---|---|
| `AGENT_HUB_URL` | `http://localhost:3000/mcp` | MCP endpoint URL |
| `GITHUB_PAT` | (unset) | GitHub Personal Access Token、 pat mode 用 (= 推奨) |
| `AGENT_HUB_USER` | (unset) | handle 名 (trust mode で識別、 pat mode で handle override) |
| `AGENT_HUB_TENANT` | (unset → `default`) | tenant 識別子 (CE 接続時) |
| `SCHEDULER_CONFIG` | `./schedules.json` | 設定 file path override |

認証 mode:
- **PAT mode (推奨)**: `GITHUB_PAT` を設定 → GitHub login を handle として認証。 `AGENT_HUB_USER` も併設で multi-persona override
- **Trust mode (= localhost 開発用)**: `AGENT_HUB_USER` のみ設定、 server-side `AUTH_MODE=trust` 必要

## 動作

1. **起動時**: `schedules.json` を読込 + validate + MCP session init
2. **schedule loop**: 各 entry の **次の fire time** を croniter で計算、 最も近い fire time まで sleep
3. **fire 時**: `send_message` MCP tool を call → 次の fire time を再計算
4. **エラー時**: session 切断等で send 失敗時、 自動 session reinit (= 60 秒後に再試行)

## エラーハンドリング

- **JSON parse error**: stderr に `[ERR]` + exit 1
- **必須 field 欠落** (`cron` / `to` / `message`): 同上
- **invalid cron expression**: 同上
- **MCP session init 失敗**: 同上
- **send_message 失敗**: stderr に `[ERR]`、 session reinit 試行 (= daemon は止まらない)
- **SIGINT (Ctrl-C)**: graceful shutdown

## Pi5 deployment

agent-hub server と並走させる Pi5 deployment の **完全手順書**。 想定 user は **SSH 直接アクセスなしで Pi5 を運用する admin** (= `@admin` Pi5 ops persona 想定)、 git pull + systemd / crontab reload で deployment cycle を完結する workflow。

### Pi5 setup 手順 (= 初回 deployment)

#### 1. リポジトリ clone

Pi5 上で agent-hub repo を `/home/pi/agent-hub/` に clone (= 既 clone 済の場合 skip):

```bash
cd /home/pi
git clone https://github.com/kishibashi3/agent-hub.git
cd agent-hub
```

#### 2. 依存 install

`packages/scheduler/` に移動して dependencies install:

```bash
cd /home/pi/agent-hub/packages/scheduler
pip install --user -r requirements.txt
```

`--user` で system Python に影響せず、 `~/.local/lib/python3.x/site-packages/` に install。 venv 使う場合は別途 venv 設定。

#### 3. schedules.json 配置

`packages/scheduler/schedules.json` を本番 schedule で編集:

```bash
nano /home/pi/agent-hub/packages/scheduler/schedules.json
```

[初期設定例](#schedulesjson-初期設定例) を参考に entry を追加。 git tracked file なので **`.gitignore` 追加 検討** (= local production config を public repo に含めたくない場合)、 or **本番 secrets 含まない form で commit** で main を update する flow も可。

#### 4. 環境変数 設定 (= secrets)

`/home/pi/agent-hub/packages/scheduler/.env` を作成 (= git ignored、 secrets 専用):

```bash
# /home/pi/agent-hub/packages/scheduler/.env
AGENT_HUB_URL=http://localhost:3000/mcp
GITHUB_PAT=ghp_xxx...
AGENT_HUB_TENANT=my-tenant
AGENT_HUB_USER=scheduler   # optional, multi-persona override
```

(systemd / crontab 両 deployment mode で env file source として利用、 下記参照)

### Deployment mode 比較

Pi5 deployment は **2 つの mode** から選択可能:

| mode | 推奨 case | pros | cons |
|---|---|---|---|
| **systemd service** (推奨) | production daemon、 自動再起動必要 | auto-restart on failure、 `journalctl` logs、 boot 起動 | systemd familiarity 必要 |
| **crontab @reboot** | simple deploy、 systemd 不要環境 | minimal config、 cron only | restart 自動再起動 logic 別途必要 |

両 mode とも **schedules.json の cron 評価は scheduler.py 自身が実行** (= 「scheduler を起動する method」 と 「schedules.json の cron 実行」 は別 layer)。

### Deployment mode A: systemd service (推奨)

#### service unit 作成

```ini
# /etc/systemd/system/agent-hub-scheduler.service
[Unit]
Description=agent-hub DM scheduler
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/agent-hub/packages/scheduler
EnvironmentFile=/home/pi/agent-hub/packages/scheduler/.env
ExecStart=/usr/bin/python3 scheduler.py
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

#### enable + start

```bash
sudo systemctl daemon-reload
sudo systemctl enable agent-hub-scheduler   # boot 時自動起動
sudo systemctl start agent-hub-scheduler    # 即起動
sudo systemctl status agent-hub-scheduler   # 状態確認
```

#### log 確認

```bash
sudo journalctl -u agent-hub-scheduler -f             # tail
sudo journalctl -u agent-hub-scheduler --since today  # 本日分
```

### Deployment mode B: crontab @reboot

systemd alternative、 cron で scheduler プロセスを起動 (= scheduler.py 自身は内部 cron loop)。

#### crontab 登録

`pi` user の crontab 編集:

```bash
crontab -e
```

以下を追加:

```cron
# agent-hub scheduler: Pi5 boot 時に起動 + 環境変数 source + logging
@reboot cd /home/pi/agent-hub/packages/scheduler && set -a && . ./.env && set +a && /usr/bin/python3 scheduler.py >> /home/pi/agent-hub-scheduler.log 2>&1
```

- `@reboot`: Pi5 boot 時 1 回起動
- `set -a && . ./.env && set +a`: `.env` を環境変数として source (= `EnvironmentFile` の cron 相当)
- `>> /home/pi/agent-hub-scheduler.log 2>&1`: stdout / stderr を log file に append

#### 確認 + 起動

```bash
# 登録確認
crontab -l

# 即起動 (= reboot 待たない手動 trigger)
cd /home/pi/agent-hub/packages/scheduler && set -a && . ./.env && set +a && nohup python3 scheduler.py >> /home/pi/agent-hub-scheduler.log 2>&1 &

# log 確認
tail -f /home/pi/agent-hub-scheduler.log
```

#### crontab mode の crash recovery 制限

`@reboot` cron は **scheduler が crash した場合 自動再起動しない** (= systemd `Restart=on-failure` 相当機能なし)。 自動再起動が必要なら以下追加:

```cron
# 5 分ごと scheduler が生きてるか check + 復活
*/5 * * * * pgrep -f 'scheduler.py' >/dev/null || (cd /home/pi/agent-hub/packages/scheduler && set -a && . ./.env && set +a && nohup python3 scheduler.py >> /home/pi/agent-hub-scheduler.log 2>&1 &)
```

→ daemon-style auto-recovery が必要なら **systemd mode 推奨** (= 上記 watch-cron は best-effort)。

### SSH-less deployment workflow (= Pi5 への SSH 直接アクセスなし運用)

Pi5 への SSH 直接アクセスを想定しない場合の deployment cycle:

#### 初期 deployment (= 1 回限り、 admin 経由)

1. **agent-hub-knowledge / planner repo 経由 で deployment notice issue 起票**: 「Pi5 で scheduler deploy 要請」 + 本 README の Pi5 setup 手順 reference
2. **@admin (= Pi5 ops persona) が手元で実行**: 上記 「Pi5 setup 手順」 1-4 + 「Deployment mode A or B」 を遂行
3. **deployment 完了通知**: @admin が agent-hub に `[boot]` log を投稿 (= scheduler 起動確認)

#### Config update (= schedules.json 変更)

1. **author が main repo に PR 起票**: `schedules.json` edit + reviewer review + planner merge
2. **@admin (= Pi5 ops persona) が Pi5 で pull + reload**:
   ```bash
   cd /home/pi/agent-hub
   git pull origin main

   # systemd mode
   sudo systemctl restart agent-hub-scheduler

   # crontab mode
   pkill -f 'scheduler.py' && (cd packages/scheduler && set -a && . ./.env && set +a && nohup python3 scheduler.py >> /home/pi/agent-hub-scheduler.log 2>&1 &)
   ```
3. **reload 完了通知**: @admin が agent-hub に `[boot] (reload)` log を投稿

#### scheduler 自身の update (= scheduler.py / requirements.txt 更新)

1. **author が main repo に PR 起票 + reviewer + planner merge**
2. **@admin が Pi5 で pull + dependencies update + restart**:
   ```bash
   cd /home/pi/agent-hub
   git pull origin main
   cd packages/scheduler
   pip install --user -r requirements.txt
   sudo systemctl restart agent-hub-scheduler    # systemd mode
   ```

→ 全 deployment cycle が **git PR + admin remote action** で完結、 SSH 直接アクセス想定なし。 admin 不在時の自動 deploy は 別 PR で検討候補 (= GitHub Actions + Pi5 self-hosted runner 等)。

### schedules.json 初期設定例

production deploy 時の初期設定 example (= `schedules.json` を以下に置換):

```json
[
  {
    "cron": "0 13 * * *",
    "to": "@planner",
    "message": "daily report を書いてください (= UTC 13:00、 本日の planner activity summary + tomorrow plan)"
  },
  {
    "cron": "0 9 * * 1",
    "to": "@researcher",
    "message": "週次調査タスク: 直近 1 週間の ecosystem activity から retrospective 候補 + 次週 priority 整理 (= 毎週月曜 UTC 09:00)"
  }
]
```

#### entry 説明

**Entry 1: @planner daily report (= UTC 13:00)**
- cron: `0 13 * * *` = 毎日 UTC 13:00 (= JST 22:00 / EST 09:00)
- to: `@planner` peer
- message: daily report 催促 (= planner が日次 activity を retrospective doc に記録する trigger)

**Entry 2: @researcher 週次調査 (= 毎週月曜 UTC 09:00)**
- cron: `0 9 * * 1` = 毎週月曜 UTC 09:00 (= JST 月 18:00 / EST 月 04:00)
- to: `@researcher` peer
- message: 週次 retrospective 候補抽出 + 次週 priority 整理

両 entry は example、 production では agent-hub ecosystem の各 peer に対する適切な timing で適宜編集。

#### cron 式 reference (= 5-field standard)

| pattern | 意味 |
|---|---|
| `0 13 * * *` | 毎日 13:00 |
| `*/30 * * * *` | 30 分ごと |
| `0 9 * * 1` | 毎週月曜 9:00 |
| `0 0 1 * *` | 毎月 1 日 0:00 |
| `0 0 * * 1-5` | 平日 (月-金) 0:00 |

croniter は標準 5-field syntax を accept (= 秒 field なし)。

## ログ

stdout:
- `[boot]`: 起動時の auth mode / user / tenant / hub / schedules 数 / session id
- `[ready]`: 各 schedule の cron + next fire time
- `[FIRE]`: cron 発火時の timestamp + to + message preview (50 文字)
- `[reinit]`: session 再 init 成功

stderr:
- `[ERR]`: 致命的エラー
- `[WARN]`: 警告 (= `AGENT_HUB_TENANT` unset 等)

## トラブルシューティング

### `[ERR] JSON parse error`

`schedules.json` の syntax 確認。 valid JSON (= 末尾 `,` 禁止、 string は `"..."` quote)。

### `[ERR] invalid cron expression`

`cron` field の syntax 確認。 croniter は標準 5-field (`分 時 日 月 曜日`) を期待:
- `0 13 * * *` = 毎日 13:00
- `*/30 * * * *` = 30 分ごと
- `0 9 * * 1` = 毎週月曜 9:00

### `[ERR] MCP session init failed`

- agent-hub server が起動しているか確認 (`AGENT_HUB_URL`)
- `GITHUB_PAT` or `AGENT_HUB_USER` の設定確認
- `AGENT_HUB_TENANT` の設定確認 (= 「見えない幽霊」 bug 防止、 [agent-hub#28](https://github.com/kishibashi3/agent-hub/issues/28) 参照)

### DM が届かない

- agent-hub server のログ確認 (= 認証エラー / tenant mismatch / 宛先 unregistered)
- scheduler の stdout で `[FIRE]` が出ているか確認
- `to` が agent-hub に register 済の participant か (= `get_participants` で確認)

## 関連

- [issue #40](https://github.com/kishibashi3/agent-hub/issues/40) — 本 package 起源
- agent-hub server の MCP API: `src/mcp/tools/send_message.ts`
- `watch.sh` (= bash MCP client reference、 agent-hub-plugin): MCP HTTP session pattern の参考実装
- `AGENT_HUB_TENANT` 関連: [agent-hub#28](https://github.com/kishibashi3/agent-hub/issues/28) (= 「見えない幽霊」 bug)
