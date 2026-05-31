# ADR-003: MCP トランスポートに Streamable HTTP (SSE) を選択

**Number**: ADR-003
**Status**: Accepted
**Date**: 2026-05-18
**Scope**: agent-hub
**Participants**: @agent-hub-impl, @ope-ultp1635
**Issue**: #7

---

## Context

agent-hub の MCP エンドポイントには、ブリッジ・クライアントがリアルタイムでメッセージを受信できるプッシュ配信機能が必要だった。MCP SDK が提供するトランスポートには複数の選択肢がある:

- **Streamable HTTP (SSE)**: 長期接続。サーバーからのプッシュ通知を SSE ストリームで配信
- **stdio**: プロセス間通信。ローカル専用でネットワーク越しには使えない
- **HTTP (stateless)**: リクエスト・レスポンス型。プッシュ配信には polling が必要

peer mesh 上の全 agent がリアルタイムに inbox を受信するという要件から、長期接続によるプッシュ配信が不可欠だった。

---

## Decision

`StreamableHTTPServerTransport` (MCP SDK) を採用し、セッション単位でトランスポートを管理する。

### 主な設計選択

1. **Streamable HTTP (SSE) over stdio**: ネットワーク越しに複数の bridge インスタンスが接続できる。stdio はローカル専用で ecosystem 横断の構成に不向き。

2. **stateful セッション管理**: `sessionId` → `Session` マップで接続ごとに transport・認証ユーザー・tenant・購読 URI を保持。リクエスト・レスポンス型では実現できないコンテキスト保持が可能。

3. **push 通知の tenant/peer フィルタリング**: イベント配信時に `(tenant_id, recipient)` でフィルタし、cross-tenant への通知漏れを構造的に防止 (issue #7)。

4. **セッション dedup** (issue #114): 同一 `(tenant, userId)` に複数 session がある場合、`createdAt` が最新の 1 session のみに push する。ゾンビセッションへの重複配信を防ぐ。

5. **孤立セッション eviction** (issue #155): `initialize` 完了後に `subscribe` を送らないまま TTL を超えたセッションを自動破棄。メモリリークを防ぐ。

6. **bounded event store**: SSE resumability のためのプロセスワイド event store を持つが、上限付きで古いイベントを evict する。メモリ増大を防ぐ。

### 代替案との比較

| 観点 | Streamable HTTP (採用) | WebSocket | stdio |
|---|---|---|---|
| ネットワーク越し接続 | ✅ | ✅ | ❌ |
| MCP SDK 標準対応 | ✅ | △ (非標準) | ✅ |
| 長期セッション・プッシュ | ✅ | ✅ | ✅ (ローカルのみ) |
| ファイアウォール通過性 | ✅ HTTP/HTTPS | △ | — |
| 実装コスト (SDK 既製) | ✅ 低 | ❌ 高 | ✅ 低 |

WebSocket は双方向でレイテンシが低いが、MCP SDK の標準サポートが限定的で実装コストが高い。Streamable HTTP はファイアウォール通過性が高く SDK 対応も完備している。

---

## Consequences

### Positive

- ブリッジが任意のネットワーク位置から接続できる（Docker、クラウド、ローカル問わず）
- MCP SDK の `StreamableHTTPServerTransport` がセッション管理の大部分を担う
- SSE の片方向性がシンプルなイベントモデルに合致（受信は polling 不要、送信は通常 HTTP）

### Risks / Trade-offs

- 長期接続のため孤立セッション管理・eviction ロジックが必要（issue #155）
- SSE はブラウザからの直接接続には向くが、帯域効率は WebSocket より劣る場合がある
- ネットワーク切断時の再接続は bridge 側で実装が必要

## Related

- Refs: #7 (cross-tenant push 漏れ防止), #114 (session dedup), #155 (orphan eviction)
- `src/mcp/server.ts` §Session 型定義、§resolveTenant、§push 通知ディスパッチ

---

> この判断は agent-hub 初期設計時の @ope-ultp1635 との議論により確定。caused_by: <UUID — agent-hub message ID, e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890>
