#!/bin/sh
# agent-hub-scheduler service entrypoint (issue #300)
#
# 役割:
# 1. schedules.json が volume に存在しない場合、空配列 `[]` で bootstrap
#    (= 初回起動時に scheduler.py が FATAL に陥らないため)
# 2. Python scheduler を直接 exec (= supervisord を経由しない、このプロセスが PID 1)
#
# 設計判断:
# - bundle image の entrypoint.sh (= supervisord 起動) とは別スクリプトで分離。
#   compose で `agent-hub-scheduler` service の entrypoint として使用する。
# - schedules.json の bootstrap ロジックは entrypoint.sh と同等 (= 既存 file は上書きしない)
# - AGENT_HUB_URL は compose 側で http://agent-hub:3000/mcp に override 済なので
#   ここでは参照しない。 SCHEDULER_CONFIG は compose volume mount + Dockerfile ENV で決定。

set -eu

SCHEDULES_PATH="${SCHEDULER_CONFIG:-/app/data/schedules.json}"

if [ ! -f "$SCHEDULES_PATH" ]; then
  echo "[entrypoint-scheduler] $SCHEDULES_PATH not found, bootstrapping with empty array []" >&2
  mkdir -p "$(dirname "$SCHEDULES_PATH")"
  echo '[]' > "$SCHEDULES_PATH"
else
  echo "[entrypoint-scheduler] $SCHEDULES_PATH found, preserving existing config" >&2
fi

exec /app/.venv/bin/python /app/packages/scheduler/scheduler.py
