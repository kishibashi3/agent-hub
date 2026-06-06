"""local-llm-monitor — クラウド LLM 会話の常時ローカル監査サービス。

設計思想 (issue #224):
- クラウド LLM が動かす全 peer の会話を、独立した LLM が常時監視
- 監査する AI が監査対象と独立したシステムであることがポイント
- ハードウェア（Gemma 4 等）が揃うまでは Claude API でモック実装

起動:
    python monitor.py

環境変数:
    AGENT_HUB_URL          (required) MCP エンドポイント
    AGENT_HUB_USER         handle 名 (default: local-llm-monitor)
    AGENT_HUB_GITHUB_PAT   PAT auth mode の場合
    AGENT_HUB_TENANT       テナント名 (optional)
    ANTHROPIC_API_KEY      Claude classifier 使用時 (required)
    ANTHROPIC_MODEL        使用モデル (default: claude-3-haiku-20240307)
    MONITOR_POLL_INTERVAL  ポーリング間隔 秒 (default: 60)
    MONITOR_ALERT_TARGET   アラート送信先 handle (default: @ope-ultp1635)
    MONITOR_HISTORY_LIMIT  参加者ごとの取得履歴件数 (default: 100)
"""
from __future__ import annotations

import logging
import os
import time
from collections import defaultdict
from typing import Any

from classifier import ClassifierInterface, ClaudeClassifier, ThreadStatus
from mcp_client import MCPClient

logger = logging.getLogger(__name__)

# デフォルト設定
_DEFAULT_POLL_INTERVAL_S = 60
_DEFAULT_ALERT_TARGET = "@ope-ultp1635"
_DEFAULT_HISTORY_LIMIT = 100


class Monitor:
    """ポーリング + 分類 + アラートのメインコントローラー。

    poll_once() を定期的に呼び出すことで:
    1. 全参加者の会話履歴を取得
    2. (sender, recipient) ペアごとにスレッドとして分類
    3. critical 検出時に alert_target へ send_message

    Args:
        client:          agent-hub との MCP クライアント
        classifier:      スレッド分類器（ClaudeClassifier / MockClassifier）
        alert_target:    critical アラートの送信先 handle
        history_limit:   参加者ごとに取得する最大メッセージ件数
        poll_interval_s: ポーリング間隔（秒）— run() ループで使用
    """

    def __init__(
        self,
        client: MCPClient,
        classifier: ClassifierInterface,
        alert_target: str = _DEFAULT_ALERT_TARGET,
        history_limit: int = _DEFAULT_HISTORY_LIMIT,
        poll_interval_s: int = _DEFAULT_POLL_INTERVAL_S,
    ) -> None:
        self.client = client
        self.classifier = classifier
        self.alert_target = alert_target
        self.history_limit = history_limit
        self.poll_interval_s = poll_interval_s

    # ------------------------------------------------------------------
    # コアロジック
    # ------------------------------------------------------------------

    def poll_once(self) -> dict[str, list[dict]]:
        """単一のポーリングサイクルを実行する。

        Returns:
            {"done": [...], "stash": [...], "critical": [...]}
            各リストには {"pair": (sender, recipient), "message_count": N} が入る。
        """
        # 1) 全参加者を取得
        participants = self.client.get_participants()
        person_names = [
            p["name"] for p in participants
            if p.get("type") == "person"
            and p["name"] != f"@{self.client.user.lstrip('@')}"
        ]
        logger.info("polling %d participants", len(person_names))

        # 2) 各参加者の履歴を収集 (重複メッセージを ID でデdup)
        seen_ids: set[str] = set()
        all_messages: list[dict[str, Any]] = []
        for name in person_names:
            try:
                msgs = self.client.get_user_history(name, limit=self.history_limit)
            except Exception as exc:
                logger.warning("get_user_history(%s) failed: %s", name, exc)
                continue
            for msg in msgs:
                msg_id = msg.get("id", "")
                if msg_id and msg_id not in seen_ids:
                    seen_ids.add(msg_id)
                    all_messages.append(msg)

        logger.info("collected %d unique messages across %d participants", len(all_messages), len(person_names))

        # 3) (sender, recipient) ペアでグループ化 → 1 スレッド単位
        threads: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for msg in all_messages:
            sender = msg.get("sender", msg.get("from", ""))
            recipient = msg.get("recipient", msg.get("to", ""))
            # 順序を正規化してペアを作る（A→B と B→A は同じスレッド）
            pair = tuple(sorted([sender, recipient]))
            threads[pair].append(msg)  # type: ignore[index]

        # 4) 各スレッドを分類
        results: dict[str, list[dict]] = {"done": [], "stash": [], "critical": []}
        for pair, msgs in threads.items():
            status: ThreadStatus = self.classifier.classify(msgs)
            entry = {"pair": pair, "message_count": len(msgs)}
            results[status].append(entry)

        # 5) critical 検出時にアラート送信
        for conv in results["critical"]:
            pair_str = " ↔ ".join(conv["pair"])
            alert_msg = (
                f"🚨 [local-llm-monitor] CRITICAL thread detected\n"
                f"Participants: {pair_str}\n"
                f"Messages: {conv['message_count']}\n"
                f"Action required: please review this conversation."
            )
            try:
                self.client.send_message(self.alert_target, alert_msg)
                logger.warning("CRITICAL alert sent to %s: %s", self.alert_target, pair_str)
            except Exception as exc:
                logger.error("failed to send critical alert: %s", exc)

        # サマリログ
        logger.info(
            "poll complete — done=%d stash=%d critical=%d",
            len(results["done"]),
            len(results["stash"]),
            len(results["critical"]),
        )
        return results

    def run(self) -> None:
        """メインポーリングループ。Ctrl+C で停止。"""
        logger.info(
            "starting monitor loop (interval=%ds, alert_target=%s)",
            self.poll_interval_s,
            self.alert_target,
        )
        while True:
            try:
                self.poll_once()
            except KeyboardInterrupt:
                logger.info("monitor stopped by user")
                break
            except Exception as exc:
                logger.error("poll_once failed: %s", exc, exc_info=True)
            time.sleep(self.poll_interval_s)


# ------------------------------------------------------------------
# エントリーポイント
# ------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    poll_interval = int(os.environ.get("MONITOR_POLL_INTERVAL", _DEFAULT_POLL_INTERVAL_S))
    alert_target = os.environ.get("MONITOR_ALERT_TARGET", _DEFAULT_ALERT_TARGET)
    history_limit = int(os.environ.get("MONITOR_HISTORY_LIMIT", _DEFAULT_HISTORY_LIMIT))

    client = MCPClient.from_env()
    classifier = ClaudeClassifier()

    with client:
        monitor = Monitor(
            client=client,
            classifier=classifier,
            alert_target=alert_target,
            history_limit=history_limit,
            poll_interval_s=poll_interval,
        )
        monitor.run()


if __name__ == "__main__":
    main()
