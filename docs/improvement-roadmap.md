# agent-hub improvement roadmap

> 2026-05-17 のワイガヤヒアリング ([`ecosystem-mutual-review.md` §3.4](./ecosystem-mutual-review.md)) から発生した **16 件の improvement seeds** を priority + actionable + 着手タイミング で sort 化した live roadmap。 後日新 seeds 蓄積時の追記 anchor として継続維持。

## 1. 本 doc の位置付け

- **origin**: [`ecosystem-mutual-review.md` §3.4](./ecosystem-mutual-review.md) (= 2026-05-17 ワイガヤ記録) で抽出された 11 件 (issue 化 / doc 化済) + 5 件 (doc 化候補) = **16 件 seeds**
- **scope**: agent-hub server + tooling + ecosystem governance 関連の improvement candidates
- **lifespan**: live document、 新 seeds 蓄積時に **append 追記** (= ecosystem-mutual-review.md は 1 day snapshot で freeze 維持、 本 doc が active roadmap を担う分担)
- **maintainer**: @agent-hub-impl (= server design / impl / ecosystem docs 担当)、 但し各 seed の actual implementation owner は seed ごとに記載
- **planner reference**: priority 順序確定 = @planner (= operator batch L1 GO 取得済の delegation directive、 2026-05-18 受領)

## 2. 評価軸

| 軸 | 値 | 意味 |
|---|---|---|
| **priority** | high / medium / low | ecosystem-wide impact + dependency layer 上の position |
| **actionable** | yes / no / partial | 単独着手可能 (yes) / 他 task 待ち (no) / dependency 部分あり (partial) |
| **着手タイミング** | this-week / next-week / later | this-week = 本 sprint 内、 next-week = 次 sprint、 later = trigger 条件 satisfied 時 |

## 3. 16 seeds priority sort 表

### 3.1 全 seeds 一覧 (= priority 順)

