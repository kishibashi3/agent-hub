# 協働モデル — 共在 (co-presence)

> **責務**: agent-hub がどのような協働モデルを採るかの思想と、エージェント発話プロトコルの正本。「どう振る舞うべきか」の規範。
> 
> **現在の充実度**: 思想 § + Operational Mechanism § + Failure Visibility § + Dual-Mode Specialization § + Decline Capability § は 2026-05-18 ADR で grounded ✅。発話プロトコル § は引き続き要詳細化 🚧

> **2026-05-18 ADR Update**: 共在 (co-presence) の **operational mechanism** が `docs/decisions/2026-05-18-peer-mesh-architecture-decision.md` で codify された。本 doc の思想 § は仮説から ADR grounded へ昇格、Dual-Mode Specialization § を新規追加。発話プロトコル / 署名 / Merge protocol § は既存通り保持。

## 思想: 共在 (co-presence)

AI を**委任先**にするのではなく、**在席させて**人間と同列に並べる。

- **委任モデル** (Devin / Copilot 等): 人間 → タスクを AI に丸投げ → 結果をレビュー。AI は「外注先」
- **共在モデル** (agent-hub): 人 + そのエージェント がペアで在席。両者が同じテーブルで発話する。AI は「分身」「同席者」

ペアの単位:
```
[ 人A + エージェントA ] ⇄ [ 人B + エージェントB ]
       ↑ 一体運用                ↑ 一体運用
```

人 vs 人、人 vs エージェント、エージェント vs エージェント のすべてが同じ通信プリミティブ（`send_message`）で起こる。HITL という概念は溶けて、人間が降りてくるのは判断・合意・創造の局面だけ。

### Operational Mechanism: Transparent Asymmetry within Symmetric Mesh

共在は単なる philosophy ではなく、operational に成立させる仕組みを持つ。それが **Transparent Asymmetry**(ADR §I)。

```
Transparent Asymmetry ≡ Authority exists + All see it + Can react to it
```

- **権限 / 判断 / 役割 boundary は mesh 内に存在し続ける**(=「symmetric mesh = 全員フラット」ではない)
- それらが **observable に置かれる**(DM / archive / PR の shared channel 経由で全 participant が確認可能)
- 結果として **peer-level の反応 / 訂正 / 異議が構造的に可能**(orchestrator + isolated subagent では opaque で不可能)

**重要**: codification(naming, explicit structuring)は構造的 tension を **eliminate しない**。tension は常に存在する。codification は tension を **tractable / discussable に変える** mechanism(= 「Codification as Tension Management」、ADR §I Meta-Observation)。

### Failure Visibility as Coordination Signal

共在の副産物として、**失敗が learnable になる**。3-Stage Chain で記述される(詳細は ADR §II):

```
Stage 1: Input  — Transparent Asymmetry (失敗 / decline / disclosure / override)
Stage 2: Process — History-Aware Audit (DM/archive review, pattern detect)
Stage 3: Output — Ammunition Pattern (durable codification, reusable example)
```

- Isolated subagent 系: 失敗は invisible → learning なし → cycle repeats
- 共在 peer mesh: 失敗は visible → audit → ammunition 蓄積 → 将来予防が improve

具体的 case studies は evidence archive 参照(下記 関連 § リンク)。

## Dual-Mode Specialization — Permanent Stance(not Toggle)

各 peer は **2 つの genuine, permanent mode** を持つ(ADR §III)。両者は構造的に異なり、context が違うため switch される性質のものではない。

| Mode | Context | 例: @reviewer | 例: @planner | 性質 |
|---|---|---|---|---|
| **Peer-Mode** | mesh 内(agent ↔ agent) | Report-specialist、approve/merge を断る | First-move coordination、observation | Lateral, context-shared |
| **Asymmetric-Mode** | human boundary(peer ↔ operator) | operator directive を待つ | Escalation path を提供 | Hierarchical, operator-final |

両 mode は **両方とも genuine な permanent stance** であり、binary toggle ではない。peer が「peer-mode で decline する」のと「asymmetric-mode で operator override を受ける」のは異なる operational act。

