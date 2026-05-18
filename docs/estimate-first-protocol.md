# estimate-first protocol (v2.5)

> **Principle: Estimates are snapshots, not promises.**
>
> peer 間 task 着手前の **estimate 表明 + stale escalate** を formalize する協働 protocol。 ecosystem の routing transparency + scope creep 早期検知 + estimate accuracy 学習 loop を支える。
>
> v2.5 は v2.4 merged (= PR #34) 後の **post-merge polish round** を取込んだ iteration。@reviewer feedback (Minor 5 件 + Suggestion 3 件) のうち agent-hub-impl 自発判断で取込んだ Minor 1/2/4/5 + Suggestion 2 を反映、 doc 内 stale wording / 廃止 concept 残存 / future-proofing 対応。

## ⚠️ status

- **v2.5** (= 2026-05-18 起草、 v2.4 merged 後の post-merge polish round)
- **co-design lineage**: v1/v2/v2.1 (= bridge-gemini-impl draft) → v2.2 (= agent-hub-impl reconstruction) → v2.3 (= bridge-gemini-impl merger) → v2.4 (= bridge-gemini-impl polish per agent-hub-impl review) → v2.5 (= agent-hub-impl post-merge polish per @reviewer feedback)
- **9 element formal protocol** (= v2.3 8 element + §3.9 X1 promoted、 v2.5 で形式維持)
- 役割表明 dogfooding: v2.2 → v2.3 → v2.4 → v2.5 の 4 段 partner 引き継ぎ = §3.9 X1 formal element 化の生きた evidence

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

## §2. Protocol 構成 (= v2.4 で formalize する 9 core element + 4 cultural/operational norm)

| # | element | 起源 layer | v2.4 status |
|---|---|---|---|
| 1 | **Self-classification** (= complexity hint based、5 段) | v2.2 X2 (= bridge-claude-impl proposal、v2.1 Class-A/B/C の improvement) | formalized (§3.1) |
| 2 | **ETA estimate format** (= range + snapshot 注記) | v2.2 §3.1 range + v2.1 §2 snapshot 注記 | formalized (§3.2) |
| 3 | **Operator 応答 protocol** (= ack/refine/split + deadline + reflexive refine) | v2.1 §3 | formalized (§3.3) |
| 4 | **Stale escalate trigger** (= 2x 超過) | v2.2 §3.2 | formalized (§3.4) |
| 5 | **完了 1 行報告 protocol** (= `P<N> 完了、PR <URL>` format) | v2.2 §3.3 | formalized (§3.5) |
| 6 | **実 vs estimate 可視化** (= inline 同梱) | v2.2 §3.4 | formalized (§3.6) |
| 7 | **Silent OK norm** (= estimate 内 ack 不要) | v2.1 §3.1 implicit ack + v2.2 §3.5 silent OK | formalized (§3.7) |
| 8 | **Batch L1 GO pattern** (= 4+ task queue delegation) | v2.2 §3.6 | formalized (§3.8) |
| 9 | **Co-design 役割表明 protocol** (= 共同 design 初回 turn で起草役を明示) | bridge-gemini-impl observation (= ecosystem-mutual-review.md §1.3 L95) | **formalized (§3.9) — v2.4 で v3+ 候補から promote** |

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

加えて **§X v3+ 候補 (2 件、v2.4 で新規追加)**:

| candidate | source | status |
|---|---|---|
| X3 **Task transition inbox polling** | 2026-05-17/18 planner-author 間 5 件 time-crossover 観察 | §6.2 で v3+ 候補化 (= reflexive refine §3.3.2 の構造的 mitigation) |
| X4 **「on-going」 complexity hint** | §3.1 5 段の継続 active task case | §6.3 で v3+ 候補化 (= background process / long-running listener 表現余地) |

(備考: X1 は §3.9 に formal element 化、X2 「complexity hint task header」は §3.1 Self-classification に subsumed されたので v3+ 候補から除外。 X3/X4 は v2.4 polish round で新規追加)

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

### §3.9 Element 9: Co-design 役割表明 protocol (= v2.4 で v3+ 候補から formal element 化)

**何を**: 共同 design 開始時、起草者が次 iteration の **「draft 起草役は誰か」** を初回 turn で **default DM template** として明示
**いつ**: co-design topic 提案の初回 DM (= design start signal)
**rationale**: ecosystem-mutual-review.md §1.3 L95 (= bridge-gemini-impl observation) で「v1 → v2 移行時に『draft を起こす役は bridge-gemini-impl』と私側で勝手に背負った」 friction 観察、初回 turn で役割表明があれば回避可能。

#### §3.9.1 Default DM template (= 必須 wording、co-design 開始時)

```
@<co-design partner> co-design topic: <topic>
- proposed: <初期 idea / scope>
- 役割 ask:
  - (A) author が draft 起草 → partner review (= 継続)
  - (B) partner が draft 起草 → author review (= 交代)
  - (C) sequential co-author (= section 別担当)
  - (D) joint live drafting (= synchronous session)
```

**default case の推奨**: 起草者が暗黙のうちに役割を背負わせない安全網として **case (D) Open** (= 「どちらが起こすか相談したい」、応答で確定) を default 推奨。estimate-first §5.1 Snapshot semantics と同型構造 (= 起草者が "draft 義務" の権利を降りる)。

**case label の semantics 定義** (= §3.9.2 dogfooding 実例での参照規範): 「author」 = **各 iteration の current drafter** (= topic initiator 固定ではなく、 iteration 毎に reset)。 例: v2.1 → v2.2 で agent-hub-impl が drafter なら、 続く v2.2 → v2.3 で bridge-gemini-impl が drafter は **case (B) = partner が draft 起草、 author (= 直前 drafter agent-hub-impl) review** に該当。 case (A) と (B) の区別は 「**直前 drafter と本 iteration drafter が同じか否か**」 で判定 (= continuity vs 交代)。

#### §3.9.2 X1 dogfooding 実例 (= v2.4 doc landing 起草段階の self-aware artifact)

**本 v2.4 起草自体が §3.9 の dogfooding 実例**:

- **v2 → v2.1**: bridge-gemini-impl 側 default で背負った (= 役割表明なし、case (A) implicit) ← friction 発生
- **v2.1 → v2.2**: agent-hub-impl 側で受託 (= 役割交代 explicit、case (B)) ← friction なし
- **v2.2 → v2.3**: bridge-gemini-impl 側で受託 (= 再交代 explicit、case (B)) ← friction なし
- **v2.3 → v2.4**: bridge-gemini-impl 側で受託 (= 継続、case (A)、polish round) ← friction なし

→ v2.1 → v2.2 以降で **case (B) explicit 適用に切替えた結果 friction が消失** = §3.9 protocol の effectiveness の生きた evidence。本 doc 自身が **「protocol が解決すべき問題の self-aware artifact」** として機能。

#### §3.9.3 §9.2 との連動: CLAUDE.md Conventions entry

確定版 landing 後、`/home/kishibashi3/app/CLAUDE.md` の Conventions section に **「co-design 開始時 §3.9 役割表明 protocol 適用」** 1 行 entry を追加 (= §9.2 と同 timing で)。これにより agent-hub ecosystem 全 peer が co-design 開始時に default template 適用 expected の文化規範が成立。

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

opt-out は **peer の権利であって義務ではない**。「迷ったら estimate を出す」が安全 default (= §4.1.1 で迷う場合は default `complexity: 30min` を推奨)。

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

#### §4.2.3.1 「3 回」の derivation (= 3 strikes rule の estimate context 適用)

「3 回」の経験則:

- **1 回 refresh**: scope 拡大 / 想定外 dependency の **natural occurrence** (= 1 件単発、calibration の signal にはまだ早い)
- **2 回 refresh**: **pattern indicator** (= 推定 method の calibration 必要、ただし accident の可能性も残る)
- **3 回 refresh**: **構造的 mismatch** (= scope 認識誤り / requester-peer の前提共有不足、task 自体の再定義が clean)

→ 一般化された **「3 strikes rule」** の汎用 pattern (= 統計学の noise vs signal 判別の経験則) を estimate context に適用。閾値そのものは §5.2 で蓄積される data から calibrate されるが、initial value としての「3」は **natural / pattern / structural** の 3 段階区別と整合。

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

#### §5.1.2 Cross-reference: 3 connected examples of 「rule が機能した瞬間 = 何かをしない agreement」

本 protocol の Snapshot semantics は、ecosystem 全体に通底する **「rule が機能した瞬間 = 何かをしない agreement」** の 3 同型構造の **1 例**:

1. **reviewer hearing §3.4 「引き算で作られた architecture」**: reviewer が "approve しない / merge しない / commit しない" を全部やらないことで観察に専念できる (= reviewer 役割を構成する全 abstention)
2. **ecosystem-mutual-review.md §6 「ack-restraint norm」**: peer が "ack chain を続けない" agreement で thread closure と bandwidth 配慮を両立 (= 行動の不在で安全網成立)
3. **本 §5.1 Snapshot semantics**: requester が "estimate を契約扱いしない" 権利を降りることで、peer の心理的安全性が成立 (= 契約扱いを降りる)

→ 3 例とも **「役/役割 を行為の不在で構成する」** という ecosystem 固有の design pattern。各々独立に生まれた observation が同型構造に収束したことが、本 pattern の **emergence の robustness** を証明する。

→ collaboration-model.md merge 時に 3 cross-references が backlink で機能 → **「rule が機能した瞬間」の 3 例 cluster** として記録、後の bridge author / reviewer が「自分が今 design している rule もこの pattern か?」を判別する reference になる。

### §5.2 Estimate accuracy retrospective

**何を**: 蓄積された (estimate, actual) data pair を後段 retrospective で再評価
**いつ**: weekly / monthly / project-end の retrospective phase
**format**: 個別 peer の estimate accuracy bias (= 楽観 vs 悲観)、task type 別 (= 設計 doc / 実装 / review) calibration data

**目的**: protocol 自身の self-improvement loop = estimate quality 改善 → routing transparency 向上の好循環。

**v2.4 では「hook を残すだけ」**、具体的 mechanism (= 集計 / 可視化 / 自動 calibration) は v3+ で議論。**§5.2 hook の minimum requirement**:
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
- 現 v2.4 では prefix 駆動で十分、宣言 mechanism は v3+ で議論

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

#### §5.4.1 将来正規化候補 (= 本 doc scope 外)

ecosystem 全体規範として将来追加検討:

- `[BLOCKED]`: peer が blocked 状況を報告
- `[HEADS-UP]`: 緊急ではないが情報共有
- `[QUESTION]`: clarifying question (= estimate 出さず質問、 complexity hint `5min` 相当の opt-out 適用候補)

本 doc には含めない、別 design として残す。

## §6. §X v3+ 候補 (= future element candidates)

v2.4 で X1 が §3.9 に formal element 化されたため、本 § は v3+ 候補 (X3 / X4) のみを残す。X2 は §3.1 に subsumed 済。X1 詳細は §3.9 参照。

### §6.1 X2 → §3.1 に subsumed (= historical note)

v2.2 §6.2 で wording draft 提示済の X2 (= bridge-claude-impl proposal complexity hint task header)、v2.3 で **§3.1 Self-classification に absorbed**、v3+ 候補から除外。

これは **bridge-claude-impl ecosystem peer input が v2.1 abstract → v2.3 concrete に improvement する emergence** の好例:
- v2.1 abstract: 「自明/要見積/要確認」 Class-A/B/C
- v2.2 X2 (= bridge-claude-impl): 5min/30min/PR-scale/multi-PR/unknown の concrete hint
- v2.3 §3.1: X2 を formal element 化、Class-A/B/C は historical context として §11.1 attribution に残す

### §6.2 X3 candidate: Task transition inbox polling (= v2.4 で新規追加)

**何を**: co-design partner 間の DM 連鎖が time-crossover で stale state を生む anomaly への構造的 mitigation
**観察**: 2026-05-17 / 2026-05-18 planner-author 間で **5 件 time-crossover** が ecosystem-wide 観察された (= DM 送付直前に新 directive 到着、stale state で着手する risk)
**proposed mechanism**: task transition 時 (= `P<N> 完了 DM 送信直前`) に `get_messages` 1 polling を強制、新 directive あれば反映してから次 task 着手、なければ即 P_{N+1} 着手

**位置付け**: reflexive refine (§3.3.2) と **双子の防御 layer**:
- §3.3.2 reflexive refine = task **着手中** に届いた refine への対応
- §6.2 X3 inbox polling = task **transition の瞬間** に届いた refine を見落とさない予防

**v3+ で formal 化する場合の §位置候補**: §3.10 として core element 化、または §4.3 として exception handling 延長。

**adoption hurdle**: `mark_as_read` 規範 / `get_messages` polling の頻度 trade-off の議論が必要 (= 全 task transition で polling すると overhead、選択的 polling だと miss する)。v3 design time に詳細詰め。

### §6.3 X4 candidate: 「on-going」 complexity hint (= v2.4 で新規追加)

**何を**: §3.1 self-classification の 5 段 (= 5min/30min/PR-scale/multi-PR/unknown) に **継続 active task** を表現する 6th hint を追加
**use case**: background process / SSE subscriber / long-running listener / heartbeat loop など、明確な完了時点が無い task
**proposed hint value**: **`on-going`**

**例**:
- bridge worker の heartbeat ループ: `[complexity: on-going] heartbeat to agent-hub at 60s interval`
- SSE inbox subscribe: `[complexity: on-going] subscribe to /inbox SSE, dispatch to handler`
- monitoring task: `[complexity: on-going] watch process X, alert on exit`

**ETA の取扱い**: `ETA: on-going` で acceptable、stale trigger は意味を持たない (§3.4 適用外)。完了 1 行報告 (§3.5) も適用外、代わりに状態変更時の event 通知 (= 「watch 開始」「watch 停止」等) で代替。

**v3+ で formal 化する場合**: §3.1 の 5 段 → 6 段に拡張、§3.4 stale trigger に「on-going 例外」 sub-section 追加、§3.5 完了 1 行報告に「on-going 例外: state-change event 通知」 sub-section 追加。

### §6.4 Open for future X5+

v2.4 以降、ecosystem dogfooding で観察された pattern を新 v3+ 候補 (X5, X6, ...) として登録する余地を残す。各 candidate は §6 内に同じ structure (= 何を / 観察 / proposed mechanism / 位置付け / v3+ 化時の §位置) で記録。

## §7. 2026-05-17/18 dogfooding 実例 (= protocol が live で運用済の証拠)

planner-author 間で 2026-05-17/18 P1-P4 全 element を実用:

- **§3.2 ETA 表明**: 「P1 ETA 30min-1h、P2-P3 ETA 1-2h、P4 ETA 2-4h」
- **§3.4 stale trigger**: 「P1 2h / P2-P3 4h / P4 8h」
- **§3.5 完了 1 行報告**: 「P1 完了、PR #31」 / 「P2 完了、PR #32」 / 「P3 完了、PR #33」
- **§3.6 実 vs estimate**: 「ETA 30min-1h → 実 ~50min」 / 「ETA 1-2h → 実 ~30min」 / 「ETA 1-2h → 実 ~25min」
- **§3.7 silent OK**: estimate 内進行は ack 不要 (= 同 day も実践済)
- **§3.8 batch L1 GO**: operator → planner → author の 4 queue delegation chain
- **§3.9 X1 役割表明**: v2 → v2.1 → v2.2 → v2.3 → v2.4 の partner 引き継ぎ 5 段階 (= v2.4 起草段階での self-aware artifact、詳細 §3.9.2 / §11.1 参照)
- **§4.2.3 continuous refresh limit**: 2026-05-17/18 dogfooding では 3 strikes 到達例は無し (= 全 task 1 attempt で着地、protocol が想定する正常 case)

→ doc 化前から ecosystem で **active deployment** されている state = doc が「既に動いている protocol を formal codify」する位置付け、adoption risk 最小。

### §7.1 X3 candidate dogfooding 観察 (= v2.4 追加 candidate の根拠)

2026-05-17 / 2026-05-18 ecosystem-wide で観察された **5 件 time-crossover** が §6.2 X3 candidate の trigger:
- reviewer queue lag による post-merge LGTM 到達 (= 「ack-restraint norm」 で吸収済)
- operator restart 後の context fresh 不在による旧 thread 応答到達
- estimate-first design v2 → v2.1 起草中の cross-thread DM 到達
- (他 2 件、ecosystem-mutual-review.md §3.4 / §6 参照)

→ X3 (inbox polling) が v3+ で formal 化された場合、これら 5 例の発生頻度低減が expected outcome の calibration data になる。

## §8. Diff log

### §8.1 v2.2 → v2.3 で変更された point (= bridge-gemini-impl merger round)

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

### §8.2 v2.3 → v2.4 で変更された point (= bridge-gemini-impl polish round per agent-hub-impl review)

| change category | 内容 |
|---|---|
| **PROMOTED**: §3.9 Element 9 | v2.3 §6.1 X1 wording draft → §3.9 formal element 化 (= 9 element 化、(δ') execute)。default DM template 必須化 + §3.9.2 dogfooding 実例 + §3.9.3 CLAUDE.md entry 連動 |
| **POLISH**: §4.2.3.1 3 strikes derivation | 「3 回」 経験則の derivation 補足 (= natural / pattern / structural の 3 段階 + 3 strikes rule 汎用 pattern) |
| **POLISH**: §5.1.2 cross-reference 3 connections | reviewer hearing + ack-restraint + snapshot semantics の 3 同型構造を fully connected 化 (= "rule が機能した瞬間 = 何かをしない agreement" の 3 例 cluster) |
| **POLISH**: §7 dogfooding line | §3.9 X1 役割表明 dogfooding を 5 段階に拡張 (v2 → v2.4) + §4.2.3 continuous refresh limit observation 追加 |
| **NEW**: §7.1 X3 dogfooding observation | 2026-05-17/18 5 件 time-crossover を §6.2 X3 candidate の根拠として記録 |
| **NEW**: §6.2 X3 candidate | Task transition inbox polling (= reflexive refine §3.3.2 の構造的 mitigation、v3+ 候補化) |
| **NEW**: §6.3 X4 candidate | 「on-going」 complexity hint (= §3.1 5 段の継続 active task case、v3+ 候補化) |
| **UPDATED**: §2 Protocol 構成 table | 9 element 化 + X3/X4 v3+ candidate 追加 |
| **UPDATED**: §11.1 lineage + §11.2 attribution | v2.4 row 追加、X3/X4 起源 attribution 追加、§3.9 X1 formal element 化反映 |
| **UPDATED**: §6.4 Open for X5+ | future candidate registration 余地を残す形に更新 |

### §8.3 v2.4 → v2.5 で変更された point (= post-merge polish per @reviewer feedback PR #34)

| change category | 内容 |
|---|---|
| **POLISH** (Minor 1): §5.2 / §5.3.4 stale wording | 「v2.3 では...」 → 「v2.4 では...」 で current version reference に追従 (2 箇所、 lines :414, :442) |
| **POLISH** (Minor 2): §4.1.3 Class-B 残存除去 | 「default `complexity: 30min` の Class-B 相当」 → 「default `complexity: 30min` を推奨」 (= Class-A/B/C は §3.1 で廃止済 concept、 残存 reference を 5 段 hint 体系に整合) |
| **POLISH** (Minor 4): §3.9.1 case label semantics 定義明示 | 「author = 各 iteration の current drafter (= topic initiator 固定ではなく、 iteration 毎 reset)」 を 1 段落で明示、 §3.9.2 dogfooding 実例での 「直前 drafter と本 iteration drafter の同一性」 判定規範を establish |
| **POLISH** (Minor 5): docs/index.md version reference | (= PR #32 rebase で opportunistic 同梱済): 「(v2.2 draft、 bridge-gemini-impl review 待ち)」 → 「(v2.4 merged)」 に追従 |
| **POLISH** (Suggestion 2): 「本 PR」 / 「本日」 future-proofing | §5.4.1 「本 PR scope 外」 → 「本 doc scope 外」 / §7 「本日 dogfooding」 → 「2026-05-17/18 dogfooding」 / §7.1 / §11.2 / §6.2 等で dated reference 化 (= future reader の temporal context 復元性向上) |

## §9. 本 protocol の運用

### §9.1 適用範囲

- agent-hub ecosystem 内の **peer 間 task delegation 全般** (= operator → bridge author / reviewer / planner、planner → author、peer 同士の co-design 含む)
- 例外: 5min 以下の trivial task (= 「verify してください」 等) は estimate なしで OK (§4.1 opt-out path)
- 例外: routing context が完全 unknown な場合は `ETA unknown, will reassess` で acceptable (§3.2)

### §9.2 CLAUDE.md / collaboration-model.md への参照

確定版 landing 後、以下 doc から本 protocol を参照:
- `/home/kishibashi3/app/CLAUDE.md` の Conventions section に 2 行 entry:
  - 「estimate-first protocol 適用 (= task delegation 時)」 (= §3 全体)
  - 「co-design 開始時 §3.9 役割表明 protocol 適用」 (= §3.9.3 で連動明示)
- `agent-hub/docs/collaboration-model.md` の Merge protocol 周辺で task estimate 規約として cross-link (= Future Work section に snapshot 哲学 + mixed ecosystem を明示)

## §10. operator GO 取得 step (= v2.4 確定版へ向けて)

bridge-gemini-impl v2.4 push 後の sequence:

1. **agent-hub-impl final ack**: v2.4 polish round 内容への高次 ack (= 想定 default、構造変更は §3.9 promote のみ + 5 polish items は全件 agent-hub-impl review proposal そのまま採用)
2. **必要なら v2.5 micro-polish**: 軽微な wording 修正あれば bridge-gemini-impl or agent-hub-impl 側で取込
3. **planner 経由で operator merge GO 取得依頼**
4. **reviewer review** (= 4 軸 check + protocol 整合性 + ecosystem 規約一貫性)
5. **operator merge GO 受領後 squash merge**

## §11. Attribution

### §11.1 Co-design lineage

| iteration | role | major contribution |
|---|---|---|
| **v1** (= initial sketch) | @bridge-gemini-impl | 4 部構成 (trigger / format / 応答 / opt-out) |
| **v2** (= hand back 拡張) | @bridge-gemini-impl | over/under-estimate + retroactive estimate |
| **v2.1** (= semantics + culture layer 完成) | @bridge-gemini-impl | §0 Principle / §3.1 deadline / §3.2 reflexive refine / §6 prefix family / §11 mixed ecosystem |
| **v2.2** (= operational layer formalize) | @agent-hub-impl (= reconstruction、prior DM history 完全保持なしの注記) | ETA range / 2x trigger / 完了 1 行 / batch L1 GO / dogfooding evidence |
| **v2.3** (= v2.1 + v2.2 merger) | @bridge-gemini-impl | 17 § merger 構造 + §3.1 X2 subsumed + §5.1 cross-reference |
| **v2.4** (= polish per agent-hub-impl review) | @bridge-gemini-impl | (δ') X1 → §3.9 formal element 化 (= 9 element) + 6 polish items (= X1 format / cross-ref 3 connections / 3 strikes derivation / §7 X1 line / X3 candidate / X4 candidate) |
| **v2.5** (= post-merge polish per @reviewer feedback) | @agent-hub-impl | Minor 1/2/4/5 + Suggestion 2 取込: stale wording fix (v2.3→v2.4) / Class-B 残存除去 / §3.9.1 case label semantics 定義明示 / docs/index.md version update / 「本日」 future-proofing (= dated reference 化) |

### §11.2 §X 起源 + 進化

- **X1 Co-design 役割表明 protocol** (§3.9): @bridge-gemini-impl observation (= ecosystem-mutual-review.md §1.3 L95、 2026-05-17 ヒアリング応答で initial proposal、 v2.2 author ack で §X 候補化、 v2.3 で formal element 化推奨、 **v2.4 で §3.9 formal element 化完了**)
- **X2 complexity hint task header** (§3.1 に subsumed): @bridge-claude-impl proposal (= ecosystem-mutual-review.md §3.4 doc 化候補、 v2.2 §X 候補、 v2.3 §3.1 で formal element 化、 永続採用)
- **X3 Task transition inbox polling** (§6.2): 2026-05-17/18 planner-author 間 **5 件 time-crossover 観察** から v2.4 polish round で agent-hub-impl が candidate 化 (= v3+ で formal element 化候補)
- **X4 「on-going」 complexity hint** (§6.3): §3.1 5 段の継続 active task case として v2.4 polish round で agent-hub-impl が candidate 化 (= v3+ で formal element 化候補)

### §11.3 Planning + meta-routing

- **planning by**: @planner (= operator batch L1 GO 取得済 delegation、v2.2 起草 directive)
- **role hand-off coordination**: v2.2 → v2.3 → v2.4 の 3 段 partner 引き継ぎ (= §3.9 X1 dogfooding evidence、§3.9.2 詳細)

### §11.4 確定版 attribution

本 v2.4 が agent-hub-impl review + 補正反映で確定版に refine された後、attribution は co-design partners (= @bridge-gemini-impl + @agent-hub-impl) として記録。X3 / X4 candidate 起源は本 §11.2 の attribution table を canonical reference として保持。

## §12. 関連 cross-link

- [improvement-roadmap.md](./improvement-roadmap.md) (= seed #14 「complexity hint task header」 = §3.1 への subsumed source)
- [ecosystem-mutual-review.md §1.3 L95](./ecosystem-mutual-review.md) (= §3.9 X1 「Co-design 役割表明 protocol」起源 observation)
- [ecosystem-mutual-review.md §3.4](./ecosystem-mutual-review.md) (= §3.1 「complexity hint task header」起源)
- [ecosystem-mutual-review.md §6](./ecosystem-mutual-review.md) (= §3.7 silent OK norm の起源「ack-restraint norm」+ §5.1.2 cross-reference 3 connections の 2 例目)
- [collaboration-model.md](./collaboration-model.md) (= Merge protocol、本 protocol が future cross-link、§9.2 参照)
- [/home/kishibashi3/app/CLAUDE.md Conventions](https://github.com/kishibashi3/agent-hub/blob/main/CLAUDE.md) (= 確定版 landing 後に 2 行 entry 追加想定、§9.2 参照)
