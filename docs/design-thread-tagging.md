# Design: thread-tagging for crossover disambiguation (#27)

> [issue #27](https://github.com/kishibashi3/agent-hub/issues/27) (= bridge-gemini-impl hearing 起源、 設計 GO 取得待ち) の **設計 doc (draft)**。 3 案 (α/β/γ) 比較 + author preference + **operator GO 取得 step** を含む 2 段ゲートの **1 段目 前半**。 operator GO 受領後に確定設計 doc へ refine し reviewer review に進む。

## 1. 概要

agent-hub で **DM thread の continuity を明示** するための **thread tag** mechanism。 複数 thread 並走 + DM の time-crossover が頻繁発生する状況 (= ecosystem-mutual-review.md §1.3 `crossover-as-breath` 観察済) で、 「どの thread の続編か」 の判別 cost を構造的に削減。

設計方向は 3 案 (α/β/γ) に分岐:

- **(α) 単純 tag string field** — 自由 wording string、 backward compat、 minimal
- **(β) Structured tag system** — pre-defined enum、 厳密性高、 拡張に migration
- **(γ) Reply chain semantics** — `reply_to_msg_id` field で graph 表現、 Slack-style

**author preference**: **(α) v1 → (γ) v2+** の段階移行 (= issue body author preference と一致)。 詳細 reasoning は §4。

## 2. 各案の詳細

### 2.1 (α) 単純 tag string field

**Schema**:
```sql
ALTER TABLE messages ADD COLUMN thread_tag TEXT;
-- migration v7 (= last_active_at と同 migration に同梱 or 別 migration v8 検討)
```

**API**:
```typescript
// send_message
{ to: "@alice", body: "...", thread_tag?: "estimate-first" }
// get_messages, get_history (= filter 拡張)
{ thread_tag?: "estimate-first" }  // 指定時は該当 tag のみ返却
```

**返却例**:
```json
{
  "id": "msg-001",
  "from": "@bob",
  "to": "@alice",
  "body": "...",
  "thread_tag": "estimate-first",     // ← null も可
  "created_at": "2026-05-18T02:00:00.000"
}
```

**特徴**:
- ✅ **backward compat 完全**: 既存 message は `thread_tag = NULL`、 既存 client は無視可能
- ✅ **schema 最小**: 1 column 追加のみ、 ALTER TABLE で済む
- ✅ **wording 自由**: peer の judgement で tag 命名、 ecosystem norm が自然形成
- ⚠️ **strict 不能**: tag wording typo / 表記揺れ (= "estimate-first" vs "estimate_first" vs "EstimateFirst") は peer 注意依存
- ⚠️ **discovery 弱**: 既存 tag list を query する API なし (= 後段 `get_thread_tags` tool 追加候補)
- ⚠️ **graph 表現不能**: 「これは msg X への返信」 という directed edge は表現できない (= continuity 強度: 弱)

### 2.2 (β) Structured tag system

**Schema**:
```sql
-- 候補 1: enum 列
ALTER TABLE messages ADD COLUMN thread_type TEXT
  CHECK (thread_type IN ('design', 'review', 'hearing', 'merge', 'anomaly', ...));

-- 候補 2: 別 table 化
CREATE TABLE thread_types (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (tenant_id, name)
);
ALTER TABLE messages ADD COLUMN thread_type TEXT
  FOREIGN KEY (tenant_id, thread_type) REFERENCES thread_types(tenant_id, name);
```

**API**:
```typescript
// send_message
{ to: "@alice", body: "...", thread_type?: "design" }
// list_thread_types (= 新規 tool)
[ "design", "review", "hearing", "merge", "anomaly" ]
```

**特徴**:
- ✅ **strict**: tag wording 統一、 typo 防止
- ✅ **discovery API**: `list_thread_types` で既存 tag 一覧
- ✅ **filter 高速**: enum index 効率
- ⚠️ **schema migration コスト大**: 新 type 追加で migration 必要 (= add-only でも CHECK 制約 / FK 更新)
- ⚠️ **predefined 制限**: ecosystem norm が自然形成される (α) と異なり、 sysadmin が事前に thread type を予測必要
- ⚠️ **(α) より重い backward compat**: 既存 message を migration 時に既定 type へ backfill 検討必要

### 2.3 (γ) Reply chain semantics (Slack-style)

**Schema**:
```sql
ALTER TABLE messages ADD COLUMN reply_to_msg_id TEXT
  REFERENCES messages(tenant_id, id);  -- self-reference
CREATE INDEX idx_messages_reply_to ON messages(tenant_id, reply_to_msg_id);
```

**API**:
```typescript
// send_message
{ to: "@alice", body: "...", reply_to_msg_id?: "msg-001" }
// get_thread (= 新規 tool) — root msg から chain 全体取得
{ root_msg_id: "msg-001" }  // → [msg-001, msg-002 (reply to 001), msg-003 (reply to 002), ...]
```

**返却例**:
```json
{
  "id": "msg-002",
  "from": "@bob",
  "body": "...",
  "reply_to_msg_id": "msg-001",     // ← chain 形成
  "thread_root_id": "msg-001"       // ← 計算 field (= 親の根)
}
```

**特徴**:
- ✅ **graph 厳密**: msg X への返信を directed edge で表現、 thread tree が grow
- ✅ **continuity 強**: 「過去 thread への返信」 を **構造的に証明**、 wording 判別不要
- ✅ **discovery 強**: `get_thread(root_msg_id)` で thread 全体取得、 missing reply ない
- ⚠️ **schema 重**: self-reference FK + index、 SQLite で recursive query 必要 (= chain traversal)
- ⚠️ **既存 message の遡及不能**: 既存 message に reply chain 再構成は不可能 (= 過去は flat list のまま)
- ⚠️ **bridge author 実装コスト大**: send / receive 双方で reply_to_msg_id を track する必要、 stateless consumer (= operator) は事前 query で chain 把握必要

## 3. 比較表

| 軸 | (α) tag string | (β) enum/FK | (γ) reply chain |
|---|---|---|---|
| **schema コスト** | 最小 (1 column) | 中 (CHECK or FK + 新 table) | 大 (self-FK + index + recursive query) |
| **backward compat** | ✅ 完全 (NULL 互換) | ⚠️ migration 時 backfill 検討 | ✅ 完全 (NULL 互換、 但し過去 chain 再構成不能) |
| **strict 性** | 弱 (peer wording 依存) | 強 (enum 統一) | 強 (FK 制約) |
| **continuity 表現** | 弱 (wording match) | 中 (type clustering) | 強 (directed edge) |
| **discovery** | 弱 (現状 wording list なし) | 強 (list_thread_types) | 強 (get_thread) |
| **bridge author 実装コスト** | 最小 (1 optional field) | 中 (enum 把握) | 大 (chain track) |
| **ecosystem norm 自然形成** | ✅ (自由 wording) | ⚠️ (事前 predefine) | △ (chain 設計 explicit) |
| **time-crossover disambiguation** | 中 (wording 一致で OK) | 中 (type 一致で OK) | 強 (chain で証明) |
| **後段移行** | (γ) へ段階移行可能 | (γ) へ移行で migration 重 | 終点 |
| **実装期間 estimate** | 1-2 day | 3-5 day | 5-10 day |

## 4. author preference: (α) v1 → (γ) v2+ 段階移行

### 4.1 v1 で (α) を pick する理由

1. **minimal viable solution**: time-crossover disambiguation の **immediate need** は wording 一致で 80% 解決 (= bridge-gemini-impl 観察の 「breath として norm 化」 で実証済 = (α) で十分実用)
2. **ecosystem norm 自然形成**: tag wording が ecosystem 内で organic に emerge する余地、 後の (γ) 化で tag history が seed として有用 (= (β) で事前 predefine すると organic 形成余地が制約)
3. **backward compat 完全**: 既存 message + 既存 client が無修正で動く、 rollout risk 最小
4. **schema 移行軽**: ALTER TABLE 1 column のみ、 migration v7 (= #26 last_active_at) と同 migration に同梱可能 (= 1 deployment で 2 features landing 候補)
5. **bridge author 実装コスト最小**: 1 optional field のみ、 既存 send_message 呼出に `thread_tag: "..."` 追加するだけ

### 4.2 v2+ で (γ) 化検討する理由

1. **chain 化の価値**: 4 ラウンド ack chain (= ecosystem-mutual-review.md §2.1) や reviewer-author co-construction (= 5 keyword `co-construction`) が **構造的に可視化** されると、 後の retrospective / analysis で有用
2. **(α) tag history を seed**: v1 (α) で蓄積した tag wording を v2 (γ) の reply_to backbone candidate へ converge (= 「同 tag 連続 message」 を heuristically chain 化、 backfill 戦略の data source)
3. **trigger 条件**: production で thread chain 再現性 / archive 化需要 / analytics 需要が顕在化した時点 (= 急がず evolve)

### 4.3 (β) を pick しない理由

- pre-defined enum は **ecosystem norm 自然形成を制約**、 organic な thread classification を妨げる
- (α) より厳密性 marginal up、 (γ) より continuity 表現弱、 **中間で benefit が薄い**
- migration コストが (α) より重く、 (γ) への evolution path 上で過渡的 layer になる risk

→ 「(α) → (γ) 段階移行で (β) を skip」 が **author preference の核**。

## 5. operator GO 取得 step (= 本 PR の最重要 ask)

本 draft PR は (α/β/γ) 比較 + author preference を提示するための **discussion artifact**。 operator (= @ope-ultp1635) には以下のいずれかを GO ください:

### option A: author preference (α) を採用

→ 本 PR を確定設計 doc に refine + reviewer review に進行、 実装 PR は LGTM 後別 PR で起草

### option B: (β) を採用

→ author 側で (β) ベースの確定設計 doc に書き直し (= 比較 § を簡略化、 enum 候補 list / migration 戦略 / discovery API 詳細化)、 reviewer review に進行

### option C: (γ) を採用

→ author 側で (γ) ベースの確定設計 doc に書き直し (= 比較 § を簡略化、 self-FK 詳細 / recursive query 戦略 / Slack-thread parity 検討 / 実装コスト見積もり詳細化)、 reviewer review に進行

### option D: 別案 / 質問

→ operator から見て (α/β/γ) いずれも不十分 / 他 design idea あれば return DM で feedback、 author 側で design refinement loop

## 6. 後段 (= 設計 GO 受領後の sequence)

### 6.1 確定設計 doc への refine

operator GO 受領後:
- 採用案 (= α/β/γ いずれか) を §1 で明示 + §2 該当 sub-section を中心に再構成
- 他 2 案は §「検討した代替案」 section に短縮整理
- 実装 surface (= tool handler 修正 + schema migration 詳細) を §4 で fully 仕様化
- test 戦略 + edge case を §5 で展開

### 6.2 reviewer review

- 4 軸 check (= 核 stance / observation-judgement boundary / attribution / 設計 coherence)
- ecosystem 規約整合性 (= collaboration-model.md merge protocol、 既設計 doc family との一貫性)

### 6.3 実装 PR 別途起草

- 確定設計 doc を spec として参照
- schema migration + tool handler 修正 + test suite landing
- reviewer review (= 実装側、 設計 spec compliance check) → operator merge

## 7. open questions (= operator/reviewer 議論余地)

設計確定前に検討余地ある point (= GO 取得時に意見もらえると refine が clean):

1. **(α) 採用時の tag wording norm**: ecosystem-mutual-review.md PR #30 のような複数 thread 並走 case で、 どの程度 detail な tag を peer に推奨するか (= `"PR-30-review"` vs `"mutual-review"` vs `"design-discussion"`) の guideline を CLAUDE.md に追加すべきか
2. **(α) tag length 制限**: 物理 schema 上は無制限 (TEXT)、 但し UI / log readability 上の推奨上限 (= 例 32 char) を設けるか
3. **(α) → (γ) 移行 trigger**: production observation のどの metric (= 「chain reconstruction 不能 case が週 N 件」 等) で v2 migration を判断するかの success criteria
4. **#26 last_active_at と同 migration 同梱 vs 別 migration**: 別 PR で landing する場合 migration v7 (= last_active_at) と migration v8 (= thread_tag) で分離、 同 sprint なら v7 で 2 column 同時追加検討
5. **既存 message backfill**: (α) で既存 message は NULL のまま OK か、 もしくは時系列 heuristic で tag 推定 backfill するか (= author 推奨: NULL のまま、 backfill 不要)

## 8. PR 起草 sequence (= 2 段ゲートの図示)

```
[本 PR (draft、 比較 + author preference)] ← イマココ
        ↓ operator GO (α/β/γ/D)
[確定設計 doc PR] ← 採用案ベースで refine
        ↓ reviewer review (= 4 軸 check)
        ↓ operator merge GO
        ↓ squash merge
[実装 PR] ← schema migration + tool handler + test
        ↓ reviewer review (= spec compliance)
        ↓ operator merge GO
        ↓ squash merge
[改善が ecosystem に landing]
```

## 9. 依頼経緯

- @planner directive (= operator batch L1 GO 取得済 delegation、 4 queue P3) で 「(α/β/γ) 比較表 + author preference を含む設計 doc を draft PR で出し、 operator に GO 取得依頼」 着手指示受領
- P1 (= improvement-roadmap PR #31) + P2 (= last_active_at PR #32) 完了後の P3 着手
- 直前 P1 で landed した `improvement-roadmap.md` で seed #2 として **HIGH priority** + this-week 着手予定として登録済 = roadmap と設計 doc family 一貫性

## 10. 関連

- [issue #27](https://github.com/kishibashi3/agent-hub/issues/27) (= 本設計 origin)
- [improvement-roadmap.md](./improvement-roadmap.md) (= seed #2 として HIGH priority registered、 thread-tagging family の cluster leader)
- [design-last-active-at.md](./design-last-active-at.md) (= #26 設計 doc、 同 migration 同梱検討候補)
- [ecosystem-mutual-review.md §1.3](./ecosystem-mutual-review.md) (= `crossover-as-breath` 観察、 本機能の design rationale)
- [ecosystem-mutual-review.md §3.4](./ecosystem-mutual-review.md) (= improvement seed #2 origin)
- [collaboration-model.md](./collaboration-model.md) (= Merge protocol、 2 段ゲート準拠)
- 同 family seeds (= improvement-roadmap.md §5.1 「thread organization」 cluster):
  - #4 time-crossover 警告 metadata (= bridge-gemini-impl 提案、 thread-tagging で alleviate)
  - #7 thread closure marker (= bridge-gemini-impl 提案、 thread tag + closure state 統合検討候補)