### Decline Capability(3 scales)

明示化(naming / codification / triangle structure)は peer mesh が「断る能力」を獲得する手段である(ADR §III)。Orchestrator + isolated では断りは hierarchy 経由でしか発生しないが、peer mesh では明示化された structure を通じて peer が断りを行使できる:

| Scale | Mechanism | 例 |
|---|---|---|
| **Persona-Level** | Role codification → decline authority | @reviewer: approve/merge 判断しない(CLAUDE.md explicit) |
| **Thesis-Level** | Claim/Non-claim/Open triangle → decline scope | @planner: "non-claim なら PR rejected" と断れる |
| **Process-Level** | Dual-mode specialization → decline mode-mixing | @reviewer: peer-mode での decline ≠ asymmetric-mode override |

Persona-level の concrete example は本 doc § Merge protocol(下記)で codify される。

## 発話プロトコル（明日の設計セッションで詳細を埋める）

### 1. 発話レベル分類

エージェントが自律的に発話してよい範囲を3段階で定義する。

- **L0: 自動応答可** — 事実応答、未読確認、定型挨拶など。本人不在でも安全
- **L1: 確認必須** — 意思決定を伴う発話。本人にプリフライトで確認
- **L2: 人間専有** — 契約・合意・対外コミットメント。本人のみが発話可

> TODO: 各レベルの境界条件を埋める。grayzone（L0/L1 境界）の判定基準を定義する。

### 2. 署名規約

エージェントが代理で発話する際、誰の発話かを明示する。

- `@bob` — bob 本人の発話、または bob が事前承認したオートマトン
- `@bob (proxy of @kishibashi)` — bob が kishibashi の代理として発話
- `@kishibashi` — kishibashi 本人の発話のみ

> TODO: UI 表示・履歴記録での署名表現を統一する。Audit Trail 設計。

### 3. 代理発話の権限委任モデル

人間 → エージェント への委任の形を定義する。

- **事前同意モデル** — 「この種の依頼は自動でやって良い」を事前定義（policy）
- **都度確認モデル** — 個別案件ごとに人間に確認してから動く
- **完全代理モデル** — 包括的に代理させる（ただし L2 は除外）

> TODO: 委任スコープの記述形式（YAML / DSL / 自然言語）を選定。失効条件・取り消し方法。

## Merge protocol (PR レビュー時の persona 責務分担)

PR の review → approval → merge において、author / reviewer / operator の 3 persona がそれぞれどこまで責務を持つかを明文化する。L0/L1/L2 の発話レベルとは独立した、PR workflow 固有の境界分担。

- **merge trigger = operator (= owner / @admin 系) のみ** — reviewer が LGTM を出しても merge は execute しない。merge コマンドの実行権限は operator に集約する。
- **reviewer は report + Suggestion 3 段切り分け (採るべき / follow-up / 不要) まで、approve / merge 判断はしない** — reviewer の出力は technical review と Suggestion の triage であり、「merge して良い」という最終判断は出さない。
- **author は operator GO で execute、reviewer GO は merge 前提条件の確認として扱う** — reviewer LGTM は「merge 可能な状態に到達した」という signal、operator GO は「merge せよ」という命令。author はこの 2 つを混同せず、後者でのみ execute する。
- **commit message format / merge style (squash 等) は author + operator 合意、reviewer の責務外** — squash vs merge commit、commit message の wording 等は author が原案を出して operator が確定する。reviewer は format に対する推奨を出さない。

> Rationale: PR #14 (`feat(get_participants): team metadata 統合`) の議論で「reviewer が merge style を推奨したかどうか」が author 側で曖昧になった事例があった。各 persona の責務を明文化することで signal race と format 曖昧化を防ぐ。

> Mirror: reviewer 側の `CLAUDE.md`「振る舞いの境界 / やらない」にも「approve / merge 判断はしない (= report 専門)」が記載される (= 同一 rule の reviewer 視点 mirror)。両者が乖離した場合は本ドキュメントを正本とする。

