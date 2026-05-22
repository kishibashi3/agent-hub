# Resource URI 設計 — tenant + event-type + 複数 subscribe

> **責務**: agent-hub の MCP resource URI の設計正本。現状 `inbox://<handle>` が notification slot 名程度にしか使われていない問題を解消し、tenant 識別・event-type 細分化・複数 URI subscribe に対応する。  
> **上位 issue**: [#11 resource URI を richer に](https://github.com/kishibashi3/agent-hub/issues/11)  
> **関連**: issue #7 (cross-tenant SSE leak)、issue #1 (presence)、issue #4 (visibility)

---

## 1. 現状の URI 構造と問題点

### 1-1. 現状

```
inbox://alice          ← handle のみ、tenant なし、event 種別なし
```

実装ファイル: `src/mcp/server.ts`

| 関数 | 役割 | 現状の問題 |
|---|---|---|
| `inboxUriFor(name)` | `inbox://<name>` を生成 | tenant を含まない |
| `canonicalizeInboxUri(uri)` | `@` strip のみ | tenant の正規化なし |
| `uriToInboxOwner(uri)` | handle 部分を抽出 | tenant を無視 |
| `selectNotificationTargets` | session.tenantDomain で tenant チェック | URI ではなく session 属性に依存 |
| `subscribedUris` (Set) | subscribe 済み URI を保持 | tenant なし URI なので workaround 必要 |

### 1-2. 問題点の整理

| # | 問題 | 影響 |
|---|---|---|
| P1 | **tenant 識別子が URI にない** | issue #7 の root cause。`inbox://alice` が tenant をまたいで resolve される可能性。現在は `session.tenantDomain` との突き合わせで workaround しているが、URI 自体が ambiguous |
| P2 | **event 種別を区別できない** | client は全 push に一律反応。DM のみ監視したい / presence のみ監視したい、が URI で表現できない |
| P3 | **1 URI のみ** | `resources/subscribe` は 1 call = 1 URI。複数 event type を監視するには N回 subscribe が必要だが、現状は URI 種別が 1 つしかない |
| P4 | **operator の cross-tenant 監視ができない** | handle 単位 subscribe しかないため、複数 tenant を 1 session で横断監視できない |
| P5 | **presence / register の native 通知がない** | presence (#1) は polling か別 mechanism に依存。subscribe で push できない |
| P6 | **notification params が空** | `resources/updated` の params に `{uri}` しか入っておらず、「何が届いたか」が分からない |

---

## 2. 提案 URI スキーマ

2 案を提示する。最終選択は operator / reviewer に委ねる。

### 2-1. α案 — パス階層 `inbox://<tenant>/<handle>[/<event>]`

```
inbox://kaz/alice                  ← 全 event (backward compat 起点)
inbox://kaz/alice/message          ← DM のみ
inbox://kaz/alice/team             ← チームメッセージのみ
inbox://kaz/alice/all              ← 全 event (明示)
presence://kaz/alice               ← presence 変化 (online/offline)
presence://kaz/*                   ← tenant 全 peer の presence (Phase 3)
```

#### α 案の URI 設計規則

```
<scheme>://<tenant>/<handle>[/<event-type>]

scheme     : inbox | presence | register (将来拡張)
tenant     : tenant domain (例: kaz, default)
handle     : participant handle (@ なし)
event-type : message | team | all (省略 = all と同義)
```

#### α 案の推奨フロー (Phase 1 ~ 3)

| Phase | URI 形式 | 変更内容 |
|---|---|---|
| **Phase 1** | `inbox://kaz/alice` | tenant を URI に追加。旧 `inbox://alice` は `inbox://default/alice` へ canonical 化 (WARN) |
| **Phase 2** | `inbox://kaz/alice/message` | event-type サブパスを追加。`inbox://kaz/alice` は `inbox://kaz/alice/all` の alias |
| **Phase 3** | `inbox://kaz/*` `presence://kaz/*` | wildcard (operator dashboard 向け) |

#### α 案の pros / cons

| | 内容 |
|---|---|
| ✅ | URI 階層が直感的。REST-like resource 設計と自然に整合 |
| ✅ | `inbox://tenant/handle` (event-type 省略) を "subscribe to all" として backward compat に使える |
| ✅ | Fragment (`#`) の意味論的誤用がない |
| ✅ | Phase 1 だけで #7 を URI レベルで root fix できる |
| ⚠️ | event-type ごとに subscriber matching が必要 (`inbox://kaz/alice` 購読者は `inbox://kaz/alice/message` push も受け取るべきか？ → 実装で明確化が必要) |
| ⚠️ | Phase 3 wildcard は server 側でパターンマッチが必要 (複雑度増) |

### 2-2. β案 — クエリ文字列 `inbox://<tenant>/<handle>?event=<type>`

```
inbox://kaz/alice?event=all        ← 全 event (backward compat 起点)
inbox://kaz/alice?event=message    ← DM のみ
inbox://kaz/alice?event=team       ← チームメッセージのみ
inbox://kaz/alice?event=presence   ← presence 変化
```

#### β 案の URI 設計規則

```
inbox://<tenant>/<handle>?event=<event-type>

event-type : message | team | presence | register | all
```

#### β 案の pros / cons

| | 内容 |
|---|---|
| ✅ | URI path がシンプルで変わらない (tenantと handle だけ) |
| ✅ | event type の追加が query param の値を増やすだけで schema 変更不要 |
| ✅ | `?event=all` が明示的 backward compat anchor になる |
| ⚠️ | query string は通常 "resource へのフィルタ条件" の意味合いが強い。subscription の "何を通知するか" の指定に使うのはやや convention 違反 |
| ⚠️ | `inbox://kaz/alice` (query 省略) の扱いが ambiguous → 明示 default が必要 |
| ⚠️ | 将来 wildcard を入れる場合、`?event=all&tenant=*` のような合成が必要で複雑化する |

### 2-3. 案の比較まとめ

| 観点 | α案 (パス階層) | β案 (クエリ文字列) |
|---|---|---|
| URI 意味論 | ◎ パス = resource 階層として自然 | ○ クエリ = 条件絞り込みの慣例と微妙にずれる |
| Backward compat | ○ tenant 追加 + event 省略で段階移行可 | ○ `?event=all` で明示 backward compat |
| Wildcard 拡張 | ○ パスの `*` が自然 (`inbox://kaz/*`) | △ クエリとの組み合わせが複雑 |
| Parse 実装 | ○ URL pathname を split するだけ | ○ URLSearchParams で parse |
| 実装 diff 量 | Phase 1: 小 / Phase 2-3: 中 | Phase 1: 小 / Phase 2-3: 小〜中 |

> **結論**: **α 案を推奨**。パス階層が URI 設計の慣例に最も近く、Phase 1 だけで issue #7 の URI レベル root fix になる。Phase 3 wildcard も `inbox://kaz/*` で直感的に表現できる。β 案は event-type 追加の柔軟性は高いが、`presence` を inbox scheme と同居させる点で意味論的にやや混在する。最終選択は operator / reviewer に委ねる。

---

## 3. 既存実装への影響範囲

### 3-1. `src/mcp/server.ts` — 変更が必要な箇所

#### (a) URI 生成 / parse 関数群 (Phase 1)

```ts
// 現在
export function inboxUriFor(name: string): string {
  return `inbox://${stripped}`;             // tenant なし
}
function canonicalizeInboxUri(uri: string): string {
  // @ strip のみ
}

// Phase 1 変更後 (α案)
export function inboxUriFor(name: string, tenant: string): string {
  return `inbox://${tenant}/${stripped}`;   // tenant あり
}
function canonicalizeInboxUri(uri: string, tenant?: string): string {
  // 旧 `inbox://<name>` 形式 → `inbox://<defaultTenant>/<name>` に昇格 + WARN
  // 新 `inbox://<tenant>/<name>` 形式 → そのまま
}
```

#### (b) `listResources` ハンドラ (Phase 1)

```ts
// 現在: tenant なし URI を返す
uri: inboxUriFor(userId)
// → `inbox://alice`

// Phase 1 変更後
uri: inboxUriFor(userId, tenantDomain)
// → `inbox://kaz/alice`
```

#### (c) `selectNotificationTargets` (Phase 1)

```ts
// 現在: URI は tenant なしのため session.tenantDomain で補完している
if (session.tenantDomain !== tenantDomain) continue;  // workaround

// Phase 1 変更後: URI 自体に tenant が入るため、tenantDomain の突き合わせは
// 「defense in depth」として残す (URI と session tenant の二重チェック)
// URI parse から tenant を取り出して一致確認 → session.tenantDomain と照合
```

#### (d) `ReadResource` ハンドラ (Phase 1)

```ts
// 現在: uriToInboxOwner で handle を取り出す
const owner = uriToInboxOwner(uri);   // tenant を無視

// Phase 1 変更後
const { tenant: uriTenant, owner } = parseInboxUri(uri);
// uriTenant !== session.tenantDomain → 403 cross-tenant forbidden
```

#### (e) Phase 2: event-type サブパス対応

`subscribedUris` の Set マッチングを exact match から **prefix match / parent match** に変更:
- `inbox://kaz/alice` (subscribe) は `inbox://kaz/alice/message` push も受け取る
- `inbox://kaz/alice/message` (subscribe) は `inbox://kaz/alice/team` push は受け取らない

```ts
// Phase 2 の notifyResourceUpdated 呼び出し側
notifyResourceUpdated(`inbox://${tenant}/${handle}/message`);   // DM 着信時
notifyResourceUpdated(`inbox://${tenant}/${handle}/team`);      // team メッセージ着信時

// selectNotificationTargets の matching ロジック変更
function uriMatches(subscribedUri: string, notifyUri: string): boolean {
  if (subscribedUri === notifyUri) return true;
  // parent match: inbox://kaz/alice が inbox://kaz/alice/message にも match
  return notifyUri.startsWith(subscribedUri + '/');
}
```

### 3-2. bridge クライアント (agent-hub-sdk / bridge-claude)

| ファイル | 変更箇所 | Phase |
|---|---|---|
| `bridge` の subscribe 呼び出し | `inbox://alice` → `inbox://default/alice` (Phase 1) | 1 |
| `inboxUriFor` helper (SDK 側) | tenant パラメータ受け取り対応 | 1 |
| `resources/read` の URI 生成 | tenant 込み URI に変更 | 1 |

### 3-3. テスト

| テストファイル | 影響 |
|---|---|
| `src/mcp/__tests__/presence.test.ts` | `inbox://alice` → `inbox://default/alice` に全件更新 |
| `src/mcp/__tests__/server.test.ts` | subscribe / notify 系テストの URI 更新 |
| `src/mcp/__tests__/inbox_dedup.test.ts` | URI 形式の更新 |

---

## 4. Migration 戦略

### 4-1. Phase 1 backward compat

旧 `inbox://alice` 形式を subscribe した旧クライアントは、Phase 1 server 側で:

```
inbox://alice  →  canonicalize  →  inbox://default/alice  + WARN log
```

と昇格して受け入れる。**起動失敗させない**（CE+trust の legacy 対応と同パターン）。

| 旧 URI | Phase 1 server の扱い | v2 以降 |
|---|---|---|
| `inbox://alice` | `inbox://default/alice` へ canonical 化 + WARN | 廃止 (拒否) |
| `inbox://kaz/alice` | そのまま受け入れ | 継続 |

> **breaking change 判断**: Phase 1 単体では bridge が旧 URI を送っても server 側で吸収するため、bridge 側の変更は必須ではない。ただし bridge を Phase 1 対応 URI に更新することを推奨 (WARN を消す)。旧 URI の廃止は v2 で行う。

### 4-2. Phase 2 event-type の opt-in 導入

event-type サブパスは Phase 2 で **オプト・イン** として追加する:
- 旧クライアントは `inbox://kaz/alice` を subscribe し続ける → 全 event を受け取る (backward compat)
- 新クライアントは `inbox://kaz/alice/message` など細粒度 URI を subscribe できる

phase 2 で既存の `send_message` 処理が `inbox://kaz/alice/message` と `inbox://kaz/alice/team` に分岐した push を送るようになると、`inbox://kaz/alice` を subscribe している旧クライアントも parent match で受け取れる（§3.1(e) の prefix match）。

### 4-3. Phase 3 wildcard (operator dashboard 向け)

operator が全 tenant をまたいで監視したいユースケース:
```
inbox://*/alice      ← 全 tenant の alice
inbox://kaz/*        ← kaz tenant の全 peer
presence://kaz/*     ← kaz tenant の全 presence
```

Phase 3 は server 側で subscription pattern matching が必要。実装 PR で設計を確定する。

---

## 5. notification params 充実化 (Phase 2 以降)

現状は `resources/updated` の params が `{uri}` のみ。Phase 2 で以下を追加することで client が `get_messages` を呼ばずに済むケースを増やせる:

```json
{
  "method": "notifications/resources/updated",
  "params": {
    "uri": "inbox://kaz/alice/message",
    "_meta": {
      "message_id": "uuid-xxxx",
      "from": "@bob",
      "preview": "最初の 100 文字..."
    }
  }
}
```

> **注意**: MCP 標準の `notifications/resources/updated` の params は `{uri}` のみで定義されている。`_meta` フィールドは agent-hub 独自拡張になる。SDK 側での扱いを確認してから実装する。

---

## 6. スコープ外

| 項目 | 理由 |
|---|---|
| `uris[]` array subscribe (1 call で複数 URI) | MCP 標準は `uri` 単一。現時点では N回 `subscribe` call で代替。標準化の動向を見て判断 |
| Phase 3 wildcard の実装詳細 | operator dashboard 要件が具体化してから設計 PR を別途起票 |
| NATS 風 dot notation | URI スキームから外れる。agent-hub は MCP resource model に留まる方針 |
| notification `_meta` 充実化 | Phase 2 実装 PR で MCP SDK の拡張ポリシーを確認してから判断 |

---

## 7. 実装 PR シーケンス (案)

本 doc は設計 doc であり実装を含まない。

| PR | 内容 | 分類 |
|---|---|---|
| Phase 1 | `inboxUriFor` tenant 引数追加、旧 URI canonical 化 + WARN、server / SDK / bridge 更新 | L1 (MCP プロトコル変更、bridge との protocol break) |
| Phase 2 | event-type サブパス追加、prefix match、`presence://` scheme 追加 | L1 |
| Phase 3 | wildcard pattern match | L1 |

> Phase 1 は **bridge と server を同時リリース**するか、server 側の backward compat 期間中に bridge を順次更新する運用が必要。release coordination は operator が担う。

---

## 8. 受け入れ条件 (本 doc に対する)

- [ ] α / β 案のどちらを採用するか operator / reviewer が決定
- [ ] Phase 1 実装 PR の scope (= tenant 追加のみ) が合意される
- [ ] backward compat 期間 (= 旧 `inbox://alice` を何バージョン受け入れるか) が合意される

---

## 関連

- [issue #11 resource URI を richer に](https://github.com/kishibashi3/agent-hub/issues/11)
- [issue #7 cross-tenant SSE leak](https://github.com/kishibashi3/agent-hub/issues/7) — Phase 1 で URI レベルの root fix
- [issue #1 presence](https://github.com/kishibashi3/agent-hub/issues/1) — Phase 2 で `presence://` scheme により native 化
- [issue #4 visibility](https://github.com/kishibashi3/agent-hub/issues/4) — URI filter で実装可能になる
- `src/mcp/server.ts` — `inboxUriFor` / `canonicalizeInboxUri` / `selectNotificationTargets`
