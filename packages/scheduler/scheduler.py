#!/usr/bin/env python3
"""
agent-hub cron-based DM scheduler (issue #40 / #65 / #92)

schedules.json を読んで cron 式 (cyclic) や run_at (one-shot) に従って
agent-hub 参加者に DM を送る軽量 daemon。 inbox に DM を送ると command として
反応 (= /ping / /list / /list all / /add / /run_at / /run_in / /delete / /run / /help)、
cron daemon 再起動なしで動的 schedule 管理可能。 sender 単位 (= `owner` field) で
attribution + restriction。

v2.0 (= issue #92 `/` prefix migration、 breaking change):
- 全 command が `/` prefix を要求 (= 旧 bare `ping` / `list` 等は **削除**、 v1.x 互換性なし)
- `run now <name>` は `/run <name>` に flatten (= single-word command)
- 未知 `/<cmd>` には `/unknown <cmd>` で明示返答 (= `docs/command-message-convention.md` §3)
- `/` で始まらない message は **silently ignore** (= scheduler は command-only peer、 LLM bypass)
- 新 `/help` command (= command 一覧 self-document)

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
- caused_by (str, optional): fire 時の send_message に渡す caused_by (= issue #221)
  /run_in / /run_at で entry 追加時に依頼メッセージ ID を自動設定。causal chain 追跡用。

環境変数:
  AGENT_HUB_URL      MCP endpoint (default: http://localhost:3000/mcp)
  GITHUB_PAT         GitHub Personal Access Token (pat mode、 推奨)
  AGENT_HUB_PARTICIPANT  handle 名 (pat mode で handle override、旧名 AGENT_HUB_USER はフォールバック)
  AGENT_HUB_TENANT   tenant 識別子 (CE 接続時、 未設定なら default tenant)

依存:
  pip install -r requirements.txt
"""

from __future__ import annotations

import json
import os
import queue
import re
import signal
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
import urllib3
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

# issue #368: cron fire 用の session を SSE thread の session に一本化する。
# 旧実装は main thread が専用の session を `init_session()` で作り、 GET /mcp を
# 張らない **POST-only session** として保持していた。 POST-only session は
# server→client の ping request を受け取る standalone SSE stream を持たないため
# ping loop を `enforce` にすると 30-90s で evict され、 その後の cron fire は
# HTTP 404 で落ちる (= 実測: issue #368 コメント 2026-09-19T21:16Z)。 落ちるのは
# 1 回きりのリマインダで、 エラーも出ず誰も気付かない。
#
# 本スロットは SSE thread が `init_session()` + `subscribe_inbox()` に成功した
# 区間だけ sid を publish し、 stream 終了 / 例外時に invalidate する
# (= 「GET stream が生きている session だけを共有する」 が不変条件)。 main thread
# は fire 時にこれを読む。 scheduler の session は thread 固有オブジェクトではなく
# POST ヘッダに載せる `mcp-session-id` 文字列でしかないため、 共有はこのスロット
# だけで成立する (= transport を跨いだ共有ではない)。
_session_cond = threading.Condition()
_shared_session_id: str | None = None

# fire 時に共有 session の publish を待つ上限 (= SSE thread の reconnect は 3-5s
# 間隔なので、 その 1-2 周期分)。 超えた場合は ephemeral session に fallback する。
_SESSION_WAIT_TIMEOUT_S = 15.0

# 待機中に `_shutdown_event` を見る間隔。 signal handler から Condition を
# notify すると main thread が lock を持っている瞬間に deadlock しうるため、
# handler 側からは起こさず待つ側が短い周期で shutdown を確認する。
_SESSION_WAIT_POLL_S = 0.5


def publish_session(session_id: str) -> None:
    """SSE thread が確立した session を main thread に公開する (= issue #368)。"""
    global _shared_session_id
    with _session_cond:
        _shared_session_id = session_id
        _session_cond.notify_all()


def invalidate_session(session_id: str | None = None) -> None:
    """公開中の session を取り下げる (= issue #368)。

    `session_id` を渡した場合は **それが現在公開中の session のときだけ** 取り下げる
    (= 古い connection の後始末が、 別の sid を消さないための防御)。
    """
    global _shared_session_id
    with _session_cond:
        if session_id is not None and _shared_session_id != session_id:
            return
        _shared_session_id = None


def current_session_id() -> str | None:
    """公開中の session を返す (= 未公開なら None)。"""
    with _session_cond:
        return _shared_session_id


def wait_for_session(timeout: float) -> str | None:
    """共有 session が公開されるまで最大 `timeout` 秒待ち、 その sid を返す。

    期限切れ、 または `_shutdown_event` が set された場合は None を返す。
    slot の確認と待機を同じ Condition の下で行うので、 「起こされた直後に
    slot が None だった」 ときも残り時間を使って待ち続ける (= PR #410 review M4)。
    """
    deadline = time.monotonic() + timeout
    with _session_cond:
        while _shared_session_id is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or _shutdown_event.is_set():
                return None
            _session_cond.wait(min(remaining, _SESSION_WAIT_POLL_S))
        return _shared_session_id


