# agent-hub scheduler

cron-based DM scheduler as agent-hub package (= [issue #40](https://github.com/kishibashi3/agent-hub/issues/40))。 軽量 Python daemon、 `schedules.json` の cron 設定や ISO 8601 datetime に従って agent-hub 参加者に DM を送る。

**Bidirectional + sender-based + one-shot timer** (= [issue #65](https://github.com/kishibashi3/agent-hub/issues/65) v4 redesign):
- scheduler 自身が agent-hub に participant として register + 自分の inbox を SSE subscribe
- 受信 DM に **7 commands** で反応: `ping` / `list` / `add` / `run_at` / `run_in` / `delete` / `run now`
- schedules は **sender 単位で管理** (= `owner` field、 自身の entry のみ操作可)
- **one-shot timer** support (= `run_at` ISO 8601 datetime / `run_in` duration、 fire 後自動削除)
- cron daemon **再起動なしで dynamic schedule 管理** 可能

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

`schedules.json` を編集 (= v4 schema):

```json
[
  {
    "name": "daily-report",
    "cron": "0 13 * * *",
    "to": "@planner",
    "message": "daily report を書いてください",
    "owner": "@ope-ultp1635"
  },
  {
    "name": "oneshot-progress",
    "run_at": "2026-05-19T12:00:00+09:00",
    "to": "@planner",
    "message": "進捗確認",
    "owner": "@ope-ultp1635",
    "one_shot": true
  }
]
```

各 entry の field:
- `name` (str, unique 必須): add/delete/run-now の identifier
- `cron` (str, optional): 標準 cron 式 (= `分 時 日 月 曜日`)、 cyclic schedule
- `run_at` (str, optional): ISO 8601 datetime (= `2026-05-19T12:00:00+09:00` 等)、 one-shot schedule
  - **`cron` と `run_at` は mutually exclusive** (= 同 entry で両方は invalid)
- `to`: agent-hub 参加者 (`@handle`) or team (`@team-name`)
- `message`: DM 本文
- `owner` (str, 必須): `@<sender-handle>` format、 add/delete/run-now で attribution + restriction
- `one_shot` (bool, optional, default false): true なら fire 後 auto-delete

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
2. **schedule loop** (main thread): 各 entry の **次の fire time** を croniter で計算、 最も近い fire time まで sleep
3. **fire 時**: `send_message` MCP tool を call → 次の fire time を再計算
4. **エラー時**: session 切断等で send 失敗時、 自動 session reinit (= 60 秒後に再試行)
5. **SSE listener thread** (= issue #65 bidirectional 化): 自分自身を `register` + `inbox://@<user>` を subscribe + long-lived SSE GET で push 待ち + 受信 command dispatch + `mark_as_read`

main thread (cron) と SSE thread (inbox) は独立 session で動作、 互いに非干渉。

## Inbox command (= bidirectional、 issue #65 v4)

scheduler 自身に DM を送ると以下 **7 commands** として反応 (= sender-based ownership + one-shot timer 統合):

| command | 動作 | scope | 永続化 |
|---|---|---|---|
| `ping` | scheduler 生存確認 | public | × |
| `list` | sender's entries 一覧 (= one-shot は残り時間付き) | sender-restricted | × |
| `add <name> <cron-5> <to> <message>` | cyclic entry 追加、 owner=sender | sender's own | ✅ atomic write |
| `run_at <ISO8601> <to> <message>` | one-shot entry 追加 (= 指定日時)、 fire 後 auto-delete | sender's own | ✅ atomic write |
| `run_in <duration> <to> <message>` | one-shot entry 追加 (= N時間/N分後)、 fire 後 auto-delete | sender's own | ✅ atomic write |
| `delete <name>` | entry 削除 (= owner check、 自身のみ) | sender's own | ✅ atomic write |
| `run now <name>` | one-shot 即時 fire (= entry は変更なし、 owner check) | sender's own | × |
| その他 | unknown command | — | — |

### `add` 引数 parse 仕様

`add <name> <cron-5-fields> <to> <message>` で **positional parse**:
- 1 word = name (e.g. `daily-report`)
- 5 words = cron expression (= 標準 5 fields `分 時 日 月 曜日`)
- 1 word = to (= `@handle` format)
- 残り = message (= 空白含み OK、 全て join)

例: `add daily-report 0 13 * * * @planner daily report を書いてください`

### `run_at` / `run_in` 引数 parse 仕様

- `run_at <ISO8601-datetime> <to> <message>` — datetime は **1 word**、 例 `2026-05-19T12:00:00+09:00`
- `run_in <duration> <to> <message>` — duration は **1 word**、 例 `2h` / `30m` / `1d` / `2h30m` (= compound 可)

name は **auto-generate** (= `oneshot-YYYYMMDDTHHMMSS` 形式)、 重複時は suffix `-1` / `-2` 自動付与。

### 使用例 (= operator から @scheduler への DM)

```
operator → @scheduler: ping
@scheduler → operator: pong (scheduler alive, 2 schedules total)

operator → @scheduler: list
@scheduler → operator: list (owner=@ope-ultp1635, 2 entries):
  daily-report                   cron='0 13 * * *' to=@planner msg='daily report を書いてください...'
  weekly-research                cron='0 9 * * 1' to=@researcher msg='週次調査タスク...'

# cyclic schedule 追加
operator → @scheduler: add ad-hoc-ping 0 9 * * * @planner morning ping check
@scheduler → operator: [OK] added 'ad-hoc-ping' (cyclic, next fire=2026-05-19T09:00:00+09:00, owner=@ope-ultp1635, persisted)

# one-shot at specific datetime
operator → @scheduler: run_at 2026-05-19T15:00:00+09:00 @planner 3時のmtg準備
@scheduler → operator: [OK] added 'oneshot-20260519T150000' (one-shot, next fire=2026-05-19T15:00:00+09:00, owner=@ope-ultp1635, persisted)

# one-shot after duration
operator → @scheduler: run_in 2h @planner 進捗確認
@scheduler → operator: [OK] added 'oneshot-20260519T140000' (one-shot, next fire=2026-05-19T14:00:00+09:00, owner=@ope-ultp1635, persisted)

# (= 2 時間後に @planner に「進捗確認」が届く、 fire 後 schedules.json から自動削除)

# 削除 (= sender's own のみ可)
operator → @scheduler: delete ad-hoc-ping
@scheduler → operator: [OK] deleted 'ad-hoc-ping' (removed from schedules.json)

# 他 sender の entry を削除しようとすると reject
researcher → @scheduler: delete daily-report
@scheduler → researcher: [ERR] 'daily-report' is owned by @ope-ultp1635, you (@researcher) cannot delete it. ownership is enforced.
```

### 設計判断 (= 安全性 + concurrency)

- **owner-based ownership**: add/run_at/run_in で entry 追加時に sender を owner に記録、 delete/run-now で **自身の entry のみ操作可** (= mistype で他 sender の entry を消す事故防止)
- **list は sender-restricted**: 他 sender の entry は見えない (= プライバシー / ノイズ削減)
- **`run now` は schedule 変更なし**: cron / run_at は touch しない、 単発 fire のみ
- **one-shot auto-delete**: fire 後に schedules.json から自動 remove + persist (= 永続化された state record)
- **schedules.json の git workflow**: daemon が add/delete で diff を作る → operator が次の deploy 時に commit (= **operational state の git 経由 audit trail**)
- **concurrency**: `_schedules_lock` で main thread (= cron read + fire) と SSE thread (= add/delete/run_at/run_in write) の race condition 防止、 schedules / iters / next_times の 3 parallel list を atomic 更新
- **rollback on persist failure**: disk write 失敗時は memory state も rollback (= atomic semantics 保持)
- **mark_as_read で再 dispatch 回避**: handled message は即時既読化
- **schedule の在/不在は name 一意性で識別**: schedules.json で name duplicate → daemon startup で exit、 add 時の duplicate は **suffix 自動付与** (= one-shot で同 timestamp の場合 graceful)

## エラーハンドリング

- **JSON parse error**: stderr に `[ERR]` + exit 1
- **必須 field 欠落** (`cron` / `to` / `message`): 同上
- **invalid cron expression**: 同上
- **MCP session init 失敗**: 同上
- **send_message 失敗**: stderr に `[ERR]`、 session reinit 試行 (= daemon は止まらない)
- **SSE thread 障害**: stderr に `[ERR sse]`、 5 秒後再接続 (= main thread の cron は影響なし)
- **register 失敗**: `[WARN]` のみ、 既登録 case 等で非致命的
- **inbox command エラー**: `[ERR] handle_inbox_command failed` log、 next command 受付可能 (= thread 落ちない)
- **SIGINT (Ctrl-C)**: graceful shutdown (= SSE thread は daemon=True で自動 cleanup)

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
