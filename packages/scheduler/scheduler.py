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
import threading
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


def register_self(
    headers: dict[str, str], session_id: str, name: str, display_name: str
) -> None:
    """`register` tool を呼出して自分の handle を登録 (= is_online=true 維持)。

    issue #65: bidirectional 化のため、 scheduler が agent-hub participant として
    explicit に登録、 get_participants で見えるようにする。
    """
    resp = requests.post(
        HUB_URL,
        headers={**headers, "mcp-session-id": session_id},
        json={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "register",
                "arguments": {"name": name, "display_name": display_name},
            },
            "id": int(time.time() * 1000),
        },
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"register failed: HTTP {resp.status_code}: {resp.text[:200]}"
        )


def subscribe_inbox(headers: dict[str, str], session_id: str, name: str) -> None:
    """`resources/subscribe` で `inbox://@<name>` を購読 (= SSE push 経路の確立)。

    server 側がこの session に対し新規 DM 着信時 `notifications/resources/updated`
    を SSE で push してくる契約。
    """
    resp = requests.post(
        HUB_URL,
        headers={**headers, "mcp-session-id": session_id},
        json={
            "jsonrpc": "2.0",
            "method": "resources/subscribe",
            "params": {"uri": f"inbox://@{name}"},
            "id": int(time.time() * 1000),
        },
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"resources/subscribe failed: HTTP {resp.status_code}: {resp.text[:200]}"
        )


def fetch_inbox(
    headers: dict[str, str], session_id: str
) -> list[dict[str, Any]]:
    """`get_messages` tool を呼出して未読 DM 一覧を取得。"""
    resp = requests.post(
        HUB_URL,
        headers={**headers, "mcp-session-id": session_id},
        json={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "get_messages", "arguments": {}},
            "id": int(time.time() * 1000),
        },
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"get_messages failed: HTTP {resp.status_code}: {resp.text[:200]}"
        )
    body = resp.json()
    # MCP tools/call result は content array の text field に JSON 文字列が入る
    result = body.get("result", {})
    content = result.get("content", [])
    if not content:
        return []
    text = content[0].get("text", "")
    if not text:
        return []
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        return []
    except json.JSONDecodeError:
        return []


def mark_message_read(
    headers: dict[str, str], session_id: str, message_id: str
) -> None:
    """`mark_as_read` tool を呼出して message を既読化。"""
    resp = requests.post(
        HUB_URL,
        headers={**headers, "mcp-session-id": session_id},
        json={
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "mark_as_read",
                "arguments": {"message_id": message_id},
            },
            "id": int(time.time() * 1000),
        },
        timeout=10,
    )
    if resp.status_code != 200:
        # mark_as_read 失敗は致命的ではない、 log のみ (= 同 DM が再 dispatch される副作用)
        print(
            f"[WARN] mark_as_read failed: HTTP {resp.status_code}: {resp.text[:200]}",
            file=sys.stderr,
        )


# ============================================================
# Command dispatch (= issue #65 bidirectional support)
# ============================================================


def handle_inbox_command(
    headers: dict[str, str],
    session_id: str,
    sender: str,
    body: str,
    schedules: list[dict[str, str]],
) -> None:
    """inbox に届いた DM body を parse し command として実行、 sender へ reply。

    現在対応 command:
    - `ping`                  : `pong (scheduler alive, N schedules loaded)` を reply
    - `schedules`             : 現在の schedules.json 内容を reply
    - `run now <idx>`         : 指定 idx の schedule を即時 fire (cron は無視)

    未知 command は usage hint を reply。 副作用は最小 (= schedules は変更しない、
    cron も touch しない、 即時実行のみ)。
    """
    body_stripped = body.strip()
    cmd_first = body_stripped.split(maxsplit=1)[0].lower() if body_stripped else ""

    try:
        if cmd_first == "ping":
            send_dm(
                headers,
                session_id,
                sender,
                f"pong (scheduler alive, {len(schedules)} schedules loaded)",
            )
            print(f"[CMD] ping ← {sender}")

        elif cmd_first == "schedules":
            if not schedules:
                send_dm(
                    headers, session_id, sender, "schedules: (none loaded)"
                )
            else:
                listing = "\n".join(
                    f"[{i}] cron='{s['cron']}' to={s['to']} message='{s['message'][:60]}{'...' if len(s['message']) > 60 else ''}'"
                    for i, s in enumerate(schedules)
                )
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"schedules ({len(schedules)} loaded):\n{listing}",
                )
            print(f"[CMD] schedules ← {sender}")

        elif cmd_first == "run":
            # `run now <idx>` 限定 (= 単独 `run` は曖昧、 reject)
            parts = body_stripped.split()
            if len(parts) < 3 or parts[1].lower() != "now":
                send_dm(
                    headers,
                    session_id,
                    sender,
                    "[ERR] usage: `run now <idx>` (idx = schedule index in `schedules` output)",
                )
                return
            try:
                idx = int(parts[2])
            except ValueError:
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"[ERR] invalid idx '{parts[2]}': must be integer",
                )
                return
            if not (0 <= idx < len(schedules)):
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"[ERR] idx {idx} out of range (0-{len(schedules) - 1})",
                )
                return
            s = schedules[idx]
            try:
                send_dm(headers, session_id, s["to"], s["message"])
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"[OK] fired schedule[{idx}] → {s['to']}",
                )
                print(
                    f"[RUN-NOW] idx={idx} ← {sender}: {s['to']}: "
                    f"{s['message'][:50]}{'...' if len(s['message']) > 50 else ''}"
                )
            except Exception as e:
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"[ERR] fire failed for schedule[{idx}]: {e}",
                )

        else:
            send_dm(
                headers,
                session_id,
                sender,
                f"[unknown command] '{body_stripped[:50]}'. usage: `ping` / `schedules` / `run now <idx>`",
            )
            print(f"[CMD] unknown ← {sender}: {body_stripped[:50]}")

    except Exception as e:
        # send_dm 自体が失敗するケース (= server 障害等)、 log のみ
        print(
            f"[ERR] handle_inbox_command failed (sender={sender}): {e}",
            file=sys.stderr,
        )


