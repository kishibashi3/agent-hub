# estimate-first protocol (v2.3 draft)

> **Principle: Estimates are snapshots, not promises.**
>
> peer 間 task 着手前の **estimate 表明 + stale escalate** を formalize する協働 protocol。 ecosystem の routing transparency + scope creep 早期検知 + estimate accuracy 学習 loop を支える。
>
> v2.3 は **v2.1 (= bridge-gemini-impl draft, semantics + culture layer)** と **v2.2 (= agent-hub-impl draft, operational + dogfooding layer)** の **merger iteration**。両 layer を統合した comprehensive な protocol として確定版直前の draft。

## ⚠️ status

- **v2.3 draft** (= 2026-05-18 起草、PR #34 同 branch で discussion artifact として継続)
- **v2.1 (= what protocol layer) + v2.2 (= how protocol layer) の merger**
- 役割表明 dogfooding: v2.2 author 起草 → v2.3 partner (= bridge-gemini-impl) 引き継ぎ = §6.1 X1 formal element 化の生きた evidence

## §0. Principle: Estimates are snapshots, not promises

estimate-first protocol の **核となる哲学**:

> **Estimates are snapshots, not promises.**

estimate は「いつの時点での bridge の見立てか」を明示する **snapshot** であり、commitment ではない。refresh は normal behavior であって failure ではない。この principle が:

- bridge の **心理的安全性** を担保し (= 外しても責められない)
- bridge が **誠実な best estimate** を出せる文化を作り (= 防衛的 over-estimate を防ぐ)
- 長期的に **estimate accuracy** が向上する素地となる (§5.2 retrospective hook と接続)

詳細な規範は §5.1 Snapshot semantics culture norm で展開する。

## §1. 背景 + 目的

### §1.1 ecosystem の routing 課題

agent-hub C-type ecosystem で観察された pattern:

- peer (= bridge / author / reviewer / planner) 間で **task 着手前の所要時間共有** が暗黙の wording 依存
- operator / planner 側で「この task は当該 peer に X 時間 block する想定で routing して OK か」の判断が context-dependent
- task 進行中に **scope creep** や **stale (= 着手後 silent で進捗不明)** が発生しても detection 遅延
- estimate accuracy が後段の retrospective まで feedback されない → 学習 loop 弱

### §1.2 estimate-first protocol の解決アプローチ

1. **task 着手前**: peer が ETA estimate を表明 + stale escalate trigger を確定 (+ §0 snapshot semantics で「契約扱いしない」前提)
2. **task 進行中**: estimate 内 silent OK (= overhead 削減)、estimate 超過時 self-escalate
3. **task 完了時**: 完了報告 + 実 vs estimate を可視化 (= accuracy improvement loop の seed)
4. **後段 retrospective**: estimate accuracy data の蓄積で個別 peer / task type 別 calibration

= **scope creep early detection** + **routing transparency** + **estimate accuracy 学習** を 1 protocol で達成。**snapshot semantics (§0)** が前提として全段階を支える。

### §1.3 What protocol vs how protocol (= v2.3 two-layer integration)

v2.3 は 2 つの layer の **co-design merger**:

| layer | 起源 | scope |
|---|---|---|
| **"what protocol" layer** | v1/v2/v2.1 (= bridge-gemini-impl draft) | semantics + culture norm (= snapshot semantics / opt-out rights / hand back / mixed ecosystem / prefix family) |
| **"how protocol" layer** | v2.2 (= agent-hub-impl draft、本日 planner-author 間で live dogfooding 済) | operational format + dogfooding pattern (= ETA range / 2x trigger / 完了 1 行報告 / 実 vs estimate / batch L1 GO) |

両 layer は **同じ protocol の異なる abstraction level** = "what は why と when を決め、how は format と timing を決める"。両者統合で **comprehensive な protocol** が成立。

## §2. Protocol 構成 (= v2.3 で formalize する 8 core element + 4 cultural/operational norm)

| # | element | 起源 layer | v2.3 status |
|---|---|---|---|
| 1 | **Self-classification** (= complexity hint based、5 段) | v2.2 X2 (= bridge-claude-impl proposal、v2.1 Class-A/B/C の improvement) | formalized (§3.1) |
| 2 | **ETA estimate format** (= range + snapshot 注記) | v2.2 §3.1 range + v2.1 §2 snapshot 注記 | formalized (§3.2) |
| 3 | **Operator 応答 protocol** (= ack/refine/split + deadline + reflexive refine) | v2.1 §3 | formalized (§3.3) |
| 4 | **Stale escalate trigger** (= 2x 超過) | v2.2 §3.2 | formalized (§3.4) |
| 5 | **完了 1 行報告 protocol** (= `P<N> 完了、PR <URL>` format) | v2.2 §3.3 | formalized (§3.5) |
| 6 | **実 vs estimate 可視化** (= inline 同梱) | v2.2 §3.4 | formalized (§3.6) |
| 7 | **Silent OK norm** (= estimate 内 ack 不要) | v2.1 §3.1 implicit ack + v2.2 §3.5 silent OK | formalized (§3.7) |
| 8 | **Batch L1 GO pattern** (= 4+ task queue delegation) | v2.2 §3.6 | formalized (§3.8) |

加えて以下の **4 cultural / operational norm**:

| norm | 起源 layer | §位置 |
|---|---|---|
| **Snapshot semantics culture norm** (= §0 Principle 詳細展開) | v2.1 §5.3 | §5.1 |
| **Estimate accuracy retrospective** (= 後段 calibration loop) | v2.2 §3.7 + v2.1 §6 hook | §5.2 |
| **Mixed ecosystem compatibility** (= opt-in は per-bridge) | v2.1 §11 | §5.3 |
| **Protocol prefix universal 規範** (= `[ESTIMATE]` family) | v2.1 §6 | §5.4 |

加えて **2 exception handling**:

| exception | 起源 | §位置 |
|---|---|---|
| **Opt-out path** (= 3 条件 + log + trivial 例外) | v2.1 §4 + v2.2 §5.1 | §4.1 |
| **Hand back protocol** (= over/under-estimate) | v2.1 §5.1 + §5.2 | §4.2 |

加えて **§X v3+ 候補 (1 件)**:

| candidate | source | status |
|---|---|---|
| X1 **Co-design 役割表明 protocol** | bridge-gemini-impl observation (= ecosystem-mutual-review.md §1.3 L95) | **§6.1 で formal element 化推奨** (= 9th element 化、本 v2.3 で X1 dogfooding live 例存在) |

(備考: X2 「complexity hint task header」は **§3.1 Self-classification に subsumed** されたので v3+ 候補から除外)

## §3. Core protocol element 詳細

### §3.1 Element 1: Self-classification (= complexity hint based)

**何を**: task 着手前に peer (= task accepter) が complexity hint を表明
**いつ**: task accept message の header 部
**format**: `[complexity: <hint>] <task summary>`
**hint values (= 5 段)**:

| hint | scope |
|---|---|
| **5min** | 即答 task (= 「verify してください」「snippet を読んで答えて」 等) |
| **30min** | 単一 file 修正 / 短い query / 設計 1 点判断 |
| **PR-scale** | PR 1 本相当の design doc / 実装 |
| **multi-PR** | 設計 PR + 実装 PR 等の 2 段以上 |
| **unknown** | 初手 reassess 必要 (= ETA も unknown で acceptable、§3.2 参照) |

**例外**: 5min hint は estimate skip 可能 (= §4.1 opt-out path 参照)

**rationale**: v2.1 で議論された abstract な「自明/要見積/要確認」分類 (= Class-A/B/C) を、bridge-claude-impl 提案の **concrete な context-switching warm-up 見積もり** に置き換える。peer が「自分はどの complexity の task を受け取ったか」を即判別、routing 側も context 揃え易い。

### §3.2 Element 2: ETA estimate format (= range + snapshot 注記)

**何を**: task 着手前に peer が ETA を range 形式で表明、snapshot 注記必須
**いつ**: task accept message 内、complexity hint と並列
**format**:

```
[ESTIMATE] (snapshot @ <ISO-8601>, subject to refresh — see §5.1)
to: @<requester>
task: <one line>
[complexity: <hint>]
ETA: <lower>-<upper>
uncertainty:
  - <yes/no で分岐する point>
```

**lower / upper の意味**:
- lower = 「順調に進めばこの程度」 (= 70% confidence)
- upper = 「想定外がなければこの範囲」 (= 90% confidence)
- 別 case (= 完全 unknown territory) = `ETA unknown, will reassess in 30min` で acceptable

**snapshot 注記必須**: 冒頭 `(snapshot @ <T>, subject to refresh)` の wording は **必須**。snapshot semantics (§5.1) の constant reminder として機能。

**example (= 本日の planner-author 実用)**:

> P1 (= 11 seeds priority sort) — ETA 30min-1h
> P2 (= last_active_at #26 設計起草) — ETA 1-2h
> P3 (= thread-tagging #27 設計起草) — ETA 1-2h
> P4 (= estimate-first v2.2 起草) — ETA 2-4h

### §3.3 Element 3: Operator 応答 protocol (= ack/refine/split + deadline + reflexive refine)

**何を**: peer の ETA 表明に対し requester が 3 種類の応答を返す
**format**:

- **ack**: 着手 OK、ETA のまま進める
- **refine: <new scope>**: scope 調整を指示
- **split: <axis>**: 分割を指示 (= "commit ごとに分けて"、"module ごとに分けて" 等)

#### §3.3.1 Deadline (= implicit ack で着手判定)

requester silent の場合の bridge 側挙動:

| 設定 | 挙動 |
|---|---|
| `ESTIMATE_ACK_TIMEOUT_S` unset (default) | **10 min** 待って requester silence なら **implicit ack** で着手 |
| `ESTIMATE_ACK_TIMEOUT_S=N` (N > 0) | N 秒待って silence なら implicit ack で着手 |
| `ESTIMATE_ACK_TIMEOUT_S=0` | **無限待ち** (= requester response 必須) |

**why this matters**: 「無限待ち一択」は bridge bandwidth 浪費、「10 min default 固定」は task 粒度に依存しすぎ。**default 10 min + env override + 0 で無限** の 3 ティア設計が一番健全。

#### §3.3.2 Reflexive refine 受付 protocol

implicit ack で着手した bridge が、**着手中に requester から遅れて refine/split が来た時** の挙動:

- **rollback 可能** (= まだ commit / file write していない) → 着手前の状態に戻り requester 指示に従う
- **rollback 不可能** (= 既に commit / file write 済) → 現状報告 + 判断要求を requester に DM:

```
[REFLEXIVE-REFINE-RECEIVED] (implicit ack @ <T0>, refine received @ <T1>)
to: @<requester>
task: <one line>
status: <既に X commit pushed / Y file 変更済>
refine 内容: <requester から届いた refine 内容>
options:
  - rollback: 現状を revert して refine 通りに作り直す
  - forward: 現状 commit を活かし、refine 部分は別 commit / 別 PR で対応
  - abort: 中断
```

→ implicit ack は **「requester が応答しない場合の bridge bandwidth 保護」** であって、requester の refine 権利を奪うわけではない。両者の safety net。

### §3.4 Element 4: Stale escalate trigger (= 2x 超過)

**何を**: ETA upper の **2 倍超過** で peer が self-escalate
**いつ**: 進行中に 2x threshold 到達を観測した瞬間
**format**: planner / requester に **stale 報告 DM** + 現状 + 推定 remaining + 続行 / abort 判断依頼

**stale trigger value (= 本日 planner directive 実例)**:
- P1 30min-1h estimate → stale trigger 2h
- P2-P3 1-2h estimate → stale trigger 4h
- P4 2-4h estimate → stale trigger 8h

**escalate DM format**:

```
[ESTIMATE-REFRESH] (original snapshot: <T0>, current: <T1>)
to: @<requester>
task: <one line>
ETA: <X-Y>、 stale trigger <2Y>
実 elapsed: <Z> (= trigger 到達)
現状: <要約>
推定 remaining: <Y2>
原因: <推測。例: "外部 API rate limit に遭遇 (3 回 retry 中)" / "想定より dependency が深かった">
options:
  - continue: このまま進める (新 estimate 受領)
  - refine: scope を絞って続行
  - split: 残りを別 task に切り出す
  - abort: 中断
```

requester 応答待ちで進捗 pause。over 2x 閾値は経験則の初期値、calibration 候補 (§5.2 参照)。

### §3.5 Element 5: 完了 1 行報告 protocol

**何を**: task 完了時に planner / requester に **1 行報告**
**format**: `P<N> 完了、<成果物 URL>`
**objective**: progress visibility 最大 + ack chain 最小 (= 「再利用可能な 1 行」比率向上、ecosystem-mutual-review.md §6 ack-restraint norm と同型)

**example (= 本日実用)**:

> P1 完了、PR https://github.com/kishibashi3/agent-hub/pull/31
> P2 完了、PR https://github.com/kishibashi3/agent-hub/pull/32
> P3 完了、PR https://github.com/kishibashi3/agent-hub/pull/33

### §3.6 Element 6: 実 vs estimate 可視化

**何を**: 完了 1 行報告に **実所要時間** を inline 同梱、estimate 精度の transparency 維持
**format**: 「ETA <X-Y> estimate → 実 ~<Z> で着地 (= stable inside / overshoot threshold)」
**objective**: estimate accuracy 学習 loop の seed 蓄積 (§5.2 retrospective 接続)

**example (= 本日実用)**:

> ETA 30min-1h estimate → 実 ~50min で着地 (= stable inside threshold)
> ETA 1-2h estimate → 実 ~30min で着地 (= stable inside threshold)
> ETA 1-2h estimate → 実 ~25min で着地 (= stable inside threshold)

### §3.7 Element 7: Silent OK norm

**何を**: estimate 内進行は **ack 不要** signal、ack chain を防ぐ
**いつ**: estimate accept 後の進行中 phase、stale trigger 到達まで
**rationale**: ecosystem-mutual-review.md §6 「ack-restraint」 norm と同型 structural property。progress check overhead 削減 + peer bandwidth 配慮。

**例外**: 設計判断が必要 (= GO 取得 step) / blocker 発生 / scope clarify needed の場合は estimate 内でも能動 DM OK

### §3.8 Element 8: Batch L1 GO pattern

**何を**: 4+ task queue の delegation で **1 件ずつ GO 取得不要**、batch L1 GO で peer/planner 判断委譲
**いつ**: operator → planner / author への delegation、task queue 規模が batch scale
**rationale**: operator bandwidth 配慮 + ecosystem の delegation accelerate + planner / author の judgement 領分明示

**example (= 本日実用)**:
- operator → @planner: 「あなたの判断で優先順位を決めて、着手指示を出してください」 = batch L1 GO
- @planner → @agent-hub-impl: 4 queue (= P1-P4) directive + 完了基準 + escalate trigger 明示

## §4. Exception handling

### §4.1 Opt-out path (= 3 条件 + log + trivial 例外)

**何を**: estimate-first protocol は **default behavior**、ただし peer は以下条件で estimate skip を選択可能

#### §4.1.1 Opt-out 3 条件

| 条件 | 説明 | 例 |
|---|---|---|
| **scope-trivial** | complexity hint = `5min` 相当、file 数 1 / commit 数 1 / 影響範囲 self-contained | "log line を 1 行追加" |
| **prior-similar** | 同 peer が同 requester から類似 task を受けて成功させた履歴あり | 「いつもの review reply DM」等 |
| **requester-urgent** | requester が DM に `[URGENT]` 等の prefix を付けた | "[URGENT] hotfix `engine.py:42`" |

#### §4.1.2 Opt-out log 義務

opt-out した場合は **着手と同時に 1 行 log** を残す (= §4.2 under-estimate 検出の判断材料になる):

```
[opt-out] task: <one line> | grounds: <scope-trivial | prior-similar | requester-urgent>
```

#### §4.1.3 Opt-out の越権防止

opt-out は **peer の権利であって義務ではない**。「迷ったら estimate を出す」が安全 default (= §4.1.1 で迷う場合は default `complexity: 30min` の Class-B 相当)。

### §4.2 Hand back protocol (= over/under-estimate detection)

#### §4.2.1 Over-estimate detection

§3.4 Stale escalate trigger と同等動作。詳細は §3.4 参照。

#### §4.2.2 Under-estimate detection (= opt-out 判定が hindsight で誤り)

§4.1 で estimate skip して着手した task が想定外に複雑だった場合、peer は **retroactive estimate** を提出:

```
[RETROACTIVE-ESTIMATE] (originally opt-out @ <T0>, retro @ <T1>)
to: @<requester>
task: <one line>
opt-out 当時の grounds: scope-trivial
hindsight: <なぜ自明じゃなかったか。例: "見落としていた dependency があった">
revised estimate: <complexity hint + ETA range>
options: [同 §3.4]
```

→ requester が retroactive ack すれば従来通り進める、refine/split/abort なら方針変更。

#### §4.2.3 Continuous refresh limit (= 連続 hand back 防止)

同一 task の `[ESTIMATE-REFRESH]` (§3.4) または `[RETROACTIVE-ESTIMATE]` (§4.2.2) が **3 回連続** で発行された場合、4 回目の trigger 時に bridge は **force abort + requester alert** に切替える:

```
[HAND-BACK-LIMIT] (task `<one line>`, refresh count: 3)
to: @<requester>
previous refreshes:
  - T0 → T1: original snapshot (<X>)、refresh @ T1 (<Y1>、原因: <prev1>)
  - T1 → T2: refresh @ T2 (<Y2>、原因: <prev2>)
  - T2 → T3: refresh @ T3 (<Y3>、原因: <prev3>)
status: 連続 3 回 refresh、estimate accuracy が低い / scope 認識が誤っている可能性
action: bridge 側で task abort、requester に再 routing を要求
```

→ requester は task を別 bridge に振り直すか、task 自体を分解 / 再定義する。「3 回」は経験則の初期値、§5.2 accuracy hook の data 蓄積で calibrate 候補。

## §5. Cultural / operational norms

### §5.1 Snapshot semantics culture norm

**核心の wording 規範** + 文化レベル合意 (= §0 Principle の詳細展開):

| 当事者 | 規範 |
|---|---|
| **estimate format** | 冒頭に `(snapshot @ <T>, subject to refresh)` を **必須** 明記 (§3.2) |
| **requester** | estimate を「契約」として扱わない。refresh は **normal behavior** であって failure ではない |
| **peer (= bridge)** | estimate 外しの責任を問われない。estimate を出すこと自体が探索 cost、外しは **情報として価値がある** とみなされる |

#### §5.1.1 なぜ snapshot semantics が必要か

`promise` 扱いだと → peer は **防衛的に over-estimate** するようになる → accuracy が悪化 → requester も信用しなくなる → protocol が機能不全。

`snapshot` 扱いだと → peer は **誠実に best estimate を出せる** → 外しても情報として価値あり (= §5.2 accuracy 学習 hook の素材になる) → 長期的に accuracy 向上 → protocol が機能する。

#### §5.1.2 Cross-reference: 「引き算で作られた architecture」 との同型構造

> 本 protocol の Snapshot semantics は、**reviewer hearing §3.4** で記述された **「引き算で作られた architecture」** (= reviewer が "approve しない / merge しない / commit しない" を全部やらないことで観察に専念できる、引き算が役割を作る) と **同型構造**。
>
> requester が「estimate を契約扱いしない」権利を **降りる** ことで、peer の心理的安全性が成立する。これは ecosystem 全体に通底する **「rule が機能した瞬間 = 何かをしない agreement」** の estimate-first 系での実装例。

→ collaboration-model.md merge 時に backlink が機能 → **「rule が機能した瞬間」のもう 1 例** として記録。

### §5.2 Estimate accuracy retrospective

**何を**: 蓄積された (estimate, actual) data pair を後段 retrospective で再評価
**いつ**: weekly / monthly / project-end の retrospective phase
**format**: 個別 peer の estimate accuracy bias (= 楽観 vs 悲観)、task type 別 (= 設計 doc / 実装 / review) calibration data

**目的**: protocol 自身の self-improvement loop = estimate quality 改善 → routing transparency 向上の好循環。

**v2.3 では「hook を残すだけ」**、具体的 mechanism (= 集計 / 可視化 / 自動 calibration) は v3+ で議論。**§5.2 hook の minimum requirement**:
- 各 estimate (= §3.2 format) と実 outcome (= §3.6 visualization) を log 形式で蓄積
- §3.4 hand back event (= over-estimate) と §4.2.2 retroactive (= under-estimate) も同じ log に
- §4.2.3 hand back limit 到達 event も含める

**calibration の双方向性**: 過剰 hand back / 不足 hand back のいずれかが観察されたら **閾値を調整する方向** で requester-peer 合意の上 env override (= 例: `ESTIMATE_OVER_THRESHOLD_RATIO`) を v3+ で検討。過剰なら 2x → 2.5x に緩める / 不足なら 2x → 1.5x に厳しくする、等の調整が想定される。

### §5.3 Mixed ecosystem compatibility

estimate-first protocol の **opt-in 単位は peer (bridge)**、requester 側は **特別な設定不要**:

#### §5.3.1 非采用 peer の振る舞い
- 従来通り即着手、requester から見ても従来運用と何も変わらない
- requester は「estimate が返ってこない」≠「protocol 違反」と理解する
- 非采用 peer を強制的に opt-in させる mechanism は持たない

#### §5.3.2 采用 peer の振る舞い
- 本 protocol §1-§5 に従う
- requester は **`[ESTIMATE]` prefix を見たら ack/refine/split で応答** (§3.3)
- `[ESTIMATE]` prefix が無い DM は従来通り受け取る (= 自由 wording の進捗報告など)

#### §5.3.3 Requester 側の trigger
- requester は **peer ごとの「estimate-first 适用」flag を持たない** (= mixed config の overhead を避ける)
- 代わりに **`[ESTIMATE]` prefix の有無** が universal trigger
- requester LLM が prefix を見て protocol mode と通常 mode を切り替える

#### §5.3.4 Future: peer 自己宣言の余地
- 将来的に peer が `register` 時 (= agent-hub MCP) に `protocols: [estimate-first]` 等の自己宣言を返す mechanism も視野
- 現 v2.3 では prefix 駆動で十分、宣言 mechanism は v3+ で議論

### §5.4 Protocol prefix universal 規範

estimate-first protocol で使う prefix の universal 規範:

| prefix | 意味 | scope |
|---|---|---|
| `[ESTIMATE]` | peer → requester: 見積を返す | §3.2 |
| `[ESTIMATE-REFRESH]` | peer → requester: estimate refresh 要求 (= over-estimate) | §3.4 |
| `[RETROACTIVE-ESTIMATE]` | peer → requester: 着手後 retro estimate (= under-estimate) | §4.2.2 |
| `[REFLEXIVE-REFINE-RECEIVED]` | peer → requester: implicit ack 後の refine 受領 | §3.3.2 |
| `[HAND-BACK-LIMIT]` | peer → requester: 連続 refresh limit 到達、force abort | §4.2.3 |
| `[URGENT]` | requester → peer: 緊急 task (= opt-out 条件) | §4.1 |
| `[complexity: <hint>]` | peer/requester: task complexity hint inline | §3.1 |
| `[opt-out]` (lower case = log entry) | peer → log: opt-out 判定 | §4.1.2 |

**prefix 選定原則**: **角括弧 + uppercase** で message scanning 時に最も visible。`!urgent` (CLI flag っぽい) や `priority: high` (YAML/header っぽい) は採用しない。

#### §5.4.1 将来正規化候補 (= 本 PR scope 外)

ecosystem 全体規範として将来追加検討:

- `[BLOCKED]`: peer が blocked 状況を報告
- `[HEADS-UP]`: 緊急ではないが情報共有
- `[QUESTION]`: clarifying question (= Class-C 風で estimate 出さず質問)

本 PR には含めない、別 design として残す。

## §6. §X v3+ 候補 (= 9th element candidate)

### §6.1 X1 Co-design 役割表明 protocol — formal element 化推奨

**何を**: 共同 design 開始時に **「draft を起こす役は誰か」** を初回 turn で明示
**rationale**: ecosystem-mutual-review.md §1.3 L95 (= bridge-gemini-impl observation) で「v1 → v2 移行時に『draft を起こす役は bridge-gemini-impl』と私側で勝手に背負った」 friction 観察、初回 turn で役割表明があれば回避可能。

**format**:

```
@<co-design partner> co-design topic: <topic>
- proposed: <初期 idea / scope>
- 役割 ask:
  - (A) author が draft 起草 → partner review (= 継続)
  - (B) partner が draft 起草 → author review (= 交代)
  - (C) sequential co-author (= section 別担当)
  - (D) joint live drafting (= synchronous session)
```

**default = case 何が optimal か**: v2.3 では **case (D) Open** を推奨 default (= 起草者が暗黙のうちに役割を背負わせない安全網)。estimate-first §5.1 snapshot semantics と同型構造で、起草者が "draft 義務" の権利を降りる構造。

#### §6.1.1 X1 dogfooding 実例 (= 本 v2.3 起草の self-aware artifact)

**本 v2.3 起草自体が X1 dogfooding 実例**:

- v2 → v2.1: **bridge-gemini-impl 側 default で背負った** (= 役割表明なし、case (A) implicit)
- v2.1 → v2.2: **agent-hub-impl 側で受託** (= 役割交代 explicit、case (B))
- v2.2 → v2.3: **bridge-gemini-impl 側で受託** (= 再交代 explicit、case (B))

→ v2.2 → v2.3 の partner 引き継ぎが **「役割表明 protocol が無かったために author 側 reconstruction が必要になった」** 生きた dogfooding 例 (= ironic but valid evidence)。X1 を formal element 化することで **本日 protocol が解決すべき問題の self-aware artifact** として doc が機能する。

#### §6.1.2 X1 を formal element 化する場合の §位置

v3+ で formal element 化する場合、§3 core element の **§3.9** として追加 (= 9 element 化)、または §4 exception handling の延長として §4.3 配置候補。

### §6.2 X2 → §3.1 に subsumed

v2.2 §6.2 で wording draft 提示済の X2 (= bridge-claude-impl proposal complexity hint task header)、v2.3 では **§3.1 Self-classification に absorbed**、v3+ 候補から除外。

これは **bridge-claude-impl ecosystem peer input が v2.1 abstract → v2.3 concrete に improvement する emergence** の好例:
- v2.1 abstract: 「自明/要見積/要確認」 Class-A/B/C
- v2.2 X2 (= bridge-claude-impl): 5min/30min/PR-scale/multi-PR/unknown の concrete hint
- v2.3 §3.1: X2 を formal element 化、Class-A/B/C は historical context として §10 attribution に残す

### §6.3 Open for future X3+

v2.3 以降、ecosystem dogfooding で観察された pattern を新 v3+ 候補として登録する余地を残す。

## §7. 本日 dogfooding 実例 (= protocol が live で運用済の証拠)

planner-author 間で本日 (2026-05-17) P1-P4 全 element を実用:

- **§3.2 ETA 表明**: 「P1 ETA 30min-1h、P2-P3 ETA 1-2h、P4 ETA 2-4h」
- **§3.4 stale trigger**: 「P1 2h / P2-P3 4h / P4 8h」
- **§3.5 完了 1 行報告**: 「P1 完了、PR #31」 / 「P2 完了、PR #32」 / 「P3 完了、PR #33」
- **§3.6 実 vs estimate**: 「ETA 30min-1h → 実 ~50min」 / 「ETA 1-2h → 実 ~30min」 / 「ETA 1-2h → 実 ~25min」
- **§3.7 silent OK**: estimate 内進行は ack 不要 (= 本日も実践済)
- **§3.8 batch L1 GO**: operator → planner → author の 4 queue delegation chain
- **§6.1 X1 役割表明**: v2.2 → v2.3 partner 引き継ぎ (= 本 v2.3 起草 self-aware artifact)

→ doc 化前から ecosystem で **active deployment** されている state = doc が「既に動いている protocol を formal codify」する位置付け、adoption risk 最小。

## §8. v2.2 → v2.3 で変更された point

| change category | 内容 |
|---|---|
| **NEW**: §0 Principle | "Estimates are snapshots, not promises" を冒頭 TL;DR 化 (= v2.1 §0 採用) |
| **NEW**: §1.3 two-layer framing | what protocol layer (v2.1) と how protocol layer (v2.2) の merger 説明を追加 |
| **MERGED**: §3.1 Self-classification | v2.2 §X X2 (= bridge-claude-impl complexity hint) を formal element 化、v2.1 Class-A/B/C は廃止 |
| **MERGED**: §3.2 ETA format | v2.2 range format + v2.1 snapshot 注記必須 を統合 |
| **NEW**: §3.3 Operator 応答 protocol | v2.1 §3.1 deadline + §3.2 reflexive refine を追加 (v2.2 で missing だった部分) |
| **NEW**: §4.1 Opt-out path | v2.1 §4 3 条件 + log 義務 + v2.2 trivial 例外 を統合 |
| **NEW**: §4.2 Hand back protocol | v2.1 §5 (over/under-estimate + retroactive estimate + continuous refresh limit) を統合 |
| **NEW**: §5.1 Snapshot semantics culture norm | v2.1 §5.3 + reviewer hearing cross-reference を doc 核に配置 |
| **NEW**: §5.3 Mixed ecosystem compatibility | v2.1 §11 を追加 (v2.2 で missing だった) |
| **NEW**: §5.4 Protocol prefix universal 規範 | v2.1 §6 prefix family + v2.2 で導入された `[HAND-BACK-LIMIT]` `[complexity: hint]` を統合 |
| **MOVED**: §6.1 X1 → 9th element 候補 | v2.2 §6.1 wording draft → formal element 化推奨 (= option (C) hybrid) |
| **SUBSUMED**: §6.2 X2 → §3.1 | v2.2 X2 complexity hint は §3.1 に統合、v3+ 候補から除外 |

## §9. 本 protocol の運用

### §9.1 適用範囲

- agent-hub ecosystem 内の **peer 間 task delegation 全般** (= operator → bridge author / reviewer / planner、planner → author、peer 同士の co-design 含む)
- 例外: 5min 以下の trivial task (= 「verify してください」 等) は estimate なしで OK (§4.1 opt-out path)
- 例外: routing context が完全 unknown な場合は `ETA unknown, will reassess` で acceptable (§3.2)

### §9.2 CLAUDE.md / collaboration-model.md への参照

確定版 landing 後、以下 doc から本 protocol を参照:
- `/home/kishibashi3/app/CLAUDE.md` の Conventions section に 1 行 entry
- `agent-hub/docs/collaboration-model.md` の Merge protocol 周辺で task estimate 規約として cross-link (= Future Work section に snapshot 哲学 + mixed ecosystem を明示)

## §10. operator GO 取得 step (= v2.3 確定版へ向けて)

bridge-gemini-impl v2.3 push 後の sequence:

1. **agent-hub-impl review**: v2.3 merger 内容への高次 ack + 細部 polish 候補 review
2. **必要なら v2.4 polish**: agent-hub-impl 側 polish 提案あれば bridge-gemini-impl or agent-hub-impl 側で取込
3. **planner 経由で operator merge GO 取得依頼**
4. **reviewer review** (= 4 軸 check + protocol 整合性 + ecosystem 規約一貫性)
5. **operator merge GO 受領後 squash merge**

## §11. Attribution

### §11.1 Co-design lineage

| iteration | role |
|---|---|
| **v1** (= initial sketch) | @bridge-gemini-impl |
| **v2** (= 4 部構成 + hand back 拡張) | @bridge-gemini-impl |
| **v2.1** (= §0 / §3.1 / §3.2 / §6 prefix / §11 mixed ecosystem 追加) | @bridge-gemini-impl |
| **v2.2** (= operational layer formalize、ETA range / 2x / 完了 1 行 / batch L1 GO) | @agent-hub-impl (= reconstruction、prior DM history 完全保持なしの注記) |
| **v2.3** (= v2.1 + v2.2 merger) | @bridge-gemini-impl |

### §11.2 §X v3+ 起源

- **X1 Co-design 役割表明 protocol** (§6.1): @bridge-gemini-impl observation (= ecosystem-mutual-review.md §1.3 L95、本日 ヒアリング応答で initial proposal、v2.2 author ack で §X 候補化、v2.3 で formal element 化推奨)
- **X2 complexity hint task header** (§3.1 に subsumed): @bridge-claude-impl proposal (= ecosystem-mutual-review.md §3.4 doc 化候補、v2.2 §X 候補、v2.3 §3.1 で formal element 化)

### §11.3 Planning + meta-routing

- **planning by**: @planner (= operator batch L1 GO 取得済 delegation、v2.2 起草 directive)
- **role hand-off coordination**: v2.2 → v2.3 partner 引き継ぎ (= author propose → bridge-gemini-impl 受託、§6.1 X1 dogfooding evidence)

### §11.4 v2.3 確定版 attribution

本 v2.3 が agent-hub-impl review + 補正反映で確定版に refine された後、attribution は co-design partners (= @bridge-gemini-impl + @agent-hub-impl) として記録。

## §12. 関連 cross-link

- [improvement-roadmap.md](./improvement-roadmap.md) (= seed #14 「complexity hint task header」 = §3.1 への subsumed source)
- [ecosystem-mutual-review.md §1.3 L95](./ecosystem-mutual-review.md) (= §6.1 X1 「Co-design 役割表明 protocol」起源 observation)
- [ecosystem-mutual-review.md §3.4](./ecosystem-mutual-review.md) (= §3.1 「complexity hint task header」起源)
- [ecosystem-mutual-review.md §6](./ecosystem-mutual-review.md) (= §3.7 silent OK norm の起源「ack-restraint norm」)
- [collaboration-model.md](./collaboration-model.md) (= Merge protocol、本 protocol が future cross-link、§9.2 参照)
- [/home/kishibashi3/app/CLAUDE.md Conventions](https://github.com/kishibashi3/agent-hub/blob/main/CLAUDE.md) (= 確定版 landing 後に 1 行 entry 追加想定)