def acquire_session(
    headers: dict[str, str], timeout: float | None = None
) -> tuple[str, bool]:
    """fire 用の session を取得する。 戻り値は `(session_id, is_ephemeral)`。

    SSE thread の session が公開されていればそれを使う (= is_ephemeral False)。
    `timeout` 秒 (= 省略時は `_SESSION_WAIT_TIMEOUT_S`) 待っても公開されない場合のみ、
    **その 1 回の送信限りの** session を `init_session()` で作る (= is_ephemeral True)。
    ephemeral session は呼出側が送信後に `close_session()` で閉じる。

    ephemeral に倒すのは「SSE 側が落ちている瞬間の fire を捨てない」ため。 作成
    直後の session は ping loop の 1 周期が回る前に送信できることを実測済み
    (= issue #368 コメント 2026-09-19T21:16Z の測定 #1)。 長命に保持はしない。
    """
    if timeout is None:
        timeout = _SESSION_WAIT_TIMEOUT_S
    sid = wait_for_session(timeout)
    if sid:
        return sid, False
    print(
        "[WARN] shared SSE session unavailable "
        f"({timeout:.0f}s wait), using ephemeral session for this fire",
        file=sys.stderr,
    )
    return init_session(headers), True


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
PAT = os.environ.get("AGENT_HUB_GITHUB_PAT", "")
HANDLE_OVERRIDE = os.environ.get("AGENT_HUB_PARTICIPANT") or os.environ.get("AGENT_HUB_USER", "")
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
            headers["X-Participant-Id"] = HANDLE_OVERRIDE
    else:
        print(
            "[ERR] Set AGENT_HUB_GITHUB_PAT (pat mode)",
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
                "clientInfo": {"name": "agent-hub-scheduler", "version": "2.0"},
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
    headers: dict[str, str],
    session_id: str,
    to: str,
    message: str,
    caused_by: str | None = None,
) -> dict[str, Any]:
    """`send_message` tool を呼出。 成功時は response body を返す、 失敗時 raise。

    issue #70 Mojibake fix: `_encode_json_body()` で UTF-8 bytes 化、
    `Content-Type: application/json; charset=utf-8` (= build_headers) で server に
    明示。 message が日本語含む場合の root encoding 整合性を保証。

    issue #221: `caused_by` を指定すると send_message tool arguments に含める。
    scheduler 経由の fire で causal chain が保たれる (= /run_in / /run_at / /run)。
    None の場合は arguments に含めない (= 既存 behavior と互換)。
    """
    arguments: dict[str, Any] = {"to": to, "message": message}
    if caused_by is not None:
        arguments["caused_by"] = caused_by
    resp = requests.post(
        HUB_URL,
        headers={**headers, "mcp-session-id": session_id},
        data=_encode_json_body({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "send_message",
                "arguments": arguments,
            },
            "id": int(time.time() * 1000),
        }),
        timeout=10,
    )
    if resp.status_code != 200:
        raise SendDmHttpError(
            resp.status_code,
            f"send_message failed: HTTP {resp.status_code}: {resp.text[:200]}",
        )
    return _parse_response_body(resp)


class SendDmHttpError(RuntimeError):
    """`send_dm` が HTTP 200 以外を受けた (= 再送可否の判定に status を使う)。"""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


# server が tools/call を処理する前に弾く status (= session 不明 / header 不備)。
# これらは配送されていないことが確実なので、 fresh session で再送してよい。
_UNDELIVERED_HTTP_STATUSES = frozenset({400, 404})


def is_undelivered_send_failure(exc: BaseException) -> bool:
    """`send_dm` の失敗が **未配送確実** なら True (= PR #410 review M1)。

    再送してよいのは server に request が届いていない / 届いても tools/call の
    前で弾かれた場合だけ。 `ReadTimeout`、 接続確立後の切断、 5xx、 response の
    parse 失敗は server 側で配送済みの可能性があり、 再送すると DM が二重に届く。

    - `ConnectTimeout`: 接続確立前に timeout
    - `ConnectionError` のうち urllib3 の `NewConnectionError` 起因 (= 接続拒否 /
      名前解決失敗)。 `RemoteDisconnected` 等の送信後切断は含めない
    - HTTP 400 / 404 (= `_UNDELIVERED_HTTP_STATUSES`)
    """
    if isinstance(exc, SendDmHttpError):
        return exc.status_code in _UNDELIVERED_HTTP_STATUSES
    if isinstance(exc, requests.exceptions.ConnectTimeout):
        return True
    if isinstance(exc, requests.exceptions.ConnectionError):
        reason = exc.args[0] if exc.args else None
        if isinstance(reason, urllib3.exceptions.MaxRetryError):
            reason = reason.reason
        return isinstance(reason, urllib3.exceptions.NewConnectionError)
    return False


def close_session(headers: dict[str, str], session_id: str) -> None:
    """session を `DELETE /mcp` で明示的に閉じる。 失敗は無視する (= best-effort)。

    PR #410 review M2: ephemeral / retry 用に作った session を放置すると、
    orphan eviction 無効 (= #407 案 A) かつ ping loop 非 enforce の区間では
    server に無期限に残る。 共有 session (= SSE thread 所有) には呼ばない。
    """
    try:
        requests.delete(
            HUB_URL,
            headers={**headers, "mcp-session-id": session_id},
            timeout=5,
        )
    except Exception as e:
        print(f"[WARN] close_session failed (ignored): {e}", file=sys.stderr)


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
# MCP ping responder (= issue #362)
# ============================================================

# SSE GET の connect / read timeout (秒) (= issue #412)。
# server は ping loop の mode (disabled / observe-only / enforce) に関係なく、
# GET stream に 15s 周期で `: keepalive` comment を書く (= server
# `SSE_KEEPALIVE_INTERVAL_MS`、 issue #240)。 stream が健全なら 15s 以内に必ず
# 行が届くので、 read timeout を keepalive 4 周期分にしておけば「行が来ない」 は
# half-open (= hub の再起動 / NAT timeout で FIN/RST が届かない) と判断できる。
# 以前の `timeout=None` では `iter_lines` が永久に block し、 死んだ sid が cron
# fire に公開されたままになっていた。
SSE_CONNECT_TIMEOUT_SEC = 10
SSE_READ_TIMEOUT_SEC = 60

# SSE 行の fast-check hint。 `data: {"jsonrpc":"2.0","id":N,"method":"ping"}` を
# JSON parse する前に文字列含有で絞る (= 既存の
# `notifications/resources/updated` fast-check と同じ pattern、 毎行 json.loads
# するコストを避ける)。
_PING_HINT = '"ping"'

# ping response POST の timeout (秒)。 server 側 `PING_TIMEOUT_MS` = 10_000 より
# 十分小さくして、 間に合わない pong に reader/responder を張り付かせない
# (= issue #374 Minor 2)。
PING_RESPONSE_TIMEOUT_SEC = 5

# responder queue の上限。 通常は 1 件ずつしか積まれない (= `PING_INTERVAL_MS`
# 30_000)。 溢れる状況は responder が詰まっている = どのみち間に合わないため drop。
_PING_QUEUE_MAXSIZE = 32

# pong log を N 本ごとの summary に集約する (= issue #374 S5)。
_PING_LOG_SUMMARY_EVERY = 100

# worker thread が stop_event を polling する間隔 (秒)。
_WORKER_POLL_SEC = 0.2

# SSE stream 切断時に worker thread の終了を待つ上限 (秒)。
# inbox worker は進行中の 1 件 (= 最大 3 POST × timeout 10s) を処理してから抜ける。
# ただし 1 通知で未読 N 件を回すため N≧2 ではこの上限で終わらないことがある
# (= issue #382 Minor 1)。 超過した場合は `abandon_event` で旧 worker の dispatch を
# 打ち切ってから再接続する。
_WORKER_JOIN_TIMEOUT_SEC = 35

