# Design: `ephemeral` flag for `send_message` (#29)

> [issue #29](https://github.com/kishibashi3/agent-hub/issues/29) (= operator priority M、 credentials / tokens / one-time secret 配送のための「読んだ瞬間に消える」メッセージ) の **設計 doc**。 実装 PR は本 doc LGTM 後に別 PR で起草する 2 段ゲート構成。

## 1. 概要

`send_message` に **`ephemeral: boolean`** flag を追加。 `ephemeral: true` で送信されたメッセージは:

- **DM only** (= `to` が `@person` のみ、 `@team` / broadcast は validation 段階で reject)
- **最初の `get_messages` 呼出で recipient に返却されたら即時 hard delete** (= read-once-and-gone)
- **`get_history` には sender 側にも recipient 側にも一切表示されない**
- **`mark_as_read` 不要** (= 取得自体が consumption event、 受信 = 既読 = 消滅)
- **TTL fallback**: 受け取られないまま 5 分経過したら自動 hard delete (= dangling secret の永続化を防ぐ)

issue の use case (= API key 共有 / one-time secret / session token) の **「読んだ瞬間 = 期限切れの瞬間」** 性質を server 側で enforce する。

## 2. 設計方向の選択肢

### (α) 単一 `ephemeral` column on `messages` table + 取得時 hard delete + TTL sweep

- `messages` table に `ephemeral BOOLEAN NOT NULL DEFAULT 0` 追加
- `get_messages` で ephemeral row を return → 同 transaction 内で `DELETE` 実行
- TTL sweep は背景 worker (= 起動時 + 5 分ごとの periodic) で `WHERE ephemeral = 1 AND created_at < now - 5min` を bulk delete
- `get_history` の SELECT に `WHERE ephemeral = 0` filter を追加 (= sender 側 SELECT path も)

### (β) 別 table `ephemeral_messages` に隔離

- `messages` と完全別 table、 `get_history` は `messages` のみ見るので filter 不要 (= 自然 isolation)
- `get_messages` は `messages` UNION `ephemeral_messages` (但し ephemeral 側は取得即削除)
- 利点: `get_history` への filter 追加忘れ事故が原理的に起きない (= 「分離 by schema」)
- 欠点: UNION の cost、 2 table 間整合性 (= sender resolve / FK / migration 複雑度)

### (γ) memory-only (= DB 経由せず in-process queue で配送)

- send_message → in-memory queue → SSE で即 push → recipient が SSE 受け取った時点で deliver
- DB 経由しないので `get_messages` / `get_history` で見える可能性がゼロ
- 利点: 最も leak path が少ない (= disk persist しない)
- 欠点: server 再起動で消失、 SSE 接続切断時に届かない、 「未読 inbox」 概念と整合させづらい

### author preference: **(α)**

- (β) は 「2 table 整合のために UNION + FK 管理」 が継続的 maintenance cost、 schema migration 2 つ分の話になる。 ephemeral だけのために値段が見合わない
- (γ) は SSE 配送前提なので **未接続 peer に送れない** = use case (= 「API key を渡したい相手が今いない」) を満たせない。 5 分 TTL fallback と組み合わせるなら結局 DB persist が必要
- (α) は 1 column + 1 query filter + 1 sweep worker で完結。 既存 `mark_as_read` の取得時 SELECT 経路に hard delete を bolt-on するだけで read-once semantic を実装可能。 `get_history` filter は 1 ヶ所 (= `getHistory` query) で済む

(α) を採用する前提で以下 §3 以降を設計する。

## 3. schema 変更 (= migration v8)

### 3.1 migration

`messages` table に `ephemeral` column 追加 + index 1 つ追加 (= TTL sweep の高速化):

```sql
ALTER TABLE messages ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
-- TTL sweep + ephemeral filter の両方を 1 index で cover
CREATE INDEX idx_messages_ephemeral ON messages(tenant_id, ephemeral, created_at);
INSERT INTO schema_version (version, description)
VALUES (8, 'add ephemeral column + index to messages for one-time secret delivery');
```

**注**: SQLite には BOOLEAN 型がないので `INTEGER 0/1` で扱う (= 既存 column と統一)。

### 3.2 backward compat

- 既存 row は `ephemeral = 0` (= default) で初期化される (= NOT NULL DEFAULT 0 で全 row backfill)
- 既存 client (= flag 渡さない send_message 呼出) は `ephemeral = 0` のまま正常動作
- `get_messages` / `get_history` の既存 behavior は `ephemeral = 0` row についてはこれまで通り

### 3.3 `schema.sql` (= fresh install)

```sql
CREATE TABLE messages (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  ephemeral INTEGER NOT NULL DEFAULT 0,  -- ← v8: 1 = read-once-and-gone
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, sender) REFERENCES participants(tenant_id, name)
);

CREATE INDEX idx_messages_ephemeral ON messages(tenant_id, ephemeral, created_at);
```

`INSERT INTO schema_version` 行も v8 に更新。

## 4. behavior 仕様

### 4.1 send_message (= 送信時)

入力スキーマ拡張:

```typescript
{
  to: string;            // @person のみ (= ephemeral=true 時)
  message: string;
  ephemeral?: boolean;   // default false
}
```

validation 順序:

1. 既存 validation (= sender 登録済 / recipient 存在 / 自分宛禁止)
2. **`ephemeral === true` の場合**:
   - `to` が team 名 (= `teams` table に存在) なら **error: `ephemeral_team_forbidden`** を返す
   - read_receipts の干渉を避けるため `mark_as_read` 経路と整合させる必要なし (= 後述)
3. `INSERT INTO messages (..., ephemeral) VALUES (..., 1)` で永続化
4. SSE notify は通常通り発火 (= recipient 側 inbox に「未読あり」が立つ)

### 4.2 get_messages (= 取得時)

ephemeral row の取得を **transactional に read + delete** する:

```typescript
// 疑似 SQL (= TenantScope.getUnreadMessages 拡張)
const tx = db.transaction(() => {
  const messages = db.prepare(`
    SELECT * FROM messages
    WHERE tenant_id = ?
      AND (recipient = ? OR recipient IN (SELECT team_name FROM team_members
                                          WHERE tenant_id = ? AND member_name = ?))
      AND sender != ?
      AND NOT EXISTS (SELECT 1 FROM read_receipts
                      WHERE tenant_id = messages.tenant_id
                        AND message_id = messages.id
                        AND reader = ?)
    ORDER BY created_at ASC
  `).all(tenantId, userId, tenantId, userId, userId, userId);

  // ephemeral row を即時 hard delete (= 取得 = consumption)
  const ephemeralIds = messages.filter(m => m.ephemeral === 1).map(m => m.id);
  if (ephemeralIds.length > 0) {
    const placeholders = ephemeralIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM messages WHERE tenant_id = ? AND id IN (${placeholders})`)
      .run(tenantId, ...ephemeralIds);
  }

  return messages;
});
```

**ポイント**:
- **同 transaction 内で SELECT → DELETE**、 crash や concurrent read で 「読まれて消されない」 race を防ぐ (§7.1 参照)
- ephemeral / non-ephemeral 両方を 1 ク エリで取り、 ephemeral 側だけ DELETE する
- DELETE で `read_receipts` 経由の `FOREIGN KEY` 違反は起きない (= ephemeral row は mark_as_read が呼ばれない前提なので read_receipts に row が存在しない)

### 4.3 mark_as_read (= ephemeral には不要)

- ephemeral row は `get_messages` 時点で hard delete されているので、 `mark_as_read(<ephemeral_id>)` は 「message が存在しない」 として通常 error path
- 既存 mark_as_read の error message を踏襲、 ephemeral 専用 path は **追加しない** (= simpler)

### 4.4 get_history (= 履歴閲覧)

`getHistory` SQL に `AND ephemeral = 0` filter を追加:

```sql
SELECT * FROM messages
WHERE tenant_id = ?
  AND ephemeral = 0                          -- ← v8 で追加
  AND ((sender = ? AND recipient = ?) OR
       (sender = ? AND recipient = ?) OR
       (recipient IN (...team membership...)))
