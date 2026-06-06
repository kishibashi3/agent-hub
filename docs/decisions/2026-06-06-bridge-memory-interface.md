# ADR: Bridge Memory Interface — context persistence across sessions

**Date**: 2026-06-06  
**Status**: Proposed  
**Author**: @ope-ultp1635  
**Related**: [agent-hub-bridges#131](https://github.com/kishibashi3/agent-hub-bridges/issues/131)

---

## Context

Bridge プロセスはセッション（Claude Code プロセス）の寿命に依存して動作する。セッション終了・compaction・クラッシュ等で会話コンテキストが失われると、次セッション起動時に文脈が断絶する。

現状、bridge は成果物（PR URL、調査結果等）を archive に残すが、**会話の文脈そのものは保存していない**。

## Decision

**全ての bridge 実装が持つべき共通インターフェースとして「記憶の永続化」を定義する。**

### 2 モード

| モード | トリガー | 保存内容 | 頻度 |
|---|---|---|---|
| **Compaction summary** | `/compact` 実行時 | コンテキスト圧縮後のサマリーテキスト | 通常運用で自動 |
| **Full archive** | 設定フラグ有効時 | 会話全文（JSONL） | 重要処理時のみ |

### 保存先規約

```
<workdir>/
  daily/
    YYYY-MM-DD.md      ← compaction サマリーを追記（デフォルト）
  archive/
    YYYY-MM-DD-HH-MM.jsonl  ← フルアーカイブ（オプション）
```

### 実装責務

全ての bridge 実装（bridge-claude / bridge-tmux-go / 将来の実装）は以下を満たす：

1. compaction または session 終了時に `daily/YYYY-MM-DD.md` にサマリーを追記する
2. `BRIDGE_FULL_ARCHIVE=1` 環境変数が設定されている場合、会話全文を `archive/` に保存する
3. 起動時に `daily/` の直近エントリを読み込み、startup context として使用できる（任意）

## Rationale

- **全 bridge 共通**: bridge-claude だけでなく、bridge-tmux（Go）や将来の実装も同じ責務を持つ
- **軽量デフォルト**: compaction サマリーのみなら容量・処理コストが小さい
- **opt-in フルアーカイブ**: めったに使わない機能はデフォルト OFF
- **workdir 内に閉じる**: peer ごとに workdir が分かれているので、記憶も peer 単位で自然に分離される

## Consequences

- bridge 実装ガイドに本 ADR への参照を追加する
- bridge-claude の `worker.py` で compaction hook を実装する（issue #131）
- bridge-tmux-go でも同様の hook を実装する
