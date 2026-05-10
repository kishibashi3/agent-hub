# agent-hub Landscape — 2026年競合 Positioning

> **責務**: 「人＋エージェントが対等に共在する協働空間」という観点での競合・近縁プロダクト調査。agent-hub の差別化軸を明確化する。 🚧 スケルトン

調査日: 2026-05-05（初版スケルトン）

## 分類軸

製品を「**人とエージェントの関係性**」で3類型に分ける:

| 類型 | モデル | 例 |
|---|---|---|
| **A. 委任型シングルエージェント** | 人 → AI に丸投げ → 人がレビュー | Devin, Cursor Background Agent |
| **B. オーケストレーション型マルチエージェント** | 人 = 監督、AI = ワーカー群 | AutoGen, CrewAI, LangGraph, BAND, Microsoft Agent 365 |
| **C. 共在型ペアエージェント** | 人＋エージェントペアが対等に交わる | **agent-hub** ／ Negroponte 構想（製品化希薄） |

## 候補一覧（要詳細調査）

| 製品 | 類型 | agent-hub との一致度 | 備考 |
|---|---|---|---|
| Devin | A | × | 委任型。比較表で対比すると agent-hub の "共在" が際立つ |
| Cursor Background Agent | A | × | 委任型 |
| BAND | B | × | distributed multi-agent + governance。agent ops 寄り |
| Microsoft Agent 365 / Copilot Chat | B | × | M365 内ワーカー。Copilot は脇役 |
| AgentCraft | B | × | Hall でエージェント可視化、人が指示 |
| AutoGen / Microsoft agent-framework | B | × | フレームワーク |
| CrewAI | B | × | タスク委任クルー |
| LangGraph | B | × | DAG/グラフベース |
| A2A (Google) | — | × | プロトコル層、製品ではない |
| Letta (旧 MemGPT) multi-agent | B寄り | △ | エージェント間DM。"人＋エージェント" ペア概念なし |
| personal.ai | — | △ | 個人専属AI、ペア交流場なし |
| Slack/Teams + bot | — | × | bot は脇役 |
| Negroponte / Knowledge Navigator | C（思想） | ◎ | "your agent talks to my agent" の元祖構想 |

> TODO: 各候補について公式ドキュメント・最新リリースを確認し、類型と一致度を確定する。

## agent-hub の差別化軸（仮説）

1. **共在 (co-presence)** — 委任ではなく在席。エージェントは同席者
2. **対等プリミティブ** — 人/AI 区別なく `send_message`
3. **MCP ネイティブ** — 任意のクライアント（Claude Code / ChatGPT / IDE）から接続可能
4. **HITL が溶ける** — Human-in-the-Loop が概念として不要になる
5. **OSS** — Microsoft Agent 365 等のロックインに対する OSS 代替

## 結論（仮）

C類型（共在型ペアエージェント）を正面から実装する量産製品は、調査時点では見当たらない。**空席ポジション**である可能性が高い。

ただし、Negroponte / Knowledge Navigator の系譜に思想的祖先があり、2026年の "agent-to-agent web" 議論の文脈とは整合する。

## 次のアクション

- [ ] BAND の最新ドキュメントを精読（最も思想が近い競合の可能性）
- [ ] Microsoft Agent 365 の発表記事（2026-05-05）の詳細確認
- [ ] Letta multi-agent の実装を確認（"代理"の概念が無いか）
- [ ] "Personal AI Envoy" 系の最新製品を網羅調査（Task サブエージェントで実施）
- [ ] 結果を反映して本ファイルを確定版に更新

## 関連

- 思想: [`collaboration-model.md`](./collaboration-model.md)
- messaging primitive: [`messaging-vs-rpc.md`](./messaging-vs-rpc.md)
- A2A 調査（不採用）: [`a2a.md`](./a2a.md)
