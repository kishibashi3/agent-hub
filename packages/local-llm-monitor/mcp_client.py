"""MCP HTTP クライアント — agent-hub との通信ヘルパー。

scheduler.py と同パターン: requests で直接 MCP Streamable HTTP を叩く。
monitor は @admin 権限で接続し get_user_history を利用する。
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import requests

logger = logging.getLogger(__name__)

# デフォルトタイムアウト (秒)
_CALL_TIMEOUT_S = 15
_INIT_TIMEOUT_S = 10


def _encode_json_body(payload: dict[str, Any]) -> bytes:
    """UTF-8 で JSON エンコードする。

    requests の json= 引数は charset をヘッダーに含めないケースがあるため、
    scheduler.py と同様に bytes で直接送出する。
    """
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _parse_response(resp: requests.Response) -> dict[str, Any]:
    """JSON-RPC レスポンスを解析し result を返す。isError なら raise。"""
    try:
        body = resp.json()
    except Exception as exc:
        raise RuntimeError(f"non-JSON response (HTTP {resp.status_code}): {resp.text[:200]}") from exc

    if "error" in body:
        raise RuntimeError(f"JSON-RPC error: {body['error']}")

    result = body.get("result", {})
    # tool 呼び出しの場合 content[0].text に JSON が入っている
    if "content" in result:
        content = result["content"]
        if content and content[0].get("type") == "text":
            text = content[0]["text"]
            parsed = json.loads(text)
            if isinstance(parsed, dict) and parsed.get("isError"):
                raise RuntimeError(f"tool error: {parsed}")
            return parsed
    return result


class MCPClient:
    """agent-hub MCP HTTP クライアント。

    使い方::

        client = MCPClient.from_env()
        client.connect()        # session 確立 + register
        participants = client.get_participants()
        client.disconnect()

    または context manager::

        with MCPClient.from_env() as client:
            ...
    """

    def __init__(
        self,
        hub_url: str,
        user: str,
        display_name: str = "",
        pat: str | None = None,
        tenant: str | None = None,
    ) -> None:
        self.hub_url = hub_url.rstrip("/")
        self.user = user
        self.display_name = display_name or f"{user} — local-llm-monitor"
        self.pat = pat
        self.tenant = tenant
        self._session_id: str | None = None
        self._req_id = 0

    @classmethod
    def from_env(cls) -> "MCPClient":
        """環境変数から設定を読んでインスタンスを生成する。

        環境変数:
            AGENT_HUB_URL      (required) MCP エンドポイント URL
            AGENT_HUB_USER     handle 名 (default: local-llm-monitor)
            AGENT_HUB_GITHUB_PAT  PAT auth mode の場合に指定
            AGENT_HUB_TENANT   テナント名 (optional)
        """
        url = os.environ.get("AGENT_HUB_URL")
        if not url:
            raise RuntimeError("AGENT_HUB_URL is required")
        return cls(
            hub_url=url,
            user=os.environ.get("AGENT_HUB_USER", "local-llm-monitor"),
            pat=os.environ.get("AGENT_HUB_GITHUB_PAT"),
            tenant=os.environ.get("AGENT_HUB_TENANT"),
        )

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def _build_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json, text/event-stream",
            "X-User-Id": self.user,
        }
        if self.pat:
            headers["Authorization"] = f"Bearer {self.pat}"
        if self.tenant:
            headers["X-Tenant-Id"] = self.tenant
        return headers

    def _session_headers(self) -> dict[str, str]:
        if not self._session_id:
            raise RuntimeError("not connected — call connect() first")
        return {**self._build_headers(), "mcp-session-id": self._session_id}

    # ------------------------------------------------------------------
    # 接続管理
    # ------------------------------------------------------------------

    def connect(self) -> None:
        """MCP セッションを確立し、自分を register する。"""
        headers = self._build_headers()

        # 1) initialize
        resp = requests.post(
            self.hub_url,
            headers=headers,
            data=_encode_json_body({
                "jsonrpc": "2.0",
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "local-llm-monitor", "version": "1.0"},
                },
                "id": self._next_id(),
            }),
            timeout=_INIT_TIMEOUT_S,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"initialize failed: HTTP {resp.status_code}: {resp.text[:200]}")

        sid = resp.headers.get("mcp-session-id")
        if not sid:
            raise RuntimeError("No mcp-session-id in initialize response")
        self._session_id = sid

        # 2) initialized notification
        requests.post(
            self.hub_url,
            headers=self._session_headers(),
            data=_encode_json_body({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            timeout=5,
        )

        # 3) register
        self._call_tool("register", {
            "name": self.user.lstrip("@"),
            "display_name": self.display_name,
        })
        logger.info("connected as @%s (session=%s)", self.user, self._session_id[:8])

    def disconnect(self) -> None:
        """セッションを破棄する (best-effort)。"""
        self._session_id = None

    def __enter__(self) -> "MCPClient":
        self.connect()
        return self

    def __exit__(self, *_: object) -> None:
        self.disconnect()

    # ------------------------------------------------------------------
    # ツール呼び出し (内部)
    # ------------------------------------------------------------------

    def _call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        """tools/call を実行し結果を返す。エラー時は raise。"""
        resp = requests.post(
            self.hub_url,
            headers=self._session_headers(),
            data=_encode_json_body({
                "jsonrpc": "2.0",
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
                "id": self._next_id(),
            }),
            timeout=_CALL_TIMEOUT_S,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"{name} failed: HTTP {resp.status_code}: {resp.text[:200]}")
        return _parse_response(resp)

    # ------------------------------------------------------------------
    # 公開 API
    # ------------------------------------------------------------------

    def get_participants(self) -> list[dict[str, Any]]:
        """全参加者 (person + team) を取得する。"""
        result = self._call_tool("get_participants", {})
        if isinstance(result, list):
            return result
        # フォールバック: result がラップされている場合
        return result if isinstance(result, list) else []

    def get_user_history(self, name: str, limit: int = 100) -> list[dict[str, Any]]:
        """[admin] 指定 participant の全送受信履歴を取得する。

        @admin handle で接続している場合のみ有効。
        """
        result = self._call_tool("get_user_history", {"name": name, "limit": limit})
        if isinstance(result, dict):
            return result.get("messages", [])
        return []

    def send_message(
        self, to: str, message: str, caused_by: str | None = None
    ) -> dict[str, Any]:
        """DM を送信する。"""
        args: dict[str, Any] = {"to": to, "message": message}
        if caused_by is not None:
            args["caused_by"] = caused_by
        return self._call_tool("send_message", args)
