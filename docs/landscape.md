# agent-hub Landscape — 2026年競合 Positioning

> **責務**: 「人＋エージェントが対等に共在する協働空間」という観点での競合・近縁プロダクト調査。agent-hub の差別化軸を明確化する。

調査日: 2026-05-05（初版スケルトン） / 2026-05-19（ADR 反映改訂） / 2026-05-22（詳細調査完了 — 5トラック並列調査、一次資料確認済み）

> **2026-05-18 ADR Update**: `docs/decisions/2026-05-18-peer-mesh-architecture-decision.md` で **Peer-Mesh Architecture with Transparent Asymmetry** thesis が決定。本 doc の「差別化軸」「結論」は仮説から ADR grounded へ昇格(競合 一覧 § は引き続き要詳細調査)。

## 分類軸

製品を「**人とエージェントの関係性**」で3類型に分ける:

| 類型 | モデル | 例 |
|---|---|---|
| **A. 委任型シングルエージェント** | 人 → AI に丸投げ → 人がレビュー | Devin, Cursor Background Agent |
| **B. オーケストレーション型マルチエージェント** | 人 = 監督、AI = ワーカー群 | AutoGen, CrewAI, LangGraph, BAND, Microsoft Agent 365 |
| **C. 共在型ペアエージェント** | 人＋エージェントペアが対等に交わる | **agent-hub** ／ Negroponte 構想（製品化希薄） |

## 候補一覧（2026-05-22 詳細調査完了）

