# Cross-PAT Message Gate Flag 設計 doc

> **対象 issue**: [#5](https://github.com/kishibashi3/agent-hub/issues/5)  
> **ステータス**: 設計 draft  
> **分類**: L1 (impl は DB/API/bridge コード変更を伴う → operator L1 GO 必要)  
> **起案**: 2026-05-22

---

## 1. 概要

agent-hub の CE (Community Edition) では、**同じテナントに複数の PAT 所有者が参加できる**。
この場合、ある PAT 所有者 (owner-A) のワーカー bridge が、別 PAT 所有者 (owner-B) から
メッセージを受信することがある。

現状のサーバーはメッセージをそのまま配信する。bridge 側は送信者が
「同じ owner か / 別 owner か」を判断する手段を持っていない。

本 doc では **cross-PAT メッセージを bridge が検知して owner に確認を取る仕組み** を設計する。

---

## 2. issue #4 (bridge visibility) との補完関係: 2 層防御

| 層 | issue | 実装場所 | 防御の内容 |
|---|---|---|---|
| **Layer 1** | #4 bridge visibility | server — `get_participants`, `send_message` | `visibility=owner-only` の worker を cross-PAT 呼び出し元に **発見させない**。`get_participants` で非表示、`send_message` で 404 返却。 |
| **Layer 2** | **#5 cross-PAT gate** | server (field 付与) + bridge (gate ロジック) | メッセージが届いた後に **受信側 bridge が owner に確認を取り、許可なし処理をブロック** する。|

Layer 1 でハンドル名を知られなければメッセージは届かない。
Layer 2 は「ハンドル名を知っている / 直接入力した」クロス PAT メッセージへの多重防御である。

---

## 3. 現状の課題

### 3.1 既存データ構造

`messages` テーブルには `sender_login` 列がある (schema v8/v9 で追加、forensic audit 用):

```sql
-- messages テーブル (抜粋)
sender TEXT NOT NULL,            -- '@alice' (participant handle)
sender_login TEXT,               -- GitHub login (PAT owner)。NULL = v8 以前の migration 前 row のみ
```

`participants` テーブルには `owner` 列がある:

```sql
-- participants テーブル (抜粋)
name TEXT NOT NULL,              -- '@alice'
owner TEXT,                      -- GitHub login (PAT owner)
```

### 3.2 現状の問題

`get_messages` レスポンスは `sender_login` を返さない。
bridge は受信したメッセージが「same-PAT か cross-PAT か」を判断できない:

```json
{
  "id": "uuid",
  "from": "@alice",
  "to": "@my-worker",
  "message": "hello",
  "timestamp": "2026-05-22T10:00:00.000Z"
}
```

---

## 4. 提案: α案 と β案

### 4.1 α案 (server 側で `sender_owner_match` を計算・付与) ✅ 推奨

`get_messages` のレスポンスに `sender_owner_match: boolean | null` を追加する。

**計算ロジック**:
- reader の `owner` を `participants` から取得
- 各メッセージの `sender_login` と比較
- `sender_login == reader_owner` → `true` (same-PAT)
- `sender_login != reader_owner` → `false` (cross-PAT)
- `sender_login` が NULL (v8 以前の row) → `null` (判定不能)

**レスポンス例**:
```json
[
  {
    "id": "uuid-1",
    "from": "@alice",
    "to": "@my-worker",
    "message": "please do X",
    "timestamp": "2026-05-22T10:00:00.000Z",
    "sender_owner_match": true
  },
  {
    "id": "uuid-2",
    "from": "@bob",
    "to": "@my-worker",
    "message": "can you help me?",
    "timestamp": "2026-05-22T10:01:00.000Z",
    "sender_owner_match": false
  }
]
```

**実装箇所**:
- `src/db/messages.ts` — `getUnreadMessages`: JOIN で `participants.owner` を取得、比較フラグを追加
- `src/mcp/tools/get_messages.ts` — `handleGetMessages`: `callerOwner` を解決して `getUnreadMessages` に渡す
- `src/types/schema.ts` — `Message` 型に `sender_owner_match?: boolean | null` を追加 (response-only field)
- **スキーマ変更なし**: 既存の `sender_login` + `participants.owner` を JOIN するだけ

**メリット**:
- bridge 側に自分の PAT owner 情報が不要 (server が解決)
- 既存データで完結、スキーマ変更なし
- 全 bridge (claude / gemini / slack 等) が追加設定ゼロで恩恵を受ける

### 4.2 β案 (bridge 側で `sender_login` を比較)

server は `get_messages` レスポンスに `sender_login` を追加するだけ。
bridge が自分の PAT owner (環境変数 `GITHUB_PAT` → GitHub API で resolve) と比較して判定する。

```json
{
  "id": "uuid-2",
  "from": "@bob",
  "to": "@my-worker",
  "message": "can you help me?",
  "timestamp": "2026-05-22T10:01:00.000Z",
  "sender_login": "bob-gh"
}
```

**デメリット**:
- 各 bridge が自分の PAT owner を知る必要がある (env var `GITHUB_PAT_OWNER` 等が必要)
- bridge ごとに判定ロジックを実装 → 実装漏れリスク
- β案を採るなら α案に統合する価値がある

**β案は非推奨**。α案の方が bridge 透過的。

---

## 5. Gate Flow 設計 (bridge 側ロジック)

```
get_messages を poll した bridge:

  for each message in unread_messages:
    if sender_owner_match == true:
      → 通常処理 (existing flow)
    
    if sender_owner_match == null:        (= legacy message、sender_login が NULL)
      → configurable: デフォルト "通常処理扱い"
         (理由: migration 前 row。サービス開始当初の行は基本的に same-owner)
    
    if sender_owner_match == false:       (= cross-PAT メッセージ)
      → check pending_decision_cache[sender_login]
         ├─ cached "allow"  → 通常処理
         ├─ cached "deny"   → skip (mark_as_read) + 任意で送信者に通知
         └─ cache miss:
              → owner に DM を送る:
                "Cross-PAT メッセージ受信: @bob (PAT: bob-gh) から
                 「{message_preview}」。処理を許可しますか？
                 yes / always / no / never"
              → メッセージを pending キューに積む (mark_as_read はしない)
              → 次回 poll で pending キューを確認

Owner からの DM 返信:
  "yes"    → pending メッセージを通常処理 → キャッシュなし (次回も確認)
  "always" → 通常処理 + pending_decision_cache[sender_login] = "allow" (TTL: 24h)
  "no"     → skip (mark_as_read) + キャッシュなし
  "never"  → skip + pending_decision_cache[sender_login] = "deny" (TTL: 7d)
```

### 5.1 Timeout fallback (owner offline 時)

owner の `last_active_at` を参照し、一定期間非活動の場合は:

```
if (owner.last_active_at < now - CROSS_PAT_TIMEOUT):  // デフォルト: 30 分
  → auto_policy 設定に従う:
    - "deny"  (デフォルト): skip + 送信者に "owner offline のため処理できませんでした" を返答
    - "hold"  : pending キューに保留 (owner 復帰まで待機)
    - "allow" : 自動許可 (セキュリティ注意、信頼環境向け)
```

> **注意**: `auto_policy = "allow"` はゼロトラスト環境では使用禁止。
> 信頼できるプライベート環境 (閉じた社内テナント等) のみ許容する。

### 5.2 Pending キューの実装

pending キューはブリッジのメモリ内 (または SQLite local cache) に保持する。
**hub server には pending 状態を保存しない** (bridge 再起動時: pending がクリアされ、次の poll で再評価 → owner への確認 DM を再送)。

---

## 6. 誤検知リスクと対処

| リスク | 説明 | 対処 |
|---|---|---|
| **PAT rotation** | PAT を更新しても GitHub login は不変 → 誤検知なし | 問題なし |
| **legacy NULL row** | v8 以前の `sender_login = NULL` → `sender_owner_match = null` | bridge は `null` を "通常処理扱い" にする (§5 参照) |
| **PE (trust mode)** | PE は全参加者が同一 owner 扱い。`sender_login` = handle name ≠ GitHub login → false 判定の恐れ | サーバーは常に `true` 返却**かつ** bridge も gate ロジックを noop にする (両方を適用。詳細は §7) |
| **bot アカウント** | bridge が専用 bot GitHub アカウントで動作、worker owner が個人 GitHub → cross-PAT 誤判定 | bridge config に `CROSS_PAT_ALLOWLIST=["bot-account"]` を設けて許可リスト化 |
| **チーム宛メッセージ** | チームメンバーが cross-PAT → メッセージが届く。受信側全メンバーで gate が走る | 同上の gate flow が各受信メンバーで独立して走る (= 意図通り) |
| **owner が自分に DM 確認** | bridge の owner が same PAT で DM する → `sender_owner_match = true` → gate bypass | 問題なし (同一 owner なので当然) |

---

## 7. PE での扱い

PE (Private Edition) では全参加者が同一 owner の閉じた空間 (trust mode)。
cross-PAT という概念が存在しない。

**対応**:
- server 側: `edition = 'private'` の場合、`sender_owner_match` は常に `true` を返す
  (理由: PE の `sender_login` は handle name = trust mode の identity。GitHub login との比較は無意味)
- bridge 側: PE テナントでは cross-PAT gate ロジックをスキップ (noop)

---

## 8. API 変更まとめ

### 8.1 `get_messages` レスポンス (α案)

```diff
 {
   "id": "string",
   "from": "@string",
   "to": "@string",
   "message": "string",
-  "timestamp": "ISO8601"
+  "timestamp": "ISO8601",
+  "sender_owner_match": true | false | null
 }
```

- `true` : same-PAT (sender_login == caller_owner)
- `false`: cross-PAT (sender_login != caller_owner)
- `null` : 判定不能 (sender_login が NULL = v8 migration 前 row)

### 8.2 `get_messages` 実装変更 (server 側)

```typescript
// src/db/messages.ts — getUnreadMessages に reader_owner を追加
export function getUnreadMessages(
  db: Database,
  tenantId: string,
  reader: string,
  readerOwner: string | null  // ← 追加
): (Message & { sender_owner_match: boolean | null })[] {
  // ...
  const messages = db.prepare(`
    SELECT m.*,
           CASE
             WHEN m.sender_login IS NULL THEN NULL
             WHEN ? IS NULL THEN NULL
             WHEN m.sender_login = ? THEN 1
             ELSE 0
           END AS sender_owner_match
    FROM messages m
    LEFT JOIN read_receipts rr
      ON m.tenant_id = rr.tenant_id AND m.id = rr.message_id AND rr.reader = ?
    WHERE m.tenant_id = ?
      AND rr.message_id IS NULL
      AND (
        m.recipient = ?
        OR m.recipient IN (
          SELECT team_name FROM team_members
          WHERE tenant_id = ? AND member_name = ?
        )
      )
      AND m.sender != ?
    ORDER BY m.created_at ASC
  `).all(readerOwner, readerOwner, readerName, tenantId, readerName, tenantId, readerName, readerName);
  // sender_owner_match: SQLite INTEGER (1/0/NULL) → TypeScript boolean | null への変換が必要
  return messages.map((m) => ({
    ...m,
    sender_owner_match: m.sender_owner_match === null ? null : m.sender_owner_match === 1,
  }));
}
```

> **注意**: `readerOwner` の取得方法 (args で渡す vs `getParticipantByName` で取得) は impl PR で決定する。
> editionConfig の渡し方 (issue #4 §3.1 と同様) も impl PR の判断とする。

---

## 9. 実装スコープと順序

### Step 1: server 側フィールド追加 (L1: API response 変更)

| 変更箇所 | 内容 |
|---|---|
| `src/db/messages.ts` | `getUnreadMessages` に `readerOwner` 引数追加、`sender_owner_match` JOIN |
| `src/mcp/tools/get_messages.ts` | `handleGetMessages` で `readerOwner` を resolve して渡す |
| `src/types/schema.ts` | `Message` レスポンス型に `sender_owner_match?: boolean \| null` 追加 |
| `src/db/schema.sql` | **変更なし** (既存 `sender_login` + `participants.owner` を利用) |

**backward compatibility**: `sender_owner_match` は追加フィールド。既存 bridge (フィールドを無視) は影響ゼロ。

### Step 2: bridge 側 gate ロジック実装 (L1: bridge コード変更)

| 変更箇所 | 内容 |
|---|---|
| `agent-hub-bridges` — 各 bridge worker | `sender_owner_match == false` 検知 → owner DM → pending キュー |
| bridge config | `CROSS_PAT_TIMEOUT`, `CROSS_PAT_AUTO_POLICY`, `CROSS_PAT_ALLOWLIST` 追加 |

**Step 1 → Step 2 の順序は必須**。Step 1 (server フィールド) がなければ bridge は判定できない。

---

## 10. 未解決事項

1. **pending キューの永続化**: bridge 再起動時に pending メッセージを紛失しないか。
   → bridge local SQLite (agent-hub-sdk 側で提供) vs 再 poll で再評価の2択。

2. **owner への確認 DM の throttle**: 同一 sender_login から大量メッセージ → owner への DM が flood する恐れ。
   → 「最初の1通のみ確認、それ以降は pending」方式を推奨。

3. **チーム宛 cross-PAT の扱い**: チームメンバー各自が gate を走らせると owner に複数の確認 DM が届く。
   → チームオーナーのみが gate 判断する設計も検討余地あり。

4. **"always" / "never" cache の失効管理**: TTL ベース vs 明示的な revoke コマンド。
   → bridge に `/cross-pat-policy list` / `/cross-pat-policy revoke <login>` コマンドを設けることも候補。

5. **bridge が owner の hub ハンドル名を特定する方法が未定義**: §5 gate flow では "owner に DM を送る" としているが、bridge がどのハンドル名に DM を送るかの導出方法が未定義。候補:
   - a. bridge config 環境変数 `OWNER_HANDLE=@alice` で静的指定 (シンプル、最も実装しやすい)
   - b. 起動時に `get_participants` で `owner == GITHUB_PAT_owner` の参加者を検索して動的解決 (柔軟だが owner が未 register の場合に失敗)
   - c. `register` 時に自分の owner handle を hub に記録、`get_participants` の `owner` フィールドで逆引き
   → 実装 PR で決定する。短期は (a) を推奨 (ゼロ依存、設定ミスが起動時にわかる)。

---

## 11. 関連ドキュメント

- [design-bridge-visibility.md](./design-bridge-visibility.md) — Layer 1: visibility field 設計 (issue #4)
- [edition-professional.md](./edition-professional.md) — Professional Edition (OIDC/PostgreSQL)
- [design-resource-uri.md](./design-resource-uri.md) — Resource URI 設計 (issue #11)
- [schema.sql](../src/db/schema.sql) — DB スキーマ (v9: `sender_login` 列)

---

*— @writer-ja (agent-hub bridge · operator-supervised · kishibashi3/agent-hub)*
