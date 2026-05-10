# articles

agent-hub に関する執筆物 (note / qiita 投稿用 draft 等)。

## drafts

### 人とAIが同じ部屋にいる、というだけの話 (note)

agent-hub の launch announcement、note 公開用。共在 (co-presence) の発想を中心に。

3 段階の draft があり、`v3` が最新かつ最も拡張された版 (orchestration の 4 段階消滅 / start-stop の対称性 / 思想と実装の同型 を含む)。

| version | 内容 | md | xml (note import) | preview (rendered) |
|---|---|---|---|---|
| v1 (初版) | 共在の発想 + CE (multi-tenant) | [note-co-presence.md](./note-co-presence.md) | [note-co-presence.xml](./note-co-presence.xml) | [📝 v1 preview](https://htmlpreview.github.io/?https://github.com/kishibashi3/agent-hub/blob/main/articles/note-co-presence.preview.html) |
| v2 | 構成見直し版 (型の問題 → 共在 の順、TOFU の再配置) | [note-co-presence.v2.md](./note-co-presence.v2.md) | — | — |
| **v3 (最新・推奨)** | v2 + 4 段の orchestration removal + start/stop 対称性 + 思想 ⇔ 実装 の同型 | [note-co-presence.v3.md](./note-co-presence.v3.md) | [note-co-presence.v3.xml](./note-co-presence.v3.xml) | **[📝 v3 preview](https://htmlpreview.github.io/?https://github.com/kishibashi3/agent-hub/blob/main/articles/note-co-presence.v3.preview.html)** |

### qiita 版 (技術寄り 2 段構え)

| version | 想定読者 | 構成 | 字数 | ファイル |
|---|---|---|---|---|
| **intro (推奨入口)** | 初見の Qiita 読者、5 分で何かを掴みたい | CUI demo (PR レビュー workflow) → 仕組み → 触り方 → deep dive リンク | ~3.9k | [qiita-intro.md](./qiita-intro.md) |
| deep dive | intro を読んで興味を持った人、設計詳細を知りたい開発者 | 動機 / アーキ比較表 / 4 段の orchestrator 解消 / control plane / TOFU / 制約 | ~11.7k | [qiita-co-presence.md](./qiita-co-presence.md) |

intro は demo 起点で hook、deep dive は actor model / blackboard / stigmergy の観点まで踏み込む。Qiita 投稿は intro を出して、興味を持った人が deep dive へ流れる動線を想定。

### worker type デモ (note 記事内に組み込み用、screenshot して img として upload)

**[🖥️ demo-cui-worker-types.html (rendered)](https://htmlpreview.github.io/?https://github.com/kishibashi3/agent-hub/blob/main/articles/demo-cui-worker-types.html)**

同じ質問 (「さっきの設計の続き、コード書いて」) を `@claude-code (global)` / `@gemma (stateful)` / `@translator (stateless)` の 3 種類に投げて、応答の「記憶のかたち」が違うのを 1 ターミナル画面で見せる。Claude Code の actual UX に近い CUI 風の見た目。

(直接 GitHub で `.html` を開くと raw 表示になるので、上の rendered link 経由で見るのが楽)
