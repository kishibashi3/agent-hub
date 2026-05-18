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

# issue #65 v2 redesign: schedules list は main thread (cron read) と SSE thread
# (start/stop write) で共有される mutable state、 排他 access が必要。
# `_schedules_lock` を with 文で取得して: read 中の write / write 中の read を防ぐ。
# save_schedules() の atomic file write も同 lock 内で行う (= memory state と disk state
# の monotonic consistency 保証)。
_schedules_lock = threading.Lock()


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


def _find_by_name(
    schedules: list[dict[str, Any]], name: str
) -> tuple[int, dict[str, Any]] | tuple[None, None]:
    """schedules list から name 一致の (idx, entry) を返す。 見つからなければ (None, None)。"""
    for i, s in enumerate(schedules):
        if s.get("name") == name:
            return i, s
    return None, None


def _parse_add_args(body_stripped: str) -> dict[str, str] | str:
    """`add <name> <cron-5-fields> <to> <message...>` を positional parse。

    cron が常に 5 fields (= croniter standard) なので、 word 切り分けで
    name (1 word) / cron (5 words) / to (1 word) / message (残り) と決定論的に分割可能。

    成功時 dict {name, cron, to, message} を返す。 失敗時 error message string を返す。
    """
    # body の先頭 "add " を除いた残り全体
    if not body_stripped.lower().startswith("add"):
        return "[INTERNAL] _parse_add_args called without 'add' prefix"
    rest = body_stripped[len("add"):].strip()
    if not rest:
        return (
            "[ERR] usage: `add <name> <cron> <to> <message>` "
            "(cron = 5 space-separated fields、 e.g. `0 13 * * *`)"
        )
    parts = rest.split()
    # 期待: name(1) + cron(5) + to(1) + message(>=1) = 最低 8 words
    if len(parts) < 8:
        return (
            f"[ERR] not enough args (got {len(parts)}, need >=8). "
            f"usage: `add <name> <cron-5-fields> <to> <message>` "
            f"e.g. `add daily 0 13 * * * @planner daily report`"
        )
    name = parts[0]
    cron_expr = " ".join(parts[1:6])  # 5 fields
    to = parts[6]
    message = " ".join(parts[7:])
    if not name:
        return "[ERR] name cannot be empty"
    if not to.startswith("@"):
        return f"[ERR] `to` must start with `@` (got '{to}')"
    return {"name": name, "cron": cron_expr, "to": to, "message": message}