# ============================================================
# SSE listener thread (= issue #65 inbox push reactor)
# ============================================================


def sse_listen_loop(
    headers: dict[str, str],
    user_id: str,
    schedules: list[dict[str, str]],
) -> None:
    """Background thread main loop:
    1. own MCP session を init
    2. register_self + subscribe_inbox
    3. SSE long-lived GET で `notifications/resources/updated` 待ち
    4. push 到着で fetch_inbox + handle_inbox_command + mark_message_read
    5. 切断時は 3 秒待って再接続

    watch.sh の SSE long-lived 接続 pattern を Python 移植 (= issue #65)。
    main thread の cron loop とは独立した session を持つ (= 同一 user の 2 session、
    server 側は別 transport として扱う)。
    """
    display_name = f"Scheduler — cron DM + inbox bidirectional (= issue #65)"
    while True:
        try:
            sid = init_session(headers)
            print(
                f"[sse-init] session={sid[:8]}... subscribing inbox://@{user_id}"
            )

            # 1. register_self (= @user_id を agent-hub に participant 登録)
            try:
                register_self(headers, sid, user_id, display_name)
                print(f"[sse-registered] @{user_id} as '{display_name}'")
            except Exception as e:
                # register 失敗は致命的ではない (= 既登録の可能性等)、 警告のみ
                print(f"[WARN] register failed: {e}", file=sys.stderr)

            # 2. subscribe inbox
            try:
                subscribe_inbox(headers, sid, user_id)
                print(f"[sse-subscribed] inbox://@{user_id}")
            except Exception as e:
                print(
                    f"[ERR sse] subscribe failed: {e}, reconnect in 5s",
                    file=sys.stderr,
                )
                time.sleep(5)
                continue

            # 3. long-lived GET で SSE stream 受信
            with requests.get(
                HUB_URL,
                headers={
                    **headers,
                    "mcp-session-id": sid,
                    "Accept": "text/event-stream",
                },
                stream=True,
                timeout=None,
            ) as resp:
                if resp.status_code != 200:
                    print(
                        f"[ERR sse] GET status {resp.status_code}: "
                        f"{resp.text[:200] if hasattr(resp, 'text') else ''}",
                        file=sys.stderr,
                    )
                    time.sleep(5)
                    continue

                for raw in resp.iter_lines(decode_unicode=True):
                    if not raw:
                        continue
                    # SSE event は "data: <json>" 形式、 method field を文字列含有判定で fast-check
                    if "notifications/resources/updated" not in raw:
                        continue

                    # 4. inbox fetch + dispatch + mark_as_read
                    try:
                        msgs = fetch_inbox(headers, sid)
                        for m in msgs:
                            sender = m.get("from", "@unknown")
                            body = m.get("message", "")
                            msg_id = m.get("id")
                            handle_inbox_command(
                                headers, sid, sender, body, schedules
                            )
                            if msg_id:
                                mark_message_read(headers, sid, msg_id)
                    except Exception as e:
                        print(
                            f"[ERR sse inbox-handler] {e}", file=sys.stderr
                        )

            # SSE stream closed: reconnect
            print(
                f"[sse-reconnect] stream closed, reconnect in 3s", file=sys.stderr
            )
            time.sleep(3)

        except Exception as e:
            print(
                f"[ERR sse-loop] {e}, reconnect in 5s", file=sys.stderr
            )
            time.sleep(5)


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

    # issue #65: bidirectional 化、 SSE listener を background thread で起動。
    # 自分自身 (= user_id) の handle で register + inbox subscribe + SSE 待ち + command dispatch。
    # daemon=True で main thread 終了に連動して自動 cleanup (= SIGINT 時の挙動 preserve)。
    sse_thread = threading.Thread(
        target=sse_listen_loop,
        args=(headers, user_id, schedules),
        name="sse-listener",
        daemon=True,
    )
    sse_thread.start()
    print(f"[sse-thread] started (target=inbox://@{user_id})")

    # croniter iterator を schedule ごとに用意
    iters = [croniter(s["cron"], datetime.now()) for s in schedules]
    next_times: list[datetime] = [it.get_next(datetime) for it in iters]

    if schedules:
        print(
            "[ready] " + "; ".join(
                f"[{i}] cron='{s['cron']}' to={s['to']} next={next_times[i].isoformat()}"
                for i, s in enumerate(schedules)
            )
        )
    else:
        # issue #65: schedules 空でも SSE listener thread が動く (= inbox commands に reply 可能)
        print("[ready] no schedules loaded; SSE inbox listener only")

    while True:
        if not schedules:
            # cron 不要、 SSE thread に任せて main は 60s sleep ループ (= SIGINT 応答性維持)
            time.sleep(60)
            continue
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