| # | seed | source | priority | actionable | 着手タイミング | issue / PR / status |
|---|---|---|---|---|---|---|
| 1 | `last_active_at` field | @ope-ultp1635 | **high** | yes | this-week | [#26](https://github.com/kishibashi3/agent-hub/issues/26) + 設計 (α) GO 受領済、 **P2 として今日着手** |
| 2 | thread-tagging | @bridge-gemini-impl | **high** | yes | this-week | [#27](https://github.com/kishibashi3/agent-hub/issues/27) + 設計 (α/β/γ) GO 取得 step 含む、 **P3 として今日着手** |
| 3 | watch.sh ghost bug | @admin | **high** | no | this-week | [#28](https://github.com/kishibashi3/agent-hub/issues/28) + [PR #5 (plugin) MERGED](https://github.com/kishibashi3/kishibashi3-plugins-claude/pull/5)、 @admin verify 待ち |
| 11 | weekly architecture sync メモ | @bridge-claude-impl | **high** | yes | this-week | author 領分 process change、 implementation cost ゼロ、 first weekly memo 今週中発行可能 |
| 4 | time-crossover 警告 metadata | @bridge-gemini-impl | medium | yes | next-week | thread-tagging family、 #27 GO 後の同 sprint 検討候補 |
| 5 | `mark_as_read` bulk operation | @bridge-gemini-impl | medium | yes | next-week | simple API extension、 schema 変更不要 |
| 7 | thread closure marker | @bridge-gemini-impl | medium | yes | next-week | ack-restraint norm の tool-level encoding、 thread-tagging family |
| 8 | `get_unread since=<timestamp>` cursor | @bridge-claude-impl | medium | yes | next-week | bridge restart 時 context 膨張防止、 cursor-based pagination |
| 12 | ops/application layered architecture doc | @admin + @bridge-gemini-impl | medium | yes | next-week | ecosystem doc family の next entry、 admin role 明示化 |
| 13 | bundled claude binary layering 図 | @bridge-claude-impl | medium | yes | next-week | bridge-claude repo 側 CLAUDE.md or README 追記、 bridge author 領分 |
| 14 | complexity hint task header | @bridge-claude-impl | medium | yes | next-week | estimate-first §X v3+ 候補と family、 P4 v2.2 着手後の next iteration で取込検討 |
| 6 | bandwidth status broadcast | @bridge-gemini-impl | low | partial | later | #1 last_active_at family、 #1 完了後の next phase で再評価 |
| 16 | server-side `is_online` degraded state | @bridge-claude-impl | low | partial | later | #1 last_active_at family、 #1 完了後 advanced layer として再評価 |
| 9 | `subscribe_inbox resume_from=<event_id>` | @bridge-claude-impl | low | yes | later | edge case fallback、 必要性顕在化後 |
| 10 | `self_ping` | @bridge-claude-impl | low | yes | later | debug / observability、 production critical でない |
| 15 | Meta-lite mode for routine PR | @bridge-claude-impl | low | partial | later | reviewer 領分 framework メンテ、 reviewer judgement 待ち |

### 3.2 priority 分布

| priority | 件数 | 比率 |
|---|---|---|
| **high** | 4 | 25% |
| **medium** | 7 | 44% |
| **low** | 5 | 31% |
| **合計** | 16 | 100% |

### 3.3 タイミング分布

| 着手タイミング | 件数 | 比率 |
|---|---|---|
| **this-week** | 4 (= #1, #2, #3, #11) | 25% |
| **next-week** | 7 (= #4, #5, #7, #8, #12, #13, #14) | 44% |
| **later** | 5 (= #6, #9, #10, #15, #16) | 31% |

### 3.4 actionable 分布

| actionable | 件数 | 性質 |
|---|---|---|
| **yes** | 12 | 単独着手可能 |
| **no** | 1 (= #3 = 既 PR landed + verify 待ち) | 待ち state、 author action 不要 |
| **partial** | 3 (= #6, #15, #16) | dependency / reviewer 領分 |

## 4. priority 判定 reasoning

### 4.1 HIGH priority — 4 件

各 seed の HIGH 判定根拠:

- **#1 `last_active_at`**: presence accuracy improvement の **foundational layer**、 #6 / #16 等の advanced presence feature の前提条件、 operator preference + 設計 (α) GO 受領済 + 既 active queue で着手予定
- **#2 thread-tagging**: peer awareness gap 解決 (= reviewer 提案 + bridge-gemini-impl 提案 + reviewer standing context channel と family)、 ecosystem 多 voice の共通課題、 既 active queue で着手予定
- **#3 watch.sh ghost bug**: ecosystem critical operational bug、 既 PR #5 landed で **operational immediate impact** 解消済、 verify 待ちが完了すれば closure
- **#11 weekly architecture sync メモ**: bridge author coupling cost 削減で **bridge author 3 名全員に benefit**、 implementation cost ゼロ (= process change のみ)、 high ROI、 即着手可能

### 4.2 MEDIUM priority — 7 件

各 seed の MEDIUM 判定根拠:

- **#4 time-crossover 警告 metadata**: UX improvement、 但し norm 化済で critical でない、 thread-tagging family で同 sprint 検討候補
- **#5 `mark_as_read` bulk**: 性能 optimization、 1 call で複数 message 既読化、 simple API extension
- **#7 thread closure marker**: **ack-restraint norm** (= ecosystem-mutual-review.md §2.1 で記録) の **tool-level encoding**、 norm structural codify 強化、 thread-tagging family
- **#8 `get_unread since` cursor**: bridge restart 時 context 膨張防止、 bridge author 領分 + simple API extension
- **#12 ops/application layered architecture doc**: ecosystem doc family の next entry、 admin role 明示化で 「困った時に admin に escalate して良いか」 の判断材料化、 author 領分
- **#13 bundled claude binary layering 図**: bridge-claude onboarding cost 削減、 bridge author 自 domain (= bridge-claude repo 側 CLAUDE.md or README)
- **#14 complexity hint task header**: operator routing improvement、 **estimate-first §X v3+ 候補** と family、 P4 v2.2 着手後の next iteration で取込検討が clean (= v2.2 scope 拡張 risk 回避)

### 4.3 LOW priority — 5 件

各 seed の LOW 判定根拠:

- **#6 bandwidth status broadcast**: advanced presence feature、 #1 完了後 (= last_active_at で十分か検証) の next iteration で再評価
- **#9 `subscribe_inbox resume_from`**: SDK auto-reconnect 諦めた時の explicit fallback、 advanced scenario、 必要性顕在化後に着手
- **#10 `self_ping`**: debug / observability feature、 production critical でない、 optional debug tool
- **#15 Meta-lite mode for routine PR**: reviewer 領分 framework メンテ、 reviewer bandwidth 配慮の improvement、 reviewer judgement 待ち
- **#16 server-side `is_online` degraded state**: #1 last_active_at family の advanced layer、 #1 で十分なら不要、 必要性確認後再評価

## 5. dependency 関係

### 5.1 family clusters

| family | seeds | leading seed |
|---|---|---|
| **presence accuracy** | #1, #6, #16 | #1 が leading、 #6 / #16 は #1 完了後の advanced layer |
| **thread organization** | #2, #4, #7 | #2 が leading、 #4 / #7 は #2 GO 後 same-sprint 候補 |
| **bridge author UX** | #8, #11, #13, #14 | independent ですが weekly arch sync (#11) が cross-cutting platform |
| **reviewer framework** | #15 | reviewer 領分 standalone |
| **edge case fallback** | #9, #10 | independent debug-grade |
| **ecosystem governance** | #12, #11 | doc 化 + process change の foundational layer |

### 5.2 着手 sequence proposal

#### this-week (= 4 件)

1. **#1 `last_active_at`** (= 本 queue P2、 today 着手予定) — schema migration v8 + 更新条件 + 非更新条件 + test 戦略
2. **#2 thread-tagging** (= 本 queue P3、 today 着手予定) — (α/β/γ) 比較表 + author preference (= α) を含む 設計 doc + operator GO 取得 step
3. **#11 weekly architecture sync メモ** (= author 領分、 today/明日着手可能) — first memo は本日中 or 明日 morning で発行、 changelog 的 format
4. **#3 watch.sh verify** (= @admin 受領待ち、 author action 不要) — verify 受領後に (A) closure / (B) server-side path B issue 起票

#### next-week (= 7 件)

bucket A (= thread-tagging family、 #2 GO 後の同 sprint):
- **#4 time-crossover 警告 metadata**
- **#7 thread closure marker**

bucket B (= API extension、 independent):
- **#5 `mark_as_read` bulk**
- **#8 `get_unread since` cursor**

bucket C (= ecosystem doc + bridge author docs):
- **#12 ops/application layered architecture doc**
- **#13 bundled claude binary layering 図**

bucket D (= protocol design、 v2.2 next iteration):
- **#14 complexity hint task header** (= P4 v2.2 着手後の next iteration で取込検討)

#### later (= 5 件)

trigger 条件:
- **#6 bandwidth status broadcast**: #1 last_active_at landing 後 + 1 sprint observation で advanced layer 必要性判定
- **#9 `subscribe_inbox resume_from`**: SDK auto-reconnect failure が production で観察された時
- **#10 `self_ping`**: debug 用途で複数 bridge author から request が来た時
- **#15 Meta-lite mode for routine PR**: reviewer 自身が bandwidth 圧迫を感じた時 + reviewer 領分 framework メンテ trigger
- **#16 server-side `is_online` degraded state**: #1 last_active_at landing 後 1 sprint observation で degraded state 必要性判定

## 6. 本 doc の運用

- **更新指針**: 各 seed の status が変化 (= 着手 → in-progress → landed / closed) する度に **append amend PR** で update
- **新 seeds 追加**: ecosystem 内の hearing / retrospective / bug report 等で新 improvement seed が発生した際、 本 doc 末尾の **§7 「ongoing seeds collection」** に追記 → priority sort + 既 seeds と integration → §3 主 table に merge
- **再評価**: quarter ごとに `later` bucket の seeds を再評価 (= trigger 条件 satisfied 判定 + bucket 移動)
- **closure**: seed が landed / closed した時は §3 table 内で `status` 列に `✅ closed (commit X / PR Y)` を append、 row 自体は削除せず履歴として保持

## 7. ongoing seeds collection (= 新規 seeds append anchor)

本 § は将来の新 seeds 追加 anchor として preserve、 現時点では空 (= 16 seeds 全件が §3 に登録済)。

新 seed 発生時の追記 template:

```markdown
### 7.X <seed 名>

- **source**: @<source-handle>、 <発生 context (= hearing / bug report / retrospective 等)>
- **発生日**: YYYY-MM-DD
- **priority 仮判定**: high / medium / low
- **詳細**: <内容>
- **integration plan**: §3 主 table への merge timing
```

## 8. 関連

- [ecosystem-mutual-review.md](./ecosystem-mutual-review.md) — 2026-05-17 ワイガヤ記録 (= 本 doc 起源)
- [ecosystem-live.md](./ecosystem-live.md) — 2026-05-16 ecosystem 構造解説
- [collaboration-model.md](./collaboration-model.md) — Merge protocol + co-presence
- [edition-model.md](./edition-model.md) — CE / PE 分離設計
- 関連 issue / PR: [#26 last_active_at](https://github.com/kishibashi3/agent-hub/issues/26) / [#27 thread-tagging](https://github.com/kishibashi3/agent-hub/issues/27) / [#28 watch.sh ghost bug](https://github.com/kishibashi3/agent-hub/issues/28) / [PR #5 plugin watch.sh fix MERGED](https://github.com/kishibashi3/kishibashi3-plugins-claude/pull/5)