def handle_inbox_command(
    headers: dict[str, str],
    session_id: str,
    sender: str,
    body: str,
    schedules: list[dict[str, Any]],
    iters: list[Any],
    next_times: list[datetime],
    config_path: Path,
) -> None:
    """inbox に届いた DM body を parse し command として実行、 sender へ reply。

    issue #65 v3 redesign (= operator 訂正 use case 反映):
    operator が send_message だけで cron daemon 再起動なしに schedules を dynamic に
    add/delete 管理したい (= 「start/stop + enabled flag」 から 「add/delete」 へ pivot)。

    対応 command:
    - `ping`                                      : 生存確認 (= 残置)
    - `schedules`                                 : 全 schedule listing
    - `add <name> <cron-5> <to> <message>`        : 新規 entry 追加 + iter init + 永続化
    - `delete <name>`                             : entry 削除 + iter 除去 + 永続化
    - `run now <name>`                            : one-shot 即時 fire (= optional、 unchanged)
    - 未知 command                                : usage hint

    `_schedules_lock` で memory state (schedules + iters + next_times) + disk state
    (schedules.json) を atomic に更新。 main thread cron loop は同 lock 内で fire 対象を snapshot。
    """
    body_stripped = body.strip()
    parts = body_stripped.split()
    cmd_first = parts[0].lower() if parts else ""

    try:
        if cmd_first == "ping":
            with _schedules_lock:
                count = len(schedules)
            send_dm(
                headers,
                session_id,
                sender,
                f"pong (scheduler alive, {count} schedules loaded)",
            )
            print(f"[CMD] ping ← {sender}")

        elif cmd_first == "schedules":
            with _schedules_lock:
                if not schedules:
                    listing_text = "schedules: (none loaded)"
                else:
                    lines = []
                    for s in schedules:
                        msg = s["message"]
                        msg_preview = (
                            f"{msg[:60]}{'...' if len(msg) > 60 else ''}"
                        )
                        lines.append(
                            f"  {s['name']:20s} cron='{s['cron']}' "
                            f"to={s['to']} message='{msg_preview}'"
                        )
                    listing_text = (
                        f"schedules ({len(schedules)} loaded):\n"
                        + "\n".join(lines)
                    )
            send_dm(headers, session_id, sender, listing_text)
            print(f"[CMD] schedules ← {sender}")

        elif cmd_first == "add":
            parsed = _parse_add_args(body_stripped)
            if isinstance(parsed, str):
                # error message
                send_dm(headers, session_id, sender, parsed)
                return
            new_entry = parsed
            with _schedules_lock:
                # uniqueness check
                existing_names = {s["name"] for s in schedules}
                if new_entry["name"] in existing_names:
                    send_dm(
                        headers,
                        session_id,
                        sender,
                        f"[ERR] add '{new_entry['name']}': name already exists. "
                        f"use `delete {new_entry['name']}` first, or pick a different name.",
                    )
                    return
                # full validation (= cron expression 等、 uniqueness は既 check)
                err = _validate_entry(new_entry, existing_names, where="add")
                if err is not None:
                    send_dm(headers, session_id, sender, f"[ERR] {err}")
                    return
                # apply: schedules + iters + next_times を atomic に append
                schedules.append(new_entry)
                new_iter = croniter(new_entry["cron"], datetime.now())
                new_next = new_iter.get_next(datetime)
                iters.append(new_iter)
                next_times.append(new_next)
                # persist to disk
                try:
                    save_schedules(config_path, schedules)
                except Exception as e:
                    # rollback memory state on disk write failure
                    schedules.pop()
                    iters.pop()
                    next_times.pop()
                    send_dm(
                        headers,
                        session_id,
                        sender,
                        f"[ERR] add '{new_entry['name']}': persist failed ({e}), state unchanged",
                    )
                    print(f"[ERR] save_schedules failed: {e}", file=sys.stderr)
                    return
            send_dm(
                headers,
                session_id,
                sender,
                f"[OK] added '{new_entry['name']}' "
                f"(cron='{new_entry['cron']}' to={new_entry['to']} "
                f"next={new_next.isoformat()}, persisted)",
            )
            print(
                f"[CMD] add name='{new_entry['name']}' cron='{new_entry['cron']}' "
                f"to={new_entry['to']} ← {sender}"
            )

        elif cmd_first == "delete":
            if len(parts) < 2:
                send_dm(
                    headers,
                    session_id,
                    sender,
                    "[ERR] usage: `delete <name>` (name = schedule name in `schedules` output)",
                )
                return
            name = parts[1]
            with _schedules_lock:
                idx, s = _find_by_name(schedules, name)
                if idx is None or s is None:
                    send_dm(
                        headers,
                        session_id,
                        sender,
                        f"[ERR] no schedule named '{name}'. "
                        f"use `schedules` to list available names.",
                    )
                    return
                # snapshot to rollback if persist fails
                snap_entry = schedules[idx]
                snap_iter = iters[idx]
                snap_next = next_times[idx]
                # apply: remove from all 3 parallel lists
                del schedules[idx]
                del iters[idx]
                del next_times[idx]
                # persist to disk
                try:
                    save_schedules(config_path, schedules)
                except Exception as e:
                    # rollback memory state on disk write failure
                    schedules.insert(idx, snap_entry)
                    iters.insert(idx, snap_iter)
                    next_times.insert(idx, snap_next)
                    send_dm(
                        headers,
                        session_id,
                        sender,
                        f"[ERR] delete '{name}': persist failed ({e}), state unchanged",
                    )
                    print(f"[ERR] save_schedules failed: {e}", file=sys.stderr)
                    return
            send_dm(
                headers,
                session_id,
                sender,
                f"[OK] deleted '{name}' (removed from schedules.json, no more fires)",
            )
            print(f"[CMD] delete name='{name}' ← {sender}")

        elif cmd_first == "run":
            # `run now <name>` 限定 (= one-shot 即時 fire、 cron 設定には触れない)
            if len(parts) < 3 or parts[1].lower() != "now":
                send_dm(
                    headers,
                    session_id,
                    sender,
                    "[ERR] usage: `run now <name>` (one-shot fire, doesn't modify schedules)",
                )
                return
            name = parts[2]
            with _schedules_lock:
                idx, s = _find_by_name(schedules, name)
                if idx is None or s is None:
                    send_dm(
                        headers,
                        session_id,
                        sender,
                        f"[ERR] no schedule named '{name}'. "
                        f"use `schedules` to list available names.",
                    )
                    return
                # snapshot to fire outside lock (= send_dm may take time)
                fire_to = s["to"]
                fire_msg = s["message"]
            try:
                send_dm(headers, session_id, fire_to, fire_msg)
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"[OK] one-shot fired '{name}' → {fire_to} (schedule unchanged)",
                )
                print(
                    f"[RUN-NOW] name={name} ← {sender}: {fire_to}: "
                    f"{fire_msg[:50]}{'...' if len(fire_msg) > 50 else ''}"
                )
            except Exception as e:
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"[ERR] fire failed for '{name}': {e}",
                )

        else:
            send_dm(
                headers,
                session_id,
                sender,
                f"[unknown command] '{body_stripped[:50]}'. "
                f"usage: `ping` / `schedules` / `add <name> <cron-5> <to> <message>` / "
                f"`delete <name>` / `run now <name>`",
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
    schedules: list[dict[str, Any]],
    iters: list[Any],
    next_times: list[datetime],
    config_path: Path,
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
                                headers,
                                sid,
                                sender,
                                body,
                                schedules,
                                iters,
                                next_times,
                                config_path,
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


def load_schedules(config_path: Path) -> list[dict[str, Any]]:
    """schedules.json を読み込んで validation 済 list を返す。

    issue #65 v3 schema (= dynamic add/delete via inbox commands):
    - `name` (string, unique 必須): add/delete/run now の identifier
    - `cron` / `to` / `message` (string 必須)
    - `enabled` field は **v2 から撤去** (= delete すれば停止、 add すれば開始、
      add/delete semantics で十分なため `enabled` flag は冗長)

    silent default は config drift 起源になるため、 `name` 欠落は **明示的 migration
    が必要** として exit(1)。

    JSON parse error / file not found / 必須 field 欠落 / name duplicate /
    invalid cron で sys.exit(1)。
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

    # Validate each entry (= issue #65 v3: name + cron + to + message)
    seen_names: set[str] = set()
    for i, entry in enumerate(data):
        if not isinstance(entry, dict):
            print(f"[ERR] schedule[{i}]: must be object", file=sys.stderr)
            sys.exit(1)
        validation_err = _validate_entry(entry, seen_names, where=f"schedule[{i}]")
        if validation_err is not None:
            print(f"[ERR] {validation_err}", file=sys.stderr)
            sys.exit(1)
        seen_names.add(entry["name"])

    return data


def _validate_entry(
    entry: dict[str, Any], seen_names: set[str], where: str = "entry"
) -> str | None:
    """schedule entry を validate、 OK なら None、 NG なら error message string を返す。

    load_schedules + add command 両方から呼ばれる共通 validator。
    `enabled` field は v3 で撤去のため check しない (= 存在すれば silent ignore する形)。
    """
    required_str = ("name", "cron", "to", "message")
    for key in required_str:
        if key not in entry:
            if key == "name":
                return (
                    f"{where}: missing required field 'name'. "
                    f"issue #65 v3 schema requires `name` (string, unique) for "
                    f"each entry. Migration: add `\"name\": \"<unique-id>\"` to each entry."
                )
            return f"{where}: missing required field '{key}'"
        if not isinstance(entry[key], str):
            return f"{where}.{key}: must be string"

    # name uniqueness + non-empty
    name = entry["name"]
    if not name:
        return f"{where}.name: must be non-empty string"
    if name in seen_names:
        return (
            f"{where}.name: duplicate name '{name}' "
            f"(names must be unique for add/delete/run-now dispatch)"
        )

    # cron expression validation
    try:
        croniter(entry["cron"], datetime.now())
    except (ValueError, KeyError) as e:
        return f"{where}.cron: invalid cron expression '{entry['cron']}': {e}"

    return None


def save_schedules(config_path: Path, schedules: list[dict[str, Any]]) -> None:
    """schedules.json を atomic write で更新 (= issue #65 v2 永続化)。

    手順:
    1. config_path.tmp に full content を JSON dump
    2. fsync で OS-level buffer flush
    3. os.replace で atomic rename (= power loss / SIGTERM 時の half-write 防止)

    呼び出し側 (= start/stop handler) は `_schedules_lock` 取得済前提。
    """
    tmp_path = config_path.with_suffix(".json.tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(schedules, f, indent=2, ensure_ascii=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, config_path)


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

    # croniter iterator を schedule ごとに用意 (= main thread 起動時、 main loop でも参照)
    iters: list[Any] = [croniter(s["cron"], datetime.now()) for s in schedules]
    next_times: list[datetime] = [it.get_next(datetime) for it in iters]

    # issue #65: bidirectional 化、 SSE listener を background thread で起動。
    # 自分自身 (= user_id) の handle で register + inbox subscribe + SSE 待ち + command dispatch。
    # daemon=True で main thread 終了に連動して自動 cleanup (= SIGINT 時の挙動 preserve)。
    # config_path + iters + next_times を渡して add/delete の永続化 + memory state 連動を実現
    # (= issue #65 v3 dynamic add/delete via inbox commands)。
    sse_thread = threading.Thread(
        target=sse_listen_loop,
        args=(headers, user_id, schedules, iters, next_times, config_path),
        name="sse-listener",
        daemon=True,
    )
    sse_thread.start()
    print(f"[sse-thread] started (target=inbox://@{user_id})")

    if schedules:
        print(
            "[ready] " + "; ".join(
                f"[{i}] name='{s['name']}' cron='{s['cron']}' to={s['to']} "
                f"next={next_times[i].isoformat()}"
                for i, s in enumerate(schedules)
            )
        )
    else:
        # issue #65: schedules 空でも SSE listener thread が動く (= add で動的追加可能)
        print("[ready] no schedules loaded; SSE inbox listener only (use `add` to register)")

    while True:
        # issue #65 v3: schedules / iters / next_times は SSE thread (= add/delete) で
        # mutate されるため、 main loop は 各 iteration で snapshot を lock 内で取得。
        with _schedules_lock:
            if not schedules:
                # 全 delete 済 (= 空 list)、 cron 不要 / add 待ち
                empty = True
                fire_target_idx: int | None = None
            else:
                empty = False
                # 最も近い next_fire_time の schedule index
                fire_target_idx = min(
                    range(len(next_times)), key=lambda i: next_times[i]
                )

        if empty:
            time.sleep(60)
            continue

        # next_times[fire_target_idx] は snapshot 後に SSE thread で delete されている可能性
        # → fire 直前に再 lock 取得 + 存在 check
        now = datetime.now()
        with _schedules_lock:
            if fire_target_idx is None or fire_target_idx >= len(schedules):
                # snapshot 後に index が無効化 (= delete された)、 ループ最初から再評価
                continue
            next_due = next_times[fire_target_idx]
            wait_s = (next_due - now).total_seconds()

        if wait_s > 0:
            # 60 秒上限で sleep (= session reconnect chance / SIGTERM 応答性 / add/delete 反映)
            time.sleep(min(wait_s, 60))
            continue

        # Fire (= issue #65 v3: lock 内で snapshot、 lock 外で send_dm)
        with _schedules_lock:
            if fire_target_idx >= len(schedules):
                # delete されていた、 abort fire
                continue
            s = schedules[fire_target_idx]
            fire_name = s["name"]
            fire_to = s["to"]
            fire_msg = s["message"]
            # 次の fire time を計算 (= 同 schedule entry の次回)
            next_times[fire_target_idx] = iters[fire_target_idx].get_next(
                datetime
            )

        try:
            send_dm(headers, session_id, fire_to, fire_msg)
            print(
                f"[FIRE] {next_due.isoformat()} name='{fire_name}' → {fire_to}: "
                f"{fire_msg[:50]}{'...' if len(fire_msg) > 50 else ''}"
            )
        except Exception as e:
            print(
                f"[ERR] send_dm failed for name='{fire_name}': {e}",
                file=sys.stderr,
            )
            # Session が切れている可能性、 re-init を試行
            try:
                session_id = init_session(headers)
                print(f"[reinit] session={session_id[:8]}...")
            except Exception as e2:
                print(f"[ERR] session reinit failed: {e2}", file=sys.stderr)
                # 60 秒待って再試行 (= server outage 等の transient state recovery)
                time.sleep(60)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[shutdown] interrupted by user", file=sys.stderr)
        sys.exit(0)
