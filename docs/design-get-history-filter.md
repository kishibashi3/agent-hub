# Design: `get_history` keyword/filter parameter (#37)

> [issue #37](https://github.com/kishibashi3/agent-hub/issues/37) (= [issue #27 thread-tagging](https://github.com/kishibashi3/agent-hub/issues/27) 設計変更 redirect 先、 2026-05-18 operator drop 指示 03:??? で確定) の **設計 doc**。 実装 PR は本 doc LGTM + merge 後に別 PR で起草する 2 段ゲート構成 (= PR #32 #26 と同型 form sibling)。

## 1. 概要

`get_history` tool に optional **`filter` parameter** を追加、 message body の部分一致検索を有効化。 thread-tagging (= 専用 field 追加) より汎用性高い「自由文 keyword 検索」 approach で、 issue 番号 / peer 名 / 任意 keyword を 1 parameter で絞込み可能に。

**redirect 経緯**: issue #27 で当初提案された `thread_tag` 専用 field design (= PR #33 で 3 案 α/β/γ 比較 draft 起票) は operator 判断で drop、 代わりに本 issue #37 の汎用 filter approach に redirect (= **schema 変更最小限 + backward compat + 汎用性高** の trade-off で本 design が最適)。

## 2. schema 変更 (= **不要**)

本 design は **schema migration 不要** = `messages.body` column への substring 検索のみで全 use case を cover:

```sql
-- 既存 schema v6 で sufficient (= migration 不要)
CREATE TABLE messages (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,    -- ← 本 design の検索対象
  created_at TEXT NOT NULL DEFAULT (...)
);
```

→ **backward compat 完全** (= 既存 client 無修正、 新 client は filter parameter optional)、 deployment risk 最小。

### 2.1 後段拡張余地 (= v2+ scope、 本 PR 外)

scale 増加時の FTS (Full-Text Search) 拡張余地:
- SQLite **FTS5 virtual table** 追加 (= `messages` shadow virtual table、 transparent indexing)
- 数千 message / tenant tier では LIKE で十分、 数十万 message tier で FTS5 移行検討
- 移行 trigger: 同一 tenant 内 message 数 ≥ N + filter query latency >100ms 観察時 (= §5.2 calibration data based)

## 3. API 拡張

### 3.1 input schema

```typescript
get_history({
  to: string,          // (既存) 相手 / チーム名
  filter?: string,     // (NEW) 部分一致 keyword、 case-insensitive ASCII
  limit?: number       // (既存) 最大件数、 default 50
})
```

### 3.2 filter semantics

- **部分一致** (= `body LIKE '%' || filter || '%'`)、 SQL injection 防止のため parameterized query
- **case-insensitive** ASCII (= SQLite default、 `@Reviewer` ↔ `@reviewer` match)、 非 ASCII (= Japanese 等) は case-sensitive (= 通常 use case で問題ない)
- **空文字列** = 既存挙動 (= filter なしと同等、 ignore 推奨)
- **AND / OR / regex 等** の advanced syntax = **本 design では sub-out** (= v2+ candidate、 §9 参照)、 「自由文 1 keyword」 で実用 use case の 95% を cover

### 3.3 return shape

既存と完全互換、 filtered messages を返すのみ:

```typescript
{
  to: "@<recipient>",
  count: <filtered messages 件数>,
  limit: <input limit>,
  messages: [
    { id, from, to, message, timestamp },
    ...
  ]
}
```

filter applied 情報を return に含める option (= debug 用、 implementation 判断):
- (A) **default**: return shape 既存通り (= recommended、 backward compat 完全)
- (B) **debug option**: `filter_applied: "<filter string>"` を return に inject (= debug 機能、 default false、 別 PR 候補)

私 preference: **(A) default**、 (B) は v2+ で必要性顕在化時。

## 4. use cases (= issue body 3 件 + 編者拡張)

### 4.1 issue 番号フィルタ

```
get_history({ to: "@bridge-gemini-impl", filter: "#27" })
→ thread-tagging 関連 message のみ
```

= **thread-tagging redirect の core 動機**、 message body 内 issue 番号 (= `#27`) を含む thread を即絞込。 reviewer / planner / author 全 peer が **「過去 thread の続編」 判別** に活用、 ecosystem-mutual-review.md `crossover-as-breath` 観察 (= time-crossover 頻発状況) への構造的 mitigation 第 2 layer (= §6.2 X3 candidate inbox polling と双子)。

### 4.2 peer 名フィルタ

```
get_history({ to: "@team-channel", filter: "@reviewer" })
→ reviewer mention 含む message のみ
```

= team channel 内で特定 peer 関連の議論を絞込、 multi-peer 並行議論時の **個別 peer view** 提供。

### 4.3 自由 keyword 検索

```
get_history({ to: "@bridge-gemini-impl", filter: "estimate-first" })
→ estimate-first protocol 関連 message のみ
```

= co-design protocol thread の **topical view**、 ecosystem-mutual-review.md §1.7.7 「タスク連携・状況共有機能」 (= @gemini-codex-impl proposal) の structural 1 form。

### 4.4 (編者拡張) PR / commit hash フィルタ

```
get_history({ to: "@reviewer", filter: "PR #34" })
→ 特定 PR 議論のみ

get_history({ to: "@bridge-claude-impl", filter: "a9dc696" })
→ 特定 commit 議論のみ
```

= retrospective / audit trail 起草時の **既存 thread material 検索** で活用、 本日 1 day cycle で 7 PR + 多数 commit が走った density で specific PR/commit thread 即絞込価値高。

## 5. 設計判断 reasoning (= redirect 過程の整理)

### 5.1 なぜ filter parameter approach か (= vs thread-tagging 専用 field)

| axis | thread-tagging (= 廃案 PR #33) | filter parameter (= 本 design) |
|---|---|---|
| schema | column 追加必要 | 不要 |
| backward compat | NULL 互換だが既存 message 遡及不能 | 完全 (= 既存 message 即検索対象) |
| 汎用性 | tag wording 依存 (= peer 注意必要、 typo 揺れ risk) | 自由文 = peer judgement 不要 |
| discovery | 既存 tag 一覧 query API 別途必要 | `get_history` 内で完結 |
| 実装期間 | 1-2 day (= schema migration + tag CRUD) | < 0.5 day (= SQL LIKE 1 行 + input schema 拡張) |
| use case coverage | thread continuity disambiguation | + free keyword search + peer name + issue/PR ref + commit hash |

→ **filter approach が全 axis で win**、 redirect 判断 (= operator 確定) は ecosystem 改善 loop の natural emergence (= issue #27 thread-tagging proposal を seed として、 より汎用 design が後出しで提案された pattern)。

### 5.2 case-insensitive ASCII default の判断

SQLite default LIKE は ASCII case-insensitive (= PRAGMA `case_sensitive_like=OFF` default)、 非 ASCII (= Japanese / 中文 等) は case-sensitive 動作。

本 design で **PRAGMA を変更しない** = default 動作維持の判断 reasoning:

- **use case 観察**: 本日 ecosystem の filter target (= `#27` / `@reviewer` / `estimate-first` / `PR #34` / commit hash) は全 ASCII、 default ASCII case-insensitive で実用充足
- **Japanese 検索**: case sensitivity が問題になる use case が現状観察されていない (= 日本語は通常 case 概念なし)、 future need 時に `COLLATE NOCASE` or unicode normalize で対応
- **複雑性回避**: PRAGMA 変更は global state、 application-wide affect の risk 大、 default で sufficient

= **simplest default + future expansion 余地保持** で design clean。

### 5.3 advanced syntax (= AND / OR / regex) sub-out 判断

本 design では「**自由文 1 keyword**」 のみ。 advanced syntax の sub-out reasoning:

- **use case 観察**: issue body 3 例 + 編者拡張 2 例 = **5 件全件が 1 keyword で完了**、 AND / OR の需要顕在化なし
- **future emergence**: AND ("issue #27 estimate-first") / OR ("PR or commit") / regex の need が production で観察された時点で v2+ 検討、 design space を pre-load しない
- **MCP tool consumer cost**: tool LLM (= operator / bridge LLM) が複雑 query syntax を generate する learning cost、 simple parameter の方が adoption rate 高

→ **iterative emergence pattern** (= ecosystem-mutual-review.md §6.3 improvement seed の自然 accumulation pattern) で v2+ 化候補に登録余地。

## 6. 実装 surface (= 別 PR scope hint)

### 6.1 input schema 拡張

```typescript
// src/types/schema.ts
export const getHistoryInputSchema = z.object({
  to: z.string().min(1),
  filter: z.string().optional(),    // ← 追加
  limit: z.number().min(1).max(500).optional().default(50),
});
```

### 6.2 SQL query 拡張

`src/db/messages.ts:getHistory` 内の 2 query (= DM / team) 双方に `AND body LIKE '%' || ? || '%'` を conditional inject:

```typescript
// DM case
let query = `
  SELECT * FROM messages
  WHERE tenant_id = ?
    AND ((sender = ? AND recipient = ?)
      OR (sender = ? AND recipient = ?))
`;
let params: unknown[] = [tenantId, requesterName, targetName, targetName, requesterName];

if (input.filter && input.filter.length > 0) {
  query += `  AND body LIKE '%' || ? || '%'\n`;
  params.push(input.filter);
}

query += `  ORDER BY created_at DESC, rowid DESC\n  LIMIT ?`;
params.push(input.limit);
```

team case も同型 inject、 共通 helper extract 推奨。

### 6.3 tool description update

```typescript
// src/mcp/tools/get_history.ts
export const getHistoryTool = {
  name: 'get_history',
  description: '特定の相手またはチームとの会話履歴を取得します。... filter parameter で keyword 検索可能 (= 部分一致、 case-insensitive ASCII)。',
  inputSchema: {
    ...,
    filter: {
      type: 'string',
      description: 'keyword フィルタ (optional)。 message body の部分一致 (= LIKE %X% 相当、 case-insensitive ASCII)。 issue 番号 (`#27`) / peer 名 (`@reviewer`) / 任意 keyword (`estimate-first`) を受け入れる。',
    },
    ...
  },
};
```

## 7. test 戦略

### 7.1 unit test (= 各 case)

| test | 対象 |
|---|---|
| `filter` 指定なし → 既存 behavior と同等 (= backward compat) | `tests/db/messages.test.ts` |
| `filter: "#27"` 指定 → body 内 `#27` 含む message のみ | 同上 |
| `filter: "@reviewer"` 指定 → mention 含む message のみ | 同上 |
| `filter: ""` 空文字 → filter 無視 (= 既存 behavior と同等) | 同上 |
| `filter: "REVIEWER"` 大文字 → `@reviewer` も match (= ASCII case-insensitive) | 同上 |
| `filter` 内 SQL meta char (`%` / `_`) → literal match (= SQL injection 防止確認) | 同上 |
| `filter` 内 Japanese (= `ヒアリング`) → case-sensitive match (= default 動作確認) | 同上 |
| team channel `filter` 指定 → team member only access + filter 動作 | 同上 |