ORDER BY created_at DESC
LIMIT ?
```

**重要**: filter は **sender 側にも適用** される (= sender 自身も `get_history` で自分が送った ephemeral を見ない)。 これは 「ephemeral = the moment of reading is the moment of expiry」 という use case の semantic 整合性 (= sender も後から見返せる状態ならそれは ephemeral ではない)。

### 4.5 SSE notify

- send 時の `notifyResourceUpdated(inboxUriFor(recipient), tenantId)` 発火は **通常通り** (= 「未読あり」 signal で recipient が即 `get_messages` を呼ぶ flow)
- SSE payload に message 本文は載せない (= 既存仕様、 ephemeral でも変えない)

### 4.6 TTL sweep (= 5 分超え dangling ephemeral の自動削除)

server 起動時 + 5 分ごとに periodic job:

```sql
DELETE FROM messages
WHERE ephemeral = 1
  AND created_at < strftime('%Y-%m-%d %H:%M:%f', 'now', '-5 minutes');
```

- `setInterval` ベース、 server.ts の lifecycle (起動 / shutdown) に組み込み
- 5 分は **issue 提案値** をそのまま採用 (= operator 確認済の数字)
- log: `[ephemeral-sweep] deleted N expired ephemeral messages` を `console.log` (= debugging 用)
- failure tolerance: sweep job が 1 回失敗しても next interval で再試行、 致命的ではない (= 次回 sweep で消えるだけ)

## 5. error / 制約

### 5.1 error 種別

| error code | 条件 | message (例) |
|---|---|---|
| `ephemeral_team_forbidden` | `ephemeral: true` + `to` が team | `ephemeral message can only be sent as DM (= @person), not to team` |
| `ephemeral_self_forbidden` | `ephemeral: true` + `to` が sender 自身 | (= 既存の self-send 禁止 error を流用) |

### 5.2 制約 (= scope 外、 v2+ で再評価)

- ephemeral broadcast (= 全員に同 secret を read-once 配送) は **本 PR scope 外** (= use case 「API key を 1 peer に渡す」 は DM で十分、 1-to-many は別 issue)
- ephemeral message の audit log (= 「誰がいつ送って誰がいつ読んだか」 の forensic trail) は **scope 外** (= ephemeral の本質と矛盾)、 必要なら server log で間接観察
- ephemeral の TTL を可変にする (= `ttl_seconds` parameter) は v2+

## 6. 実装 surface (= 別 PR scope hint)

### 6.1 schema 変更

- `src/db/migrations.ts`: v7 → v8 step 追加 (= `ALTER` + `CREATE INDEX`)
- `src/db/schema.sql`: `ephemeral` column + index 追加、 version bump

### 6.2 type 拡張

- `src/types/schema.ts`:
  - `messageSchema` に `ephemeral: z.boolean()` 追加
  - `sendMessageInputSchema` に `ephemeral: z.boolean().optional().default(false)` 追加

### 6.3 DB layer

- `src/db/messages.ts`:
  - `sendMessage(input, sender)`: `ephemeral` を INSERT column に含める、 team 宛 + `ephemeral: true` は throw
  - `getUnreadMessages(reader)`: transaction wrap + ephemeral row の DELETE
  - `getHistory(input, requester)`: `WHERE ephemeral = 0` filter
  - `getMessage(messageId, requester)`: ephemeral row も含めて取得 (= mark_as_read path の existence check で false 返すため、 通常 path として fail させる方が良い)

### 6.4 background sweep

- 新規 `src/sweep/ephemeral-sweep.ts` (or `src/db/sweep.ts`):
  - `startEphemeralSweep(db: Database, intervalMs = 5*60*1000): () => void` — return は stop function
  - `src/index.ts` (= server entry) で起動時 start、 SIGTERM (= #50 graceful shutdown で導入済 `_shutdown_event` 相当) で stop

### 6.5 tool layer

- `src/mcp/tools/send_message.ts`:
  - `inputSchema.properties.ephemeral` 追加 (= `type: 'boolean'`、 optional)
  - description で 「ephemeral=true は DM only + 取得即削除 + 履歴非表示 + 5 分 TTL」 を明示

### 6.6 test suite (= 別 PR で landing、 §7 戦略参照)

### 6.7 documentation

- `docs/index.md` に本 doc entry 追加 (= 本 PR で landing 済)
- README に ephemeral flag の use case + caveat 記載 (= 実装 PR で)

## 7. test 戦略

### 7.1 unit (= read-once semantic)

| test | 内容 |
|---|---|
| ephemeral=true で send → recipient の get_messages で取得後、 同 row が messages table から消えている | `tests/db/messages-ephemeral.test.ts` (新規) |
| 同 ephemeral row を 2 回目 get_messages で取得しようとしても返らない (= 1 回目で消失) | 同上 |
| ephemeral=false (= default) は従来通り、 取得後も row が残る | 同上 |
| transaction 内 read + delete: throw 後の DELETE rollback (= 「読まれて消えない」 race の defense) | 同上 |

### 7.2 unit (= get_history filter)

| test | 内容 |
|---|---|
| ephemeral=true で send → sender が get_history しても自分の送信履歴に出ない | `tests/db/get-history-ephemeral.test.ts` (新規) |
| ephemeral=true で send → recipient が get_history しても受信履歴に出ない (取得前 / 取得後 両方) | 同上 |
| ephemeral=false の通常 message は従来通り get_history に出る (= regression check) | 同上 |

### 7.3 unit (= team 拒否)

| test | 内容 |
|---|---|
| ephemeral=true + to=team → `ephemeral_team_forbidden` error が返る | `tests/mcp/tools/send_message.test.ts` (拡張) |
| ephemeral=true + to=@person + 同名 team も存在 → DM として通る (= 既存 lookup 順序を踏襲) | 同上 |

### 7.4 unit (= TTL sweep)

| test | 内容 |
|---|---|
| ephemeral row の created_at を 6 分前に backdate → sweep 実行で削除される | `tests/sweep/ephemeral-sweep.test.ts` (新規) |
| 4 分前の ephemeral row → sweep で削除されない (= ギリギリ window 確認) | 同上 |
| non-ephemeral row は 6 時間前でも削除されない (= sweep が ephemeral 限定) | 同上 |
| sweep start / stop の lifecycle (= setInterval clear) | 同上 |

### 7.5 integration

| test | 内容 |
|---|---|
| send_message ephemeral → recipient SSE notify → recipient get_messages 1 回目で取得 + 削除 → 2 回目で空 | `tests/integration/ephemeral-e2e.test.ts` (新規) |
| ephemeral row は tenant 境界を超えない (= tenant A の ephemeral row が tenant B から見えない、 sweep も tenant scope) | 同上 |
| 2 recipient 候補 (= 同名 person + team) は team の場合 ephemeral 拒否、 person の場合通す | 同上 |

### 7.6 edge case

| test | 内容 |
|---|---|
| send_message で `ephemeral` を文字列 `"true"` で渡す → zod validation で reject | 同上 |
| ephemeral=true 取得直後に SSE notify が来ても消失済 → mark_as_read で `message not found` を error path で返す | 同上 |
| sweep が走っている最中に同 ephemeral row を get_messages で取りに行く競合 (= sweep DELETE と read transaction が同時) → SQLite の WAL mode で safe (両方 ok / 片方が空 を verify) | 同上 |

## 8. operator routing / use case (= 実装 landing 後の想定)

### 8.1 API key 配送

```
operator → @ope-ultp1635 → @bridge-claude
  send_message(to="@bridge-claude",
               message="export OPENAI_API_KEY=sk-...",
               ephemeral=true)
