# agent-hub dashboard sidecar image (= @admin feature request、 2026-05-20)
#
# Python 3.13 stdlib only (= sqlite3 + http.server) で動作する軽量 sidecar、
# D3.js は CDN 経由なので Python 依存ゼロ + slim image で十分。
#
# 既存 fly.io 用 `Dockerfile` (= server-only) + bundle 用 `Dockerfile.bundle`
# (= server + scheduler) と並ぶ **3 番目** の独立 image。 docker-compose 内
# sidecar として agent-hub bundle と並走、 SQLite DB volume を read-only mount。

FROM python:3.13-slim

WORKDIR /app

# 依存なし (= stdlib のみ)、 source のみ copy
COPY server.py .

# 環境変数 default 値:
# - DB_PATH: agent-hub bundle と同じ `/app/data/app.db` を期待 (= compose 経由で
#   shared volume mount される想定)
# - PORT: dashboard listen port (= 8080 が canonical default)
# - AGENT_HUB_TENANT: 未指定なら全 tenant aggregate (= admin clarification)
ENV DB_PATH=/app/data/app.db \
    PORT=8080

EXPOSE 8080

# python -u で stdout を unbuffered (= docker logs で realtime tail 可能)
CMD ["python", "-u", "server.py"]