# `abandon_event` を立てた後、 旧 inbox worker の終了を待つ上限 (秒)。
# 打ち切り後に残るのは「進行中の 1 件の dispatch + mark_message_read」だけなので
# 最大 2 POST × timeout 10s を見込む (= issue #382 Minor 1)。
_WORKER_ABANDON_JOIN_SEC = 25

# inbox worker の停止 sentinel (= queue に積まれた残件を処理してから終了させる)。
_STOP_WORKER = object()

# inbox worker への「未読を取りに行け」合図 (= 通知の中身は使わないため単一 token)。
_INBOX_POLL = object()


def _parse_sse_data_line(raw: str) -> dict[str, Any] | None:
    """SSE の `data: <json>` 行を JSON-RPC message (dict) として parse。

    MCP SDK (= `WebStandardStreamableHTTPServerTransport.writeSSEEvent`) の出力は
    `event: message\n` [`id: <n>\n`] `data: <json>\n\n` の 3〜4 行。 本 helper は
    `data:` 行のみを対象とし、 それ以外の行 (= `event:` / `id:` / 空行) と
    JSON parse 失敗・非 dict payload は None を返す (= caller は skip)。
    """
    if not raw.startswith("data:"):
        return None
    payload = raw[len("data:"):].strip()
    if not payload:
        return None
    try:
        msg = json.loads(payload)
    except json.JSONDecodeError:
        return None
    return msg if isinstance(msg, dict) else None


def respond_ping(
    headers: dict[str, str], session_id: str, request_id: Any
) -> None:
    """server→client の MCP `ping` request に空 result の JSON-RPC response を返す。

    issue #362: server の active ping-presence loop (= `runOneActivePingCycle`) は
    `server.ping()` で protocol-level ping request を standalone SSE stream
    (= scheduler が張っている long-lived GET /mcp) に流す。 応答がないと
    timeout 10s × 3 attempts で session が evict され、 SSE 再接続 →
    re-initialize を繰り返して `is_online` がフラップする。

    MCP spec (Ping utility) の定めどおり **空 result の response** を返す
    (= `pong` という method は存在しない)。 StreamableHTTP では server→client
    request への response は **POST /mcp の body として送る**。 body が
    response / notification のみの POST に対し transport は `202 Accepted` を
    返す (= tools/call と違い SSE body は返らない)。

    timeout は `PING_RESPONSE_TIMEOUT_SEC` (= server の `PING_TIMEOUT_MS` 10s より
    十分小さい)。 10s 張り付くと pong が間に合わず evict される側に回るため、
    間に合わない pong は諦めて次 cycle の ping に賭ける (= issue #374 Minor 2)。

    **session 失効時の実挙動** (= issue #374 Minor 3): stale な `mcp-session-id`
    を載せた non-initialize POST は、 server の auto-reissue path
    (= issue #68 / PR #100、 既定 enabled) が横取りして **新 session を発行し
    202 を返す**。 つまり「session が死んでいれば非 2xx が返る」わけではなく、
    下の非 2xx WARN 分岐はこのケースでは発火しない。 代わりに pong 1 本ごとに
    誰も subscribe していない捨て session が生まれる (= `is_online` には影響しない
    が session table には積まれる)。 そのため caller 側 (`_ping_responder_loop`)
    は **stream 終了後の pong を抑止** する。 抑止をすり抜けて生まれた orphan は
    server 側の orphan eviction GC (= issue #369 / #361) に委ねる。
    """
    resp = requests.post(
        HUB_URL,
        headers={**headers, "mcp-session-id": session_id},
        data=_encode_json_body({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {},
        }),
        timeout=PING_RESPONSE_TIMEOUT_SEC,
    )
    # 202 が正 (= response-only POST)、 実装差で 200 を返す transport も許容。
    # 非 2xx はほぼ auto-reissue path に乗らなかった異常系のみ (上記 docstring 参照)。
    if resp.status_code not in (200, 202):
        print(
            f"[WARN] ping response failed: HTTP {resp.status_code}: "
            f"{resp.text[:200]}",
            file=sys.stderr,
        )


def _valid_request_id(request_id: Any) -> bool:
    """JSON-RPC 2.0 / MCP Ping utility が許す `id` 型か判定 (= issue #374 S4)。

    spec 上 `id` は String または Number (Null は response 専用)。 bool は Python
    では int の subclass だが JSON-RPC の Number ではないため除外する。
    SSE に書けるのは hub server 本体のみなので実害は低いが、 不正 id をそのまま
    response に echo して transport を混乱させないための入口 guard。
    """
    if isinstance(request_id, bool):
        return False
    return isinstance(request_id, (str, int))


def _try_handle_ping(raw: str, ping_queue: "queue.Queue[Any]") -> bool:
    """SSE 行が MCP `ping` request なら responder queue に積んで True。 他は False。

    issue #374 Minor 2: 以前はこの場で response を POST していたが、 SSE reader
    thread が POST (= 最大 10s) でブロックされる間 `iter_lines` が消費されず、
    後続の ping 行が読まれないまま server 側 timeout に達していた。 reader thread
    は **行を積むだけ** にし、 実 POST は `_ping_responder_loop` (専用 thread) が
    行う。

    True を返した場合 caller は当該行の以降の処理を skip する (= ping は
    inbox push とは無関係)。 False の場合は既存の
    `notifications/resources/updated` 判定に素通りさせる (= 既存経路は無変更)。
    """
    msg = _parse_sse_data_line(raw)
    if msg is None or msg.get("method") != "ping":
        return False
    request_id = msg.get("id")
    if request_id is None:
        # id 無し = notification 扱い、 response を返してはいけない (JSON-RPC 仕様)。
        return True
    if not _valid_request_id(request_id):
        print(
            f"[WARN] ping with invalid id type: {str(request_id)[:64]!r}",
            file=sys.stderr,
        )
        return True
    try:
        ping_queue.put_nowait(request_id)
    except queue.Full:
        # responder が詰まっている = どのみち間に合わない。 落として次 ping に賭ける。
        print(
            f"[WARN] ping queue full, dropped id={str(request_id)[:64]!r}",
            file=sys.stderr,
        )
    return True


