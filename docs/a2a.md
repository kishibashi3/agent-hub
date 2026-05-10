# Google A2A プロトコル調査レポート

> **責務**: A2A プロトコルの仕様概要・Agent Card・メッセージング・SDK の調査結果。 ✅
>
> **⚠️ 非採用**: 2026-03-29 の設計セッションで A2A を不採用とし、MCP に一本化した。理由: A2A は P2P トポロジ前提だが、agent-hub はハブ型。本文書は調査記録として保存する。思想的補完は [`messaging-vs-rpc.md`](./messaging-vs-rpc.md) 参照。

調査日: 2026-03-28
ソース: Web検索（公式仕様書、GitHub、AWS/LangChain ドキュメント）

## 概要

A2A (Agent-to-Agent) は、異なるAIエージェント間の通信を標準化するオープンプロトコル。

- 公式リポジトリ: https://github.com/a2aproject/A2A
- 仕様: https://a2a-protocol.org/v0.3.0/specification/
- プロトコルバージョン: v0.3.0
- ベース: JSON-RPC 2.0
- ライセンス: Apache 2.0

## A2A と MCP の関係

**補完関係であり、競合ではない。**

| | A2A | MCP |
|---|---|---|
| 方向 | 水平（エージェント↔エージェント） | 垂直（エージェント↔ツール/データ） |
| 目的 | エージェント間の連携・委譲 | 外部ツール・データソースへのアクセス |
| 例 | 営業エージェント→承認エージェント | エージェント→DB検索ツール |

組み合わせ: プランナーエージェントが A2A で他エージェントに依頼 → 各エージェントは MCP でツールを使う

## Agent Card

エージェントの自己紹介。`/.well-known/agent-card.json` で公開する。

```json
{
  "name": "Approval Agent",
  "description": "契約承認を処理するエージェント",
  "version": "1.0.0",
  "url": "https://api.example.com/a2a",
  "protocolVersion": "0.3.0",
  "capabilities": {
    "streaming": true
  },
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "skills": [
    {
      "id": "contract-approval",
      "name": "契約承認",
      "description": "契約の承認・却下を処理する",
      "tags": ["approval", "contract"]
    }
  ]
}
```

## メッセージング

### message/send（同期）

リクエスト:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {
          "kind": "text",
          "text": "X社との契約を承認してください"
        }
      ],
      "messageId": "msg-uuid-here"
    },
    "metadata": {}
  }
}
```

レスポンス:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "task-uuid",
    "contextId": "context-uuid",
    "status": {
      "state": "completed"
    },
    "artifacts": [
      {
        "artifactId": "artifact-uuid",
        "name": "approval-result",
        "parts": [
          {
            "kind": "text",
            "text": "承認しました。条件: 来年は15%で交渉してください。"
          }
        ]
      }
    ]
  }
}
```

### message/stream（SSE ストリーミング）

レスポンスは `text/event-stream` で返る。イベント種別:

| イベント | 用途 |
|---|---|
| `TaskStatusUpdateEvent` | タスクの状態変化（working → input-required → completed） |
| `TaskArtifactUpdateEvent` | 生成物の配信（チャンク分割対応） |

ストリーム終了条件: COMPLETED, FAILED, CANCELED, REJECTED, INPUT_REQUIRED

## タスクの状態遷移

```
submitted → working → completed
                ↓
          input-required  ← これがHITL
                ↓
            working → completed
```

**`input-required` が HITL のプロトコル表現。** エージェントが人間の入力を待っている状態。

## SDK

### Python（公式）

```python
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import InMemoryTaskStore
from a2a.utils import new_agent_text_message

class MyAgentExecutor(AgentExecutor):
    async def execute(self, context: RequestContext, event_queue: EventQueue):
        result = await self.process(context)
        event_queue.enqueue_event(new_agent_text_message(result))

    async def cancel(self, context: RequestContext, event_queue: EventQueue):
        raise Exception('cancel not supported')

# サーバー起動
handler = DefaultRequestHandler(
    agent_executor=MyAgentExecutor(),
    task_store=InMemoryTaskStore()
)
app = A2AStarletteApplication(agent_card=card, http_handler=handler)
# uvicorn で起動
```

- リポジトリ: https://github.com/a2aproject/a2a-python
- フレームワーク: Starlette + Uvicorn (ASGI)

### JavaScript/TypeScript（公式）

```bash
npm install @a2a-js/sdk
```

- リポジトリ: https://github.com/a2aproject/a2a-js
- v0.3.0 対応
- Node.js + ブラウザ対応
- SSE サポート

### 他の実装

- Dexwox A2A Node SDK: `npm install @dexwox-labs/a2a-node`
- AWS Bedrock AgentCore: A2A プロトコル対応

## 私たちのプロダクトへの適用

### コンテンツ追加型 HITL = `input-required` 状態

```
田中エージェント → Kazuhiroエージェント: message/send「承認して」
                                            ↓
Kazuhiroエージェント: status = "working"
Kazuhiroエージェント: status = "input-required" ← Kazuhiroに聞く
                                            ↓
Kazuhiro（人間）: フィードバック → message/send
                                            ↓
Kazuhiroエージェント: status = "working"
Kazuhiroエージェント: status = "completed" + artifact（承認結果+学び）
                                            ↓
田中エージェント: artifact を受け取る
```

**A2A の `input-required` 状態が、まさにコンテンツ追加型 HITL のプロトコル表現。**

## 参考リンク

- [A2A Protocol 仕様 v0.3.0](https://a2a-protocol.org/v0.3.0/specification/)
- [A2A GitHub](https://github.com/a2aproject/A2A)
- [A2A Python SDK](https://github.com/a2aproject/a2a-python)
- [A2A JS SDK](https://github.com/a2aproject/a2a-js)
- [A2A Streaming & Async](https://a2a-protocol.org/latest/topics/streaming-and-async/)
- [MCP vs A2A 比較 (Auth0)](https://auth0.com/blog/mcp-vs-a2a/)
- [A2A Protocol Explained (HuggingFace)](https://huggingface.co/blog/1bo/a2a-protocol-explained)
- [A2A Purchasing Concierge Codelab](https://codelabs.developers.google.com/intro-a2a-purchasing-concierge)
