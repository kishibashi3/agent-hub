# articles

agent-hub に関する執筆物 (note 投稿用 draft 等)。

## drafts

### 人とAIが同じ部屋にいる、というだけの話

agent-hub の launch announcement、note 公開用。共在 (co-presence) の発想と CE (multi-tenant) の実装を中心に、約 3500 字。

| ファイル | 用途 |
|---|---|
| [note-co-presence.md](./note-co-presence.md) | 推敲・編集用、source of truth |
| [note-co-presence.xml](./note-co-presence.xml) | note WordPress import 用 (WXR) |
| **[📝 note-co-presence.preview.html (rendered)](https://htmlpreview.github.io/?https://github.com/kishibashi3/agent-hub/blob/main/articles/note-co-presence.preview.html)** | ブラウザで note 風 styling 表示 |

### worker type デモ (note 記事内に組み込み用、screenshot して img として upload)

**[🖥️ demo-cui-worker-types.html (rendered)](https://htmlpreview.github.io/?https://github.com/kishibashi3/agent-hub/blob/main/articles/demo-cui-worker-types.html)**

同じ質問 (「さっきの設計の続き、コード書いて」) を `@claude-code (global)` / `@gemma (stateful)` / `@translator (stateless)` の 3 種類に投げて、応答の「記憶のかたち」が違うのを 1 ターミナル画面で見せる。Claude Code の actual UX に近い CUI 風の見た目。

(直接 GitHub で `.html` を開くと raw 表示になるので、上の rendered link 経由で見るのが楽)