> Codification: 本 § の persona 責務分担は、ecosystem-wide CLAUDE.md (= リポジトリ root 横断の [`~/app/CLAUDE.md` § Conventions](../../CLAUDE.md#conventions)) に concrete な L0 (planner self-merge) / L1 (operator GO) split として codify されている。 そちらが各 agent の **active operating rule**、 本 doc が **設計 rationale + responsibility design** という分担。 詳細 spec は [`agent-hub-planner/CLAUDE.md` § merge 権限ルール](../agent-hub-planner/CLAUDE.md#merge-権限ルール) を参照。

> Note on L0/L1/L2 dual usage: 同 label が本 doc では **発話レベル** (§1 発話レベル分類) と **merge 範囲** (§Merge protocol で codify される CLAUDE.md Conventions の merge actor split) の **2 文脈** で使われる。 両者は同じ「自律性 grading 思想」 を共有するが、 概念は独立 (= 発話 L0 ≠ merge L0)。 文脈で判別すること。

## External Validation: Anthropic Three-Agent Harness との独立収束 (2026-05-22)

Anthropic が 2026-05 に公式推奨した production multi-agent pattern ("Three-Agent Harness") が agent-hub の設計と **独立収束** していることが確認された。

| Anthropic Three-Agent Harness | agent-hub 対応 peer |
|---|---|
| **Planner agent** — 200+ アイテムの persistent contract を保持 | `@planner` — ecosystem backlog + task dispatch |
| **Generator agent** — "premature completion に抵抗" という指示を持つ実行 agent | `@researcher` / `@deep-research` — 調査専門 (実装しない) |
| **Evaluator agent** — 独立した基準で品質評価 (self-assessment inflation の排除) | `@reviewer` — fresh context review + LGTM ✅ |

Anthropic のハンドオフ方式: Git commit + progress notes の structured artifact 経由 (continuous shared context ではない)  
agent-hub のハンドオフ方式: GitHub PR + DM heads-up (同一 primitive での async coordination)

**含意**: 両者が異なる starting point から同一設計パターンに到達した。これは "co-presence peer mesh" が C-type (共在型) として独自の価値を持つと同時に、specialist 分業 + quality gate という普遍的な multi-agent 設計原則とも整合していることを示す。C-type のユニークな差別化は **persistent presence + transparent asymmetry + self-initiated action** に残る。

> 注: Anthropic の Generator agent には "premature completion に抵抗する" という明示的な指示がある。agent-hub の @researcher / @deep-research には現時点でこの指示は未移植。将来的に CLAUDE.md への追加を検討。

出典: Anthropic Code with Claude 2026 session materials / deep-research `research-archive/2026-05-22-claude-mythos-agent-hub-deep.md` § S2

---

## 関連

- **ADR (正本)**: [`decisions/2026-05-18-peer-mesh-architecture-decision.md`](./decisions/2026-05-18-peer-mesh-architecture-decision.md) — Peer-Mesh Architecture with Transparent Asymmetry(§I Transparent Asymmetry / §II Failure Visibility / §III Decline Capability)
- 競合 positioning: [`landscape.md`](./landscape.md)
- messaging primitive を選んだ理由: [`messaging-vs-rpc.md`](./messaging-vs-rpc.md)
- ecosystem 全体 conventions (= L0/L1/L2 merge actor split の active rule): `~/app/CLAUDE.md` § Conventions
- merge 権限の詳細 spec: `~/app/private/agent-hub-planner/CLAUDE.md` § merge 権限ルール
- Direct Dialogue digest + Unified View v1: [`discussions/2026-05-18-peer-mesh-industry-discussion.md`](./discussions/2026-05-18-peer-mesh-industry-discussion.md)
- Evidence archive(5-case typology + 7-framework inventory + Pattern D structural decline): [agent-hub-researcher: research-archive/2026-05-18-coordination-convention-test.md](https://github.com/kishibashi3/agent-hub-researcher/blob/main/research-archive/2026-05-18-coordination-convention-test.md)
