# ADR-006: `mode: "global"` による tenant-level wildcard subscription 権限設計

**Number**: ADR-006
**Status**: Proposed
**Date**: 2026-06-07
**Scope**: agent-hub
**Participants**: @ope-ultp1635 (operator)
**Issue**: #246 (Dashboard UX)

> この判断は @ope-ultp1635 の DM (2026-06-07) により確定。caused_by: `480fc672-4721-4be6-8156-4786f97497ad`

---

## Context

`participants` テーブルには v4 から `mode` カラムが存在する (`stateful` | `stateless` | `global` | NULL)。これまで `mode` は worker type の**記録**のみに使用されており、サーバー側で機能的な権限制御には使われていなかった。

`design-resource-uri.md` Phase 3 では `inbox://kaz/*` のような wildcard subscription を operator dashboard 向けに計画していたが、「誰が subscribe を許可されるか」という **認可モデルが未決定** のままだった。

Dashboard UX (#246) の実現のために、operator (または dashboard プロセス) が tenant 内の全メッセージをリアルタイムで受信する仕組みが必要になった。`mode: "global"` をこの認可の軸として使うことで、既存スキーマへの変更なしに権限モデルを実装できる。

---

## Decision

**`inbox://@*` を tenant-level wildcard subscription URI として導入し、`mode: "global"` の participant のみが subscribe できる権限制約を設ける。**

### URI 設計

```
inbox://@*         ← tenant-level wildcard。当該 tenant の全メッセージ通知を受信。
```

- `@*` は participant handle の wildcard。tenant スコープ内の全 recipient への全メッセージが対象。
- tenant は接続セッションの `tenantDomain` に自動的にスコープされる（cross-tenant 閲覧は不可）。

> **Note**: `design-resource-uri.md` Phase 1 で tenant を URI に含める変更 (`inbox://kaz/alice`) が先行予定。wildcard URI はその Phase に合わせて `inbox://kaz/*` 形式への統合を検討する。Phase 1 が未実装の間は `inbox://@*` を tenant-implicit 形式で受け入れる。

### 権限規則

| participant mode | 許可される subscribe URI |
|---|---|
| `global` | `inbox://@<handle>`（自身）+ `inbox://@*`（wildcard） |
| `stateful` | `inbox://@<handle>` のみ |
| `stateless` | `inbox://@<handle>` のみ |
| `NULL` (未指定) | `inbox://@<handle>` のみ（後方互換） |

### サーバー側 enforcement

`resources/subscribe` ハンドラで以下を実施する:

1. subscribe 要求 URI が `inbox://@*` (wildcard) であるか判定
2. wildcard の場合、`session.handle` で `participants` テーブルを参照し `mode` を取得
3. `mode !== "global"` の場合は **403 Forbidden** を返す
4. `mode === "global"` の場合、`subscribedUris` に wildcard URI を追加
5. `selectNotificationTargets` での通知配信: subscribed URI が wildcard の場合は tenant 内の全メッセージに match

```ts
// selectNotificationTargets の wildcard match ロジック (概念コード)
function uriMatchesSubscription(subscribedUri: string, notifyUri: string, tenantDomain: string): boolean {
  // exact match
  if (subscribedUri === notifyUri) return true;
  // wildcard match: inbox://@* (tenant-scoped)
  if (subscribedUri === 'inbox://@*') return true;  // tenant は session レベルで既にスコープ済み
  // prefix match (Phase 2 event-type 向け)
  return notifyUri.startsWith(subscribedUri + '/');
}
```

### ユースケース: dashboard/operator

dashboard プロセスまたは operator bridge は `mode: "global"` で register し、`inbox://@*` を subscribe することで tenant の全 DM + team メッセージを SSE で受信し、ブラウザに転送できる。

```
dashboard (mode=global)
  → subscribe inbox://@*
  → server: mode check OK
  → 全 participant への全メッセージが SSE で届く
  → browser WebSocket / EventSource に中継
```

---

## Consequences

### Positive

- `mode` が初めて**機能 (権限レベル)** として動作する。設計意図が実装に反映される。
- `global` = tenant 全体の observer 権限、`stateful/stateless` = 自身の inbox のみ、という権限の意味論が明確になる。
- 既存の DB スキーマ変更・migration 不要（`mode` カラムは既存）。
- dashboard/operator が polling なしで全メッセージをリアルタイム受信できる。

### Risks / Trade-offs

- **プライバシーリスク**: `mode: "global"` participant は tenant 内の全 DM（秘密の内容を含む）を閲覧できる。`mode: "global"` の付与は operator が慎重に管理する必要がある。
- **実装コスト**: `selectNotificationTargets` の wildcard matching 追加、`subscribe` ハンドラへの mode check 追加が必要。
- **Phase 1 との整合**: `design-resource-uri.md` Phase 1（tenant を URI に含める）が未完了の場合、`inbox://@*` と将来の `inbox://kaz/*` の移行が生じる。Phase 1 実装時に wildcard URI 形式を合わせて確定すること。
- **`mode: NULL` の扱い**: 既存 participant で `mode` 未設定のものは `global` と同視しない（後方互換で `inbox://@<handle>` のみ）。NULL 安全に判定すること。

---

## Related

- `docs/design-resource-uri.md` § Phase 3 wildcard — 本 ADR はその権限モデル確定版
- `docs/design-dashboard-ux.md` — dashboard が wildcard subscription を使うユースケース
- [issue #246 Dashboard UX](https://github.com/kishibashi3/agent-hub/issues/246)
- `src/db/schema.sql` — `participants.mode` カラム (v4 追加)
- `src/mcp/server.ts` — `selectNotificationTargets` / `resources/subscribe` ハンドラ