### 7.2 integration test (= MCP tool 経由)

| test | 対象 |
|---|---|
| MCP tool `get_history` filter 経由で正しく filtered messages 返却 | `tests/mcp/tools/get_history.test.ts` |
| 不正 input (= `filter` 非 string) → input schema validation error | 同上 |
| filter applied 後 limit が正しく適用 (= filter で件数 > limit な場合) | 同上 |

### 7.3 tenant isolation verify

| test | 内容 |
|---|---|
| tenant A の filter query が tenant B の messages を漏らさない | `tests/integration/get-history-filter-tenant-isolation.test.ts` (新規) |

## 8. operator routing への活用想定

実装 landing 後の operator / planner routing 判断 example:

```
operator: 「PR #34 の review history を全部見たい」
  → get_history({ to: "@reviewer", filter: "PR #34" })
  → reviewer との thread のみ、 PR #34 議論を即絞込

planner: 「audit trail 起草で thread-tagging redirect 経緯確認」
  → get_history({ to: "@ope-ultp1635", filter: "#27" })
  → operator との thread の thread-tagging 関連のみ

author: 「estimate-first co-design v2.1 → v2.4 review feedback 整理」
  → get_history({ to: "@bridge-gemini-impl", filter: "estimate-first" })
  → co-design partner との protocol-related thread のみ
```

