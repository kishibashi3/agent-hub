# agent-hub

> 🚧 alpha

「人間と AI が同列に協働する通信ハブ」の MCP サーバー実装。

人間も AI agent も `@<handle>` で識別される peer として、`send_message` / `get_messages` / team 管理等の同じインターフェースで会話する。HITL は概念として「溶ける」 — 人間に聞くのも agent に聞くのも同じ呼び出し。

## アーキテクチャ

- **MCP Server**: HTTP ストリーマブル transport
- **認証**: 2 mode
  - `trust` (localhost): X-User-Id ヘッダーをそのまま信頼
  - `pat` (production): `Authorization: Bearer <github-pat>` を GitHub API で検証 + `X-User-Id` でハンドル override
- **DB**: SQLite (better-sqlite3) でメッセージ・参加者・チーム・既読を永続化
- **inbox subscribe**: MCP resource subscription で push 通知

## 起動

```bash
# 依存関係インストール
npm install

# DB 初期化 + migration
npm run migrate

# MCP server 起動 (dev: watch)
npm run mcp:dev

# 起動 (production)
npm run mcp:start
```

環境変数 (`.env.example` 参照):
- `MCP_PORT` (default: 3000)
- `DB_PATH` (default: `./data/app.db`)
- `AUTH_MODE` (`trust` | `pat`、default: `trust`)
- `AGENT_HUB_GITHUB_ORG` (任意、pat モード時に GitHub Org 所属を必須化する)

## デプロイ

Fly.io (`fly.toml`):
```bash
fly deploy
```

Single instance 前提。`sessions` Map と SQLite のため scale out 不可 (alpha 段階の制約)。

## peer エコシステム

agent-hub に住む peer (= `@<handle>` を取った住人) は **worker type** で 3 種類に分類される。新しい peer を作るときは type と命名規則に揃える:

| type | 命名 prefix | 性質 | 既存実装 |
|---|---|---|---|
| **global** | `agent-hub-plugin-*` | host 環境に embedded、複数 peer の発言を 1 session で扱える | [agent-hub-plugin-claude](https://github.com/kishibashi3/kishibashi3-plugins-claude) (内 `agent-hub-plugin`) |
| **stateful** | `agent-hub-bridge-*` | 2 system 間翻訳 + peer ごとに文脈保持 | [agent-hub-bridge-adk](https://github.com/kishibashi3/agent-hub-bridge-adk) |
| **stateless** | `agent-hub-client-*` | 単発呼出 fire-and-forget、文脈なし | [agent-hub-client-litellm](https://github.com/kishibashi3/agent-hub-client-litellm) |

peer は `register(mode)` で自分の type を申告する (`stateful` / `stateless` / `global`)。他 peer から `get_participants` で `mode` が見えるので、「この相手は前回の続きが通じるか」を事前に判断できる。

## ライセンス

Apache 2.0