def _ping_responder_loop(
    headers: dict[str, str],
    session_id: str,
    ping_queue: "queue.Queue[Any]",
    stop_event: threading.Event,
) -> None:
    """`_try_handle_ping` が積んだ ping id に response を POST する専用 thread。

    issue #374 Minor 2: SSE reader thread を POST でブロックさせないための分離。
    inbox dispatch がどれだけ長引いても pong はこの thread から出続ける。

    stop_event が set された後 (= SSE stream 切断後) は queue に**残っている
    ping を捨てる** (= 取り出さずに終了する)。 死んだ session への pong POST は
    server の auto-reissue path に拾われて捨て session を生むだけで、 presence
    には一切寄与しないため (= issue #374 Minor 3)。 既に取り出した 1 件は
    最後まで処理してから抜ける (= POST を発行済みの往復を途中で捨てないため)。

    server 側の eviction cancel は GET handler からしか呼ばれない (= `src/mcp/
    server.ts` の `cancelPendingEviction` の非 test 呼出元は GET のみ) ため、
    「切断直前の ping は eviction grace 中なら意味がある」は実装上成立しない
    (= issue #382 Minor 2)。 切断後の pong は一律抑止する。

    POST 失敗は致命的ではない (= 次 cycle の ping で retry、 最悪 evict →
    再接続で復帰) ため log のみで swallow する。
    """
    answered = 0
    while not stop_event.is_set():
        try:
            request_id = ping_queue.get(timeout=_WORKER_POLL_SEC)
        except queue.Empty:
            continue
        try:
            respond_ping(headers, session_id, request_id)
            answered += 1
            # issue #374 S5: 毎 ping の stdout 出力 (= 約 2880 行/日) をやめ、
            # N 本ごとの summary に集約する。
            if answered % _PING_LOG_SUMMARY_EVERY == 0:
                print(
                    f"[sse-pong] answered {answered} pings "
                    f"(session={session_id[:8]}...)"
                )
        except Exception as e:
            print(
                f"[ERR sse ping] id={str(request_id)[:64]!r}: {e}", file=sys.stderr
            )
    # issue #382 Minor 3: 接続が短命だと summary 閾値 (= 約 50 分) に届かず 1 行も
    # 出ない。 pong の挙動を見たい場面 (= evict 頻発時) でこそ消えるため、 loop
    # 終了時に端数を flush する。
    if answered and answered % _PING_LOG_SUMMARY_EVERY != 0:
        print(
            f"[sse-pong] answered {answered} pings "
            f"(session={session_id[:8]}..., stream closed)"
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


def _build_fire_message(message: str, owner: str) -> str:
    """発火メッセージに返信先を付与する (issue #282)。

    cron / run_at / run_in / /run コマンドで発火する際、受信者が返信先を把握できるよう
    メッセージ末尾に `---\n返信先: @<登録者>` セクションを付与する。
    owner は schedules.json の `owner` field (= `@handle` 形式)。
    """
    return f"{message}\n\n---\n返信先: {owner}"


def handle_inbox_command(
    headers: dict[str, str],
    session_id: str,
    sender: str,
    body: str,
    schedules: list[dict[str, Any]],
    iters: list[Any],
    next_times: list[datetime],
    config_path: Path,
    msg_id: str | None = None,
) -> None:
    """inbox に届いた DM body を parse し command として実行、 sender へ reply。

    issue #65 v4 redesign (= operator 全 use case 統合):
    - sender-based ownership (= owner field、 自身の entry のみ操作可)
    - one-shot timer (= /run_at / /run_in、 fire 後 auto-delete)
    - cyclic cron (= /add)

    v2.0 (= issue #92 `/` prefix migration、 breaking change):
    全 command が `/` prefix を要求。 `/` で始まらない body は **エラー応答を返す**
    (= issue #282、 旧 silently ignore から変更)、 未知 `/<cmd>` は `/unknown <cmd>`
    で明示返答 (= `docs/command-message-convention.md` §3)。

    issue #221: `msg_id` を受け取り、 /run_in / /run_at で作成する one-shot entry の
    `caused_by` に設定する。 fire 時に send_message へ caused_by が渡され causal chain
    が保たれる。 /run (即時 fire) でも caused_by=msg_id を send_dm() に渡す。

    対応 command:
    - `/ping`                                       : 生存確認
    - `/list`                                       : sender's entries 一覧 (one-shot 残り時間付き)
    - `/list all`                                   : 全 entries 一覧 (= cross-owner view、 issue #85)
    - `/add <name> <cron-5> <to> <message>`         : cyclic entry 追加、 owner=sender
    - `/run_at <ISO8601> <to> <message>`            : one-shot entry 追加 (= 指定日時)、 fire 後 auto-delete
    - `/run_in <duration> <to> <message>`           : one-shot entry 追加 (= N時間後)、 fire 後 auto-delete
    - `/delete <name>`                              : entry 削除 (= owner check)
    - `/run <name>`                                 : one-shot 即時 fire (= owner check、 entry は変更なし)
    - `/help`                                       : command 一覧 self-document
    - 未知 `/<cmd>`                                  : `/unknown <cmd>` 返答
    - 非 `/` body                                   : エラー応答を返す (= issue #282)
    """
    body_stripped = body.strip()
    parts = body_stripped.split()
    cmd_first = parts[0].lower() if parts else ""

    # issue #282: `/` で始まらない body はエラー応答を返す (= 旧 silently ignore から変更)。
    # scheduler は command-only peer、 自然言語 message を受領しても LLM 処理は行わない。
    # 送信者に「コマンドのみ受け付ける」旨を明示することで意図しない無反応を防ぐ。
    if not cmd_first.startswith("/"):
        send_dm(
            headers,
            session_id,
            sender,
            "@scheduler は自由メッセージは受け付けません。コマンドは /help で確認してください。",
            caused_by=msg_id,
        )
        return

    try:
        if cmd_first == "/ping":
            with _schedules_lock:
                count = len(schedules)
            send_dm(
                headers,
                session_id,
                sender,
                f"pong (scheduler alive, {count} schedules total)",
            )
            print(f"[CMD] /ping ← {sender}")

        elif cmd_first == "/list":
            # issue #85 v4: `/list all` sub-command (= cross-owner view) を追加。
            # 既存 `/list` (= sender's own entries only) と並ぶ別 path として処理。
            sub_cmd = parts[1].lower() if len(parts) > 1 else ""
            if sub_cmd == "all":
                with _schedules_lock:
                    entries = list(schedules)
                    if not entries:
                        listing_text = (
                            "list all: no schedules in the system "
                            "(use `/add` or `/run_at` / `/run_in` to create one)"
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
                print(f"[CMD] /list all ← {sender} ({len(entries)} entries)")
            else:
                # default: sender's own entries (= owner-filtered、 既存 behavior)
                with _schedules_lock:
                    own = [s for s in schedules if _check_owner(s, sender)]
                    if not own:
                        listing_text = (
                            f"list: no schedules owned by {sender} "
                            f"(use `/add` or `/run_at` / `/run_in` to create one、 "
                            f"or `/list all` to see all entries across owners)"
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
                print(f"[CMD] /list ← {sender} ({len(own) if own else 0} entries)")

        elif cmd_first == "/add":
            parsed = _parse_add_args(body_stripped, owner=sender)
            if isinstance(parsed, str):
                send_dm(headers, session_id, sender, parsed)
                return
            _do_add_entry(
                headers, session_id, sender, parsed,
                schedules, iters, next_times, config_path,
            )

        elif cmd_first == "/run_at":
            parsed = _parse_run_at_args(body_stripped, owner=sender)
            if isinstance(parsed, str):
                send_dm(headers, session_id, sender, parsed)
                return
            # issue #221: 依頼メッセージ ID を caused_by として保存 → fire 時に伝搬
            if msg_id is not None:
                parsed["caused_by"] = msg_id
            _do_add_entry(
                headers, session_id, sender, parsed,
                schedules, iters, next_times, config_path,
            )

        elif cmd_first == "/run_in":
            parsed = _parse_run_in_args(body_stripped, owner=sender)
            if isinstance(parsed, str):
                send_dm(headers, session_id, sender, parsed)
                return
            # issue #221: 依頼メッセージ ID を caused_by として保存 → fire 時に伝搬
            if msg_id is not None:
                parsed["caused_by"] = msg_id
            _do_add_entry(
                headers, session_id, sender, parsed,
                schedules, iters, next_times, config_path,
            )

        elif cmd_first == "/delete":
            if len(parts) < 2:
                send_dm(
                    headers,
                    session_id,
                    sender,
                    "[ERR] usage: `/delete <name>` (= owner-restricted、 自身の entry のみ削除可)",
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
                        f"[ERR] no schedule named '{name}'. use `/list` to see your entries.",
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
            print(f"[CMD] /delete name='{name}' ← {sender}")

        elif cmd_first == "/run":
            # v2.0 (= issue #92): 旧 `run now <name>` を `/run <name>` に flatten
            # (= single-word command + 1 positional arg)。 convention doc §5.2 起草時の
            # literal rename 案 (= `/run now`) から impl PR #108 で flatten refinement に
            # 確定 (= issue #109 で convention doc も同期)。 single-word に統一する理由は
            # docs/command-message-convention.md §5.2 impl refinement note 参照。
            if len(parts) < 2:
                send_dm(
                    headers,
                    session_id,
                    sender,
                    "[ERR] usage: `/run <name>` (= owner-restricted、 one-shot 即時 fire、 entry は変更なし)",
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
                        f"[ERR] no schedule named '{name}'. use `/list` to see your entries.",
                    )
                    return
                if not _check_owner(s, sender):
                    send_dm(
                        headers,
                        session_id,
                        sender,
                        f"[ERR] '{name}' is owned by {s.get('owner', '?')}, "
                        f"you ({sender}) cannot run it.",
                    )
                    return
                fire_to = s["to"]
                fire_owner = s["owner"]
                fire_msg = _build_fire_message(s["message"], fire_owner)  # issue #282
            try:
                # issue #221: /run 即時 fire でも caused_by を現在の依頼 msg_id に設定
                send_dm(headers, session_id, fire_to, fire_msg, caused_by=msg_id)
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"[OK] one-shot fired '{name}' → {fire_to} (schedule unchanged)",
                )
                print(
                    f"[RUN] name='{name}' ← {sender}: {fire_to}: "
                    f"{fire_msg[:50]}{'...' if len(fire_msg) > 50 else ''}"
                )
            except Exception as e:
                send_dm(
                    headers,
                    session_id,
                    sender,
                    f"[ERR] /run '{name}' failed: {e}",
                )

        elif cmd_first == "/help":
            # v2.0 (= issue #92): self-document、 docs/command-message-convention.md §3.2 整合。
            help_text = (
                "scheduler commands (v2.0):\n"
                "  /ping                                 — 生存確認 (= /pong + count 返答)\n"
                "  /list                                 — sender's entries 一覧\n"
                "  /list all                             — 全 entries 一覧 (= cross-owner view)\n"
                "  /add <name> <cron-5> <to> <message>   — cyclic entry 追加、 owner=sender\n"
                "  /run_at <ISO8601> <to> <message>      — one-shot 追加 (= 指定日時)、 fire 後 auto-delete\n"
                "  /run_in <duration> <to> <message>     — one-shot 追加 (= N時間後)、 fire 後 auto-delete\n"
                "  /delete <name>                        — entry 削除 (= owner check)\n"
                "  /run <name>                           — one-shot 即時 fire (= owner check、 entry 不変)\n"
                "  /help                                 — this listing\n"
                "詳細: https://github.com/kishibashi3/agent-hub/blob/main/packages/scheduler/README.md"
            )
            send_dm(headers, session_id, sender, help_text)
            print(f"[CMD] /help ← {sender}")

        else:
            # v2.0 (= issue #92): 未知 `/<cmd>` には `/unknown <cmd>` で明示返答
            # (= docs/command-message-convention.md §3 convention、 sender 側の判別用)。
            send_dm(headers, session_id, sender, f"/unknown {cmd_first}")
            print(f"[CMD] /unknown ← {sender}: {cmd_first}")

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
    """`/add <name> <cron-5-fields> <to> <message>` を positional parse + entry dict.

    成功時 dict {name, cron, to, message, owner} を返す。 失敗時 error str。
    """
    rest = body_stripped[len("/add"):].strip()
    if not rest:
        return (
            "[ERR] usage: `/add <name> <cron-5> <to> <message>` "
            "(cron = 5 space-separated fields、 e.g. `0 13 * * *`)"
        )
    parts = rest.split()
    if len(parts) < 8:
        return (
            f"[ERR] not enough args (got {len(parts)}, need >=8). "
            f"usage: `/add <name> <cron-5-fields> <to> <message>` "
            f"e.g. `/add daily 0 13 * * * @planner daily report`"
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
    """`/run_at <ISO8601> <to> <message>` を parse + one-shot entry dict.

    name は auto-generate (= `oneshot-<sanitized-run_at>` form)。
    """
    rest = body_stripped[len("/run_at"):].strip()
    if not rest:
        return (
            "[ERR] usage: `/run_at <ISO8601-datetime> <to> <message>` "
            "(e.g. `/run_at 2026-05-19T12:00:00+09:00 @planner 進捗確認`)"
        )
    parts = rest.split(maxsplit=2)
    if len(parts) < 3:
        return (
            f"[ERR] not enough args (got {len(parts)}, need >=3). "
            f"usage: `/run_at <ISO8601> <to> <message>`"
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
    """`/run_in <duration> <to> <message>` を parse + one-shot entry dict.

    duration: `2h` (2 hours) / `30m` (30 mins) / `1d` (1 day) / `2h30m` (compound)。
    internal で run_at に変換 (= now + duration)。
    """
    rest = body_stripped[len("/run_in"):].strip()
    if not rest:
        return (
            "[ERR] usage: `/run_in <duration> <to> <message>` "
            "(duration = `2h` / `30m` / `1d` / `2h30m` 等、 e.g. `/run_in 2h @planner 進捗確認`)"
        )
    parts = rest.split(maxsplit=2)
    if len(parts) < 3:
        return (
            f"[ERR] not enough args (got {len(parts)}, need >=3). "
            f"usage: `/run_in <duration> <to> <message>`"
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
        f"[CMD] /add name='{new_entry['name']}' mode={mode_label} "
        f"next={new_next.isoformat()} ← {sender}"
    )


# ============================================================
# SSE listener thread (= issue #65 inbox push reactor)
# ============================================================


def _inbox_worker_loop(
    headers: dict[str, str],
    session_id: str,
    inbox_queue: "queue.Queue[Any]",
    schedules: list[dict[str, Any]],
    iters: list[Any],
    next_times: list[datetime],
    config_path: Path,
    abandon_event: threading.Event | None = None,
) -> None:
    """inbox push 通知を受けて fetch_inbox + dispatch + mark_as_read する専用 thread。

    issue #374 Minor 2: これらは 1 件あたり最大 3 回の POST (= `timeout=10`) を
    伴うため、 SSE reader thread 上で実行すると `iter_lines` が消費されず
    ping 行が読まれないまま server 側 timeout (= `PING_TIMEOUT_MS` 10s ×
    `PING_MAX_RETRIES` 2) に達し、 #362 が潰そうとした evict が再現していた。

    `_STOP_WORKER` sentinel を受け取ると終了する。 sentinel は queue の末尾に
    積まれるため、 **切断時点で積まれていた通知は処理してから** 抜ける
    (= pong と違い、 取りこぼすと DM が未読のまま残るため)。

    dispatch 中の例外は log のみで swallow する (= 1 通の失敗で worker を
    落とさない)。 既存の `[ERR sse inbox-handler]` prefix を維持。

    issue #382 Minor 1: 1 通知につき `fetch_inbox` が返した未読 N 件を回すため、
    N≧2 では reader 側の `_WORKER_JOIN_TIMEOUT_SEC` で終わらないことがある。
    join が timeout すると reader は再接続し、 新 sid で 2 本目の worker が
    起動する → 旧 worker が `mark_message_read` する前の DM を新 worker が
    再取得し、 同じ `/add` が 2 回走って `foo` と `foo-1` の別 entry が黙って
    できる (= サイレント縮退)。 reader は join 超過時に `abandon_event` を立て、
    この loop は **各 message の dispatch 前** にそれを見て離脱する。 進行中の
    1 件は `mark_message_read` まで終わらせてから抜ける (= 途中終了で dispatch
    済みの message が未読のまま残ると、 それこそ新 worker が再実行するため)。
    """
    while True:
        item = inbox_queue.get()
        if item is _STOP_WORKER:
            return
        if abandon_event is not None and abandon_event.is_set():
            return
        try:
            msgs = fetch_inbox(headers, session_id)
            for m in msgs:
                if abandon_event is not None and abandon_event.is_set():
                    print(
                        "[WARN sse inbox-handler] abandoned by reader, "
                        f"{len(msgs)} fetched (session={session_id[:8]}...)",
                        file=sys.stderr,
                    )
                    return
                sender = m.get("from", "@unknown")
                body = m.get("message", "")
                msg_id = m.get("id")
                handle_inbox_command(
                    headers,
                    session_id,
                    sender,
                    body,
                    schedules,
                    iters,
                    next_times,
                    config_path,
                    msg_id=msg_id,  # issue #221: causal chain 追跡
                )
                if msg_id:
                    mark_message_read(headers, session_id, msg_id)
        except Exception as e:
            print(f"[ERR sse inbox-handler] {e}", file=sys.stderr)


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
    4. push 到着で inbox worker に合図 (= fetch_inbox + handle_inbox_command +
       mark_message_read は `_inbox_worker_loop` が別 thread で実行)
    5. server→client の MCP `ping` request には空 result を返す (= issue #362。
       実 POST は `_ping_responder_loop` が別 thread で実行)
    6. 切断時は worker を畳んでから 3 秒待って再接続

    watch.sh の SSE long-lived 接続 pattern を Python 移植 (= issue #65)。
    issue #368: GET stream が生きている区間だけ、 この connection の sid を
    `publish_session()` で main thread の cron fire に公開し、 stream 終了 / 例外時に
    `invalidate_session()` で取り下げる。 main thread は自前の session を持たない
    (= 同一 user の session はこの 1 本。 SSE が落ちている瞬間の fire だけ、 送信
    限りの ephemeral session を作って送信後に閉じる)。

    issue #374 Minor 2: この関数が回す reader loop は **行を読んで振り分ける
    だけ** で、 HTTP POST を一切行わない。 以前は ping response と inbox
    dispatch を reader thread 上で直接実行していたため、 inbox 処理中は
    `iter_lines` が消費されず ping 行が読まれないまま server 側の
    `PING_TIMEOUT_MS` × `PING_MAX_RETRIES` に達し、 #362 が潰そうとした
    evict が残っていた。 connection ごとに ping / inbox の 2 worker thread を
    起こし、 stream 終了時に畳む。
    """
    display_name = f"Scheduler — cron DM + inbox bidirectional (= issue #65)"
    # issue #382 Minor 1 follow-up: 打ち切った worker は fetch 済みの残り未読を
    # 捨てて抜けるため、 次の connection で 1 回だけ catch-up poll を積む
    # (= 積まないと次の DM が来るまで未読が処理されない窓ができる)。
    pending_inbox_poll = False
    # issue #368: outer except から invalidate するため、 while の外で束縛しておく
    # (= 初回 `init_session()` が raise した場合に NameError にしない)。
    sid: str | None = None
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
                # issue #412: read timeout で half-open を検知する。 発火すると
                # `iter_lines` から例外が上がり、 内側 `finally` で sid を取り
                # 下げてから外側 `except` 経由で再接続する。
                timeout=(SSE_CONNECT_TIMEOUT_SEC, SSE_READ_TIMEOUT_SEC),
            ) as resp:
                if resp.status_code != 200:
                    print(
                        f"[ERR sse] GET status {resp.status_code}: "
                        f"{resp.text[:200] if hasattr(resp, 'text') else ''}",
                        file=sys.stderr,
                    )
                    time.sleep(5)
                    continue

                # issue #368: GET stream が 200 で確立した時点で、 この sid を
                # cron fire 用に公開する。 main thread はこれを読んで fire する
                # (= POST-only session を持たない)。
                publish_session(sid)

                # 4. worker thread 起動 (= issue #374 Minor 2)。
                # reader thread は「行を読んで振り分ける」だけにし、 POST を
                # 伴う処理 (= pong / inbox dispatch) は別 thread に逃がす。
                # 両者を別 queue / 別 thread にしているのは、 1 本の worker に
                # 相乗りさせると inbox 処理待ちで pong が再び starve するため。
                stop_event = threading.Event()
                # issue #382 Minor 1: join 超過時に旧 inbox worker の dispatch を
                # 打ち切るための event (= stop_event が「積み残しを捌いてから
                # 終われ」なのに対し、 こちらは「今すぐ dispatch をやめろ」)。
                abandon_event = threading.Event()
                ping_thread: threading.Thread | None = None
                inbox_thread: threading.Thread | None = None

                # issue #382 S-b: thread 起動を `try` の内側に置く。 外に置くと
                # `inbox_thread.start()` の `RuntimeError` (= thread 枯渇) で
                # `finally` に到達せず、 起動済みの ping worker が空 queue を
                # polling し続ける。
                try:
                    ping_queue: queue.Queue[Any] = queue.Queue(
                        maxsize=_PING_QUEUE_MAXSIZE
                    )
                    inbox_queue: queue.Queue[Any] = queue.Queue()
                    pt = threading.Thread(
                        target=_ping_responder_loop,
                        args=(headers, sid, ping_queue, stop_event),
                        name="sse-ping-responder",
                        daemon=True,
                    )
                    it = threading.Thread(
                        target=_inbox_worker_loop,
                        args=(
                            headers,
                            sid,
                            inbox_queue,
                            schedules,
                            iters,
                            next_times,
                            config_path,
                            abandon_event,
                        ),
                        name="sse-inbox-worker",
                        daemon=True,
                    )
                    # start() 後に代入する (= 未 start の Thread を join すると
                    # RuntimeError になるため、 `finally` からは起動済みだけを見る)。
                    pt.start()
                    ping_thread = pt
                    it.start()
                    inbox_thread = it

                    if pending_inbox_poll:
                        # 直前の connection で worker を打ち切っている。 その
                        # fetch で取った残り未読は誰も処理していないため、 通知を
                        # 待たずに 1 回だけ取りに行かせる。
                        pending_inbox_poll = False
                        inbox_queue.put(_INBOX_POLL)

                    for raw in resp.iter_lines(decode_unicode=True):
                        if not raw:
                            continue
                        # issue #362: server→client の MCP `ping` request に空 result の
                        # response を返す。 inbox push 判定より前に処理する (= ping 行は
                        # `notifications/resources/updated` を含まないため、 後段の
                        # fast-check に到達すると読み捨てられる)。
                        if _PING_HINT in raw and _try_handle_ping(raw, ping_queue):
                            continue
                        # SSE event は "data: <json>" 形式、 method field を文字列含有判定で fast-check
                        if "notifications/resources/updated" not in raw:
                            continue

                        # inbox 通知は「未読を取りに行け」の合図でしかなく、
                        # fetch_inbox は毎回全未読を返す。 既に 1 件積んであるなら
                        # 積み増さず coalesce する。
                        if inbox_queue.empty():
                            inbox_queue.put(_INBOX_POLL)
                finally:
                    # issue #368: GET stream が切れた sid は ping に応答できない
                    # (= server 側で evict 対象)。 main thread が掴み続けないよう
                    # 真っ先に取り下げる。
                    invalidate_session(sid)
                    # stream 終了: 切断後の pong は一律抑止する (= stale sid への
                    # POST は server の auto-reissue path に拾われて捨て session を
                    # 生むだけ。 POST では eviction cancel が走らないため grace を
                    # 待つ意味もない、 issue #382 Minor 2)。 inbox は積み残しを
                    # 処理してから終了させる (= DM 取りこぼし防止)。
                    stop_event.set()
                    if ping_thread is not None:
                        ping_thread.join(timeout=_WORKER_JOIN_TIMEOUT_SEC)
                    if inbox_thread is not None:
                        inbox_queue.put(_STOP_WORKER)
                        inbox_thread.join(timeout=_WORKER_JOIN_TIMEOUT_SEC)
                        if inbox_thread.is_alive():
                            # issue #382 Minor 1: ここで再接続すると新 sid の
                            # worker が旧 worker 未既読の DM を再取得し、 同じ
                            # command が 2 回走る。 旧 worker を打ち切り、 進行中の
                            # 1 件が畳まれるまで追加で待ってから再接続する。
                            abandon_event.set()
                            print(
                                "[WARN sse] inbox worker still running after "
                                f"{_WORKER_JOIN_TIMEOUT_SEC}s, abandoning it "
                                f"(session={sid[:8]}...)",
                                file=sys.stderr,
                            )
                            inbox_thread.join(
                                timeout=_WORKER_ABANDON_JOIN_SEC
                            )
                            if inbox_thread.is_alive():
                                print(
                                    "[WARN sse] abandoned inbox worker did not "
                                    "exit; duplicate dispatch is still possible "
                                    f"(session={sid[:8]}...)",
                                    file=sys.stderr,
                                )
                            else:
                                # 打ち切り済みで既に畳めている = 残り未読を処理
                                # する主体がいない。 次の connection で catch-up
                                # poll を 1 回積む。 まだ生きている場合に積まない
                                # のは、 in-flight の 1 件を新 worker が二重
                                # dispatch する窓を広げないため (= 上の WARN が
                                # その縮退を明示している)。
                                pending_inbox_poll = True

            # SSE stream closed: reconnect
            print(
                f"[sse-reconnect] stream closed, reconnect in 3s", file=sys.stderr
            )
            time.sleep(3)

        except Exception as e:
            # issue #368: 公開済みのまま例外で抜ける経路 (= GET 確立後 ~ 内側
            # try 到達前) を塞ぐ。 世代が進んでいれば no-op。
            invalidate_session(sid)
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

    # caused_by optional string (= issue #221: causal chain 追跡)
    if "caused_by" in entry:
        if not isinstance(entry["caused_by"], str):
            return f"{where}.caused_by: must be string"

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

    # issue #368: main thread は自前の session を作らない。 cron fire は SSE thread
    # が確立した session (= GET /mcp を張っており ping に応答できる) を共有して使う。
    # 旧実装の POST-only session は ping loop `enforce` 下で evict され、 その後の
    # fire が HTTP 404 で静かに落ちていた。
    print(
        f"[boot] mode=pat user={user_id} "
        f"tenant={TENANT or 'default'} hub={HUB_URL} "
        f"schedules={len(schedules)} session=<shared with sse thread>"
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

    # issue #368: 最初の fire までに session が公開されるのを待つ (= 起動直後に
    # due な entry があると、 待たない場合は ephemeral fallback に倒れるため)。
    # 待てなくても致命的ではない (= fire 時に再度待ち、 それでも駄目なら
    # ephemeral session で送る) ので、 ここでは警告に留めて先に進む。
    if wait_for_session(_SESSION_WAIT_TIMEOUT_S):
        print(f"[sse-thread] session published for cron fire")
    else:
        print(
            "[WARN] shared session not published within "
            f"{_SESSION_WAIT_TIMEOUT_S:.0f}s of startup",
            file=sys.stderr,
        )

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
        print("[ready] no schedules loaded; SSE inbox listener only (use `/add` / `/run_at` / `/run_in` to register)")

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
            fire_msg = _build_fire_message(s["message"], s["owner"])  # issue #282
            fire_caused_by: str | None = s.get("caused_by")  # issue #221
            is_one_shot = bool(s.get("one_shot")) or (
                bool(s.get("run_at")) and not s.get("cron")
            )

        send_ok = False
        # 配送済みかもしれない失敗 (= `is_undelivered_send_failure` が False)。
        # 再送せず、 one-shot は二重配送を避けて配送済み扱いで消す。
        maybe_delivered = False
        first_err: Exception | None = None
        fire_label = 'one-shot' if is_one_shot else 'cyclic'
        try:
            # issue #368: SSE thread が公開している session を使う。 未公開なら
            # 短時間待ち、 それでも取れなければこの fire 限りの session を作る。
            session_id, ephemeral = acquire_session(headers)
        except Exception as e:
            # ephemeral session の initialize 失敗 = まだ送っていない。
            print(
                f"[ERR] session acquire failed for name='{fire_name}': {e}",
                file=sys.stderr,
            )
            first_err = e
        else:
            try:
                send_dm(headers, session_id, fire_to, fire_msg, caused_by=fire_caused_by)
                send_ok = True
                print(
                    f"[FIRE] {next_due.isoformat()} name='{fire_name}' "
                    f"({fire_label}) → {fire_to}: "
                    f"{fire_msg[:50]}{'...' if len(fire_msg) > 50 else ''}"
                    f"{' [ephemeral session]' if ephemeral else ''}"
                )
            except Exception as e:
                print(
                    f"[ERR] send_dm failed for name='{fire_name}': {e}",
                    file=sys.stderr,
                )
                first_err = e
                maybe_delivered = not is_undelivered_send_failure(e)
            finally:
                if ephemeral:
                    close_session(headers, session_id)

        if first_err is not None and not maybe_delivered:
            # issue #368: ここで諦めると「エラーも出ずに消えるリマインダ」 が
            # 残る。 共有 session が切断 / evict されていた場合に備え、 その 1 回
            # 限りの session を作り直して即座に再送する。 旧実装は session を
            # 作り直すだけで **その fire 分は再送していなかった**。
            # PR #410 review M1: 再送は未配送が確実な失敗に限る。
            retry_sid: str | None = None
            try:
                retry_sid = init_session(headers)
                send_dm(
                    headers, retry_sid, fire_to, fire_msg,
                    caused_by=fire_caused_by,
                )
                send_ok = True
                print(
                    f"[FIRE-RETRY] {next_due.isoformat()} name='{fire_name}' "
                    f"({fire_label}) → {fire_to} "
                    f"(retried with a fresh session)"
                )
            except Exception as e2:
                print(
                    f"[ERR] send_dm retry failed for name='{fire_name}': {e2}",
                    file=sys.stderr,
                )
                # init_session の失敗は未配送。 send_dm の失敗は再度判定する。
                if retry_sid is not None:
                    maybe_delivered = not is_undelivered_send_failure(e2)
                if not maybe_delivered:
                    # hub 自体が落ちている場合の hot loop 回避 (= one-shot は
                    # send_ok=False で entry が残り、 次 iteration で即 due になる)。
                    _shutdown_event.wait(60)
            finally:
                if retry_sid is not None:
                    close_session(headers, retry_sid)

        if maybe_delivered:
            print(
                f"[WARN] name='{fire_name}' ({fire_label}) not resent: "
                "the failure may have happened after delivery",
                file=sys.stderr,
            )

        # state update (= one-shot 削除 or cyclic next_time advance)
        with _schedules_lock:
            # delete されていた / index ずれの場合は skip
            if fire_target_idx >= len(schedules):
                continue
            # 念のため fire_name と一致確認 (= snapshot 中に delete + insert で別 entry に置換 case)
            if schedules[fire_target_idx].get("name") != fire_name:
                continue
            # maybe_delivered の one-shot も消す (= entry を残すと次 iteration で
            # 即 due になり結局再送される。 parse 失敗が恒常的だと毎周期 DM が届く)。
            if is_one_shot and (send_ok or maybe_delivered):
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
