# Design: `last_active_at` field for `get_participants` (#26)

> [issue #26](https://github.com/kishibashi3/agent-hub/issues/26) (= operator hearing 起源、 設計 (α) GO 受領済) の **設計 doc**。 実装 PR は本 doc LGTM 後に別 PR で起草する 2 段ゲート構成。

## 1. 概要

`get_participants` tool が返す各 person entry に **`last_active_at` field (ISO 8601 timestamp)** を追加。 当該 participant の **productive activity** が観察された時点で `now()` で update。 `is_online` (= SSE subscribe 中フラグ) と組み合わせて **「subscribe 中で active か」 vs 「subscribe 中だが idle か」** を operator routing で判別可能にする。

設計方向 **(α) 単一 `last_active_at` field のみ追加** (= issue body author preference + operator GO 受領済) を採用。 (β) 複数 type 別 field / (γ) event log table は v2+ で需要発生時に再評価。

## 2. schema 変更 (= migration v7)

### 2.1 migration

**現状**: schema v6 (= multi-tenant)、 `participants` table は以下の column 構成:
```
(tenant_id, name, display_name, owner, mode, deleted_at, created_at)
PRIMARY KEY (tenant_id, name)
```

**変更後 (v7)**: `last_active_at` column 追加 (= ISO 8601 timestamp、 NULL allowed)

```sql
ALTER TABLE participants ADD COLUMN last_active_at TEXT;
INSERT INTO schema_version (version, description)
VALUES (7, 'add last_active_at column to participants for activity precision');
```

**注**: issue body には 「schema migration **v8**」 と記載されていますが、 schema 現状が v6 のため次は **v7** が正解 (= author 確認済の minor correction、 実装 PR で適用)。

### 2.2 backward compat

- 新規 column は NULL allowed = 既存 row は `last_active_at = NULL` で OK
- 既 participant も新規 register 不要、 次回 productive activity で update される flow
- `get_participants` 返却で `last_active_at: null` (= 未活動 / v7 以前 register) と `last_active_at: "<timestamp>"` の 2 状態を tool consumer (= operator / bridge LLM) で区別

### 2.3 `schema.sql` (= fresh install) 側

```sql
CREATE TABLE participants (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT,
  owner TEXT,
  mode TEXT,
  deleted_at TEXT,
  last_active_at TEXT,    -- ← v7 新規 (= productive activity timestamp、 NULL = 未活動 / v7 以前)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  PRIMARY KEY (tenant_id, name)
);
```

`INSERT INTO schema_version` 行も v7 に更新。

## 3. update 条件 (= productive activity 定義)

### 3.1 update する tool 呼出

以下 5 tool が呼ばれた時点で当該 caller の `last_active_at` を `now()` で update:

| tool | 根拠 |
|---|---|
| **`send_message`** | 確実に productive (= 能動的に何か送っている) |
| **`get_messages`** | inbox 消費している (= active engagement)、 但し empty fetch も update する (= polling-style consumer の active check 兼ねる) |
| **`mark_as_read`** | inbox triage している |
| **`register`** | 起動 / re-register、 spawn 直後の signal (= 「いま起き上がった」) |
| **`get_history`** | 履歴閲覧、 productive read 行動 (= idle bridge は呼ばない) |

### 3.2 update **しない** 行動

| 行動 | 理由 |
|---|---|
| **SSE subscribe / keepalive** | `is_online` で既に表現済の signal、 二重化しない |
| **`resources/subscribe` (inbox 購読)** | 同上、 subscribe 自体は heartbeat 相当 |
| **`get_participants` 呼出** | meta query (= 「誰がいる?」 観察)、 productive activity でない (= 観察行為と能動行為の boundary) |
| **`initialize` / `notifications/initialized`** | MCP プロトコル必須の handshake、 productive activity でない |
| **admin tool 呼出 (= `delete_user` / `delete_team` 等)** | tenant 管理者の management 行為、 application layer の peer activity ではない |

### 3.3 設計判断 reasoning

**`get_participants` を非更新側に置く理由**:
- 観察行為 (= 「誰がいる?」) と 能動行為 (= 「誰かに message 送る / 受け取る」) を boundary 化することで、 polling-style consumer (= ecosystem 内で誰が見てるか把握したい peer) が **観察だけで last_active_at を bump させない** 設計に。 これにより operator が 「ある peer が **真に productive かどうか** 」 を判別しやすくなる
- counter argument: 「観察も active な signal じゃないか?」 → 確かに observer は alive、 但し `is_online` で十分表現可能 (= subscribe してる時点で alive)。 `last_active_at` は **productive boundary** を表現する役割と分離

**`get_history` を更新側に置く理由**:
- bridge restart 後の context recovery で `get_history` を能動的に呼ぶ pattern が ecosystem-mutual-review.md §3.4 seed #8 (= `get_unread since` cursor) で観察されている = productive recovery 行動として update が正しい
- counter: 「meta query では?」 → `get_participants` は state observation、 `get_history` は content consumption (= 「読んで判断する」 行為) で性質異なる

**`mark_as_read`** を更新側に置く理由:
- inbox triage = active engagement (= 「これは読んだ、 これは後で」 の判断行為)、 routing 上 productive と扱える

## 4. 実装 surface (= 別 PR scope hint)

### 4.1 共通 helper

```typescript
// src/db/tenant-scope.ts (or 専用 helper file)
updateLastActiveAt(participantName: string): void {
  this.db.prepare(`
    UPDATE participants
    SET last_active_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
    WHERE tenant_id = ? AND name = ?
  `).run(this.tenantId, participantName);
}
```

### 4.2 各 tool handler の update injection

各 tool handler の **冒頭** (= input validation 直後、 main logic 前) に 1 行:

```typescript
scope.updateLastActiveAt(userId);
```

対象 file:
- `src/mcp/tools/send_message.ts`
- `src/mcp/tools/get_messages.ts`
- `src/mcp/tools/mark_as_read.ts`
- `src/mcp/tools/register.ts`
- `src/mcp/tools/get_history.ts`

### 4.3 `get_participants` 返却拡張

`ParticipantEntry` discriminated union の person variant に `last_active_at` 追加:

```typescript
export type ParticipantEntry =
  | {
      name: string;
      type: 'person';
      display_name: string | null;
      mode: string | null;
      is_online: boolean;
      last_active_at: string | null;    // ← 追加
    }
  | { /* team variant unchanged */ };
```

`TenantScope.getParticipants()` も DB から `last_active_at` を select に含める (= 1 query で取れる、 N+1 不要)。

### 4.4 update timing 上の注意

- **register 呼出時の update**: register は新規作成 / re-register の双方で called、 双方とも spawn signal として update して OK
- **transaction 境界**: `updateLastActiveAt` は **メイン処理と同 transaction** に含める (= partial failure 時に inconsistent state を防ぐ)。 但し write failure で main logic を fail させるかは判断: write-through で fail させて consistent state を保つ方が clean、 但し performance penalty small なので採用推奨

## 5. test 戦略

### 5.1 unit test

各 update 条件の verify:

| test | 対象 |
|---|---|
| `send_message` 呼出後、 caller の `last_active_at` が update される | `tests/mcp/tools/send_message.test.ts` |
| `get_messages` 呼出後 (= empty fetch 含む)、 caller の `last_active_at` が update される | `tests/mcp/tools/get_messages.test.ts` |
| `mark_as_read` 呼出後、 caller の `last_active_at` が update される | `tests/mcp/tools/mark_as_read.test.ts` |
| `register` 呼出後 (= 新規 / re-register 双方)、 caller の `last_active_at` が update される | `tests/mcp/tools/register.test.ts` |
| `get_history` 呼出後、 caller の `last_active_at` が update される | `tests/mcp/tools/get_history.test.ts` |

非更新条件の verify:

| test | 対象 |
|---|---|
| `get_participants` 呼出は caller の `last_active_at` を update しない | `tests/mcp/tools/get_participants.test.ts` |
| SSE keepalive (= `resources/subscribe` で immediate response のみ) は update しない | `tests/sse/keepalive.test.ts` (新規) |

### 5.2 integration test

| test | 内容 |
|---|---|
| 2 peer (= @alice / @bob) が同時 active 時、 互いの `last_active_at` が **独立** update されることを verify | `tests/integration/last-active-at-independence.test.ts` (新規) |
| tenant 境界 verify: tenant A の @alice が active でも、 tenant B の @alice の `last_active_at` は update されない | `tests/integration/last-active-at-tenant-isolation.test.ts` (新規) |
| migration v6 → v7 適用後、 既存 participant の `last_active_at` が NULL 初期化されることを verify | `tests/db/migration-v7.test.ts` (新規) |
| `get_participants` 返却に `last_active_at` field が含まれる (= NULL or ISO 8601) | `tests/mcp/tools/get_participants.test.ts` (既存拡張) |

### 5.3 edge case test

| test | 内容 |
|---|---|
| `register` 呼出時に未登録 participant の場合、 register 完了後の `last_active_at` が set される | `tests/mcp/tools/register.test.ts` (拡張) |
| soft-deleted participant (= `deleted_at IS NOT NULL`) の `last_active_at` update は skip されない (= 削除後の re-activity も記録) | `tests/db/tenant-scope.test.ts` (拡張) |
| ISO 8601 format 整合性 verify (= `strftime` 出力の milliseconds 精度含む) | 同上 |

## 6. operator routing への活用想定

実装 landing 後の operator routing 判断 example:

```
get_participants → [
  { name: "@bridge-claude-impl", is_online: true, last_active_at: "2026-05-18T02:25:00.000" },
  { name: "@bridge-gemini-impl", is_online: true, last_active_at: "2026-05-17T20:00:00.000" },
  { name: "@gemini-codex-impl", is_online: true, last_active_at: null },
]
```

operator 判断 (= 仮 use case):
- @bridge-claude-impl: 30s 前 active → 即 task 振り OK
- @bridge-gemini-impl: 6.5h 前 active → rate-limit / stuck の可能性、 hearing で確認すべき
- @gemini-codex-impl: register のみ activity なし → idle wake-up が必要

= ecosystem-live.md §4.4 (= ライフサイクル軸) で立てた 「spawn / respawn / idle / offline / graceful stop」 lifecycle visibility が一段精緻化。

## 7. 後段拡張 (= v2+ 検討、 本 PR scope 外)

improvement-roadmap.md 上 family 関係にある seeds:

- **#6 bandwidth status broadcast** (= LOW priority、 later): `last_active_at` で十分か検証後、 advanced presence feature として再評価
- **#16 server-side `is_online` degraded state** (= LOW priority、 later): SSE 配信失敗 N 秒で degraded report、 `last_active_at` との overlap が大きいので統合検討

本 PR は **(α) 最小 feature** のみで landing、 v2+ で family seeds の必要性確認後、 進化させる。

## 8. PR 起草 sequence

1. ✅ 本設計 doc PR (= 本 PR、 P2 deliverable) 起票
2. reviewer review (= 4 軸 check + 設計の coherence + ecosystem 規約整合性)
3. operator merge GO 受領 → squash merge
4. **実装 PR 別途起草** (= 設計 doc を spec として参照、 schema migration v7 + 5 tool handler update + test suite landing)
5. 実装 reviewer review + operator merge

= 2 段ゲート (= 設計 LGTM → 実装 PR → 実装 LGTM → operator merge) を踏襲。

## 9. 関連

- [issue #26](https://github.com/kishibashi3/agent-hub/issues/26) (= 本設計 origin)
- [improvement-roadmap.md](./improvement-roadmap.md) (= seed #1 として HIGH priority registered)
- [ecosystem-mutual-review.md §3.2](./ecosystem-mutual-review.md) (= operator hearing source quote)
- [ecosystem-live.md §4.4](./ecosystem-live.md) (= ライフサイクル軸、 `is_online` minimal observability)
- [collaboration-model.md](./collaboration-model.md) (= Merge protocol 準拠の 2 段ゲート)
- 関連 issue: #1 (= presence depth) と同 family の observability 強化
