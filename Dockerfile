# agent-hub MCP server (Streamable HTTP)
#
# Fly.io デプロイ用。SQLite を /app/data に永続化（fly volume mount 想定）。
# Phase 1: X-User-Id 信頼ネットワーク前提のまま外に出す（shared secret は別途追加）。

FROM node:20-bookworm-slim

WORKDIR /app

# better-sqlite3 はネイティブビルド必要
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# 依存だけ先にコピーしてキャッシュ効かせる
COPY package.json package-lock.json* ./
RUN npm ci

# ソースコード
COPY src ./src
COPY tsconfig.json ./

# DB ファイル置き場（fly volume をここにマウントする想定）
RUN mkdir -p /app/data

ENV NODE_ENV=production \
    MCP_PORT=3000 \
    DB_PATH=/app/data/app.db

EXPOSE 3000

# health check（agent-hub の /health エンドポイント）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

# tsx で TS を直接実行（試用段階のシンプル運用）
CMD ["npm", "run", "mcp:start"]
