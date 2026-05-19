#!/usr/bin/env python3
"""
agent-hub cron-based DM scheduler (issue #40 / #65)

schedules.json を読んで cron 式 (cyclic) や run_at (one-shot) に従って
agent-hub 参加者に DM を送る軽量 daemon。 inbox に DM を送ると command として
反応 (= ping / list / list all / add / run_at / run_in / delete / run now)、
cron daemon 再起動なしで動的 schedule 管理可能。 sender 単位 (= `owner` field) で
attribution + restriction。

設定例 (schedules.json):
  [
    {
      "name": "daily-report",
      "cron": "0 13 * * *",
      "to": "@planner",
      "message": "daily report を書いて",
      "owner": "@ope-ultp1635"
    },
    {
      "name": "oneshot-2026-05-19T12",
      "run_at": "2026-05-19T12:00:00+09:00",
      "to": "@planner",
      "message": "進捗確認",
      "owner": "@ope-ultp1635",
      "one_shot": true
    }
  ]

各 entry の field:
- name (str, unique 必須): add/delete/run-now の identifier
- cron (str, optional): 5-fields cron expression、 cyclic schedule
- run_at (str, optional): ISO 8601 datetime、 one-shot schedule
  → cron / run_at は **mutually exclusive** (= 同 entry で両方は invalid)
- to (str, 必須): `@handle` format の送信先
- message (str, 必須): DM 本文
- owner (str, 必須): `@<sender-handle>` format、 add/delete/run-now で restriction
- one_shot (bool, optional, default false): true なら fire 後 auto-delete

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
import re
import signal
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from croniter import croniter

# v4 redesign (= issue #65 sender-based + one-shot): schedules list と
# iters/next_times は main thread (= cron fire) と SSE thread (= add/delete/run_at/run_in)
# 両方から mutate される shared state、 `_schedules_lock` で排他 access 保証。
_schedules_lock = threading.Lock()

# issue #50: SIGTERM (= systemd / supervisor) + SIGINT (= Ctrl-C) graceful shutdown。
# signal handler が set すると main loop が iteration 末尾で break、 SSE thread は
# daemon=True なので main 終了に連動して自動 cleanup。 進行中の HTTP timeout
# (= max 10s) を超えない範囲で graceful shutdown 完了。
_shutdown_event = threading.Event()


def _on_signal(signum: int, _frame: Any) -> None:
    """SIGTERM / SIGINT handler — `_shutdown_event` を set + log。

    issue #50: production daemon (= systemd / supervisor 下) で `systemctl stop`
    すると SIGTERM が送られる。 元実装は `KeyboardInterrupt` (= SIGINT) のみ
    catch、 SIGTERM では abrupt termination → MCP session dangling state +
    進行中の HTTP request 半端打ち切り + shutdown log 欠落。

    本 handler で SIGTERM / SIGINT 両方に対し:
    1. `_shutdown_event` set (= main loop が次回 iteration で graceful exit)
    2. signal 名 log (= 「正常終了かクラッシュか」 を operator に明示)
    3. signal handler 内では time.sleep の wakeup を待たない (= main loop の
       60s sleep cap 内で SIGTERM 検出済の場合次回 iteration で確実に exit)

    SIGTERM の default は process termination だが、 本 handler 登録後は
    Python control flow に渡される。 main loop 内の sleep は signal で
    interrupt されて即時 return する (= Python の `time.sleep` 仕様)。
    """
    name = signal.Signals(signum).name
    print(f"\n[shutdown] received {name}, draining...", file=sys.stderr)
    _shutdown_event.set()


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
    """MCP HTTP request headers (= auth + tenant + content-type)。

    Content-Type に **charset=utf-8** 明示 (= issue #70 Mojibake fix):
    explicit charset で proxy / 中間層 / server 実装が Latin-1 解釈に倒れる risk を
    減らす。 併せて body serialization で `ensure_ascii=False` を使い、 raw UTF-8
    bytes として送出するのが `_encode_json_body()` helper の役割。
    """
    headers: dict[str, str] = {
        "Content-Type": "application/json; charset=utf-8",
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


def _encode_json_body(payload: dict[str, Any]) -> bytes:
    """payload を UTF-8 bytes に encode (= issue #70 Mojibake 防止)。

    `requests.post(..., json=payload, ...)` 直接利用で起きる問題:
    1. 内部 `json.dumps()` が default `ensure_ascii=True` → non-ASCII char が
       `\\uXXXX` escape される (= 通常は正常に decode されるが、 中間層次第で混乱)
    2. requests が `json=` の場合 Content-Type charset を上書きする path あり
    3. 一部 server / proxy が Content-Type charset 未指定で Latin-1 にフォールバック

    本 helper で:
    1. `json.dumps(..., ensure_ascii=False)` で raw Unicode を serialize
    2. `.encode('utf-8')` で explicit UTF-8 bytes 化
    3. caller は `requests.post(..., data=<bytes>, ...)` で bytes 直接送出
    + Content-Type に `charset=utf-8` (= build_headers) で server に UTF-8 明示

    これで scheduler → server の HTTP body は **bytes-level で UTF-8 invariant**、
    中間層の charset 推定 / 自動変換に影響されない。 issue #70 「テストメッセージです」
    等の日本語 Mojibake 根本対策。
    """
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _parse_response_body(resp: requests.Response) -> dict[str, Any]:
    """MCP server response を parse (= application/json と text/event-stream 両対応)。

    agent-hub server (= StreamableHTTP transport) は client の Accept ヘッダーに
    `text/event-stream` を含む場合 **SSE 形式 (`data: <json>\\n\\n`)** で
    response を返す。 plain `resp.json()` を SSE response に対して呼ぶと、
    response body が `data: ...` で始まるため空 JSON parse として
    `JSONDecodeError: Expecting value: line 1 column 1 (char 0)` で fail する。

    @admin Pi5 bug report (= 2026-05-18 23:00 UTC): `notifications/resources/updated`
    push 後の `get_messages` tool call で fetch_inbox が SSE format response を受け、
    `resp.json()` で crash していた件の root cause。

    本 helper は Content-Type で判別:
    - `text/event-stream`: SSE lines を parse、 最初の `data: <json>` 行を JSON decode
    - 他 (= `application/json` 等): plain `resp.json()`

    SSE response のうち、 単一 jsonrpc response (= tools/call の reply) は
    1 つの `data:` line に full JSON が入る前提 (= MCP StreamableHTTP の慣例)。

    **UTF-8 decoding** (= @admin Pi5 second bug report 2026-05-20、 issue #88):
    `requests` lib は Content-Type に charset 指定が無い場合 **ISO-8859-1** を fallback
    として使う。 SSE response の `text/event-stream` は charset を含まないため、
    `resp.text` を使うと日本語 (= multi-byte UTF-8) が ISO-8859-1 として誤 decode され、
    mangled な byte sequence が JSON parser に渡って `Unterminated string` で fail する。
    本 helper では `resp.content.decode("utf-8", errors="replace")` で **explicit UTF-8
    decode** を強制し、 charset 未指定 SSE でも正常 parse する。
    """
    content_type = resp.headers.get("Content-Type", "")
    if "text/event-stream" in content_type:
        # SSE format: 'data: <json>' lines を find。 resp.text ではなく resp.content
        # から explicit UTF-8 decode (= issue #88、 日本語 message の mojibake 回避)。
        body_text = resp.content.decode("utf-8", errors="replace")
        for line in body_text.splitlines():
            if line.startswith("data: "):
                payload = line[6:].strip()
                if payload:
                    return json.loads(payload)
        raise ValueError(
            f"no `data:` line in SSE response (Content-Type={content_type}): "
            f"{body_text[:200]}"
        )
    return resp.json()


def init_session(headers: dict[str, str]) -> str:
    """MCP session を initialize し、 session_id を返す。"""
    resp = requests.post(
        HUB_URL,
        headers=headers,
        data=_encode_json_body({
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "agent-hub-scheduler", "version": "1.0"},
            },
            "id": 0,
        }),
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
        data=_encode_json_body({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        timeout=5,
    )

    return session_id


def send_dm(
    headers: dict[str, str], session_id: str, to: str, message: str
) -> dict[str, Any]:
    """`send_message` tool を呼出。 成功時は response body を返す、 失敗時 raise。

    issue #70 Mojibake fix: `_encode_json_body()` で UTF-8 bytes 化、
    `Content-Type: application/json; charset=utf-8` (= build_headers) で server に
    明示。 message が日本語含む場合の root encoding 整合性を保証。
    """
    resp = requests.post(
        HUB_URL,
        headers={**headers, "mcp-session-id": session_id},
        data=_encode_json_body({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "send_message",
                "arguments": {"to": to, "message": message},
            },
            "id": int(time.time() * 1000),
        }),
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"send_message failed: HTTP {resp.status_code}: {resp.text[:200]}")
    return _parse_response_body(resp)


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
        data=_encode_json_body({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "register",
                "arguments": {"name": name, "display_name": display_name},
            },
            "id": int(time.time() * 1000),
        }),
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
        data=_encode_json_body({
            "jsonrpc": "2.0",
            "method": "resources/subscribe",
            "params": {"uri": f"inbox://@{name}"},
            "id": int(time.time() * 1000),
        }),
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
        data=_encode_json_body({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": "get_messages", "arguments": {}},
            "id": int(time.time() * 1000),
        }),
        timeout=10,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"get_messages failed: HTTP {resp.status_code}: {resp.text[:200]}"
        )
    body = _parse_response_body(resp)
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
        data=_encode_json_body({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "mark_as_read",
                "arguments": {"message_id": message_id},
            },
            "id": int(time.time() * 1000),
        }),
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


def _check_owner(entry: dict[str, Any], sender: str) -> bool:
    """sender が entry の owner と一致するか check。 owner-based 操作制限用。"""
    return entry.get("owner") == sender


def _format_schedule_entry(
    s: dict[str, Any], now: datetime, include_owner: bool = False
) -> str:
    """1 entry を 1 行の表示文字列に format する (= list / list all 共通)。

    issue #85 で `list all` (= cross-owner view) を追加するに当たり、
    既存 `list` (= owner-filtered) と format を共有するため抽出。

    - cyclic (cron 有) → `cron='<expr>'`
    - one-shot (cron 無 + run_at 有) → `run_at='<ISO>' [remaining time]`
    - one-shot で fire 後 auto-delete 予定なら `[ONESHOT]` marker
    - `include_owner=True` で `owner=@<handle>` field を追加 (= list all 用)
    """
    msg = s["message"]
    msg_preview = msg[:50] + ("..." if len(msg) > 50 else "")
    if s.get("cron"):
        mode = f"cron='{s['cron']}'"
    else:
        # one-shot
        run_at_dt = _parse_iso8601(s.get("run_at", "")) or now
        remaining = run_at_dt - now
        mode = f"run_at='{s.get('run_at', '?')}' [{_format_remaining(remaining)}]"
    oneshot_marker = " [ONESHOT]" if s.get("one_shot") else ""
    owner_field = f" owner={s.get('owner', '?')}" if include_owner else ""
    return (
        f"  {s['name']:30s} {mode}{oneshot_marker} "
        f"to={s['to']}{owner_field} msg='{msg_preview}'"
    )


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

    issue #65 v4 redesign (= operator 全 use case 統合):
    - sender-based ownership (= owner field、 自身の entry のみ操作可)
    - one-shot timer (= run_at / run_in、 fire 後 auto-delete)
    - cyclic cron (= add)

    対応 command:
    - `ping`                                       : 生存確認
    - `list`                                       : sender's entries 一覧 (one-shot 残り時間付き)
    - `list all`                                   : 全 entries 一覧 (= cross-owner view、 issue #85)
    - `add <name> <cron-5> <to> <message>`         : cyclic entry 追加、 owner=sender
    - `run_at <ISO8601> <to> <message>`            : one-shot entry 追加 (= 指定日時)、 fire 後 auto-delete
    - `run_in <duration> <to> <message>`           : one-shot entry 追加 (= N時間後)、 fire 後 auto-delete
    - `delete <name>`                              : entry 削除 (= owner check)
    - `run now <name>`                             : one-shot 即時 fire (= owner check、 entry は変更なし)
    - 未知 command                                 : usage hint
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
                f"pong (scheduler alive, {count} schedules total)",
            )
            print(f"[CMD] ping ← {sender}")

        elif cmd_first == "list":
            # issue #85 v4: `list all` sub-command (= cross-owner view) を追加。
            # 既存 `list` (= sender's own entries only) と並ぶ別 path として処理。
            sub_cmd = parts[1].lower() if len(parts) > 1 else ""
            if sub_cmd == "all":
                with _schedules_lock:
                    entries = list(schedules)
                    if not entries:
                        listing_text = (
                            "list all: no schedules in the system "
                            "(use `add` or `run_at` / `run_in` to create one)"
                        )
                    else:
                        now = datetime.now().astimezone()
                        lines = [
                            _format_schedule_entry(s, now, include_owner=True)
                            for s in entries
                        ]
                        listing_text = (
                            f"list all ({len(entries)} entries):\n"
                            + "\n".join(lines)
                        )
                send_dm(headers, session_id, sender, listing_text)
                print(f"[CMD] list all ← {sender} ({len(entries)} entries)")
            else:
                # default: sender's own entries (= owner-filtered、 既存 behavior)
                with _schedules_lock:
                    own = [s for s in schedules if _check_owner(s, sender)]
                    if not own:
                        listing_text = (
                            f"list: no schedules owned by {sender} "
                            f"(use `add` or `run_at` / `run_in` to create one、 "
                            f"or `list all` to see all entries across owners)"
                        )
                    else:
                        now = datetime.now().astimezone()
                        lines = [
                            _format_schedule_entry(s, now, include_owner=False)
                            for s in own
                        ]
                        listing_text = (
                            f"list (owner={sender}, {len(own)} entries):\n"
                            + "\n".join(lines)
                        )
                send_dm(headers, session_id, sender, listing_text)
                print(f"[CMD] list ← {sender} ({len(own) if own else 0} entries)")

        elif cmd_first == "add":
            parsed = _parse_add_args(body_stripped, owner=sender)
            if isinstance(parsed, str):
                send_dm(headers, session_id, sender, parsed)
                return
            _do_add_entry(
                headers, session_id, sender, parsed,
                schedules, iters, next_times, config_path,
            )

        elif cmd_first == "run_at":
            parsed = _parse_run_at_args(body_stripped, owner=sender)
            if isinstance(parsed, str):
                send_dm(headers, session_id, sender, parsed)
                return
            _do_add_entry(
                headers, session_id, sender, parsed,
                schedules, iters, next_times, config_path,
            )

        elif cmd_first == "run_in":
            parsed = _parse_run_in_args(body_stripped, owner=sender)
            if isinstance(parsed, str):
                send_dm(headers, session_id, sender, parsed)
                return
            _do_add_entry(
                headers, session_id, sender, parsed,
                schedules, iters, next_times, config_path,
            )

        elif cmd_first == "delete":
            if len(parts) < 2:
                send_dm(
                    headers,
                    session_id,
                    sender,
                    "[ERR] usage: `delete <name>` (= owner-restricted、 自身の entry のみ削除可)",
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
                        f"[ERR] no schedule named '{name}'. use `list` to see your entries.",
                    )
                    return
                if not _check_owner(s, sender):
                    send_dm(
                        headers,
                        session_id,
                        sender,
                        f"[ERR] '{name}' is owned by {s.get('owner', '?')}, "
                        f"you ({sender}) cannot delete it. ownership is enforced.",
                    )
                    return
                snap_entry = schedules[idx]
                snap_iter = iters[idx]
                snap_next = next_times[idx]
                del schedules[idx]
                del iters[idx]
                del next_times[idx]
                try:
                    save_schedules(config_path, schedules)
                except Exception as e:
                    schedules.insert(idx, snap_entry)
                    iters.insert(idx, snap_iter)
                    next_times.insert(idx, snap_next)
                    send_dm(
                        headers,
                        session_id,
                        sender,
                        f"[ERR] delete '{name}': persist failed ({e}), state unchanged",
                    )
                    return
            send_dm(
                headers,
                session_id,
                sender,
                f"[OK] deleted '{name}' (removed from schedules.json)",
            )
            print(f"[CMD] delete name='{name}' ← {sender}")

        elif cmd_first == "run":
            if len(parts) < 3 or parts[1].lower() != "now":
                send_dm(
                    headers,
                    session_id,
                    sender,
                    "[ERR] usage: `run now <name>` (= owner-restricted、 entry は変更なし)",
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
                        f"[ERR] no schedule named '{name}'. use `list` to see your entries.",
                    )
                    return
                if not _check_owner(s, sender):
                    send_dm(
                        headers,
                        session_id,
                        sender,
                        f"[ERR] '{name}' is owned by {s.get('owner', '?')}, "
                        f"you ({sender}) cannot run-now it.",
                    )
                    return
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
                    f"[RUN-NOW] name='{name}' ← {sender}: {fire_to}: "
                    f"{fire_msg[:50]}{'...' if len(fire_msg) > 50 else ''}"
                )
            except Exception as e:
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"[ERR] run-now '{name}' failed: {e}",
                )

        else:
            send_dm(
                headers,
                session_id,
                sender,
                f"[unknown command] '{body_stripped[:50]}'. "
                f"usage: `ping` / `list` / `list all` / `add <name> <cron-5> <to> <msg>` / "
                f"`run_at <ISO8601> <to> <msg>` / `run_in <duration> <to> <msg>` / "
                f"`delete <name>` / `run now <name>`",
            )
            print(f"[CMD] unknown ← {sender}: {body_stripped[:50]}")

    except Exception as e:
        print(
            f"[ERR] handle_inbox_command failed (sender={sender}): {e}",
            file=sys.stderr,
        )


# ============================================================
# Command argument parsers (= v4: add / run_at / run_in)
# ============================================================


def _parse_add_args(
    body_stripped: str, owner: str
) -> dict[str, Any] | str:
    """`add <name> <cron-5-fields> <to> <message>` を positional parse + entry dict.

    成功時 dict {name, cron, to, message, owner} を返す。 失敗時 error str。
    """
    rest = body_stripped[len("add"):].strip()
    if not rest:
        return (
            "[ERR] usage: `add <name> <cron-5> <to> <message>` "
            "(cron = 5 space-separated fields、 e.g. `0 13 * * *`)"
        )
    parts = rest.split()
    if len(parts) < 8:
        return (
            f"[ERR] not enough args (got {len(parts)}, need >=8). "
            f"usage: `add <name> <cron-5-fields> <to> <message>` "
            f"e.g. `add daily 0 13 * * * @planner daily report`"
        )
    name = parts[0]
    cron_expr = " ".join(parts[1:6])
    to = parts[6]
    message = " ".join(parts[7:])
    return {
        "name": name,
        "cron": cron_expr,
        "to": to,
        "message": message,
        "owner": owner,
    }


def _parse_run_at_args(
    body_stripped: str, owner: str
) -> dict[str, Any] | str:
    """`run_at <ISO8601> <to> <message>` を parse + one-shot entry dict.

    name は auto-generate (= `oneshot-<sanitized-run_at>` form)。
    """
    rest = body_stripped[len("run_at"):].strip()
    if not rest:
        return (
            "[ERR] usage: `run_at <ISO8601-datetime> <to> <message>` "
            "(e.g. `run_at 2026-05-19T12:00:00+09:00 @planner 進捗確認`)"
        )
    parts = rest.split(maxsplit=2)
    if len(parts) < 3:
        return (
            f"[ERR] not enough args (got {len(parts)}, need >=3). "
            f"usage: `run_at <ISO8601> <to> <message>`"
        )
    run_at_str, to, message = parts[0], parts[1], parts[2]
    dt = _parse_iso8601(run_at_str)
    if dt is None:
        return (
            f"[ERR] invalid ISO 8601 datetime '{run_at_str}' "
            f"(example: '2026-05-19T12:00:00+09:00')"
        )
    # past datetime check (= 過去日時を指定された場合 warn)
    now = datetime.now().astimezone()
    if dt <= now:
        return (
            f"[ERR] run_at '{run_at_str}' is in the past or now "
            f"(now={now.isoformat()}). use future datetime."
        )
    # name auto-generate (= sortable + readable)
    name = f"oneshot-{dt.strftime('%Y%m%dT%H%M%S')}"
    return {
        "name": name,
        "run_at": dt.isoformat(),
        "to": to,
        "message": message,
        "owner": owner,
        "one_shot": True,
    }


def _parse_run_in_args(
    body_stripped: str, owner: str
) -> dict[str, Any] | str:
    """`run_in <duration> <to> <message>` を parse + one-shot entry dict.

    duration: `2h` (2 hours) / `30m` (30 mins) / `1d` (1 day) / `2h30m` (compound)。
    internal で run_at に変換 (= now + duration)。
    """
    rest = body_stripped[len("run_in"):].strip()
    if not rest:
        return (
            "[ERR] usage: `run_in <duration> <to> <message>` "
            "(duration = `2h` / `30m` / `1d` / `2h30m` 等、 e.g. `run_in 2h @planner 進捗確認`)"
        )
    parts = rest.split(maxsplit=2)
    if len(parts) < 3:
        return (
            f"[ERR] not enough args (got {len(parts)}, need >=3). "
            f"usage: `run_in <duration> <to> <message>`"
        )
    dur_str, to, message = parts[0], parts[1], parts[2]
    td = _parse_duration(dur_str)
    if td is None or td.total_seconds() <= 0:
        return (
            f"[ERR] invalid duration '{dur_str}' "
            f"(supported: `2h` / `30m` / `1d` / `2h30m` 等、 positive only)"
        )
    now = datetime.now().astimezone()
    run_at_dt = now + td
    name = f"oneshot-{run_at_dt.strftime('%Y%m%dT%H%M%S')}"
    return {
        "name": name,
        "run_at": run_at_dt.isoformat(),
        "to": to,
        "message": message,
        "owner": owner,
        "one_shot": True,
    }


def _do_add_entry(
    headers: dict[str, str],
    session_id: str,
    sender: str,
    new_entry: dict[str, Any],
    schedules: list[dict[str, Any]],
    iters: list[Any],
    next_times: list[datetime],
    config_path: Path,
) -> None:
    """add / run_at / run_in 共通の entry 追加 + persist 処理。

    name uniqueness 自動 resolve (= 衝突時 suffix append) → validate → atomic update。
    """
    with _schedules_lock:
        existing_names = {s["name"] for s in schedules}
        # name uniqueness 自動 resolve (= oneshot で同 timestamp の場合等)
        orig_name = new_entry["name"]
        counter = 1
        while new_entry["name"] in existing_names:
            new_entry["name"] = f"{orig_name}-{counter}"
            counter += 1
            if counter > 100:
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"[ERR] cannot resolve unique name for '{orig_name}' after 100 tries",
                )
                return
        err = _validate_entry(new_entry, existing_names, where="new entry")
        if err is not None:
            send_dm(headers, session_id, sender, f"[ERR] {err}")
            return
        # apply: schedules + iters + next_times に append
        schedules.append(new_entry)
        now = datetime.now().astimezone()
        if new_entry.get("cron"):
            new_iter = croniter(new_entry["cron"], now)
            new_next = new_iter.get_next(datetime).astimezone()
            iters.append(new_iter)
        else:
            new_iter = None
            new_next = _parse_iso8601(new_entry["run_at"]) or now
            iters.append(None)  # one-shot は iter なし
        next_times.append(new_next)
        try:
            save_schedules(config_path, schedules)
        except Exception as e:
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
    mode_label = "cyclic" if new_entry.get("cron") else "one-shot"
    send_dm(
        headers,
        session_id,
        sender,
        f"[OK] added '{new_entry['name']}' ({mode_label}, "
        f"next fire={new_next.isoformat()}, owner={sender}, persisted)",
    )
    print(
        f"[CMD] add name='{new_entry['name']}' mode={mode_label} "
        f"next={new_next.isoformat()} ← {sender}"
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


# ============================================================
# Parsers (= v4: ISO 8601 datetime / duration / remaining time format)
# ============================================================


def _parse_iso8601(s: str) -> datetime | None:
    """ISO 8601 datetime string を datetime に parse。 失敗時 None。

    Python 3.11+ の `datetime.fromisoformat` は full ISO 8601 を support。
    timezone-aware datetime を返す (= naive の場合は local tz を assume)。
    """
    try:
        dt = datetime.fromisoformat(s)
        # naive → local tz aware に変換
        if dt.tzinfo is None:
            dt = dt.astimezone()
        return dt
    except (ValueError, TypeError):
        return None


_DURATION_RE = re.compile(r"(\d+)([dhms])")


def _parse_duration(s: str) -> timedelta | None:
    """duration string `<N><unit>...` を timedelta に parse。 unit: d/h/m/s。

    例: "2h" → 2 hours / "30m" → 30 mins / "2h30m" → 2 hours + 30 mins
    failure → None。
    """
    if not s:
        return None
    matches = _DURATION_RE.findall(s)
    if not matches:
        return None
    # 全体が match で覆われているか確認 (= "2h foo" のような extra noise reject)
    consumed = sum(len(m[0]) + 1 for m in matches)
    if consumed != len(s):
        return None
    total = timedelta()
    for n_str, unit in matches:
        n = int(n_str)
        if unit == "d":
            total += timedelta(days=n)
        elif unit == "h":
            total += timedelta(hours=n)
        elif unit == "m":
            total += timedelta(minutes=n)
        elif unit == "s":
            total += timedelta(seconds=n)
    return total


def _format_remaining(td: timedelta) -> str:
    """timedelta を `Nh Nm left` / `Nd Nh left` 形式で format (= list 表示用)。"""
    total_s = int(td.total_seconds())
    if total_s < 0:
        return "OVERDUE"
    if total_s < 60:
        return f"{total_s}s left"
    if total_s < 3600:
        return f"{total_s // 60}m left"
    if total_s < 86400:
        h = total_s // 3600
        m = (total_s % 3600) // 60
        return f"{h}h {m}m left"
    d = total_s // 86400
    h = (total_s % 86400) // 3600
    return f"{d}d {h}h left"


def _next_fire_time(entry: dict[str, Any], now: datetime) -> datetime:
    """entry の次回 fire time を計算 (= cyclic は croniter / one-shot は run_at 固定)。

    cron / run_at の判定 + 対応する次回 datetime を返す。 timezone-aware datetime を
    返すので比較時は同 type で comparison。
    """
    if entry.get("cron"):
        # cyclic: croniter で次回 fire time
        return croniter(entry["cron"], now).get_next(datetime)
    elif entry.get("run_at"):
        # one-shot: run_at の datetime をそのまま (= 既 fired なら past datetime のまま、
        # main loop でその case を fire + auto-delete で処理)
        dt = _parse_iso8601(entry["run_at"])
        if dt is None:
            raise ValueError(f"invalid run_at in entry: {entry.get('name', '?')}")
        return dt
    else:
        raise ValueError(
            f"entry has neither cron nor run_at: {entry.get('name', '?')}"
        )


# ============================================================
# Schedule loader + validator (= v4 schema: name + cron|run_at + owner + one_shot)
# ============================================================


def _find_by_name(
    schedules: list[dict[str, Any]], name: str
) -> tuple[int, dict[str, Any]] | tuple[None, None]:
    """schedules list から name 一致の (idx, entry) を返す。 見つからなければ (None, None)。"""
    for i, s in enumerate(schedules):
        if s.get("name") == name:
            return i, s
    return None, None


def _validate_entry(
    entry: dict[str, Any], seen_names: set[str], where: str = "entry"
) -> str | None:
    """v4 schema entry を validate、 OK なら None、 NG なら error message string。

    必須: name (str unique) / to (str @prefix) / message (str) / owner (str @prefix)
    択一: cron (str 5-fields) OR run_at (str ISO 8601) — 必ず一方のみ
    optional: one_shot (bool、 default false)

    呼び出し元 (= load_schedules / add command / run_at command 等) で共通利用。
    """
    # 必須 string fields
    for key in ("name", "to", "message", "owner"):
        if key not in entry:
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

    # to / owner format (= @prefix 必須)
    if not entry["to"].startswith("@"):
        return f"{where}.to: must start with `@` (got '{entry['to']}')"
    if not entry["owner"].startswith("@"):
        return f"{where}.owner: must start with `@` (got '{entry['owner']}')"

    # cron / run_at 択一 (= v4: mutually exclusive)
    has_cron = bool(entry.get("cron"))
    has_run_at = bool(entry.get("run_at"))
    if has_cron and has_run_at:
        return (
            f"{where}: `cron` and `run_at` are mutually exclusive "
            f"(got both, pick one)"
        )
    if not has_cron and not has_run_at:
        return f"{where}: must have either `cron` (cyclic) or `run_at` (one-shot)"

    if has_cron:
        if not isinstance(entry["cron"], str):
            return f"{where}.cron: must be string"
        try:
            croniter(entry["cron"], datetime.now())
        except (ValueError, KeyError) as e:
            return f"{where}.cron: invalid cron expression '{entry['cron']}': {e}"

    if has_run_at:
        if not isinstance(entry["run_at"], str):
            return f"{where}.run_at: must be string"
        dt = _parse_iso8601(entry["run_at"])
        if dt is None:
            return (
                f"{where}.run_at: invalid ISO 8601 datetime '{entry['run_at']}' "
                f"(example: '2026-05-19T12:00:00+09:00')"
            )

    # one_shot bool check
    if "one_shot" in entry:
        if not isinstance(entry["one_shot"], bool):
            return f"{where}.one_shot: must be boolean"

    return None


def load_schedules(config_path: Path) -> list[dict[str, Any]]:
    """schedules.json を読み込んで validation 済 list を返す。

    issue #65 v4 schema:
    - name (str, unique 必須) + to + message + owner
    - cron OR run_at (= 択一)
    - one_shot (= optional bool)

    JSON parse error / file not found / 必須 field 欠落 / name duplicate /
    invalid cron / invalid run_at / mutually-exclusive violation で sys.exit(1)。
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

    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        print(
            f"[ERR] {config_path}: top-level must be JSON array or object",
            file=sys.stderr,
        )
        sys.exit(1)

    seen_names: set[str] = set()
    for i, entry in enumerate(data):
        if not isinstance(entry, dict):
            print(f"[ERR] schedule[{i}]: must be object", file=sys.stderr)
            sys.exit(1)
        err = _validate_entry(entry, seen_names, where=f"schedule[{i}]")
        if err is not None:
            print(f"[ERR] {err}", file=sys.stderr)
            print(
                f"[HINT] v4 schema requires: name + (cron OR run_at) + to + message + owner. "
                f"Migration from v1 (= no name/owner): add `name` and `owner` to each entry.",
                file=sys.stderr,
            )
            sys.exit(1)
        seen_names.add(entry["name"])

    return data


def save_schedules(
    config_path: Path, schedules: list[dict[str, Any]]
) -> None:
    """schedules.json を atomic write で更新 (= v4 永続化)。

    手順: temp file 書き出し → fsync → os.replace (= power loss / SIGTERM 時の
    half-write 防止)。 呼び出し側 (= add/delete/run_at/run_in handler) は
    `_schedules_lock` 取得済前提。
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

    # croniter iterator + next_times を schedule ごとに用意 (= v4: cyclic / one-shot 切り分け)
    # iters[i] は cron entry なら croniter、 one-shot entry なら None。
    iters: list[Any] = []
    next_times: list[datetime] = []
    now_init = datetime.now().astimezone()
    for s in schedules:
        if s.get("cron"):
            it = croniter(s["cron"], now_init)
            iters.append(it)
            next_times.append(it.get_next(datetime).astimezone())
        else:
            iters.append(None)
            dt = _parse_iso8601(s["run_at"]) or now_init
            next_times.append(dt)

    # issue #65 v4: bidirectional 化 + sender-based ownership + one-shot timer。
    # SSE listener を background thread で起動、 schedules / iters / next_times を共有
    # (= _schedules_lock で排他)、 config_path で add/delete/run_at/run_in の永続化先共有。
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
                f"[{i}] name='{s['name']}' "
                f"{('cron=' + repr(s['cron'])) if s.get('cron') else ('run_at=' + repr(s.get('run_at')))} "
                f"to={s['to']} next={next_times[i].isoformat()}"
                for i, s in enumerate(schedules)
            )
        )
    else:
        print("[ready] no schedules loaded; SSE inbox listener only (use `add` / `run_at` / `run_in` to register)")

    # issue #50: SIGTERM / SIGINT graceful shutdown handler を登録 (= systemd / supervisor
    # 下での `systemctl stop` 等を script の Python control flow に渡す)。
    # SIGTERM = systemd stop / docker stop / pkill 等の default termination signal、
    # SIGINT = Ctrl-C (= 元 KeyboardInterrupt path も統合)。 両 signal を同 handler で
    # `_shutdown_event` set し、 main loop 末尾で graceful exit する。
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    while not _shutdown_event.is_set():
        # v4: schedules / iters / next_times は SSE thread で mutate されるので
        # lock 内で snapshot を取得。
        with _schedules_lock:
            if not schedules:
                empty = True
                fire_target_idx: int | None = None
            else:
                empty = False
                fire_target_idx = min(
                    range(len(next_times)), key=lambda i: next_times[i]
                )

        if empty:
            time.sleep(60)
            continue

        # snapshot 後に delete されている可能性 → fire 直前に再 lock + 存在 check
        now = datetime.now().astimezone()
        with _schedules_lock:
            if fire_target_idx is None or fire_target_idx >= len(schedules):
                continue
            next_due = next_times[fire_target_idx]
            # next_due が naive datetime の場合 aware に変換 (= comparison 一貫性)
            if next_due.tzinfo is None:
                next_due = next_due.astimezone()
            wait_s = (next_due - now).total_seconds()

        if wait_s > 0:
            time.sleep(min(wait_s, 60))
            continue

        # Fire (= lock 内で snapshot、 lock 外で send_dm、 fire 後 lock 内で next_times advance or 削除)
        is_one_shot = False
        with _schedules_lock:
            if fire_target_idx >= len(schedules):
                continue
            s = schedules[fire_target_idx]
            fire_name = s["name"]
            fire_to = s["to"]
            fire_msg = s["message"]
            is_one_shot = bool(s.get("one_shot")) or (
                bool(s.get("run_at")) and not s.get("cron")
            )

        send_ok = False
        try:
            send_dm(headers, session_id, fire_to, fire_msg)
            send_ok = True
            print(
                f"[FIRE] {next_due.isoformat()} name='{fire_name}' "
                f"({'one-shot' if is_one_shot else 'cyclic'}) → {fire_to}: "
                f"{fire_msg[:50]}{'...' if len(fire_msg) > 50 else ''}"
            )
        except Exception as e:
            print(
                f"[ERR] send_dm failed for name='{fire_name}': {e}",
                file=sys.stderr,
            )
            try:
                session_id = init_session(headers)
                print(f"[reinit] session={session_id[:8]}...")
            except Exception as e2:
                print(f"[ERR] session reinit failed: {e2}", file=sys.stderr)
                time.sleep(60)

        # state update (= one-shot 削除 or cyclic next_time advance)
        with _schedules_lock:
            # delete されていた / index ずれの場合は skip
            if fire_target_idx >= len(schedules):
                continue
            # 念のため fire_name と一致確認 (= snapshot 中に delete + insert で別 entry に置換 case)
            if schedules[fire_target_idx].get("name") != fire_name:
                continue
            if is_one_shot and send_ok:
                # one-shot fire 成功 → auto-delete + persist
                del schedules[fire_target_idx]
                del iters[fire_target_idx]
                del next_times[fire_target_idx]
                try:
                    save_schedules(config_path, schedules)
                    print(f"[ONESHOT-DELETE] name='{fire_name}' (auto-removed after fire)")
                except Exception as e:
                    print(
                        f"[ERR] save_schedules after one-shot fire failed: {e}",
                        file=sys.stderr,
                    )
            elif iters[fire_target_idx] is not None:
                # cyclic → next fire time advance
                next_times[fire_target_idx] = (
                    iters[fire_target_idx].get_next(datetime).astimezone()
                )


if __name__ == "__main__":
    # issue #50: signal handler (= main() 内で signal.signal() で登録) が SIGTERM/SIGINT
    # を catch して `_shutdown_event` を set、 main loop が graceful exit する path に
    # 統合済。 旧 `KeyboardInterrupt` catch は signal handler 登録**前**の早期
    # interrupt (= argparse / config load 中の Ctrl-C 等) に対する fallback として
    # 残置。 通常の SIGINT は signal handler 経由で graceful exit する。
    try:
        main()
        print("[shutdown] exiting cleanly", file=sys.stderr)
        sys.exit(0)
    except KeyboardInterrupt:
        # signal handler 登録前の早期 Ctrl-C fallback
        print("\n[shutdown] interrupted by user (pre-handler)", file=sys.stderr)
        sys.exit(0)
