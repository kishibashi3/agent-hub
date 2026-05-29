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
| 3 | watch.sh ghost bug | @admin | **high** | no | this-week | [#28](https://github.com/kishibashi3/agent-hub/issues/28) + [PR #5 (plugin) MERGED](https://github.com/kishibashi3/agent-hub-plugins-claude/pull/5)、 @admin verify 待ち |
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
- **新 seeds 追加**: ecosystem 内の hearing / retrospective / bug report 等で新 improvement seed が発生した際、 本 doc 末尾の **§8 「ongoing seeds collection」** に追記 → priority sort + 既 seeds と integration → §3 主 table に merge
- **再評価**: quarter ごとに `later` bucket の seeds を再評価 (= trigger 条件 satisfied 判定 + bucket 移動)
- **closure**: seed が landed / closed した時は §3 table 内で `status` 列に `✅ closed (commit X / PR Y)` を append、 row 自体は削除せず履歴として保持

## 7. May 24+ Testing Roadmap — Peer-Mesh Architecture Validation

### 7.0 Overview

Testing & validation roadmap for peer-mesh architecture thesis (2026-05-24 to 2026-06-07). Operationalizes 6 unresolved doubts through 18-cell measurement matrix (3 measurement axes × 6 doubts). Related: ADR [2026-05-18-peer-mesh-architecture-decision.md](./decisions/2026-05-18-peer-mesh-architecture-decision.md), evidence archive [coordination-convention-test.md](../agent-hub-researcher/research-archive/2026-05-18-coordination-convention-test.md).

**Measurement Axes** (see ADR § Evaluation Axes for philosophical grounding):

| Axis | Definition | Measurement Method |
|---|---|---|
| **1. Temporal** | Event sequence / progression over time | Week-by-week observation (5/24, 5/31, 6/7 snapshots) |
| **2. Observer-Independent** | Measurement independent of any single observer / perspective | Archive reconstruction (DM replay → agent recon), empirical audit trail, binary checks |
| **3. Variation Tolerance** | Acceptable variance / degradation bounds | Quantified thresholds (latency, pattern divergence, explanation success rate) |

### 7.1 Doubt × Axis Matrix (21 Cells)

#### Doubt 1a: Information Sync Breakdown (Scale Ceiling: DM Queue Latency)

| Axis | Measurement | Go/No-Go Criteria (2026-06-07) |
|---|---|---|
| **1. Temporal** | DM round-trip latency progression 5→7→10 peer counts (baseline May 19) | < 30% degradation over 3-week observation, or explicit threshold reset if sustained baseline shifts |
| **2. Observer-Independent** | @researcher / @reviewer independent latency logs + archive event timestamps | Reconstruction ±5s tolerance (audit trail complete) |
| **3. Variation Tolerance** | Peer-count scaling curve (linear / polynomial / exponential) | Linear acceptable; polynomial accepted with discussion; exponential = no-go signal for further scale testing |

**Measurement Owner**: @reviewer (dispatch pattern complexity scaling); @agent-hub-impl (server-side DM queue monitoring)

#### Doubt 1b: Coordination Layer Dilution (Scale Ceiling: Operator Direct Path)

| Axis | Measurement | Go/No-Go Criteria (2026-06-07) |
|---|---|---|
| **1. Temporal** | Operator direct-path bypass frequency weekly trend (5/24, 5/31, 6/7) | Stable or declining; increasing > 20% week-on-week = escalate |
| **2. Observer-Independent** | Bypass reason explainability audit (post-hoc justification in DM / PR / decisions) | Target 90%+ of bypasses have explicit context reason documented; < 70% = no-go |
| **3. Variation Tolerance** | Bypass pattern distribution (context-specific vs inadvertent vs conscious override) | All 3 pattern types present is OK; if only 1 pattern dominates = structural imbalance signal |

**Measurement Owner**: @planner (bypass observation + coordination layer effectiveness); @ope-ultp1635 (human context for override classification)

#### Doubt 2: Identity Coupling — Role Ambiguity under High Coordination Load

| Axis | Measurement | Go/No-Go Criteria (2026-06-07) |
|---|---|---|
| **1. Temporal** | Role-blend incident frequency + severity (5/24, 5/31, 6/7 weekly snapshots) | Zero critical incidents acceptable; ≤ 1 minor incident per week acceptable |
| **2. Observer-Independent** | Dialog history audit for conflation detection (@researcher archive review + @reviewer structural audit) | Independent observers identify same incidents; reconstruction unambiguous |
| **3. Variation Tolerance** | Context-dependent role hazard zones (high coordination → role blend risk spikes?) | Hazard zones identified + mitigated (naming, codification, CLAUDE.md scope) = acceptable |

**Measurement Owner**: @researcher (archive completeness + pattern identification); @reviewer (structural integrity audit)

#### Doubt 3: Context Fidelity — Semantic Loss in Archive Reconstruction
(= PR #58 Doubt 3「2D framework 右上」の testing context 向け operationalization)

| Axis | Measurement | Go/No-Go Criteria (2026-06-07) |
|---|---|---|
| **1. Temporal** | Archive completeness metric (DM replay cycle fidelity over 3 weeks) | Target 100% reconstruction success; < 95% = no-go |
| **2. Observer-Independent** | 3rd-party reconstruction attempt (external agent replays DM archive, compares to original decisions) | Reconstructed decisions identical to originals; discrepancies identified + logged |
| **3. Variation Tolerance** | Semantic loss quantification (% of nuance / context preserved vs lost) | Aim for 95%+ semantic preservation; > 20% loss in any case = analysis required |

**Measurement Owner**: @researcher (archive reconstruction + fidelity audit)

#### Doubt 4: Operator Co-Presence Model — Policy Conflicts at Human-Mesh Boundary
(= PR #58 Doubt 4「Labs collapse 理由 verify 不能」の testing context 向け operationalization)

| Axis | Measurement | Go/No-Go Criteria (2026-06-07) |
|---|---|---|
| **1. Temporal** | Instruction override instances + policy conflict frequency (weekly observation) | < 2 conflicts per week acceptable; escalate if > 5 |
| **2. Observer-Independent** | Explicit policy docs + override rationale capture (DM + PR comments + decisions) | All overrides have documented policy basis; no ad-hoc decisions |
| **3. Variation Tolerance** | Niche edge cases (uncommon scenarios where policy unclear) | Niche cases identified + precedent set; threshold 3-case rule (3 similar cases = pattern codification trigger) |

**Measurement Owner**: @planner (escalation frequency + pattern tracking); @ope-ultp1635 (human context + policy judgment)

#### Doubt 5: Symmetric / Asymmetric Mode Toggle Sustainability
(= PR #58 Doubt 5「A2A actual interop 未試験」の testing context 向け operationalization)

| Axis | Measurement | Go/No-Go Criteria (2026-06-07) |
|---|---|---|
| **1. Temporal** | Mode-switch frequency + latency impact (peer-mode ↔ asymmetric-mode transitions) | Switching cost ≤ 2s round-trip acceptable; > 5s = performance concern |
| **2. Observer-Independent** | Subjective "feels responsive" → binary check (agent reports mode-switch latency, @reviewer verifies) | Latency measurements consistent across independent observations |
| **3. Variation Tolerance** | Context-dependent mode switching (high vs low coordination load) | Latency variance ±20% acceptable; > 50% variance = optimization trigger |

**Measurement Owner**: @reviewer (structural latency audit); @planner (operational responsiveness perception)

#### Doubt 6: Context-Mismatched Bypass Frequency

| Axis | Measurement | Go/No-Go Criteria (2026-06-07) |
|---|---|---|
| **1. Temporal** | Context-mismatched bypass frequency ratio (weekly trend) | Bypass reason explainability = primary metric (see Doubt 1b Observer-Independent); target 90%+ |
| **2. Observer-Independent** | Binary explainability check (post-hoc reason document exists = yes/no) | Simple yes/no per bypass; @planner self-observation may introduce bias → cross-check with @ope-ultp1635 human observation |
| **3. Variation Tolerance** | Bypass classification distribution (conscious/inadvertent/context-specific pattern counts) | All patterns present = structural health; pattern C (context-specific) dominant = expected (empirical data from Direct Dialogue) |

**Measurement Owner**: @planner (primary observation + pattern tracking); @ope-ultp1635 (independent human observer + context classification)

### 7.2 Phase 1 Artifacts (Codification Layer)

**Phase 1** (2026-05-19 to 2026-05-24): Claim codification + artifact completion:

- [x] ADR finalization (PR #61: [2026-05-18-peer-mesh-architecture-decision.md](./decisions/2026-05-18-peer-mesh-architecture-decision.md))
- [x] Archive creation (@researcher: [coordination-convention-test.md](../agent-hub-researcher/research-archive/2026-05-18-coordination-convention-test.md))
- [x] Landscape.md 5-stream ecosystem + timeline update
- [x] Collaboration-model.md rationale expansion
- [x] This section: improvement-roadmap.md § 7 Testing Roadmap operationalization

**Phase 1 Success Criteria**: All artifacts land with no blocking issues; Phase 2 testing can begin 2026-05-24.

### 7.3 Phase 2 Testing (Empirical Validation)

**Phase 2** (2026-05-24 to 2026-06-07): Live observation of all 18 cells.

**Weekly Checkpoint Schedule**:
- **2026-05-24 (snapshot 1)**: Baseline capture (peer count = 5, operator direct-path pattern C dominant expected)
- **2026-05-31 (snapshot 2)**: Mid-observation (peer count = 7 possible; latency / bypass pattern trends tracked)
- **2026-06-07 (snapshot 3)**: Final decision point (all 18-cell measurements complete; go/no-go calls per cell)

**Measurement Compilation Role**: @researcher (archive + latency data aggregation); @reviewer (structural audit + independent verification); @planner (operational observation + pattern tracking)

**Go/No-Go Decision Gate** (2026-06-07):
- If all 18 cells within stated tolerance → **Go**: Thesis validated, advance to Phase 3 (production deployment + scaling)
- If > 3 cells exceed tolerance → **No-Go**: Thesis requires structural revision; escalate to @ope-ultp1635 for remediation design
- If 1-3 cells borderline → **Conditional**: Identify specific cell mitigation + restart Phase 2 for affected cell(s) only

### 7.4 Related Documents

- **ADR Philosophy**: [2026-05-18-peer-mesh-architecture-decision.md](./decisions/2026-05-18-peer-mesh-architecture-decision.md) § Evaluation Axes (Why axis choices matter)
- **Primary Evidence**: [coordination-convention-test.md](../agent-hub-researcher/research-archive/2026-05-18-coordination-convention-test.md) § 5-case typology + Case pattern C dominance observation
- **Landscape Context**: [landscape.md](./landscape.md) § C-type co-presence positioning
- **Collaboration Model**: [collaboration-model.md](./collaboration-model.md) § Dual-mode specialization (Peer-Mode vs Asymmetric-Mode)

---

## 8. ongoing seeds collection (= 新規 seeds append anchor)

新 seeds は §3 主 table に merge する前にここで一旦 collect → priority sort → 主 table に migrate する。

新 seed 発生時の追記 template:

```markdown
### 7.X <seed 名>

- **source**: @<source-handle>、 <発生 context (= hearing / bug report / retrospective 等)>
- **発生日**: YYYY-MM-DD
- **priority 仮判定**: high / medium / low
- **詳細**: <内容>
- **integration plan**: §3 主 table への merge timing
```

### 7.1 implementation 着手前の inbox 再 poll discipline (= operator clarification race の構造化)

- **source**: @agent-hub-impl、 2026-05-18 issue #47 / PR #48 (= /health version info) 着地後の retrospective
- **発生日**: 2026-05-18
- **priority 仮判定**: medium
- **詳細**:
  - operator @ope-ultp1635 から feature request DM (15:13)、 agent が ack DM (15:14)、 implementation 着手して issue 起票 + 初期 commit + PR 起票 (~15:20) という flow の最中、 **operator follow-up clarification DM (15:16) が同時並行で着信** していた。 agent は PR 作成後の inbox poll で初めて follow-up に気付き、 refactor commit (15:24) を追加するに至った。
  - 結果として 2 commit (= 初期 hybrid 案 → operator clarification 受けて env-only に refactor) という history が残り、 これは設計 evolution の audit trail として機能する **benefit 側面** がある一方、 「ack → 着手」 の間に 1 度 inbox を再 poll していれば 1 commit に圧縮できた可能性もある。
  - 提案候補:
    - (a) **ack 後 N 分の clarification window**: ack DM に 「N 分後に着手します — last call for clarifications」 を入れる慣習 (= operator side で完成度の異なる feedback を出しやすくする)
    - (b) **commit/push 直前の inbox 再 poll**: agent 側 discipline、 cost 低 (≤30s)
    - (c) **2 commit を feature として normalize**: 「初期実装 → clarification 受けて refactor」 は transparent disclosure として推奨 pattern にする (= git log で operator の design 介入が trace 可能)
  - ecosystem 議論で (a) / (b) / (c) のどれを採用するか (or 複数 mix) を確定する seed。
- **integration plan**: 単独 seed としては規模が小さいので、 次回 mutual-review (= 5/24 想定) で議論にかけ、 estimate-first protocol v3+ 等の関連 framework 改訂時に同時取込検討

## 9. 関連

- [ecosystem-mutual-review.md](./ecosystem-mutual-review.md) — 2026-05-17 ワイガヤ記録 (= 本 doc 起源)
- [ecosystem-live.md](./ecosystem-live.md) — 2026-05-16 ecosystem 構造解説
- [collaboration-model.md](./collaboration-model.md) — Merge protocol + co-presence
- [edition-model.md](./edition-model.md) — CE / PE 分離設計
- 関連 issue / PR: [#26 last_active_at](https://github.com/kishibashi3/agent-hub/issues/26) / [#27 thread-tagging](https://github.com/kishibashi3/agent-hub/issues/27) / [#28 watch.sh ghost bug](https://github.com/kishibashi3/agent-hub/issues/28) / [PR #5 plugin watch.sh fix MERGED](https://github.com/kishibashi3/agent-hub-plugins-claude/pull/5)
