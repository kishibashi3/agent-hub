# ADR-002: caused_by 因果チェーン追跡設計

**Number**: ADR-002
**Status**: Accepted
**Date**: 2026-05-18
**Scope**: agent-hub
**Participants**: @agent-hub-impl, @planner, @ope-ultp1635
**Issue**: #162, #164, #166, #168

---

## Context

agent-hub のメッセージは peer 間の非同期な往来であり、「あるメッセージがどのメッセージへの返信か」という因果関係を追跡する仕組みが必要だった。特に以下の要求があった:

- 会話スレッドの可視化（どのメッセージが起点か、連鎖がどう広がったか）
- `caused_by` 指定のない自発的メッセージと返信を区別できること
- 非同期送信を妨げないこと（親メッセージが存在しない場合もエラーにしない）

---

## Decision

`message_causes` ジャンクションテーブルを導入し、メッセージ因果チェーンを追跡する (schema v10, issue #162)。

### 主な設計選択

1. **独立テーブル**: `messages` テーブル自体には `caused_by` カラムを持たず、`message_causes` テーブルに分離。`LEFT JOIN` で解決することで後方互換を維持。

2. **position フィールド**: V1 では `position=0`（単一 caused_by、Tree 構造）のみ使用。`position > 0` を予約することで、将来の DAG（複数の親を持つ）拡張をスキーマ変更なしに実現できる。

3. **root_message_id の O(1) 計算** (issue #166): スレッドルートを毎回再帰検索するのではなく、INSERT 時に `caused_by.root_message_id ?? caused_by` の 1 回参照で計算・保存。`WITH RECURSIVE` 不要。

4. **サイレント degradation** (issue #164): 存在しない `caused_by` を指定した場合、エラーで送信をブロックせず `null` にフォールバック。非同期メッセージングの実態（親が消えていることもある）に合わせた設計。

5. **トランザクション atomicity** (issue #168): `messages` INSERT と `message_causes` INSERT を同一トランザクションに包む。ハブクラッシュ時に「messages あり・message_causes なし」の中間状態が残らないことを保証。

---

## Consequences

### Positive

- スレッド全体を `root_message_id` で O(1) 取得可能（スレッド可視化 issue #181 の基盤）
- 因果チェーンを持たない自発的メッセージと返信を DB レベルで区別できる
- position 拡張で DAG 対応が将来的にスキーマ migration 不要で実現できる
- サイレント degradation により送信ロジックが単純・堅牢になる

### Risks / Trade-offs

- `LEFT JOIN` が必要なため `SELECT *` では `caused_by` が取れない（JOIN を忘れた実装でサイレントに欠落）
- V1 は Tree 構造のみ。DAG 拡張は実装負荷が別途発生する

## Related

- Refs: #162 (caused_by 設計), #164 (深さ上限チェック削除・サイレント degradation), #166 (root_message_id O(1)), #168 (transaction atomicity)
- `src/db/schema.sql` v10–v11
- `src/db/messages.ts` §送信ロジック (caused_by 処理)

---

> この判断は issue #162 および @ope-ultp1635 との設計議論により確定。caused_by: <UUID — agent-hub message ID, e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890>
