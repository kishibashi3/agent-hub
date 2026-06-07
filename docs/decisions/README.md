# ADR (Architecture Decision Record) ガイド

agent-hub ecosystem の重要な設計判断を `docs/decisions/` に記録する運用ガイド。

---

## 書くべき判断の閾値

| 判断カテゴリ | ADR 必要? |
|---|---|
| API contract 変更 (endpoint / field 追加・削除・変更) | ✅ 必須 |
| DB schema 設計 / storage 選択 | ✅ 必須 |
| Ecosystem 共通 convention (messaging protocol / auth model 等) | ✅ 必須 |
| Transport / infrastructure 選択 (SSE / WebSocket 等) | ✅ 必須 |
| 機能追加 (既存 API の範囲内) | △ 任意 (design-*.md で代替可) |
| Bug fix / refactor | ❌ 不要 |

---

## ファイル命名

```
YYYY-MM-DD-<slug>.md
```

- 日付 = 判断を確定した日
- slug = kebab-case で判断内容を簡潔に
- 例: `2026-06-01-caused-by-design.md`

---

## 採番

- frontmatter の `**Number**: ADR-NNN` で管理
- 新しい ADR を追加する前に `docs/decisions/` の最新番号を確認して +1 する
- 現在の最新: **ADR-006** (`2026-06-07-global-mode-wildcard-subscription.md`)

---

## 最小テンプレート

```markdown
# ADR-NNN: <Title>

**Number**: ADR-NNN
**Status**: Proposed | Accepted | Deprecated | Superseded by ADR-NNN
**Date**: YYYY-MM-DD
**Scope**: agent-hub | ecosystem
**Participants**: @handle (role)
**Issue**: #N  ← optional

---

## Context

<この判断を迫られた背景・制約・問題を 3〜5 文で。>

## Decision

<何を決めたか。1〜3 文で明確に。>

## Consequences

### Positive
- <得られるもの>

### Risks / Trade-offs
- <失うもの・リスク・制約>

## Related

- Refs: #N
- docs/X.md
```

---

## 誰が ADR を書くか

> **v2 (2026-05-31)**: 旧ルールでは「リードした peer が書く」としていたが、ecosystem 横断の場合は責任者を一意にするため「常に @planner が書く」に narrowing した (PR #187)。

### 1. Writer は scope で決まる

| scope | writer |
|---|---|
| 単一 repo 内の技術判断 (DB schema / API contract 等) | PR を出した **impl peer** — PR と同時に書く |
| ecosystem 横断の判断 (cross-repo convention 等) | **@planner** が書く |

### 2. デフォルトの引き金 — 空白を作らない

「誰が書くか」を曖昧にすると「誰も書かない」になる (diffusion of responsibility)。  
上記により常に責任者が一意に定まる: **repo 内 = PR author / 横断 = @planner**。空白にしない。

### 3. 決定の出所を必ず残す — writer ≠ decider 対策

書く人が誰であれ、ADR の `## Context` に **「誰の・どの判断で決まったか」** を明記する:

- 決定に至った DM / issue / PR を参照し、後から経緯を辿れるようにする
- 例: `> この判断は @ope-ultp1635 の DM (2026-05-31) により確定。caused_by: <UUID — agent-hub message ID, e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890>`
- 理由: 決定の決め手が writer 以外 (人間や他 peer) から来ることが多い。出所を本文に刻まないと、後から読む peer が「なぜそう決めたか」を再構成できない ([#181](https://github.com/kishibashi3/agent-hub/issues/181) caused_by 可視化と噛み合う設計)。

---

## 運用ルール

- **いつ書くか**: PR と同時提出が理想。事後形式化 (既存設計の ADR 化) も可、その場合は `**Status**: Accepted` で起票。
- **Scope フィールド**:
  - `agent-hub` = server 固有の判断
  - `ecosystem` = 複数 repo / bridge / peer をまたぐ判断
- **Review フロー**: 通常の PR フロー (`LGTM ✅` PR comment → @planner self-merge)。`scope: ecosystem` の ADR は operator GO 推奨。
- **docs/index.md 更新**: 新 ADR を追加したら `docs/index.md` の `## 設計判断 / Decisions` セクションに 1 行追記する。

---

## 既存 ADR

| No. | ファイル | タイトル | Status | Scope |
|---|---|---|---|---|
| ADR-001 | [2026-05-18-peer-mesh-architecture-decision.md](./2026-05-18-peer-mesh-architecture-decision.md) | Peer-Mesh Architecture with Transparent Asymmetry | Adopted | ecosystem |
| ADR-002 | [2026-05-18-caused-by-design.md](./2026-05-18-caused-by-design.md) | caused_by 因果チェーン追跡設計 | Accepted | agent-hub |
| ADR-003 | [2026-05-18-sse-transport.md](./2026-05-18-sse-transport.md) | MCP トランスポートに Streamable HTTP (SSE) を選択 | Accepted | agent-hub |
| ADR-004 | [2026-05-18-tenant-isolation.md](./2026-05-18-tenant-isolation.md) | マルチテナント分離設計 | Accepted | agent-hub |
| ADR-005 | [2026-05-31-bridge-claude-otlp-span.md](./2026-05-31-bridge-claude-otlp-span.md) | bridge-claude OTLP span emit (observability #1) | Adopted | ecosystem |
| ADR-006 | [2026-06-07-global-mode-wildcard-subscription.md](./2026-06-07-global-mode-wildcard-subscription.md) | `mode: "global"` による tenant-level wildcard subscription 権限設計 | Proposed | agent-hub |
