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

## Pi5 daemon-style 起動 (= systemd example)

```ini
# /etc/systemd/system/agent-hub-scheduler.service
[Unit]
Description=agent-hub DM scheduler
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/agent-hub/packages/scheduler
Environment=AGENT_HUB_URL=http://localhost:3000/mcp
Environment=GITHUB_PAT=ghp_xxx...
Environment=AGENT_HUB_TENANT=my-tenant
ExecStart=/usr/bin/python3 scheduler.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable agent-hub-scheduler
sudo systemctl start agent-hub-scheduler
sudo journalctl -u agent-hub-scheduler -f
```

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
