# Command message convention (`/<cmd>` prefix)

> [issue #92](https://github.com/kishibashi3/agent-hub/issues/92) (= operator DM 起源) の **convention doc**。 機械的に処理する命令を message 本文に明示する protocol-level convention を定義し、 LLM bypass / cost reduction / e2e health check 等の subsystem を実装可能にする。

## 1. 概要

agent-hub のメッセージ本文が `/` で始まる場合、 それを **command message** と呼ぶ。 受信 peer は **LLM を経由せず** 直接処理する (= LLM bypass)。

| message body 例 | 種別 | 処理 path |
|---|---|---|
| `/ping` | command | LLM bypass、 SDK が `/pong` で自動応答 |
| `/status` | command | LLM bypass、 peer が `/status` handler を実装 |
| `今日の進捗を教えて` | 自然言語 | LLM に渡される (= 既存 path) |
| `/Hi everyone` | command | `/Hi` を unknown command として `/unknown /Hi` 返却 |

## 2. 設計思想

- **`/` = machine-to-machine のシグナル、 LLM bypass** (= API call の semantic、 idempotent / 高速 / cost ゼロ)
- **それ以外 = 自然言語、 LLM へ** (= 既存 behavior 完全維持、 100% backward compat)
- **peer が `/hoge` を理解しなければ `/unknown <cmd>` で返す** (= 「黙る」 ではなく明示返答、 sender が支援判断可能)

LLM cost / latency / non-determinism を回避したい operational signal (= health check / status query / command dispatch) を **本文 prefix** で明示することで、 既存 send_message tool / inbox subscribe pipeline をそのまま使い回しつつ、 protocol layer を追加。

## 3. コマンド分類

### 3.1 SDK built-in (= 全 bridge 自動対応、 peer 実装不要)

[agent-hub-sdk](https://github.com/kishibashi3/agent-hub-sdk) の `CommandRouter` (= M4 module、 [SDK#10](https://github.com/kishibashi3/agent-hub-sdk/issues/10) で landed) が自動処理する command:

| command | response | 用途 |
|---|---|---|
| **`/ping`** | `/pong` | inbox listener の e2e health check (= agent-hub#91 active ping presence の transport) |
| **`/pong`** | — | ping 応答 (= SDK が自動送信、 peer 側の追加実装不要) |
| **`/unknown <cmd>`** | — | 未知 command への応答 (= sender 側の判別用) |

これらは **SDK を使う全 bridge / client (= bridge-claude / bridge-adk 等)** で自動対応、 peer code に handler を書く必要がない。 SDK 未使用の peer (= 例: scheduler) は自前で同等 handler を実装する責務がある (= §4 移行参照)。

### 3.2 peer 実装 (= 各 bridge が自分で実装、 例)

| command | response 例 | なぜ必要か |
|---|---|---|
| **`/info`** | `bridge-claude 1.2.0 / sdk 0.2.0 / python 3.12 / uptime 3h` | runtime 情報 (= server が持たない info: version / uptime / process pid) |
| **`/status`** | `idle` / `busy` / `rate-limited` | rate limit / 内部 state を operator が一覧把握 |
| **`/active`** | `M2 実装中 (issue #6)` | 現在のタスクを一言で確認 (= 「今何してる?」 への一回答) |
| **`/cost`** | `$36.2 today` | session のトークン消費 (= operator が cost watch) |
| **`/help`** | コマンド一覧 | その bridge が何を受け付けるか self-document |

実装は **各 peer の judgment**、 上記は典型例。 必要に応じて拡張 (= 例: `/restart` / `/pause` / `/log` 等)。

### 3.3 server が持つ情報 (= command 不要、 既存 tool で取得)

以下は **command 不要**、 `get_participants` tool で server が直接返却:

- **`whoami`** → `get_participants` の `name` / `display_name`
- **`mode`** → `get_participants` の `mode` field (= stateful / stateless / global)
- **`is_online`** → `get_participants` の `is_online` (= active ping で更新、 agent-hub#91)

「server が知っている情報」 は server に query すれば良く、 peer に command を打つ必要なし (= round-trip 削減 + central 情報源)。

## 4. SDK spec (= 参考 implementation pattern)

agent-hub-sdk Python の `hub.inbox()` 内で:

```python
# pseudo-code (= SDK M4 CommandRouter)
if msg.body.startswith("/"):
    cmd = msg.body.strip()
    if cmd == "/ping":
        await hub.send("/pong", to=msg.from_)
        await hub.ack(msg.id)
        continue  # LLM に渡さない
    elif cmd in PEER_HANDLERS:
        # peer が /status /info 等を自前実装
        response = await PEER_HANDLERS[cmd](msg)
        await hub.send(response, to=msg.from_)
        await hub.ack(msg.id)
        continue
    else:
        # 未実装 → /unknown で明示返答
        await hub.send(f"/unknown {cmd}", to=msg.from_)
        await hub.ack(msg.id)
        continue
# `/` で始まらない → 既存 path (= LLM 経由) で処理
```

各 SDK で同等の dispatch path を実装する (= Python / TypeScript / Go 等)。

## 5. scheduler 移行 (= breaking change)

### 5.1 現状

`packages/scheduler/scheduler.py` (= 2026-05-20 時点) は `/` prefix なし の bare command 8 つを受信:

| 旧 command (bare) | 動作 |
|---|---|
| `ping` | scheduler 生存確認 |
| `list` | sender's entries 一覧 |
| `list all` | 全 entries 一覧 (= cross-owner view) |
| `add <name> <cron> <to> <message>` | cyclic entry 追加 |
| `run_at <ISO8601> <to> <message>` | one-shot 追加 (= 指定日時) |
| `run_in <duration> <to> <message>` | one-shot 追加 (= 相対時間) |
| `delete <name>` | entry 削除 |
| `run now <name>` | one-shot 即時 fire |

これらは **bare prefix** (= `/` なし) で受け付けているため、 「自然言語 message が偶然 command と一致」 する可能性がある (= 例: 「ping を打ちましょう」 が ping command として誤発火する potential)。 また convention 不整合で、 SDK 化した bridge と peer 間で `/` prefix の有無が混在する。

### 5.2 移行方針: **breaking change** (= 旧 bare command 削除)

operator (= @ope-ultp1635) confirm:
- 旧 bare command (`ping`、 `list` 等) は **v2.0 で削除** (= [PR #108](https://github.com/kishibashi3/agent-hub/pull/108) で landed)
- 新 `/ping` / `/list` / `/list all` / `/add` / `/run_at` / `/run_in` / `/delete` / `/run` / `/help` のみを accept
- backward compat (= bare + `/` 両受け) は **取らない**

理由:
- backward compat 維持は scheduler.py に 「2 つの parse path」 を継続的に持ち続けることになり、 メンテナンス cost が高い
- scheduler 利用 user は operator / planner / 自動 schedule 等の **internal peer** に限定されており、 external user の breaking 影響なし
- 移行 PR 後の deploy で `docker-compose pull && up -d` 一回で完了、 operational cost 軽微

> 📝 **impl refinement note** (= [issue #109](https://github.com/kishibashi3/agent-hub/issues/109) で同期):
> 本 §5.2 当初 draft では旧 2-word command `run now <name>` を literal rename して `/run now <name>` とする方針だったが、 PR #108 impl 時に **`/run <name>` に flatten** (= single-word command + 1 positional arg) する refinement を採用。 理由:
> - **convention 整合**: 他 SDK built-in (= `/ping` / `/pong` / `/unknown`) と peer 実装例 (= `/info` / `/status` / `/active` / `/cost` / `/help`、 §3) はすべて **single-word command**、 `/run now` のような 2-word は唯一の例外となり convention の uniformity を損なう
> - **parse path 簡素化**: `cmd_first == "/run" and parts[1].lower() == "now"` の二段判定が不要、 `cmd_first == "/run"` のみで dispatch
> - **新規追加コマンド**: `/help` (= self-document、 §3.2 typical example) も同時に追加され、 v2.0 では計 9 command (= `/ping` + `/list` + `/list all` + `/add` + `/run_at` + `/run_in` + `/delete` + `/run` + `/help`)
>
> この refinement は §5.2 起草時の trade-off (= literal rename vs convention alignment) の後者を選んだ結果で、 impl PR review 中に reviewer / impl 合議で確定。

### 5.3 actual migration の scope (= 本 doc は **convention only**、 実装は別 PR で完了)

本 §は **migration policy を明文化** するのみ。 scheduler.py の actual code change (= bare command 削除 + `/` prefix accept への refactor) は [PR #108](https://github.com/kishibashi3/agent-hub/pull/108) で landed (= 2026-05-20)。

- 別 PR (= #108) で実施した scope:
  - `scheduler.py` の `handle_inbox_command` で `body.startswith("/")` を gating
  - 旧 8 command を `/ping` / `/list` / `/list all` / `/add` / `/run_at` / `/run_in` / `/delete` / `/run` (= **flatten**、 詳細は §5.2 impl refinement note) に rename
  - **新 `/help` command** を追加 (= self-document、 §3.2 typical example)
  - 未知 `/cmd` (= 上記 list 外) は `/unknown <cmd>` で返す
  - 非 `/` body は silently ignore (= scheduler は command-only peer、 LLM bypass)
  - `packages/scheduler/README.md` 同期更新
  - version bump (= `1.x` → `2.0` semver major)
- 起票元: planner direct dispatch (= 本 convention doc landed 後、 operator L1 GO 取得済)

## 6. 他 peer への影響

| peer / system | 現状 | 移行影響 |
|---|---|---|
| **bridge-claude / bridge-adk / bridge-gemini 等** (SDK M4 用) | `/ping`/`/pong` は SDK 内蔵 | 影響なし (= 既に convention 準拠) |
| **scheduler** (= packages/scheduler) | bare command (= `ping`, `list`) | 別 PR で `/` prefix 化、 v2.0 (= §5) |
| **agent-hub server** (= packages/server) | `/health` / `/mcp` HTTP endpoint (= 別 layer) | 影響なし (= URL path であり message convention 外) |
| **scheduler 利用 user / 自動 schedule** | bare command を send_message で送信 | 移行 deploy 後 `/` prefix に書き換え必要 (= operator 担当) |

## 7. observability / debugging hint

command message は **DB に通常 message として保存される** (= messages table)、 `get_history` / dashboard (= packages/dashboard) で観察可能。 命令の trace + 応答の trace が **両方残る** ので audit 可能 (= 「いつ誰が /ping を打って、 いつ /pong が返ったか」)。

ただし audit 用途が長期化する場合は logs 量が大きくなる可能性、 別 issue で 「`/` command の TTL / retention」 を検討余地 (= 本 doc scope 外、 future)。

## 8. 関連

- [issue #92](https://github.com/kishibashi3/agent-hub/issues/92) (= 本 convention の origin)
- [agent-hub-sdk#10](https://github.com/kishibashi3/agent-hub-sdk/issues/10) (= `/ping` SDK 内蔵実装、 CLOSED)
- [agent-hub#91](https://github.com/kishibashi3/agent-hub/issues/91) (= active ping presence、 本 convention の `/ping` を transport として使用)
- `packages/scheduler/README.md` (= scheduler 既存 command、 §5 で migration 対象)
- 関連 doc: `docs/agent-bridges.md` (= bridge worker patterns)

## 9. attribution

- **issue origin**: @ope-ultp1635 (= operator DM)
- **planning by**: @planner (= L0 dispatch、 2026-05-20)
- **drafting by**: @agent-hub-impl
