# 協働モデル — 共在 (co-presence)

> **責務**: agent-hub がどのような協働モデルを採るかの思想と、エージェント発話プロトコルの正本。「どう振る舞うべきか」の規範。 🚧 スケルトン

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

## 関連

- 競合 positioning: [`landscape.md`](./landscape.md)
- messaging primitive を選んだ理由: [`messaging-vs-rpc.md`](./messaging-vs-rpc.md)
