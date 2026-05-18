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

# build 時に commit 情報を焼き込む (issue #47: /health version info)
# fly.io deploy では `flyctl deploy --build-arg GIT_COMMIT=$(git rev-parse HEAD) --build-arg GIT_COMMIT_AT=$(git log -1 --format=%cI HEAD)` 想定。
#
# default は **空文字** (= build-arg 未指定でも image build 成功、 ENV は空 → server 側
# readEnvString で `null` に倒れる)。 `'unknown'` 等の文字列 default を入れない理由:
# server 側 fallback chain は env-only + null fallback で設計されており、 build 側で
# 意味のある文字列を流すと silent fallback (= 「対応サーバーだが env 未設定」 と区別
# できない) になるため (= reviewer Minor #1 / PR #48 follow-up)。
ARG GIT_COMMIT=
ARG GIT_COMMIT_AT=

ENV NODE_ENV=production \
    MCP_PORT=3000 \
    DB_PATH=/app/data/app.db \
    GIT_COMMIT=${GIT_COMMIT} \
    GIT_COMMIT_AT=${GIT_COMMIT_AT}

EXPOSE 3000

# health check（agent-hub の /health エンドポイント）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

# tsx で TS を直接実行（試用段階のシンプル運用）
CMD ["npm", "run", "mcp:start"]
