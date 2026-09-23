# ping loop mode (disabled / observe-only / enforce)

server の active ping loop (issue #91) の挙動を決める 3 値の対応表。運用時に参照するための doc。
実装の正本は `src/mcp/server.ts` の `resolvePingLoopMode()` / `runOneActivePingCycle()` /
`startActivePingLoop()`。この doc と実装が食い違ったら実装が正しい。

関連 issue: #356 (再有効化の条件) / #363 (3 値化) / #368 (enforce の前提実測) /
#369 (orphan eviction の分離) / #390 / #416 (observe-only の prune と summary)

## 1. env から mode を決める規則

mode は **起動時に 1 回だけ** 決まる。env を変えたら server の restart が必要。

| `AGENT_HUB_MCP_PING_LOOP_MODE` | `AGENT_HUB_MCP_PING_LOOP_DISABLED` | 実効 mode |
|---|---|---|
| `disabled` / `observe-only` / `enforce` | (見ない) | MODE の値 |
| 上の 3 値以外 (例: `observe_only`) | (見ない) | **起動しない** (`EnvConfigError`、fail-fast) |
| 未設定 / 空文字 | 空文字以外が set | `disabled` |
| 未設定 / 空文字 | 未設定 / 空文字 | `observe-only` (code default) |

- MODE は前後の空白を除いて小文字にしてから比べる (`" Enforce "` は `enforce`)
- 旧 flag は値を見ない。`"0"` や `"false"` でも set されていれば `disabled` になる
- MODE が 3 値以外のとき、旧 flag や既定値に黙って倒すことはしない。typo で `disabled` になると
  「warning が出ない = 非応答 session なし」と読めてしまうため (#363 / #384)

### code default と production の実効値の違い

| 環境 | 設定 | 実効 mode |
|---|---|---|
| production (`docker-compose.yml` / Pi5) | `AGENT_HUB_MCP_PING_LOOP_DISABLED: "1"` を明示 | `disabled` |
| env を何も set していない環境 (ローカル起動等) | なし | `observe-only` |

- code default が `enforce` でないのは、ping に応答できないと分かっている client
  (@scheduler の POST-only session (#368)、VS Code plugin (agent-hub-plugin-vscode#67)) を
  env 未設定の環境でいきなり evict しないため (operator 判断 2026-09-20)
- production は旧 flag を残している。image と compose の更新順序が前後しても、無効化が外れないようにするため

## 2. mode ごとの挙動

| | `disabled` | `observe-only` | `enforce` |
|---|---|---|---|
| ping loop の起動 | しない | する | する |
| ping の送出 (30s 間隔、1 回 10s timeout × 3 attempt) | なし | あり | あり |
| 非応答の観測 | なし | 失敗記録 (`observedFailingSessions`) に入れる | あり |
| 非応答 session の evict | なし | **しない** (session は残り、`is_online` も true のまま) | する (`transport.close()` + `sessions.delete`) |
| orphan eviction (session GC、#369) | 動く | 動く | 動く |
| 起動ログ | `active ping loop disabled (= ping loop mode: disabled)` | `active ping loop starting (= mode=observe-only、…)` | `active ping loop starting (= mode=enforce、…)` |

- orphan eviction は ping loop とは別の loop で、mode に関係なく動く。止めたいときは
  `AGENT_HUB_MCP_ORPHAN_EVICTION_DISABLED` を使う (#369)
- 「非応答」の判定条件は observe-only と enforce で同じ。違うのは、非応答だった session の扱いだけ

## 3. mode の切り替え (運用の段階)

段階的に再有効化する手順 (#356)。どの切り替えも env の書き換えと restart だけで済む。

| 現在 | 次 | 条件 | 操作 |
|---|---|---|---|
| `disabled` | `observe-only` | 段階 1 に入る判断 (operator) | `AGENT_HUB_MCP_PING_LOOP_MODE: "observe-only"` を set して restart |
| `observe-only` | `enforce` | 下の「enforce に上げる条件」をすべて満たす (operator gate) | `AGENT_HUB_MCP_PING_LOOP_MODE: "enforce"` にして restart |
| `observe-only` / `enforce` | `disabled` | 問題が出たとき (rollback) | `AGENT_HUB_MCP_PING_LOOP_MODE: "disabled"` にして restart。MODE を消しても、旧 flag `"1"` が残っていれば `disabled` に戻る |

- 旧 flag `AGENT_HUB_MCP_PING_LOOP_DISABLED` は rollback 経路として残す (#356 の条件 4)

### enforce に上げる条件

operator が判断する。判断材料は次のとおり (#356 / #363)。

- ping に応答しない client がいなくなっていること
  - @scheduler の cron 用 POST-only session が evict される問題 (#368)。影響は enforce で実測済み
    (#368 の 2026-09-19T21:16Z コメント)
  - @scheduler の SSE ループの pong 応答 (#362)
  - VS Code plugin の ping 応答 (agent-hub-plugin-vscode#67)
- observe-only で 1 日運用して、下の warning ログで非応答 session が出ていないと確認できたこと

各 issue の状態は GitHub で確認すること。この doc には状態を書かない。

## 4. observe-only の失敗記録とログ

observe-only は同じ warning を毎 cycle 出さない。session ごとに「失敗中かどうか」を記録し、
状態が変わったときだけログを出す。30s 間隔で毎回出すと 1 session あたり 1 日 2,880 行になり、読めなくなるため。

| 失敗記録の状態 | 起きたこと | 次の状態 | ログ |
|---|---|---|---|
| なし | ping 成功 | なし | なし |
| なし | ping 失敗 (3 attempt とも) | あり | `ping failed for session <sid> (…) after 3 attempts — observe-only mode, NOT disconnecting` (warn) |
| あり | ping 失敗 | あり | なし (失敗件数 `observedFailures` には毎 cycle 数える) |
| あり | ping 成功 | なし | `ping recovered for session <sid> (…) — observe-only mode` |
| あり | session が消えた (orphan eviction / GET close eviction / `transport.onclose`) | なし (次の cycle の冒頭で prune) | 個別ログなし。cycle summary の `observedPruned` に数える |

### cycle summary

cycle の結果を 1 行にまとめたもの。次のどれかがあった cycle だけ出る (#390 / #416)。

- `disconnected > 0` (enforce で evict した)
- 状態遷移 (新規失敗 + 復帰) が 1 件以上
- prune が 1 件以上

```
[MCP] ping cycle: mode=observe-only total=<n> alive=<n> disconnected=<n> observedFailures=<n> observedPruned=<n>
```

- 件数ではなく遷移数で判断している。「1 件復帰 + 1 件新規失敗」の cycle は件数が変わらないが、summary は出る (#390)
- prune も条件に入っている。失敗中の session が消えただけの cycle でも summary が出るので、
  `observedFailures` が減った理由をログから読める (#416)
- 何も起きない cycle では summary は出ない。ping loop には orphan eviction のような heartbeat ログがないため、
  ログが出ないことだけでは「非応答 session なし」と「loop 停止」を区別できない。起動ログで mode を確認する