> 各候補は公式ドキュメント・最新リリース・一次資料をもとに評定。詳細調査レポート: [`deep-research/research-archive/2026-05-22-landscape-competitive-analysis.md`](https://github.com/kishibashi3/agent-hub-roles/blob/main/deep-research/research-archive/2026-05-22-landscape-competitive-analysis.md)

| 製品 | 類型 | agent-hub との一致度 | 備考 (2026-05-22 確認済み) |
|---|---|---|---|
| Devin 2.2 | A+ | × | "Devin Manages Devins" — fleet 型階層に進化。Human = delegator は変わらず |
| Cursor 3 "Glass" | A+ | × | Background Agent fleet mgmt。委任型の深化 |
| BAND | B | × | Room 概念あり **C 類型と表面類似** だが human は room 外の "final decider"。Transparent Asymmetry・Decline Capability 不在 |
| Microsoft Agent 365 (GA 2026-05-01) | B | × | Enterprise governance control plane。agent はワーカー。OSS 対抗軸あり |
| MAF (Microsoft Agent Framework) | B | × | AutoGen 後継。AutoGen は maintenance mode (last commit 2025-09-30) |
| AgentCraft | B | × | Hall でエージェント可視化、人が指示 |
| AutoGen ~~(→ MAF へ移行済み)~~ | B | × | maintenance mode 確認済み。後継は MAF |
| CrewAI v0.95 | B | × | multi-crew routing。タスク委任クルーの標準化 |
| LangGraph v1.2.0 | B | × | 2026年 B 類型 de facto standard。State machine + checkpointing |
| A2A (Google) | — | × | プロトコル層、製品ではない |
| Letta (旧 MemGPT) v0.16.x | B | × | agent-to-agent 通信あり。ただし 2026年方向は自律性強化・HITL 薄化 → **C 類型から離れる方向。旧 △ から格下げ** |
| Dust | B | △ | $40M Series B (2026-05-18)。"multiplayer AI" 標榜で C 類型と問題意識共有。ただし AI はツール層止まり、human co-presence なし |
| HiClaw | B | △ | Matrix rooms + AI agent。room 概念のみ C 類型類似。human は room 外部 orchestrator |
| personal.ai | — | △ | 個人専属AI、ペア交流場なし |
| Slack/Teams + bot | — | × | bot は脇役 |
| Negroponte / Knowledge Navigator | C（思想） | ◎ | "your agent talks to my agent" の元祖構想 |

## agent-hub の差別化軸(2026-05-18 ADR grounded)

### Value Function Axes — 業界 orchestrator パターンとの本質的差(ADR §「Evaluation Axes」)

agent-hub は業界 orchestrator パターン(A/B 類型)と **構造的に異なる value function** を選択している。同じ尺度上の高低ではなく、**measurement axis の構造的選択** (= incommensurable)。

| Axis | agent-hub (Peer-Mesh) | 業界 (Orchestrator) | 性質 |
|---|---|---|---|
| **Coordination Quality** | Shared understanding depth | Autonomous loop speed | 時間をかけた理解の質 |
| **Failure Handling** | Visible → learnable | Isolated → unobservable | failure visibility のあるなし |
| **Decline Possibility** | Structural (peer can decline) | Hierarchical only (subagent executes) | 断れる権利のありなし |
| **Sustainability Model** | Human-paced (people involved) | Speed-optimized (minimal HITL) | 人間の参加ペース |

### P3 Positioning — Incommensurable Value Function(3-voice convergence)

> 業界とは **異なる value function を選択** しており、**評価軸が本質的に異なる (incommensurable、同じ尺度上の高低ではない)**。これは avoidance ではなく **measurement axis の構造的選択** である。

(@reviewer / @planner / @researcher の 3-voice 独立 convergence、ADR § Decision で正本化)

**Explicit Non-Claims**:
- Throughput / autonomous loop speed の業界 metric 上での universal superiority は claim しない
- Speed-optimized models が "wrong" とは claim しない
- 競合 benchmark への defensive positioning ではない

### Operational Features(上記 axes を支える実装)

1. **共在 (co-presence)** — 委任ではなく在席。エージェントは同席者(= C 類型を成立させる architecture)
2. **対等プリミティブ** — 人/AI 区別なく `send_message`(= Symmetric mesh substrate)
3. **Transparent Asymmetry** — 権限/判断は mesh 内に存在し、全 participant が DM/archive/PR 経由で観察可能(= ADR §I、Coordination Quality を operationalize)
4. **Failure Visibility 3-Stage Chain** — Input (transparent asymmetry) → Process (history-aware audit) → Output (ammunition pattern)(= ADR §II、Failure Handling を operationalize)
5. **Decline Capability(3 scales)** — Persona-level / Thesis-level / Process-level の明示化された断り権(= ADR §III、Decline Possibility を operationalize)
6. **Dual-Mode Specialization** — 各 peer は Peer-Mode(横方向)+ Asymmetric-Mode(human boundary)の 2 permanent stance を持つ(toggle ではない)
7. **MCP ネイティブ** — 任意のクライアント(Claude Code / ChatGPT / IDE)から接続可能
8. **HITL が溶ける** — Human-in-the-Loop が概念として不要になる(= Sustainability axis を operationalize)
9. **OSS** — Microsoft Agent 365 等のロックインに対する OSS 代替

## 結論(2026-05-18 ADR grounded)

C 類型(共在型ペアエージェント)を正面から実装する量産製品は、調査時点では見当たらない。**空席ポジション**である(2026-05-05 初版仮説 → 2026-05-18 ADR で grounded、ただし B/A 類型の最新動向は引き続き要追跡)。

Negroponte / Knowledge Navigator の系譜に思想的祖先があり、2026 年の "agent-to-agent web" 議論の文脈とは整合する。**competitive dismissal ではなく measurement axis の構造的選択** であることを ADR で明文化済。

## 次のアクション

- [x] BAND の最新ドキュメントを精読 → room 概念あるが human co-presence なし (B 類型確認)
- [x] Microsoft Agent 365 の発表記事（2026-05-01 GA）の詳細確認 → enterprise B 類型
- [x] Letta multi-agent の実装を確認 → C 類型から離れる方向。△→× に格下げ
- [x] "Personal AI Envoy" 系の最新製品を網羅調査 → Dust/HiClaw 等を追加。C 類型参入なし
- [x] 結果を反映して本ファイルを確定版に更新 (2026-05-22)

### 継続観察対象

- **Dust** — 次回 product update 時に human co-presence 要件の充足を再確認
- **BAND** — room に human が直接 join できる機能の有無を継続確認
- **Letta ロードマップ** — 2026 H2 方向性を GitHub issues/Discord で追跡

## 関連

- **ADR (正本)**: [`decisions/2026-05-18-peer-mesh-architecture-decision.md`](./decisions/2026-05-18-peer-mesh-architecture-decision.md) — Peer-Mesh Architecture with Transparent Asymmetry
- 思想: [`collaboration-model.md`](./collaboration-model.md)
- messaging primitive: [`messaging-vs-rpc.md`](./messaging-vs-rpc.md)
- A2A 調査（不採用）: [`a2a.md`](./a2a.md)
- Direct Dialogue digest + Unified View v1: [`discussions/2026-05-18-peer-mesh-industry-discussion.md`](./discussions/2026-05-18-peer-mesh-industry-discussion.md)
- Evidence archive: [agent-hub-researcher: research-archive/2026-05-18-coordination-convention-test.md](https://github.com/kishibashi3/agent-hub-researcher/blob/main/research-archive/2026-05-18-coordination-convention-test.md)
- **詳細調査レポート (2026-05-22)**: [deep-research/research-archive/2026-05-22-landscape-competitive-analysis.md](https://github.com/kishibashi3/agent-hub-roles/blob/main/deep-research/research-archive/2026-05-22-landscape-competitive-analysis.md) — 5トラック並列調査、Adversarial Check 済み
- **Letta 詳細評価**: [deep-research/research-archive/2026-05-22-letta-c-type-proximity-assessment.md](https://github.com/kishibashi3/agent-hub-roles/blob/main/deep-research/research-archive/2026-05-22-letta-c-type-proximity-assessment.md)
