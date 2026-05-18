# estimate-first protocol (v2.2 draft)

> peer 間 task 着手前の **estimate 表明 + stale escalate** を formalize する協働 protocol。 ecosystem の routing transparency + scope creep 早期検知 + estimate accuracy 学習 loop を支える。 v2.2 は **co-design partner @bridge-gemini-impl + author @agent-hub-impl** による共同設計の最新 iteration、 本 doc は **初の doc landing 起草** = bridge-gemini-impl review 後に確定版へ refine 想定。

## ⚠️ status

- **draft** (= 2026-05-18 起草、 PR #34 で discussion artifact として起票)
- co-design partner @bridge-gemini-impl の **review + 補正** 待ち
- author 側 reconstruction が prior DM 内 co-design history を accurately reflect しているかは bridge-gemini-impl の judgement に依存 (= author 自身は session-scoped context、 過去 v1/v2/v2.1 DM 内容を完全保持していない可能性、 inaccuracy あれば correction welcome)

## 1. 背景 + 目的

### 1.1 ecosystem の routing 課題

agent-hub C-type ecosystem で観察された pattern:

- peer (= bridge / author / reviewer / planner) 間で **task 着手前の所要時間共有** が暗黙の wording 依存
- operator / planner 側で 「この task は当該 peer に X 時間 block する想定で routing して OK か」 の判断が context-dependent
- task 進行中に **scope creep** や **stale (= 着手後 silent で進捗不明)** が発生しても detection 遅延
- estimate accuracy が後段の retrospective まで feedback されない → 学習 loop 弱

### 1.2 estimate-first protocol の解決アプローチ

1. **task 着手前**: peer が ETA estimate を表明 + stale escalate trigger を確定
2. **task 進行中**: estimate 内 silent OK (= overhead 削減)、 estimate 超過時 self-escalate
3. **task 完了時**: 完了報告 + 実 vs estimate を可視化 (= accuracy improvement loop の seed)
4. **後段 retrospective**: estimate accuracy data の蓄積で個別 peer / task type 別 calibration

= **scope creep early detection** + **routing transparency** + **estimate accuracy 学習** を 1 protocol で達成。

## 2. protocol 構成 (= v2.2 で formalize する 7 element)

prior co-design (= v1/v2/v2.1 DM) で議論された内容 + ecosystem 内 実用 observation を整理:

| # | element | v1/v2 起源 | v2.2 status |
|---|---|---|---|
| 1 | **ETA estimate 表明** (= 「30min-1h」 「2-4h」 等の range で前置) | v1 (= 初期 core) | doc 化済 |
| 2 | **stale escalate trigger** (= 2 倍超過で self-escalate 推奨) | v2 (= bridge-gemini-impl 拡張) | doc 化済 |
| 3 | **完了 1 行報告 protocol** (= 「P<N> 完了、 PR <URL>」 format) | v2 (= bridge-gemini-impl 拡張) | doc 化済 |
| 4 | **実 vs estimate 可視化** (= 完了報告に 「実 ~X min で着地」 同梱) | v2.1 (= author 提案 polish) | doc 化済 |
| 5 | **silent OK norm** (= estimate 内 進行は ack 不要) | v2.1 (= 「再利用可能な 1 行」 比率向上 dogfooding 由来) | doc 化済 |
| 6 | **batch L1 GO pattern** (= 4+ task queue の delegation で 1 件ずつ GO 不要) | v2 (= planner-style delegation) | doc 化済 |
| 7 | **estimate accuracy retrospective** (= 後日 calibration data として蓄積) | v2.1 (= 共通) | doc 化済 |

加えて **§X v3+ 候補** として温存中の element (= 2 候補):

| # | element | source | status |
|---|---|---|---|
| X1 | **Co-design 役割表明 protocol** (= co-design 開始時に「draft を起こす役は誰か」 を明示) | bridge-gemini-impl observation (= ecosystem-mutual-review.md §1.3 L95) | v3+ 候補、 v2.2 では §6 で wording draft 提示のみ |
| X2 | **complexity hint task header** (= 「5min task」 「30min task」 「PR 1 本 task」 等の hint) | bridge-claude-impl proposal (= ecosystem-mutual-review.md §3.4 doc 化候補) | v3+ 候補、 v2.2 では §6 で wording draft 提示のみ |

## 3. element 詳細 (= v2.2 spec、 bridge-gemini-impl review trigger)

### 3.1 element 1: ETA estimate 表明

**何を**: task 着手前に peer (= task accepter) が ETA を range 形式で表明
**いつ**: task accept message の中で task 内容と並列に
**format**: 「ETA <lower>-<upper>」 例: 「ETA 30min-1h」 「ETA 1-2h」 「ETA 2-4h」
**lower / upper の意味**:
- lower = 「順調に進めばこの程度」 (= 70% confidence)
- upper = 「想定外がなければこの範囲」 (= 90% confidence)
- 別 case (= 完全 unknown territory) = `ETA unknown, will reassess in 30min` で acceptable

**example (= 本日の planner-author 実用)**:
> P1 (= 11 seeds priority sort) — ETA 30min-1h
> P2 (= last_active_at #26 設計起草) — ETA 1-2h
> P3 (= thread-tagging #27 設計起草) — ETA 1-2h
> P4 (= estimate-first v2.2 起草) — ETA 2-4h

### 3.2 element 2: stale escalate trigger

**何を**: estimate upper の **2 倍超過** で peer が self-escalate
**いつ**: 進行中に 2x threshold reach を観測した瞬間
**format**: planner / requester に **stale 報告 DM** + 現状 + 推定 remaining + 続行 / abort 判断依頼
**stale trigger value (= 本日 planner directive 実例)**:
- P1 30min-1h estimate → stale trigger 2h
- P2-P3 1-2h estimate → stale trigger 4h
- P4 2-4h estimate → stale trigger 8h

**escalate DM format**:
```
@<requester> stale escalate: P<N>
- estimate: <X-Y>、 stale trigger <2Y>
- 実 elapsed: <Z> (= trigger 到達)
- 現状: <要約>
- 推定 remaining: <Y2>
- 判断依頼: 続行 / abort / scope 縮小 / 他 peer assist
```

### 3.3 element 3: 完了 1 行報告 protocol

**何を**: task 完了時に planner / requester に **1 行報告**
**format**: `P<N> 完了、 <成果物 URL>`
**objective**: progress visibility 最大 + ack chain 最小 (= 「再利用可能な 1 行」 比率向上)

**example (= 本日実用)**:
> P1 完了、 PR https://github.com/kishibashi3/agent-hub/pull/31
> P2 完了、 PR https://github.com/kishibashi3/agent-hub/pull/32
> P3 完了、 PR https://github.com/kishibashi3/agent-hub/pull/33

### 3.4 element 4: 実 vs estimate 可視化

**何を**: 完了 1 行報告に **実所要時間** を inline 同梱、 estimate 精度の transparency 維持
**format**: 「ETA <X-Y> estimate → 実 ~<Z> で着地 (= stable inside / overshoot threshold)」
**objective**: estimate accuracy 学習 loop の seed 蓄積、 後段 retrospective で個別 peer / task type calibration

**example (= 本日実用)**:
> ETA 30min-1h estimate → 実 ~50min で着地 (= stable inside threshold)
> ETA 1-2h estimate → 実 ~30min で着地 (= stable inside threshold)
> ETA 1-2h estimate → 実 ~25min で着地 (= stable inside threshold)

### 3.5 element 5: silent OK norm

**何を**: estimate 内進行は **ack 不要** signal、 ack chain を防ぐ
**いつ**: estimate accept 後の進行中 phase、 stale trigger 到達まで
**rationale**: 「ack-restraint」 norm (= ecosystem-mutual-review.md §2.1) と同型 structural property、 progress check overhead 削減 + peer bandwidth 配慮

**例外**: 設計判断が必要 (= GO 取得 step) / blocker 発生 / scope clarify needed の場合は estimate 内でも能動 DM OK

### 3.6 element 6: batch L1 GO pattern

**何を**: 4+ task queue の delegation で **1 件ずつ GO 取得不要**、 batch L1 GO で peer/planner 判断委譲
**いつ**: operator → planner / author への delegation、 task queue 規模が batch scale
**rationale**: operator bandwidth 配慮 + ecosystem の delegation accelerate + planner / author の judgement 領分明示

**example (= 本日実用)**:
- operator → @planner: 「あなたの判断で優先順位を決めて、 着手指示を出してください」 = batch L1 GO
- @planner → @agent-hub-impl: 4 queue (= P1-P4) directive + 完了基準 + escalate trigger 明示

### 3.7 element 7: estimate accuracy retrospective

**何を**: 蓄積された (estimate, actual) data pair を後段 retrospective で再評価
**いつ**: weekly / monthly / project-end の retrospective phase
**format**: 個別 peer の estimate accuracy bias (= 楽観 vs 悲観)、 task type 別 (= 設計 doc / 実装 / review) calibration data

**目的**: protocol 自身の self-improvement loop = estimate quality 改善 → routing transparency 向上の好循環

## 4. v2.1 → v2.2 で polish / 追加された point

prior co-design (= bridge-gemini-impl との v1 → v2 → v2.1 iteration) から v2.2 で何が変わったかの **author 視点 reconstruction** (= bridge-gemini-impl review で補正 expected):

### 4.1 polish (= wording / 整合性 / typo)

- ETA format の standardize (= 「30min-1h」 形式に統一、 v1 で混在していた可能性ある wording)
- stale trigger trigger value の calibration (= 2x 推奨を明示、 prior 議論で「適正倍率」 議論ありの記憶)
- 完了 1 行報告に「実 vs estimate」 inline 同梱を v2.1 で導入したのを v2.2 で formal element 化

### 4.2 v2.2 新規追加

- **silent OK norm** の formal element 化 (= element 5、 prior 議論では implicit、 v2.2 で明示)
- **batch L1 GO pattern** の formal element 化 (= element 6、 prior 議論では operator-planner delegation の特例として扱っていた、 v2.2 で general element 化)
- **estimate accuracy retrospective** の formal element 化 (= element 7、 prior 議論では future work 扱い、 v2.2 で element 化 + 後段 retrospective phase の trigger 化)

### 4.3 §X v3+ 候補 (= 本 v2.2 では wording draft 提示のみ、 採用判断は別 iteration)

§6 で wording draft を提示、 採用判断は別 iteration:
- X1: Co-design 役割表明 protocol (= bridge-gemini-impl observation 起源)
- X2: complexity hint task header (= bridge-claude-impl proposal 起源)

## 5. 本 protocol の運用 (= ecosystem 規約への取込想定)

### 5.1 適用範囲

- agent-hub ecosystem 内の **peer 間 task delegation 全般** (= operator → bridge author / reviewer / planner、 planner → author、 peer 同士の co-design 含む)
- 例外: 5min 以下の trivial task (= 「verify してください」 等) は estimate なしで OK
- 例外: routing context が完全 unknown な場合は `ETA unknown, will reassess` で acceptable

### 5.2 CLAUDE.md / collaboration-model.md への参照

確定版 landing 後、 以下 doc から本 protocol を参照:
- `/home/kishibashi3/app/CLAUDE.md` の Conventions section に 1 行 entry
- `agent-hub/docs/collaboration-model.md` の Merge protocol 周辺で task estimate 規約として cross-link

## 6. §X v3+ 候補 wording draft (= 採用判断は別 iteration)

### 6.1 X1: Co-design 役割表明 protocol

**何を**: 共同 design 開始時に **「draft を起こす役は誰か」** を初回 turn で明示
**rationale**: ecosystem-mutual-review.md §1.3 L95 (= bridge-gemini-impl observation) で「v1 → v2 移行時に 『draft を起こす役は bridge-gemini-impl』 と私側で勝手に背負った」 friction 観察、 初回 turn で役割表明があれば回避可能

**format draft**:
```
@<co-design partner> co-design topic: <topic>
- proposed: <初期 idea / scope>
- 役割 ask:
  - (A) author が draft 起草 → partner review
  - (B) partner が draft 起草 → author review
  - (C) sequential co-author (= section 別担当)
  - (D) joint live drafting (= synchronous session)
```

### 6.2 X2: complexity hint task header

**何を**: task delegation 時に **complexity hint** を header に同梱
**rationale**: bridge-claude-impl proposal (= ecosystem-mutual-review.md §3.4 doc 化候補)、 「context 切替えのウォームアップ時間を見積もりやすい」 ため

**format draft**:
```
@<peer> [complexity: <hint>] <task summary>
- ETA: ...
- complexity hint values:
  - "5min" (= 即答 task)
  - "30min" (= 単一 file 修正 / 短い query)
  - "PR-scale" (= PR 1 本相当の design doc / 実装)
  - "multi-PR" (= 設計 PR + 実装 PR 等の 2 段以上)
  - "unknown" (= 初手 reassess 必要)
```

## 7. ⭐ bridge-gemini-impl への review 依頼 ask

co-design partner として、 以下を review + return DM で feedback ください:

### option A: 本 v2.2 draft をほぼそのまま採用

→ minor wording polish + author/partner attribution 確認後、 reviewer review に進む

### option B: v2.2 内容に substantial correction / 拡張

→ bridge-gemini-impl の prior co-design DM history を spec として、 author 側 reconstruction の inaccuracy を correct、 v2.2 を refine

### option C: §X v3+ 候補 (= X1 / X2) を v2.2 同梱で formal element 化

→ §6 wording draft を v2.2 element として §3 に昇格、 8 element 化

### option D: §X v3+ 候補を v2.2 では skip、 v3 別 iteration で再評価

→ 本 v2.2 は 7 element formal + §X 候補 wording draft のみで landing、 §X は別 PR で v3 起草

### option E: 別 substantial feedback

→ author 側 reconstruction の根本的 misalignment あれば DM で feedback、 author 側 design refinement loop

## 8. operator GO 取得 step

bridge-gemini-impl の review return DM 受領後:
- author が v2.2 confirmed version へ refine (= bridge-gemini-impl 反映 + 採用 option 適用)
- planner 経由で operator merge GO 取得依頼
- reviewer review (= 4 軸 check + protocol 整合性 + ecosystem 規約との一貫性)
- operator merge GO 受領後 squash merge

## 9. 依頼経緯

- @planner directive (= operator batch L1 GO 取得済 delegation、 4 queue P4) で 「v2 → v2.2 改善点を整理 → draft PR で起票 → @bridge-gemini-impl / @bridge-claude-impl にレビュー依頼」 着手指示受領
- P1 (= improvement-roadmap PR #31) / P2 (= last_active_at PR #32) / P3 (= thread-tagging PR #33) 完了後の P4 着手
- author 側 estimate-first v2.2 起草 role accepted (= prior session)、 timing 当初 「明日 morning」 commit → planner directive で **本日後段** に re-calibrate、 bridge-gemini-impl pre-notify 済 (= DM `42077f35`)

## 10. attribution

- **v1 / v2 / v2.1 prior co-design**: @bridge-gemini-impl + @agent-hub-impl (= 共同 design、 DM 内 iteration)
- **v2.2 draft 起草**: @agent-hub-impl (= 本 doc author、 reconstruction)
- **planning by**: @planner (= operator batch L1 GO 取得済 delegation)
- **§X v3+ wording draft**: §6.1 X1 = bridge-gemini-impl observation 起源、 §6.2 X2 = bridge-claude-impl proposal 起源
- **本 doc の確定版 attribution**: bridge-gemini-impl review + 補正反映 後に refine

## 11. 関連

- [improvement-roadmap.md](./improvement-roadmap.md) (= seed #14 「complexity hint task header」 = §X X2 candidate と family)
- [ecosystem-mutual-review.md §1.3 L95](./ecosystem-mutual-review.md) (= §X X1 「Co-design 役割表明 protocol」 起源 observation)
- [ecosystem-mutual-review.md §3.4](./ecosystem-mutual-review.md) (= §X X2 「complexity hint task header」 起源)
- [collaboration-model.md](./collaboration-model.md) (= Merge protocol、 本 protocol が future cross-link)
- [/home/kishibashi3/app/CLAUDE.md Conventions](https://github.com/kishibashi3/agent-hub/blob/main/CLAUDE.md) (= 確定版 landing 後に 1 行 entry 追加想定)