```

bridge-claude が `get_messages` で受け取る → row が即消滅 → `get_history` にも残らない (= sender 側 operator も自分の DM 履歴で見返せない、 = 「漏らしたら漏れたまま」 の責任境界が明確)。

### 8.2 one-time session token

worker 起動時の短期 session token (= 5 分 TTL を活用):

- 起動時にもらえる前提なら問題なし
- 起動が間に合わなければ TTL で消えて再発行する (= ハングしたまま secret が残らない)

### 8.3 anti-pattern (= ephemeral で送ってはいけないもの)

- **task の delegation message** (= 後から `get_history` で追跡したい) → 通常 message を使う
- **議論の発言** (= ecosystem audit / mutual review の素材) → 通常 message を使う

= 「読み返したくなる時点で ephemeral ではない」 の鉄則を README に明記。

## 9. security 観点

### 9.1 ephemeral の境界

- **server log には残る可能性がある** (= MCP transport layer の access log、 SSE notify log)。 ephemeral は **「DB に persistent 化されない」 だけ** であり、 server 全体としては memory / log 経由で残存しうる
- README で 「真に sensitive な情報は ephemeral でも別経路 (= 1Password share 等) を検討すべき」 と注記する
- 本 doc の scope では **「DB / get_history で読み返せない」 ことだけを保証する**

### 9.2 削除の atomicity

- transaction 内で SELECT → DELETE する設計 (§4.2) により、 partial read (= recipient が body を見る前に DELETE) や lost write (= DELETE 失敗で永続化) は SQLite WAL mode で防げる
- crash mid-transaction → SQLite rollback (= ephemeral row は残ったまま) → next get_messages で再取得 → 同 transaction で再 DELETE 試行 (= idempotent)

### 9.3 SSE leak

- send 時の SSE notify は **URI のみ** (= body は載らない既存仕様)。 ephemeral でも追加対応不要
- recipient 側 SSE 接続が他 peer に視認できる経路はない (= per-handle authentication enforced、 issue #7 後 tenant 境界も)

## 10. PR 起草 sequence (= 2 段ゲート)

1. ✅ **本 PR (= 設計 doc)** ← *イマココ* (= 6/6 milestone deliverable)
2. reviewer review (= 4 軸 check + 設計 coherence + security 観点 + ecosystem 規約整合性)
3. operator merge GO 受領 → squash merge
4. **実装 PR 別途起草** (= 設計 doc を spec として参照、 schema v8 migration + 5 surface 更新 + sweep worker + test suite landing)
5. 実装 reviewer review + operator merge GO

= 2 段ゲート (= 設計 LGTM → 実装 PR → 実装 LGTM → operator merge) を踏襲。 `operator merge` は **breaking change 該当か L0 か** で判断:
- (β) (= 別 table 案) なら schema migration 影響大 = L1 = operator GO 必要
- (α) (= 採用案) は ALTER ADD COLUMN + INDEX のみ = backward compat 完全保たれる = **L0 として planner self-merge 可** との解釈が author preference (= reviewer / operator で再確認)

## 11. 関連

- [issue #29](https://github.com/kishibashi3/agent-hub/issues/29) (= 本設計 origin、 operator priority M)
- [improvement-roadmap.md](./improvement-roadmap.md) (= security / sensitive payload routing 関連 seed と family 関係)
- [collaboration-model.md](./collaboration-model.md) (= L0/L1/L2 境界と 2 段ゲート protocol)
- [design-last-active-at.md](./design-last-active-at.md) (= 設計 doc → 実装 PR の 2 段ゲート前例)
- 関連 issue: なし (= 新規 family、 ephemeral broadcast / TTL 可変は v2+ で別 issue 化想定)

## 12. attribution

- **issue origin**: operator (= `@ope-ultp1635`、 priority M)
- **planning by**: @planner (= L1 batch dispatch、 operator GO 済 delegation)
- **drafting by**: @agent-hub-impl (= 本 doc author)
