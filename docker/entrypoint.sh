#!/bin/sh
# agent-hub bundle image entrypoint (= issue #95)
#
# 役割:
# 1. scheduler の config (= schedules.json) が volume に存在しない場合、 空配列
#    `[]` で bootstrap (= 初回起動時に scheduler が FATAL に陥らないため)
# 2. supervisord に PID 1 として exec (= signal handling / lifecycle 管理)
#
# 設計判断:
# - scheduler 側 (= scheduler.py) は 「config 必須、 存在しなければ exit 1」 の
#   defensive semantics を維持 (= production deployment で意図しない empty state を
#   防ぐ重要 invariant)
# - bundle image は user experience を優先し、 「初回起動の bootstrap」 だけ
#   entrypoint で吸収。 user が手動 mount せず空 volume で起動した場合の friction 除去
# - 既存 schedules.json (= user が以前作った設定) は **絶対に上書きしない** (= `-f` check)

set -eu

SCHEDULES_PATH="${SCHEDULER_CONFIG:-/app/data/schedules.json}"

# volume mount された data dir が初回起動で空の場合、 schedules.json を bootstrap
if [ ! -f "$SCHEDULES_PATH" ]; then
  echo "[entrypoint] $SCHEDULES_PATH not found, bootstrapping with empty array []" >&2
  # parent dir も無い可能性 (= volume mount された /app/data 空) を考慮して mkdir -p
  mkdir -p "$(dirname "$SCHEDULES_PATH")"
  echo '[]' > "$SCHEDULES_PATH"
else
  # 既存 file は触らない、 user の設定を保護
  echo "[entrypoint] $SCHEDULES_PATH found, preserving existing config" >&2
fi

# supervisord を PID 1 として exec (= shell 自体は exit、 supervisord が signal を直接受領)
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/agent-hub.conf -n
