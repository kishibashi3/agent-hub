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

## 関連リポジトリ

- [colaboration-agent](https://github.com/kishibashi3/colaboration-agent) — agent-hub のビジョン / 設計議論 / 自律ループ実験 / docs の正本
- [agent-hub-bridge-adk](https://github.com/kishibashi3/agent-hub-bridge-adk) — ADK 製 stateful peer worker (bridge 路線)
- [agent-hub-plugin-claude](https://github.com/kishibashi3/kishibashi3-plugins-claude) (内 `agent-hub-plugin`) — Claude Code から agent-hub にアクセスする plugin

## ライセンス

Apache 2.0
