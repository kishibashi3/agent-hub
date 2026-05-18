#!/usr/bin/env python3
"""
agent-hub cron-based DM scheduler (issue #40)

schedules.json を読んで cron 式に従って agent-hub 参加者に DM を送る軽量 daemon。

設定例 (schedules.json):
  [
    {"cron": "0 13 * * *", "to": "@planner", "message": "daily report を書いて"},
    {"cron": "*/30 * * * *", "to": "@reviewer", "message": "新規 PR の queue を確認"}
  ]

環境変数:
  AGENT_HUB_URL      MCP endpoint (default: http://localhost:3000/mcp)
  GITHUB_PAT         GitHub Personal Access Token (pat mode、 推奨)
  AGENT_HUB_USER     handle 名 (trust mode で識別、 pat mode で handle override)
  AGENT_HUB_TENANT   tenant 識別子 (CE 接続時、 未設定なら default tenant)

依存:
  pip install -r requirements.txt
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from croniter import croniter


# ============================================================
# Config + Auth
# ============================================================

HUB_URL = os.environ.get("AGENT_HUB_URL", "http://localhost:3000/mcp")
PAT = os.environ.get("GITHUB_PAT", "")
HANDLE_OVERRIDE = os.environ.get("AGENT_HUB_USER", "")
TENANT = os.environ.get("AGENT_HUB_TENANT", "")

# Default to schedules.json next to this script
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent / "schedules.json"


def build_headers() -> dict[str, str]:
    """MCP HTTP request headers (= auth + tenant + content-type)."""
    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if TENANT:
        headers["X-Tenant-Id"] = TENANT

    if PAT:
        headers["Authorization"] = f"Bearer {PAT}"
        if HANDLE_OVERRIDE:
            # PAT mode + persona override (= multi-persona、 同 owner で別 handle)
            headers["X-User-Id"] = HANDLE_OVERRIDE
    elif HANDLE_OVERRIDE:
        # Trust mode (= localhost のみ、 server-side AUTH_MODE=trust が前提)
        headers["X-User-Id"] = HANDLE_OVERRIDE
    else:
        print(
            "[ERR] Set GITHUB_PAT (pat mode) or AGENT_HUB_USER (trust mode)",
            file=sys.stderr,
        )
        sys.exit(1)

    return headers


def resolve_user_id(headers: dict[str, str]) -> str:
    """Auth mode に応じた user_id を返す (= log 表示用)。"""
    if HANDLE_OVERRIDE:
        return HANDLE_OVERRIDE
    if PAT:
        # PAT mode で GitHub login を resolve
        try:
            resp = requests.get(
                "https://api.github.com/user",
                headers={
                    "Authorization": f"Bearer {PAT}",
                    "User-Agent": "agent-hub-scheduler",
                    "Accept": "application/vnd.github+json",
                },
                timeout=10,
            )
            if resp.status_code == 200:
                return resp.json().get("login", "unknown")
        except requests.RequestException as e:
            print(f"[WARN] Could not resolve GitHub login: {e}", file=sys.stderr)
    return "unknown"


# ============================================================
# MCP HTTP client (= watch.sh pattern を Python 移植)
# ============================================================


def init_session(headers: dict[str, str]) -> str:
    """MCP session を initialize し、 session_id を返す。"""
    resp = requests.post(
        HUB_URL,
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "agent-hub-scheduler", "version": "1.0"},
            },
            "id": 0,
        },
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"initialize failed: HTTP {resp.status_code}: {resp.text[:200]}"
        )

    session_id = resp.headers.get("mcp-session-id")
    if not session_id:
        raise RuntimeError("No mcp-session-id header in initialize response")

    # MCP protocol 必須: initialized notification を送る
    requests.post(
        HUB_URL,
        headers={**headers, "mcp-session-id": session_id},
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        timeout=5,
    )

    return session_id


def send_dm(
    headers: dict[str, str], session_id: str, to: str, message: str
) -> dict[str, Any]:
    """`send_message` tool を呼出。 成功時は response body を返す、 失敗時 raise。"""
    resp = requests.post(
        HUB_URL,
        headers={**headers, "mcp-session-id": session_id},
        json={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "send_message",
                "arguments": {"to": to, "message": message},
            },
            "id": int(time.time() * 1000),
        },
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"send_message failed: HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.json()


# ============================================================
# Schedule loader + validator
# ============================================================


def load_schedules(config_path: Path) -> list[dict[str, str]]:
    """schedules.json を読み込んで validation 済 list を返す。

    JSON parse error / file not found / 必須 field 欠落 で sys.exit(1)。
    """
    try:
        text = config_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        print(f"[ERR] Config file not found: {config_path}", file=sys.stderr)
        sys.exit(1)

    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        print(f"[ERR] JSON parse error in {config_path}: {e}", file=sys.stderr)
        sys.exit(1)

    # 単一 dict も list として扱う (= schedules.json で 1 件設定 case の便宜)
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        print(
            f"[ERR] {config_path}: top-level must be JSON array or object",
            file=sys.stderr,
        )
        sys.exit(1)

    # Validate each entry
    required = ("cron", "to", "message")
    for i, entry in enumerate(data):
        if not isinstance(entry, dict):
            print(f"[ERR] schedule[{i}]: must be object", file=sys.stderr)
            sys.exit(1)
        for key in required:
            if key not in entry:
                print(
                    f"[ERR] schedule[{i}]: missing required field '{key}'",
                    file=sys.stderr,
                )
                sys.exit(1)
            if not isinstance(entry[key], str):
                print(
                    f"[ERR] schedule[{i}].{key}: must be string",
                    file=sys.stderr,
                )
                sys.exit(1)
        # cron expression validation
        try:
            croniter(entry["cron"], datetime.now())
        except (ValueError, KeyError) as e:
            print(
                f"[ERR] schedule[{i}].cron: invalid cron expression '{entry['cron']}': {e}",
                file=sys.stderr,
            )
            sys.exit(1)

    return data


# ============================================================
# Main loop
# ============================================================


def main() -> None:
    """Daemon main loop = config load → MCP session → cron scheduling loop。"""
    # Config path: $SCHEDULER_CONFIG or default (= same dir as script)
    config_path = Path(os.environ.get("SCHEDULER_CONFIG", str(DEFAULT_CONFIG_PATH)))
    schedules = load_schedules(config_path)

    headers = build_headers()
    user_id = resolve_user_id(headers)

    # tenant unset の場合 WARN (= agent-hub#28 「見えない幽霊」 bug 防止と同 pattern)
    if not TENANT:
        print(
            f"[WARN] AGENT_HUB_TENANT unset → connecting to default tenant.",
            file=sys.stderr,
        )

    # MCP session init
    try:
        session_id = init_session(headers)
    except Exception as e:
        print(f"[ERR] MCP session init failed: {e}", file=sys.stderr)
        sys.exit(1)

    print(
        f"[boot] mode={'pat' if PAT else 'trust'} user={user_id} "
        f"tenant={TENANT or 'default'} hub={HUB_URL} "
        f"schedules={len(schedules)} session={session_id[:8]}..."
    )

    # croniter iterator を schedule ごとに用意
    iters = [croniter(s["cron"], datetime.now()) for s in schedules]
    next_times: list[datetime] = [it.get_next(datetime) for it in iters]

    print(
        "[ready] " + "; ".join(
            f"[{i}] cron='{s['cron']}' to={s['to']} next={next_times[i].isoformat()}"
            for i, s in enumerate(schedules)
        )
    )

    while True:
        now = datetime.now()
        # 最も近い next_fire_time の schedule index
        min_idx = min(range(len(next_times)), key=lambda i: next_times[i])
        next_due = next_times[min_idx]
        wait_s = (next_due - now).total_seconds()

        if wait_s > 0:
            # 60 秒上限で sleep (= session reconnect chance / SIGTERM 応答性)
            time.sleep(min(wait_s, 60))
            continue

        # Fire
        s = schedules[min_idx]
        try:
            send_dm(headers, session_id, s["to"], s["message"])
            print(
                f"[FIRE] {next_due.isoformat()} → {s['to']}: {s['message'][:50]}"
                f"{'...' if len(s['message']) > 50 else ''}"
            )
        except Exception as e:
            print(f"[ERR] send_dm failed for schedule[{min_idx}]: {e}", file=sys.stderr)
            # Session が切れている可能性、 re-init を試行
            try:
                session_id = init_session(headers)
                print(f"[reinit] session={session_id[:8]}...")
            except Exception as e2:
                print(f"[ERR] session reinit failed: {e2}", file=sys.stderr)
                # 60 秒待って再試行 (= server outage 等の transient state recovery)
                time.sleep(60)

        # 次の fire time を計算 (= 同 schedule entry の次回)
        next_times[min_idx] = iters[min_idx].get_next(datetime)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[shutdown] interrupted by user", file=sys.stderr)
        sys.exit(0)
