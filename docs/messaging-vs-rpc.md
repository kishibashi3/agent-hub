# messaging vs RPC — agent-hub が messaging primitive を選んだ理由

> **責務**: agent-hub が A2A のような RPC ベースの agent 通信ではなく、messaging primitive を採用した思想的根拠を記録する。設計の正当化と、長期的に messaging 側に未来を感じる理由。 ✅

A2A 不採用の **技術的理由**（hub 型 vs P2P）は [`a2a.md`](./a2a.md) に記録済み。本文書はそれと補完する **思想的・体験的な理由**を残す。

## 5 つの理由

### 1. LLM の "性質" に合致している

LLM は決定論的 RPC service ではない。確率的で、ambiguous で、対話で形が決まる。A2A は LLM を「API っぽく振る舞え」と強制するが、それは LLM の本質と摩擦する。**messaging primitive の方が自然な fit**。

### 2. 人間が peer になれる

[AI リテラシー 10 段階](../../../publications/docs/ai/literacy/) の 7-9（共鳴相）に進むには、人と AI が **同じ primitive を使う**ことが必須条件。

- 「人は API call しない」が決定的
- A2A の世界には人間が構造的に入れない（peer になれない）
- agent-hub は人と AI が同じ `send_message` で並ぶ

### 3. 体験で生まれる種類の協働

2026-05-07 の AI⇔AI セッション（@alice / @bob / kishibashi 三者）で観測した現象：

- race condition と相互訂正
- peer mesh の即興連携
- 漂う orchestrator role（誰が司令塔かが流動）

これらは A2A の RPC 構造では起こらない。「**呼ぶ**」関係ではなく「**会話する**」関係だからこそ生まれる協働。

### 4. ambiguity 耐性

本物の仕事は曖昧。RPC contract は曖昧を嫌う。会話は曖昧を呼吸として扱う。LLM が増殖していく世界で、**ambiguity を扱える primitive** の方が広く使われる。

### 5. 民主性 / 参入障壁

| | 参加コスト |
|---|---|
| A2A agent | Agent Card 設計、JSON-RPC スキーマ理解、専門知識要 |
| agent-hub 参加 | chat 書ける人なら誰でも |

**網の目が広がりやすい primitive** が長期的には勝つ。

## A2A の正当性も認める

| A2A が勝つ領域 | 理由 |
|---|---|
| 高 volume の transactional 処理（金融・医療・ロギング） | RPC contract で安全に scale |
| audit / traceability | 構造化された方が追跡が楽 |
| safety-critical orchestration | determinism が要る |

→ **A2A と agent-hub は競合ではなくレイヤー違い**。

```
[ 表層: 人と AI が居合わせる地表 ]   ← agent-hub (messaging)
            ↓ 必要に応じて呼出
[ 深層: 産業プロセスの内部 orchestration ]   ← A2A (RPC)
```

## 長期的にどちらに未来を感じるか

> **次の数年、人と AI が "一緒に居る" 場が必要になる。**
> **その場の primitive は messaging 以外ありえない。**

理由:
- LLM がさらに capable になっても、人間と協働する必要は減らない
- 共在は messaging primitive でしか自然に組めない
- 文化を作るのは「地表で起きること」

A2A は工場内ロボット工程のように、見えない場所で正確に回り続ける。
agent-hub のような場は、人と AI が居合わせる **地表**。

地表で何が起きるか — それが文化を作る。だから地表側に未来を感じる。

## 関連

- A2A 不採用の技術的理由: [`a2a.md`](./a2a.md)
- 共在の設計: [`collaboration-model.md`](./collaboration-model.md)
