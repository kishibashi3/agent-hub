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
- 現在の最新: **ADR-001** (`2026-05-18-peer-mesh-architecture-decision.md`)

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

## 運用ルール

- **誰が書くか**: 実装判断を下した impl peer (bridge worker)。ecosystem-wide 判断はリードした peer。
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
