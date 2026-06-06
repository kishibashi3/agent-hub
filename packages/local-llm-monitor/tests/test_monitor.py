"""local-llm-monitor の単体テスト。

Mock を使って MCP クライアントと分類器を差し替えることで、
ネットワーク・LLM API 不要で動作を検証する。
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# パッケージルートを sys.path に追加
sys.path.insert(0, str(Path(__file__).parent.parent))

from classifier import ClassifierInterface, ClaudeClassifier, MockClassifier, _format_thread
from monitor import Monitor


# ------------------------------------------------------------------
# フィクスチャ
# ------------------------------------------------------------------

def _make_message(
    msg_id: str,
    sender: str,
    recipient: str,
    body: str,
    created_at: str = "2026-06-06T00:00:00Z",
) -> dict:
    return {
        "id": msg_id,
        "sender": sender,
        "recipient": recipient,
        "body": body,
        "created_at": created_at,
    }


def _make_mock_client(participants: list[dict], history_map: dict[str, list[dict]]) -> MagicMock:
    """MCPClient のモック。

    participants: get_participants() が返すリスト
    history_map:  {handle: [messages]} — get_user_history() が返すマップ
    """
    client = MagicMock()
    client.user = "local-llm-monitor"
    client.get_participants.return_value = participants
    client.get_user_history.side_effect = lambda name, limit=100: history_map.get(name, [])
    client.send_message.return_value = {"id": "alert-msg-id"}
    return client


# ------------------------------------------------------------------
# ClassifierInterface テスト
# ------------------------------------------------------------------

class TestMockClassifier:
    def test_returns_default_status(self):
        clf = MockClassifier(default_status="done")
        assert clf.classify([]) == "done"

    def test_returns_critical(self):
        clf = MockClassifier(default_status="critical")
        msgs = [_make_message("1", "@alice", "@bob", "something bad")]
        assert clf.classify(msgs) == "critical"

    def test_call_log_records_invocations(self):
        log: list[list[dict]] = []
        clf = MockClassifier(default_status="stash", call_log=log)
        msgs1 = [_make_message("1", "@a", "@b", "hi")]
        msgs2 = [_make_message("2", "@c", "@d", "yo")]
        clf.classify(msgs1)
        clf.classify(msgs2)
        assert len(log) == 2
        assert log[0] == msgs1
        assert log[1] == msgs2

    def test_empty_messages_returns_default(self):
        clf = MockClassifier(default_status="stash")
        assert clf.classify([]) == "stash"


# ------------------------------------------------------------------
# _format_thread テスト
# ------------------------------------------------------------------

class TestFormatThread:
    def test_formats_messages_in_order(self):
        msgs = [
            _make_message("2", "@bob", "@alice", "pong", "2026-06-06T00:00:02Z"),
            _make_message("1", "@alice", "@bob", "ping", "2026-06-06T00:00:01Z"),
        ]
        text = _format_thread(msgs)
        lines = text.splitlines()
        assert len(lines) == 2
        # 時系列昇順
        assert "@alice → @bob: ping" in lines[0]
        assert "@bob → @alice: pong" in lines[1]

    def test_empty_messages(self):
        assert _format_thread([]) == ""


# ------------------------------------------------------------------
# Monitor.poll_once テスト
# ------------------------------------------------------------------

class TestMonitorPollOnce:
    def test_no_participants_returns_empty_results(self):
        client = _make_mock_client(participants=[], history_map={})
        monitor = Monitor(client=client, classifier=MockClassifier("done"))
        results = monitor.poll_once()
        assert results == {"done": [], "stash": [], "critical": []}

    def test_skips_self_from_participants(self):
        """monitor 自身は get_user_history の対象外。"""
        participants = [
            {"name": "@local-llm-monitor", "type": "person"},
            {"name": "@alice", "type": "person"},
        ]
        history_map = {
            "@alice": [_make_message("1", "@alice", "@bob", "hello")],
        }
        client = _make_mock_client(participants, history_map)
        monitor = Monitor(client=client, classifier=MockClassifier("done"))
        monitor.poll_once()
        # local-llm-monitor の get_user_history は呼ばれない
        call_args = [c.args[0] for c in client.get_user_history.call_args_list]
        assert "@local-llm-monitor" not in call_args
        assert "@alice" in call_args

    def test_skips_team_entries(self):
        """team type の entry は get_user_history の対象外。"""
        participants = [
            {"name": "@team-alpha", "type": "team"},
            {"name": "@bob", "type": "person"},
        ]
        history_map = {
            "@bob": [_make_message("1", "@alice", "@bob", "hi")],
        }
        client = _make_mock_client(participants, history_map)
        monitor = Monitor(client=client, classifier=MockClassifier("done"))
        monitor.poll_once()
        call_args = [c.args[0] for c in client.get_user_history.call_args_list]
        assert "@team-alpha" not in call_args
        assert "@bob" in call_args

    def test_deduplicates_messages_by_id(self):
        """同一 message_id が複数参加者の履歴に現れても 1 回だけ分類する。"""
        # @alice と @bob の会話: 同じメッセージが両者の履歴に出てくる
        shared_msg = _make_message("shared-1", "@alice", "@bob", "hello")
        participants = [
            {"name": "@alice", "type": "person"},
            {"name": "@bob", "type": "person"},
        ]
        history_map = {
            "@alice": [shared_msg],
            "@bob": [shared_msg],  # 同じ ID
        }
        call_log: list[list[dict]] = []
        client = _make_mock_client(participants, history_map)
        monitor = Monitor(client=client, classifier=MockClassifier("done", call_log=call_log))
        monitor.poll_once()
        # (@alice, @bob) ペアが 1 スレッドとして 1 回分類される
        assert len(call_log) == 1
        assert len(call_log[0]) == 1  # メッセージは dedup 済み

    def test_groups_messages_by_pair(self):
        """(alice, bob) と (alice, charlie) は別スレッドとして分類される。"""
        participants = [
            {"name": "@alice", "type": "person"},
            {"name": "@bob", "type": "person"},
            {"name": "@charlie", "type": "person"},
        ]
        history_map = {
            "@alice": [
                _make_message("1", "@alice", "@bob", "to bob"),
                _make_message("2", "@alice", "@charlie", "to charlie"),
            ],
            "@bob": [],
            "@charlie": [],
        }
        call_log: list[list[dict]] = []
        client = _make_mock_client(participants, history_map)
        monitor = Monitor(client=client, classifier=MockClassifier("done", call_log=call_log))
        monitor.poll_once()
        # 2 ペア (alice-bob, alice-charlie) → 2 回 classify 呼び出し
        assert len(call_log) == 2

    def test_all_done_no_alert(self):
        """done のみ — send_message は呼ばれない。"""
        participants = [{"name": "@alice", "type": "person"}]
        history_map = {"@alice": [_make_message("1", "@alice", "@bob", "done task")]}
        client = _make_mock_client(participants, history_map)
        monitor = Monitor(client=client, classifier=MockClassifier("done"))
        results = monitor.poll_once()
        client.send_message.assert_not_called()
        assert len(results["done"]) == 1
        assert len(results["critical"]) == 0

    def test_critical_triggers_alert(self):
        """critical 検出 → alert_target に send_message が呼ばれる。"""
        participants = [{"name": "@alice", "type": "person"}]
        history_map = {"@alice": [_make_message("1", "@alice", "@bob", "bad stuff")]}
        client = _make_mock_client(participants, history_map)
        monitor = Monitor(
            client=client,
            classifier=MockClassifier("critical"),
            alert_target="@ope-ultp1635",
        )
        results = monitor.poll_once()
        assert len(results["critical"]) == 1
        client.send_message.assert_called_once()
        call_args = client.send_message.call_args
        assert call_args.args[0] == "@ope-ultp1635"
        assert "CRITICAL" in call_args.args[1]

    def test_multiple_critical_sends_multiple_alerts(self):
        """2 つの critical スレッド → 2 回 send_message。"""
        participants = [
            {"name": "@alice", "type": "person"},
            {"name": "@charlie", "type": "person"},
        ]
        history_map = {
            "@alice": [_make_message("1", "@alice", "@bob", "bad1")],
            "@charlie": [_make_message("2", "@charlie", "@dave", "bad2")],
        }
        client = _make_mock_client(participants, history_map)
        monitor = Monitor(client=client, classifier=MockClassifier("critical"))
        results = monitor.poll_once()
        assert len(results["critical"]) == 2
        assert client.send_message.call_count == 2

    def test_alert_send_failure_is_non_fatal(self):
        """send_message が失敗しても poll_once は完了する。"""
        participants = [{"name": "@alice", "type": "person"}]
        history_map = {"@alice": [_make_message("1", "@alice", "@bob", "bad")]}
        client = _make_mock_client(participants, history_map)
        client.send_message.side_effect = RuntimeError("network error")
        monitor = Monitor(client=client, classifier=MockClassifier("critical"))
        # 例外が外に漏れないことを確認
        results = monitor.poll_once()
        assert len(results["critical"]) == 1

    def test_get_user_history_failure_is_non_fatal(self):
        """get_user_history が失敗しても他の参加者の処理を継続する。"""
        participants = [
            {"name": "@alice", "type": "person"},
            {"name": "@bob", "type": "person"},
        ]
        client = MagicMock()
        client.user = "local-llm-monitor"
        client.get_participants.return_value = participants
        # alice は失敗、bob は成功
        def _history(name: str, limit: int = 100):
            if name == "@alice":
                raise RuntimeError("history unavailable")
            return [_make_message("1", "@bob", "@charlie", "hi")]
        client.get_user_history.side_effect = _history
        client.send_message.return_value = {}

        monitor = Monitor(client=client, classifier=MockClassifier("done"))
        results = monitor.poll_once()
        # bob の会話は分類される
        assert len(results["done"]) == 1

    def test_results_structure(self):
        """結果の構造が正しい。"""
        participants = [{"name": "@alice", "type": "person"}]
        history_map = {"@alice": [_make_message("1", "@alice", "@bob", "hello")]}
        client = _make_mock_client(participants, history_map)
        monitor = Monitor(client=client, classifier=MockClassifier("stash"))
        results = monitor.poll_once()
        assert set(results.keys()) == {"done", "stash", "critical"}
        assert len(results["stash"]) == 1
        entry = results["stash"][0]
        assert "pair" in entry
        assert "message_count" in entry
        assert entry["message_count"] == 1


# ------------------------------------------------------------------
# ClaudeClassifier テスト (Anthropic SDK モック)
# ------------------------------------------------------------------

class TestClaudeClassifier:
    def test_classify_done(self):
        with patch("classifier.anthropic") as mock_anthropic:
            mock_client = MagicMock()
            mock_anthropic.Anthropic.return_value = mock_client
            mock_client.messages.create.return_value = MagicMock(
                content=[MagicMock(text='{"status": "done", "reason": "task completed"}')]
            )
            clf = ClaudeClassifier(model="claude-3-haiku-20240307")
            msgs = [_make_message("1", "@alice", "@bob", "PR merged, done")]
            result = clf.classify(msgs)
            assert result == "done"

    def test_classify_critical(self):
        with patch("classifier.anthropic") as mock_anthropic:
            mock_client = MagicMock()
            mock_anthropic.Anthropic.return_value = mock_client
            mock_client.messages.create.return_value = MagicMock(
                content=[MagicMock(text='{"status": "critical", "reason": "unexpected loop"}')]
            )
            clf = ClaudeClassifier(model="claude-3-haiku-20240307")
            msgs = [_make_message("1", "@alice", "@bob", "infinite retry")]
            result = clf.classify(msgs)
            assert result == "critical"

    def test_classify_falls_back_on_api_error(self):
        """API エラー時は stash にフォールバックする。"""
        with patch("classifier.anthropic") as mock_anthropic:
            mock_client = MagicMock()
            mock_anthropic.Anthropic.return_value = mock_client
            mock_client.messages.create.side_effect = Exception("API error")
            clf = ClaudeClassifier(model="claude-3-haiku-20240307")
            result = clf.classify([_make_message("1", "@a", "@b", "test")])
            assert result == "stash"

    def test_classify_falls_back_on_invalid_json(self):
        """不正 JSON 応答時は stash にフォールバックする。"""
        with patch("classifier.anthropic") as mock_anthropic:
            mock_client = MagicMock()
            mock_anthropic.Anthropic.return_value = mock_client
            mock_client.messages.create.return_value = MagicMock(
                content=[MagicMock(text="not json at all")]
            )
            clf = ClaudeClassifier(model="claude-3-haiku-20240307")
            result = clf.classify([_make_message("1", "@a", "@b", "test")])
            assert result == "stash"

    def test_classify_empty_messages_returns_done(self):
        """空メッセージリストは done を返す (API 呼び出しなし)。"""
        with patch("classifier.anthropic") as mock_anthropic:
            mock_client = MagicMock()
            mock_anthropic.Anthropic.return_value = mock_client
            clf = ClaudeClassifier(model="claude-3-haiku-20240307")
            result = clf.classify([])
            assert result == "done"
            mock_client.messages.create.assert_not_called()