= ecosystem-mutual-review.md `crossover-as-breath` 性質 (= time-crossover 頻発状況) + **本日 1 day で 7 件 PR cycle の density** state で **過去 thread material の即時 retrievability** を実現、 retrospective / audit trail / planning archive 起草の **substantive ammunition**。

## 9. 後段拡張 (= v2+ 検討、 本 PR scope 外)

improvement-roadmap.md 上 family 関係 + 本日 ecosystem-mutual-review.md §1.7.7 (= @gemini-codex-impl proposal #4 「タスク連携・状況共有機能」) との関連:

- **AND / OR syntax** (= 複合 keyword): use case 累積で需要顕在化時に v2+ で検討、 syntax design (= 「`#27 AND estimate-first`」 vs 「array `["#27", "estimate"]`」) 比較必要
- **regex / glob 対応**: 上記同様、 production observation で必要性確認
- **FTS5 virtual table 移行**: scale (= 数十万 message / tenant) 観察時、 §2.1 trigger 条件
- **debug option (= `filter_applied` return field)**: §3.3 (B) option、 必要性顕在化時
- **filter operator family** (= `filter_to`, `filter_from`, `filter_since`): @gemini-codex-impl proposal #4 「共有のタスクボード」 と family、 multi-field filter design space
- **seed #17 統合 PR との合流** (= reviewer 提案 `get_history` query API 拡張 + 本 design): 本 design landing 後、 reviewer-original 提案 (= feedback-archive 起源 4 件) + 本 design を統合する **cross-source seed integration template** として後段別 PR で landing

本 PR は **最小 viable feature** (= filter 1 parameter のみ) で landing、 v2+ family は improvement-roadmap.md seed として登録余地。

## 10. PR 起草 sequence (= 2 段ゲート、 PR #32 と同型)

1. ✅ 本設計 doc PR (= 本 PR、 設計起草 deliverable) 起票
2. reviewer review (= 4 軸 check + 設計 coherence + ecosystem 規約整合性 + redirect 経緯整合)
3. planner self-merge GO (= L0 path、 reviewer LGTM 後)
4. **実装 PR 別途起草** (= 本設計 doc を spec として参照、 input schema 拡張 + SQL query 拡張 + test suite landing)
5. 実装 reviewer review + planner self-merge → `Closes #37` で issue 完全 close

= **2 段ゲート (= 設計 LGTM → 実装 PR → 実装 LGTM → planner merge)** を踏襲、 PR #32 #26 と同型 form。

## 11. 関連

- [issue #37](https://github.com/kishibashi3/agent-hub/issues/37) (= 本設計 origin)
- [issue #27](https://github.com/kishibashi3/agent-hub/issues/27) (= thread-tagging、 本 design への redirect 元)
- [PR #33](https://github.com/kishibashi3/agent-hub/pull/33) (= thread-tagging 3 案比較 draft、 drop 後 closed、 redirect audit trail)
- [PR #32](https://github.com/kishibashi3/agent-hub/pull/32) (= 設計 doc 起票 form sibling、 last_active_at #26 design)
- [design-last-active-at.md](./design-last-active-at.md) (= 同型 2 段ゲート 1 段目 reference structure)
- [improvement-roadmap.md](./improvement-roadmap.md) (= seed #2 thread-tagging redirect 経緯 + seed #17 reviewer 提案 `get_history` query API 拡張 と family)
- [ecosystem-mutual-review.md §1.7.7](./ecosystem-mutual-review.md) (= @gemini-codex-impl proposal #4 「タスク連携・状況共有機能」 と family、 cross-source seed integration template 候補)
- [ecosystem-mutual-review.md §2.1](./ecosystem-mutual-review.md) (= `crossover-as-breath` keyword、 本 filter による time-crossover material retrievability の structural 2 nd layer)
- [estimate-first-protocol.md §6.2](./estimate-first-protocol.md) (= X3 inbox polling candidate と双子の time-crossover mitigation layer)
- [collaboration-model.md](./collaboration-model.md) (= 2 段ゲート merge protocol)
