"""
Unit tests for agent-hub scheduler (issue #49).

対象: load_schedules / build_headers / _next_fire_time (cron iteration)

テスト実行:
    cd packages/scheduler
    uv pip install -r requirements-dev.txt --python .venv/bin/python  # 初回のみ
    .venv/bin/pytest tests/ -v
"""

from __future__ import annotations

import json
import queue
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import pytest

# scheduler モジュールの globals を patch するため import は関数内で行わず
# モジュールを参照経由で操作する。
import sys
import os

# プロジェクトルートを sys.path に追加 (= scheduler.py が同ディレクトリにある前提)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import scheduler as sched


# ============================================================
# Helpers
# ============================================================

def _valid_cron_entry(**overrides) -> dict:
    """テスト用の最小 valid cron entry。"""
    base = {
        "name": "test-daily",
        "cron": "0 9 * * *",
        "to": "@planner",
        "message": "hello",
        "owner": "@ope",
    }
    base.update(overrides)
    return base


def _valid_oneshot_entry(**overrides) -> dict:
    """テスト用の最小 valid one-shot entry。"""
    future = datetime.now(tz=timezone.utc) + timedelta(hours=2)
    base = {
        "name": "test-oneshot",
        "run_at": future.isoformat(),
        "to": "@planner",
        "message": "one-shot",
        "owner": "@ope",
        "one_shot": True,
    }
    base.update(overrides)
    return base


def _write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")


# ============================================================
# load_schedules
# ============================================================

class TestLoadSchedules:
    """load_schedules の正常系 / 異常系 (= sys.exit(1)) テスト。"""

    def test_valid_array(self, tmp_path: Path) -> None:
        """valid JSON array → list を返す。"""
        cfg = tmp_path / "schedules.json"
        entries = [_valid_cron_entry(), _valid_cron_entry(name="test-weekly", cron="0 10 * * 1")]
        _write_json(cfg, entries)
        result = sched.load_schedules(cfg)
        assert len(result) == 2
        assert result[0]["name"] == "test-daily"

    def test_valid_single_object_becomes_list(self, tmp_path: Path) -> None:
        """JSON object (1件) → list 化 (= [entry])。"""
        cfg = tmp_path / "schedules.json"
        _write_json(cfg, _valid_cron_entry())
        result = sched.load_schedules(cfg)
        assert isinstance(result, list)
        assert len(result) == 1

    def test_valid_oneshot_entry(self, tmp_path: Path) -> None:
        """run_at を持つ one-shot entry も正常 parse。"""
        cfg = tmp_path / "schedules.json"
        _write_json(cfg, [_valid_oneshot_entry()])
        result = sched.load_schedules(cfg)
        assert result[0]["one_shot"] is True

    def test_file_not_found_exits(self, tmp_path: Path) -> None:
        """存在しないファイル → sys.exit(1)。"""
        with pytest.raises(SystemExit) as exc:
            sched.load_schedules(tmp_path / "nonexistent.json")
        assert exc.value.code == 1

    def test_json_parse_error_exits(self, tmp_path: Path) -> None:
        """不正 JSON → sys.exit(1)。"""
        cfg = tmp_path / "schedules.json"
        cfg.write_text("{invalid json", encoding="utf-8")
        with pytest.raises(SystemExit) as exc:
            sched.load_schedules(cfg)
        assert exc.value.code == 1

    def test_toplevel_string_exits(self, tmp_path: Path) -> None:
        """top-level が string → sys.exit(1)。"""
        cfg = tmp_path / "schedules.json"
        _write_json(cfg, "not an array or object")
        with pytest.raises(SystemExit) as exc:
            sched.load_schedules(cfg)
        assert exc.value.code == 1

    def test_toplevel_number_exits(self, tmp_path: Path) -> None:
        """top-level が number → sys.exit(1)。"""
        cfg = tmp_path / "schedules.json"
        _write_json(cfg, 42)
        with pytest.raises(SystemExit) as exc:
            sched.load_schedules(cfg)
        assert exc.value.code == 1

    def test_entry_not_dict_exits(self, tmp_path: Path) -> None:
        """array 内の entry が dict でない → sys.exit(1)。"""
        cfg = tmp_path / "schedules.json"
        _write_json(cfg, ["string-entry"])
        with pytest.raises(SystemExit) as exc:
            sched.load_schedules(cfg)
        assert exc.value.code == 1

    @pytest.mark.parametrize("missing_field", ["to", "message", "owner"])
    def test_missing_required_field_exits(
        self, tmp_path: Path, missing_field: str
    ) -> None:
        """必須 field (to / message / owner) 欠落 → sys.exit(1)。"""
        entry = _valid_cron_entry()
        del entry[missing_field]
        cfg = tmp_path / "schedules.json"
        _write_json(cfg, [entry])
        with pytest.raises(SystemExit) as exc:
            sched.load_schedules(cfg)
        assert exc.value.code == 1

    def test_missing_both_cron_and_run_at_exits(self, tmp_path: Path) -> None:
        """cron も run_at もない entry → sys.exit(1)。"""
        entry = {
            "name": "no-trigger",
            "to": "@planner",
            "message": "hi",
            "owner": "@ope",
        }
        cfg = tmp_path / "schedules.json"
        _write_json(cfg, [entry])
        with pytest.raises(SystemExit) as exc:
            sched.load_schedules(cfg)
        assert exc.value.code == 1

    def test_field_not_string_exits(self, tmp_path: Path) -> None:
        """必須 field が string でない (to=integer) → sys.exit(1)。"""
        entry = _valid_cron_entry(to=123)
        cfg = tmp_path / "schedules.json"
        _write_json(cfg, [entry])
        with pytest.raises(SystemExit) as exc:
            sched.load_schedules(cfg)
        assert exc.value.code == 1

    def test_invalid_cron_expression_exits(self, tmp_path: Path) -> None:
        """不正 cron 式 → sys.exit(1)。"""
        entry = _valid_cron_entry(cron="99 99 99 99 99")
        cfg = tmp_path / "schedules.json"
        _write_json(cfg, [entry])
        with pytest.raises(SystemExit) as exc:
            sched.load_schedules(cfg)
        assert exc.value.code == 1

    def test_duplicate_name_exits(self, tmp_path: Path) -> None:
        """name が重複 → sys.exit(1)。"""
        cfg = tmp_path / "schedules.json"
        _write_json(cfg, [_valid_cron_entry(), _valid_cron_entry()])  # 同じ name
        with pytest.raises(SystemExit) as exc:
            sched.load_schedules(cfg)
        assert exc.value.code == 1


# ============================================================
# build_headers
# ============================================================

class TestBuildHeaders:
    """build_headers の auth mode 別 header 構成テスト。

    module-level globals (PAT / HANDLE_OVERRIDE / TENANT) を patch して各 path を検証。
    """

    def test_pat_only(self) -> None:
        """PAT のみ → Authorization: Bearer <pat> のみ (X-Participant-Id なし)。"""
        with patch.object(sched, "PAT", "ghp_testtoken"), \
             patch.object(sched, "HANDLE_OVERRIDE", ""), \
             patch.object(sched, "TENANT", ""):
            headers = sched.build_headers()
        assert headers["Authorization"] == "Bearer ghp_testtoken"
        assert "X-Participant-Id" not in headers
        assert "X-Tenant-Id" not in headers

    def test_pat_with_handle_override(self) -> None:
        """PAT + HANDLE_OVERRIDE → Authorization + X-Participant-Id。"""
        with patch.object(sched, "PAT", "ghp_testtoken"), \
             patch.object(sched, "HANDLE_OVERRIDE", "@scheduler"), \
             patch.object(sched, "TENANT", ""):
            headers = sched.build_headers()
        assert headers["Authorization"] == "Bearer ghp_testtoken"
        assert headers["X-Participant-Id"] == "@scheduler"

    def test_pat_with_tenant(self) -> None:
        """PAT + TENANT → Authorization + X-Tenant-Id。"""
        with patch.object(sched, "PAT", "ghp_testtoken"), \
             patch.object(sched, "HANDLE_OVERRIDE", ""), \
             patch.object(sched, "TENANT", "myteam"):
            headers = sched.build_headers()
        assert headers["Authorization"] == "Bearer ghp_testtoken"
        assert headers["X-Tenant-Id"] == "myteam"

    def test_content_type_always_present(self) -> None:
        """Content-Type: application/json; charset=utf-8 は常に付与される。"""
        with patch.object(sched, "PAT", "ghp_testtoken"), \
             patch.object(sched, "HANDLE_OVERRIDE", ""), \
             patch.object(sched, "TENANT", ""):
            headers = sched.build_headers()
        assert headers["Content-Type"] == "application/json; charset=utf-8"

    def test_neither_pat_nor_handle_exits(self) -> None:
        """PAT も HANDLE_OVERRIDE も未設定 → sys.exit(1)。"""
        with patch.object(sched, "PAT", ""), \
             patch.object(sched, "HANDLE_OVERRIDE", ""), \
             patch.object(sched, "TENANT", ""):
            with pytest.raises(SystemExit) as exc:
                sched.build_headers()
        assert exc.value.code == 1


# ============================================================
# cron iteration loop (_next_fire_time)
# ============================================================

class TestNextFireTime:
    """_next_fire_time の next-fire 計算テスト。

    issue #49 scope: "cron iteration loop を単独関数に切り出して unit-testable に refactor"
    → `_next_fire_time(entry, now)` として既に存在するため直接テスト。
    """

    _TZ = timezone(timedelta(hours=9))  # JST (scheduler production env と同一)

    def _now(self, **kwargs) -> datetime:
        """テスト用の固定 now。"""
        base = datetime(2026, 5, 22, 10, 0, 0, tzinfo=self._TZ)
        return base.replace(**kwargs) if kwargs else base

    def test_cron_entry_returns_future_datetime(self) -> None:
        """cron entry → now より後の datetime を返す。"""
        entry = _valid_cron_entry(cron="0 12 * * *")  # 毎日 12:00
        now = self._now()  # 10:00
        result = sched._next_fire_time(entry, now)
        assert result > now
        assert result.hour == 12
        assert result.minute == 0

    def test_cron_entry_same_day_fires_today(self) -> None:
        """now が 10:00、cron 12:00 → 当日 12:00 を返す。"""
        entry = _valid_cron_entry(cron="0 12 * * *")
        now = self._now()  # 2026-05-22 10:00 JST
        result = sched._next_fire_time(entry, now)
        assert result.day == now.day
        assert result.hour == 12

    def test_oneshot_entry_returns_run_at(self) -> None:
        """run_at entry → run_at datetime を返す (croniter 使用なし)。"""
        run_at_dt = datetime(2026, 5, 23, 15, 30, 0, tzinfo=self._TZ)
        entry = _valid_oneshot_entry(run_at=run_at_dt.isoformat())
        result = sched._next_fire_time(entry, self._now())
        # timezone-aware な datetime として等価比較
        assert result.replace(microsecond=0).astimezone(self._TZ) == \
               run_at_dt.replace(microsecond=0)

    def test_multiple_schedules_earliest_selected(self) -> None:
        """複数 entry のうち next_time が最小のものを min() で選択できる。"""
        now = self._now()
        entries = [
            _valid_cron_entry(name="late",  cron="0 23 * * *"),   # 23:00
            _valid_cron_entry(name="early", cron="0 11 * * *"),   # 11:00
            _valid_cron_entry(name="mid",   cron="0 15 * * *"),   # 15:00
        ]
        next_times = [sched._next_fire_time(e, now) for e in entries]
        earliest_idx = min(range(len(next_times)), key=lambda i: next_times[i])
        assert entries[earliest_idx]["name"] == "early"

    def test_cron_next_time_advances_after_fire(self) -> None:
        """fire 後に croniter.get_next() を呼ぶと next_time が進む。"""
        from croniter import croniter
        entry = _valid_cron_entry(cron="0 9 * * *")  # 毎日 9:00
        now = self._now(hour=8)  # 8:00 = 次回は当日 9:00
        it = croniter(entry["cron"], now)
        first_next = it.get_next(datetime).astimezone()
        assert first_next.hour == 9
        # fire 後: 次の next_next は翌日 9:00
        second_next = it.get_next(datetime).astimezone()
        assert (second_next - first_next).total_seconds() == pytest.approx(86400, abs=60)

    def test_no_cron_no_run_at_raises(self) -> None:
        """cron も run_at もない entry → ValueError。"""
        entry = {"name": "bad", "to": "@x", "message": "m", "owner": "@o"}
        with pytest.raises(ValueError, match="neither cron nor run_at"):
            sched._next_fire_time(entry, self._now())

    def test_invalid_run_at_raises(self) -> None:
        """run_at が不正 datetime 文字列 → ValueError。"""
        entry = _valid_oneshot_entry(run_at="not-a-datetime")
        with pytest.raises(ValueError, match="invalid run_at"):
            sched._next_fire_time(entry, self._now())


# ============================================================
# caused_by (issue #221)
# ============================================================

class TestCausedBy:
    """issue #221: scheduler fire 時の caused_by 伝搬テスト。"""

    @pytest.fixture(autouse=True)
    def fresh_shutdown_event(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """各テストに fresh な _shutdown_event を注入して並列実行時の isolation を保証する (issue #236)。"""
        monkeypatch.setattr(sched, "_shutdown_event", threading.Event())

    # ----------------------------------------------------------
    # _validate_entry
    # ----------------------------------------------------------

    def test_validate_entry_caused_by_string_ok(self) -> None:
        """caused_by が string → validation OK。"""
        entry = _valid_oneshot_entry(caused_by="msg-uuid-abc")
        err = sched._validate_entry(entry, set(), where="entry")
        assert err is None

    def test_validate_entry_caused_by_absent_ok(self) -> None:
        """caused_by 未指定 → validation OK (optional field)。"""
        entry = _valid_oneshot_entry()
        assert "caused_by" not in entry
        err = sched._validate_entry(entry, set(), where="entry")
        assert err is None

    def test_validate_entry_caused_by_non_string_fails(self) -> None:
        """caused_by が string でない → validation error。"""
        entry = _valid_oneshot_entry(caused_by=12345)
        err = sched._validate_entry(entry, set(), where="entry")
        assert err is not None
        assert "caused_by" in err

    # ----------------------------------------------------------
    # send_dm
    # ----------------------------------------------------------

    def test_send_dm_includes_caused_by(self) -> None:
        """caused_by 指定時 → send_message arguments に caused_by が含まれる。"""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "application/json"}
        mock_resp.json.return_value = {"result": {}}

        with patch("scheduler.requests.post", return_value=mock_resp) as mock_post:
            sched.send_dm(
                headers={"Content-Type": "application/json"},
                session_id="sess-1",
                to="@target",
                message="hello",
                caused_by="cause-msg-id",
            )

        _args, kwargs = mock_post.call_args
        import json as _json
        body = _json.loads(kwargs["data"].decode("utf-8"))
        arguments = body["params"]["arguments"]
        assert arguments["caused_by"] == "cause-msg-id"
        assert arguments["to"] == "@target"
        assert arguments["message"] == "hello"

    def test_send_dm_omits_caused_by_when_none(self) -> None:
        """caused_by=None (default) → send_message arguments に caused_by が含まれない。"""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "application/json"}
        mock_resp.json.return_value = {"result": {}}

        with patch("scheduler.requests.post", return_value=mock_resp) as mock_post:
            sched.send_dm(
                headers={"Content-Type": "application/json"},
                session_id="sess-1",
                to="@target",
                message="hello",
            )

        _args, kwargs = mock_post.call_args
        import json as _json
        body = _json.loads(kwargs["data"].decode("utf-8"))
        arguments = body["params"]["arguments"]
        assert "caused_by" not in arguments

    # ----------------------------------------------------------
    # handle_inbox_command: /run_in と /run_at が caused_by を entry に保存
    # ----------------------------------------------------------

    def _make_shared_state(self):
        """handle_inbox_command テスト用の shared state 一式を返す。"""
        schedules: list = []
        iters: list = []
        next_times: list = []
        return schedules, iters, next_times

    def test_run_in_stores_caused_by_in_entry(self, tmp_path: Path) -> None:
        """/run_in で作成した entry に caused_by が設定される。"""
        cfg = tmp_path / "schedules.json"
        cfg.write_text("[]", encoding="utf-8")
        schedules, iters, next_times = self._make_shared_state()

        sent: list = []

        def fake_send_dm(headers, session_id, to, message, caused_by=None):
            sent.append({"to": to, "message": message, "caused_by": caused_by})
            return {}

        with patch.object(sched, "send_dm", side_effect=fake_send_dm):
            sched.handle_inbox_command(
                headers={},
                session_id="sess-1",
                sender="@ope",
                body="/run_in 2h @target hello",
                schedules=schedules,
                iters=iters,
                next_times=next_times,
                config_path=cfg,
                msg_id="request-msg-id-xyz",
            )

        assert len(schedules) == 1
        assert schedules[0]["caused_by"] == "request-msg-id-xyz"

    def test_run_at_stores_caused_by_in_entry(self, tmp_path: Path) -> None:
        """/run_at で作成した entry に caused_by が設定される。"""
        from datetime import datetime, timezone, timedelta
        future = (datetime.now(tz=timezone.utc) + timedelta(hours=1)).strftime(
            "%Y-%m-%dT%H:%M:%S+00:00"
        )
        cfg = tmp_path / "schedules.json"
        cfg.write_text("[]", encoding="utf-8")
        schedules, iters, next_times = self._make_shared_state()

        with patch.object(sched, "send_dm", return_value={}):
            sched.handle_inbox_command(
                headers={},
                session_id="sess-1",
                sender="@ope",
                body=f"/run_at {future} @target hello",
                schedules=schedules,
                iters=iters,
                next_times=next_times,
                config_path=cfg,
                msg_id="request-msg-id-abc",
            )

        assert len(schedules) == 1
        assert schedules[0]["caused_by"] == "request-msg-id-abc"

    def test_run_in_no_caused_by_when_msg_id_none(self, tmp_path: Path) -> None:
        """/run_in で msg_id=None の場合、entry に caused_by が設定されない。"""
        cfg = tmp_path / "schedules.json"
        cfg.write_text("[]", encoding="utf-8")
        schedules, iters, next_times = self._make_shared_state()

        with patch.object(sched, "send_dm", return_value={}):
            sched.handle_inbox_command(
                headers={},
                session_id="sess-1",
                sender="@ope",
                body="/run_in 2h @target hello",
                schedules=schedules,
                iters=iters,
                next_times=next_times,
                config_path=cfg,
                msg_id=None,
            )

        assert len(schedules) == 1
        assert "caused_by" not in schedules[0]

    def test_run_command_passes_caused_by_to_send_dm(self, tmp_path: Path) -> None:
        """/run <name> 即時 fire で send_dm に caused_by が渡される。"""
        from datetime import datetime, timezone, timedelta
        cfg = tmp_path / "schedules.json"
        future = datetime.now(tz=timezone.utc) + timedelta(hours=1)
        entry = _valid_oneshot_entry(name="myshot")
        schedules = [entry]
        iters = [None]
        next_times = [future]

        fired_args: list = []

        def fake_send_dm(headers, session_id, to, message, caused_by=None):
            fired_args.append({"to": to, "message": message, "caused_by": caused_by})
            return {}

        with patch.object(sched, "send_dm", side_effect=fake_send_dm):
            sched.handle_inbox_command(
                headers={},
                session_id="sess-1",
                sender="@ope",
                body="/run myshot",
                schedules=schedules,
                iters=iters,
                next_times=next_times,
                config_path=cfg,
                msg_id="run-cmd-msg-id",
            )

        # fired_args[0] = fire to @planner, fired_args[1] = [OK] reply to sender
        assert fired_args[0]["to"] == "@planner"
        assert fired_args[0]["caused_by"] == "run-cmd-msg-id"

    # ----------------------------------------------------------
    # main loop fire パス (issue #228)
    # ----------------------------------------------------------

    def _run_main_with_entry(self, tmp_path: Path, entry: dict) -> list:
        """
        指定 entry を 1 件持つ config で main() を起動し、
        send_dm の呼び出し引数リストを返す。

        main loop が entry を fire した直後に _shutdown_event を set して
        main() を終了させる。
        """
        cfg = tmp_path / "schedules.json"
        cfg.write_text(json.dumps([entry]), encoding="utf-8")

        fired_args: list = []
        sched._shutdown_event.clear()

        def fake_send_dm(headers, session_id, to, message, caused_by=None):
            fired_args.append({"to": to, "message": message, "caused_by": caused_by})
            sched._shutdown_event.set()
            return {}

        with patch.object(sched, "build_headers", return_value={}), \
             patch.object(sched, "resolve_user_id", return_value="@test-user"), \
             patch.object(sched, "init_session", return_value="test-sess"), \
             patch.object(sched, "send_dm", side_effect=fake_send_dm), \
             patch.object(sched, "save_schedules"), \
             patch("threading.Thread"), \
             patch.dict(os.environ, {"SCHEDULER_CONFIG": str(cfg)}):
            sched.main()

        return fired_args

    def test_main_loop_fire_passes_caused_by(self, tmp_path: Path) -> None:
        """main loop: caused_by 設定済み one-shot entry fire → send_dm に caused_by が渡される。"""
        past = (datetime.now(tz=timezone.utc) - timedelta(hours=1)).isoformat()
        entry = {
            "name": "test-fire-cb",
            "run_at": past,
            "to": "@planner",
            "message": "scheduled-hello",
            "owner": "@ope",
            "one_shot": True,
            "caused_by": "orig-msg-id-xyz",
        }

        fired_args = self._run_main_with_entry(tmp_path, entry)

        assert len(fired_args) == 1
        assert fired_args[0]["to"] == "@planner"
        assert fired_args[0]["caused_by"] == "orig-msg-id-xyz"

    def test_main_loop_fire_no_caused_by_when_absent(self, tmp_path: Path) -> None:
        """main loop: caused_by なし one-shot entry fire → send_dm に caused_by=None が渡される。"""
        past = (datetime.now(tz=timezone.utc) - timedelta(hours=1)).isoformat()
        entry = {
            "name": "test-fire-no-cb",
            "run_at": past,
            "to": "@planner",
            "message": "scheduled-hello",
            "owner": "@ope",
            "one_shot": True,
            # caused_by なし
        }

        fired_args = self._run_main_with_entry(tmp_path, entry)

        assert len(fired_args) == 1
        assert fired_args[0]["to"] == "@planner"
        assert fired_args[0]["caused_by"] is None


# ============================================================
# issue #282: 発火メッセージ返信先付与 + 非コマンドメッセージ拒否
# ============================================================

class TestIssue282:
    """issue #282: 発火メッセージ末尾に返信先付与、非コマンドメッセージにエラー応答。"""

    @pytest.fixture(autouse=True)
    def fresh_shutdown_event(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sched, "_shutdown_event", threading.Event())

    def _make_shared_state(self):
        return [], [], []

    # ----------------------------------------------------------
    # _build_fire_message
    # ----------------------------------------------------------

    def test_build_fire_message_appends_reply_to(self) -> None:
        """_build_fire_message → メッセージ末尾に返信先セクションが付与される。"""
        result = sched._build_fire_message("hello", "@ope")
        assert result == "hello\n\n---\n返信先: @ope"

    def test_build_fire_message_preserves_original(self) -> None:
        """_build_fire_message → 元メッセージ本文は変更されない。"""
        msg = "テストメッセージです"
        result = sched._build_fire_message(msg, "@alice")
        assert result.startswith(msg)
        assert "返信先: @alice" in result

    # ----------------------------------------------------------
    # handle_inbox_command: 非コマンドメッセージ拒否
    # ----------------------------------------------------------

    def test_non_command_message_sends_error_reply(self, tmp_path: Path) -> None:
        """`/` で始まらないメッセージ → エラー応答を返す。"""
        cfg = tmp_path / "schedules.json"
        cfg.write_text("[]", encoding="utf-8")
        schedules, iters, next_times = self._make_shared_state()

        sent: list = []

        def fake_send_dm(headers, session_id, to, message, caused_by=None):
            sent.append({"to": to, "message": message})
            return {}

        with patch.object(sched, "send_dm", side_effect=fake_send_dm):
            sched.handle_inbox_command(
                headers={},
                session_id="sess-1",
                sender="@user1",
                body="こんにちは",
                schedules=schedules,
                iters=iters,
                next_times=next_times,
                config_path=cfg,
            )

        assert len(sent) == 1
        assert sent[0]["to"] == "@user1"
        assert "@scheduler は自由メッセージは受け付けません" in sent[0]["message"]
        assert "/help" in sent[0]["message"]

    def test_non_command_empty_body_sends_error_reply(self, tmp_path: Path) -> None:
        """空文字列メッセージ → エラー応答を返す。"""
        cfg = tmp_path / "schedules.json"
        cfg.write_text("[]", encoding="utf-8")
        schedules, iters, next_times = self._make_shared_state()

        sent: list = []

        def fake_send_dm(headers, session_id, to, message, caused_by=None):
            sent.append({"to": to, "message": message})
            return {}

        with patch.object(sched, "send_dm", side_effect=fake_send_dm):
            sched.handle_inbox_command(
                headers={},
                session_id="sess-1",
                sender="@user1",
                body="",
                schedules=schedules,
                iters=iters,
                next_times=next_times,
                config_path=cfg,
            )

        assert len(sent) == 1
        assert sent[0]["to"] == "@user1"

    # ----------------------------------------------------------
    # main loop: 発火メッセージに返信先付与
    # ----------------------------------------------------------

    def _run_main_with_entry(self, tmp_path: Path, entry: dict) -> list:
        cfg = tmp_path / "schedules.json"
        cfg.write_text(json.dumps([entry]), encoding="utf-8")
        fired_args: list = []
        sched._shutdown_event.clear()

        def fake_send_dm(headers, session_id, to, message, caused_by=None):
            fired_args.append({"to": to, "message": message, "caused_by": caused_by})
            sched._shutdown_event.set()
            return {}

        with patch.object(sched, "build_headers", return_value={}), \
             patch.object(sched, "resolve_user_id", return_value="@test-user"), \
             patch.object(sched, "init_session", return_value="test-sess"), \
             patch.object(sched, "send_dm", side_effect=fake_send_dm), \
             patch.object(sched, "save_schedules"), \
             patch("threading.Thread"), \
             patch.dict(os.environ, {"SCHEDULER_CONFIG": str(cfg)}):
            sched.main()

        return fired_args

    def test_main_loop_fire_appends_reply_to(self, tmp_path: Path) -> None:
        """main loop 発火 → メッセージ末尾に「返信先: @<owner>」が付与される。"""
        past = (datetime.now(tz=timezone.utc) - timedelta(hours=1)).isoformat()
        entry = {
            "name": "test-reply-to",
            "run_at": past,
            "to": "@planner",
            "message": "scheduled-hello",
            "owner": "@ope",
            "one_shot": True,
        }

        fired_args = self._run_main_with_entry(tmp_path, entry)

        assert len(fired_args) == 1
        assert fired_args[0]["message"] == "scheduled-hello\n\n---\n返信先: @ope"

    # ----------------------------------------------------------
    # handle_inbox_command: /run コマンドの発火メッセージに返信先付与
    # ----------------------------------------------------------

    def test_run_command_appends_reply_to(self, tmp_path: Path) -> None:
        """/run <name> 即時 fire → 発火メッセージ末尾に返信先が付与される。"""
        from datetime import timezone, timedelta
        cfg = tmp_path / "schedules.json"
        future = datetime.now(tz=timezone.utc) + timedelta(hours=1)
        entry = _valid_oneshot_entry(name="myshot", message="run-me", owner="@alice")
        schedules = [entry]
        iters = [None]
        next_times = [future]

        fired_args: list = []

        def fake_send_dm(headers, session_id, to, message, caused_by=None):
            fired_args.append({"to": to, "message": message})
            return {}

        with patch.object(sched, "send_dm", side_effect=fake_send_dm):
            sched.handle_inbox_command(
                headers={},
                session_id="sess-1",
                sender="@alice",
                body="/run myshot",
                schedules=schedules,
                iters=iters,
                next_times=next_times,
                config_path=cfg,
            )

        # fired_args[0] = fire to @planner, fired_args[1] = [OK] reply to @alice
        assert fired_args[0]["to"] == "@planner"
        assert fired_args[0]["message"] == "run-me\n\n---\n返信先: @alice"


# ============================================================
# issue #362: SSE ループが MCP ping に response を返す
# ============================================================

class _StopSseLoop(BaseException):
    """`sse_listen_loop` の無限 loop を test から脱出させる sentinel。

    `BaseException` 派生なので loop 内の `except Exception` に捕まらず、
    patch した `time.sleep` から raise すると loop 外まで propagate する。
    """


class _FakeSseResponse:
    """`requests.get(..., stream=True)` の戻り値 stub (= context manager + iter_lines)。"""

    def __init__(self, lines: list[str], status_code: int = 200) -> None:
        self._lines = lines
        self.status_code = status_code
        self.text = ""

    def __enter__(self) -> "_FakeSseResponse":
        return self

    def __exit__(self, *_exc) -> bool:
        return False

    def iter_lines(self, decode_unicode: bool = False):
        yield from self._lines


class _FakePostResponse:
    def __init__(self, status_code: int = 202) -> None:
        self.status_code = status_code
        self.text = ""


def _run_sse_loop_once(
    tmp_path: Path,
    lines: list[str],
    inbox: list[dict],
    fetch_hook=None,
):
    """fake SSE stream を 1 周だけ流して (pong POST, fetch 回数, 既読化) を返す。

    loop 末尾の `time.sleep` を sentinel raise に差し替えて 1 周で脱出する。
    issue #374 以降 pong / inbox dispatch は worker thread 上で走るが、
    `sse_listen_loop` は stream 終了時に worker を join してから
    `time.sleep` に入るため、 戻り値は決定的。
    `fake_fetch_inbox` に blocking 動作を差し込みたい場合は
    `fetch_hook` を渡す (= starvation 回帰 test 用)。
    """
    cfg = tmp_path / "schedules.json"
    cfg.write_text("[]", encoding="utf-8")

    pongs: list = []
    fetch_calls: list = []
    marked: list = []
    commands: list = []

    def fake_get(url, headers=None, stream=None, timeout=None):
        return _FakeSseResponse(lines)

    def fake_post(url, headers=None, data=None, timeout=None):
        pongs.append(json.loads(data.decode("utf-8")))
        return _FakePostResponse(202)

    def fake_fetch_inbox(headers, session_id):
        fetch_calls.append(session_id)
        if fetch_hook is not None:
            fetch_hook()
        return list(inbox)

    def fake_sleep(_secs):
        raise _StopSseLoop()

    with patch.object(sched, "init_session", return_value="sess-fake"), \
         patch.object(sched, "register_self"), \
         patch.object(sched, "subscribe_inbox"), \
         patch.object(sched, "fetch_inbox", side_effect=fake_fetch_inbox), \
         patch.object(sched, "mark_message_read", side_effect=lambda h, s, m: marked.append(m)), \
         patch.object(sched, "handle_inbox_command", side_effect=lambda *a, **k: commands.append(a[2:4])), \
         patch("scheduler.requests.get", side_effect=fake_get), \
         patch("scheduler.requests.post", side_effect=fake_post), \
         patch("scheduler.time.sleep", side_effect=fake_sleep):
        try:
            sched.sse_listen_loop({}, "scheduler", [], [], [], cfg)
        except _StopSseLoop:
            pass

    return pongs, fetch_calls, marked, commands


class TestIssue362:
    """issue #362: server→client の MCP `ping` request に空 result を返す。

    実 hub への接続は CI で張れないため、 SSE stream を `_FakeSseResponse` で
    差し替えた fake SSE による unit test で検証する。
    """

    # ----------------------------------------------------------
    # _parse_sse_data_line
    # ----------------------------------------------------------

    def test_parse_data_line_returns_dict(self) -> None:
        """`data: <json>` 行 → dict を返す。"""
        msg = sched._parse_sse_data_line(
            'data: {"jsonrpc":"2.0","id":7,"method":"ping"}'
        )
        assert msg == {"jsonrpc": "2.0", "id": 7, "method": "ping"}

    def test_parse_data_line_ignores_non_data_lines(self) -> None:
        """`event:` / `id:` 行と空 data → None。"""
        assert sched._parse_sse_data_line("event: message") is None
        assert sched._parse_sse_data_line("id: 12") is None
        assert sched._parse_sse_data_line("data:") is None
        assert sched._parse_sse_data_line("data:   ") is None

    def test_parse_data_line_ignores_broken_json(self) -> None:
        """JSON parse 不能 / 非 dict payload → None (= 例外を投げない)。"""
        assert sched._parse_sse_data_line('data: {"jsonrpc":') is None
        assert sched._parse_sse_data_line("data: [1, 2, 3]") is None

    def test_parse_data_line_handles_utf8_body(self) -> None:
        """非 ASCII を含む data 行も正常 parse (= ensure_ascii=False 前提)。"""
        msg = sched._parse_sse_data_line(
            'data: {"method":"notifications/message","params":{"text":"日本語"}}'
        )
        assert msg is not None
        assert msg["params"]["text"] == "日本語"

    # ----------------------------------------------------------
    # respond_ping
    # ----------------------------------------------------------

    def test_respond_ping_posts_empty_result(self) -> None:
        """respond_ping → `{"jsonrpc":"2.0","id":<id>,"result":{}}` を POST する。"""
        with patch("scheduler.requests.post", return_value=_FakePostResponse(202)) as mock_post:
            sched.respond_ping({"Accept": "application/json"}, "sess-abc", 42)

        assert mock_post.call_count == 1
        kwargs = mock_post.call_args.kwargs
        assert kwargs["headers"]["mcp-session-id"] == "sess-abc"
        body = json.loads(kwargs["data"].decode("utf-8"))
        assert body == {"jsonrpc": "2.0", "id": 42, "result": {}}
        # JSON-RPC response なので method field は含まない (= "pong" method は存在しない)
        assert "method" not in body

    def test_respond_ping_accepts_200_and_202(self) -> None:
        """202 (= response-only POST の正) と 200 のどちらも WARN を出さない。"""
        for status in (200, 202):
            with patch("scheduler.requests.post", return_value=_FakePostResponse(status)):
                with patch("scheduler.print") as mock_print:
                    sched.respond_ping({}, "sess-abc", 1)
                assert mock_print.call_count == 0

    def test_respond_ping_warns_on_error_status(self) -> None:
        """4xx/5xx では WARN log を出すが例外は投げない (= issue #374 S6)。"""
        with patch("scheduler.requests.post", return_value=_FakePostResponse(404)):
            with patch("scheduler.print") as mock_print:
                sched.respond_ping({}, "sess-abc", 1)  # raise しないこと
        assert mock_print.call_count == 1
        logged = mock_print.call_args.args[0]
        assert "[WARN] ping response failed: HTTP 404" in logged

    def test_respond_ping_uses_short_timeout(self) -> None:
        """POST timeout は server の PING_TIMEOUT_MS (10s) より短い (= issue #374 Minor 2)。"""
        with patch("scheduler.requests.post", return_value=_FakePostResponse(202)) as mock_post:
            sched.respond_ping({}, "sess-abc", 1)
        assert mock_post.call_args.kwargs["timeout"] == sched.PING_RESPONSE_TIMEOUT_SEC
        assert sched.PING_RESPONSE_TIMEOUT_SEC < 10

    # ----------------------------------------------------------
    # _try_handle_ping (= issue #374 で queue 投入に変更)
    # ----------------------------------------------------------

    def test_try_handle_ping_enqueues_ping(self) -> None:
        """ping 行 → True を返し request id を responder queue に積む。"""
        q: queue.Queue = queue.Queue()
        assert sched._try_handle_ping(
            'data: {"jsonrpc":"2.0","id":3,"method":"ping"}', q
        ) is True
        assert q.get_nowait() == 3

    def test_try_handle_ping_enqueues_id_zero(self) -> None:
        """id=0 の ping も積む (= falsy な id を取りこぼさない)。"""
        q: queue.Queue = queue.Queue()
        assert sched._try_handle_ping(
            'data: {"jsonrpc":"2.0","id":0,"method":"ping"}', q
        ) is True
        assert q.get_nowait() == 0

    def test_try_handle_ping_ignores_other_methods(self) -> None:
        """ping 以外の行 → False (= 既存の inbox 判定に素通りさせる)。"""
        q: queue.Queue = queue.Queue()
        assert sched._try_handle_ping(
            'data: {"jsonrpc":"2.0","method":"notifications/resources/updated",'
            '"params":{"uri":"inbox://@scheduler"}}',
            q,
        ) is False
        assert q.empty()

    def test_try_handle_ping_skips_ping_notification(self) -> None:
        """id 無し ping (= notification) には response を返さない (JSON-RPC 仕様)。"""
        q: queue.Queue = queue.Queue()
        assert sched._try_handle_ping(
            'data: {"jsonrpc":"2.0","method":"ping"}', q
        ) is True
        assert q.empty()

    def test_try_handle_ping_does_not_block_reader(self) -> None:
        """reader thread 側は POST しない (= respond_ping を呼ばない)。"""
        q: queue.Queue = queue.Queue()
        with patch.object(sched, "respond_ping") as mock_respond:
            sched._try_handle_ping(
                'data: {"jsonrpc":"2.0","id":9,"method":"ping"}', q
            )
        assert mock_respond.call_count == 0

    # ----------------------------------------------------------
    # sse_listen_loop (= fake SSE stream での統合)
    # ----------------------------------------------------------

    def test_sse_loop_answers_ping_frame(self, tmp_path: Path) -> None:
        """fake SSE の ping frame → 空 result の response を POST する。"""
        lines = [
            "event: message",
            "id: 1",
            'data: {"jsonrpc":"2.0","id":11,"method":"ping"}',
            "",
        ]
        pongs, fetch_calls, _marked, _cmds = _run_sse_loop_once(tmp_path, lines, [])

        assert pongs == [{"jsonrpc": "2.0", "id": 11, "result": {}}]
        # ping は inbox fetch を発生させない
        assert fetch_calls == []

    def test_sse_loop_inbox_push_not_regressed(self, tmp_path: Path) -> None:
        """既存の `notifications/resources/updated` 経路が退行しない。"""
        lines = [
            "event: message",
            "id: 1",
            'data: {"jsonrpc":"2.0","method":"notifications/resources/updated",'
            '"params":{"uri":"inbox://@scheduler"}}',
            "",
        ]
        inbox = [{"id": "msg-1", "from": "@alice", "message": "/ping"}]
        pongs, fetch_calls, marked, commands = _run_sse_loop_once(
            tmp_path, lines, inbox
        )

        assert fetch_calls == ["sess-fake"]
        assert marked == ["msg-1"]
        assert commands == [("@alice", "/ping")]
        # inbox push は pong POST を生まない
        assert pongs == []

    def test_sse_loop_handles_ping_then_inbox_push(self, tmp_path: Path) -> None:
        """ping → inbox push の混在 stream で両方処理される。"""
        lines = [
            "event: message",
            "id: 1",
            'data: {"jsonrpc":"2.0","id":5,"method":"ping"}',
            "",
            "event: message",
            "id: 2",
            'data: {"jsonrpc":"2.0","method":"notifications/resources/updated",'
            '"params":{"uri":"inbox://@scheduler"}}',
            "",
        ]
        inbox = [{"id": "msg-2", "from": "@bob", "message": "/list"}]
        pongs, fetch_calls, marked, commands = _run_sse_loop_once(
            tmp_path, lines, inbox
        )

        assert pongs == [{"jsonrpc": "2.0", "id": 5, "result": {}}]
        assert fetch_calls == ["sess-fake"]
        assert marked == ["msg-2"]
        assert commands == [("@bob", "/list")]


class TestIssue374:
    """issue #374: SSE reader thread から pong / inbox dispatch を分離する。

    reader thread が POST でブロックされる間 `iter_lines` が消費されず ping 行が
    読まれない (= starvation) のが本丸。 module 直下の `_run_sse_loop_once`
    harness (= TestIssue362 と共用) で fake SSE 統合も検証する。
    """

    # ----------------------------------------------------------
    # S4: request_id の型検証
    # ----------------------------------------------------------

    def test_valid_request_id_accepts_str_and_int(self) -> None:
        """JSON-RPC の id は String / Number のみ許す。"""
        assert sched._valid_request_id("abc") is True
        assert sched._valid_request_id(0) is True
        assert sched._valid_request_id(-1) is True

    def test_valid_request_id_rejects_bool_and_containers(self) -> None:
        """bool (= int の subclass) / list / dict / float でない非 Number は弾く。"""
        assert sched._valid_request_id(True) is False
        assert sched._valid_request_id(False) is False
        assert sched._valid_request_id([1]) is False
        assert sched._valid_request_id({"a": 1}) is False

    def test_try_handle_ping_drops_invalid_id(self) -> None:
        """不正な型の id は queue に積まず WARN して True (= 行は消費済み)。"""
        q: queue.Queue = queue.Queue()
        with patch("scheduler.print") as mock_print:
            handled = sched._try_handle_ping(
                'data: {"jsonrpc":"2.0","id":true,"method":"ping"}', q
            )
        assert handled is True
        assert q.empty()
        assert "invalid id type" in mock_print.call_args.args[0]

    def test_try_handle_ping_drops_when_queue_full(self) -> None:
        """responder queue が満杯なら落として WARN (= 例外を投げない)。"""
        q: queue.Queue = queue.Queue(maxsize=1)
        q.put_nowait(1)
        with patch("scheduler.print") as mock_print:
            handled = sched._try_handle_ping(
                'data: {"jsonrpc":"2.0","id":2,"method":"ping"}', q
            )
        assert handled is True
        assert "ping queue full" in mock_print.call_args.args[0]

    # ----------------------------------------------------------
    # _ping_responder_loop
    # ----------------------------------------------------------

    def test_ping_responder_answers_queued_pings(self) -> None:
        """queue に積まれた id に対し respond_ping を呼ぶ。"""
        q: queue.Queue = queue.Queue()
        q.put_nowait(1)
        q.put_nowait(2)
        stop = threading.Event()
        answered: list = []

        def fake_respond(_h, _s, request_id):
            answered.append(request_id)
            if len(answered) == 2:
                stop.set()

        with patch.object(sched, "respond_ping", side_effect=fake_respond):
            sched._ping_responder_loop({}, "sess-1", q, stop)

        assert answered == [1, 2]

    def test_ping_responder_drops_pings_after_stop(self) -> None:
        """stop_event 済み (= stream 切断後) は queue の残りを POST しない。"""
        q: queue.Queue = queue.Queue()
        q.put_nowait(7)
        stop = threading.Event()
        stop.set()

        with patch.object(sched, "respond_ping") as mock_respond:
            sched._ping_responder_loop({}, "sess-1", q, stop)

        assert mock_respond.call_count == 0

    def test_ping_responder_survives_post_failure(self) -> None:
        """respond_ping が例外を投げても worker は落ちない。"""
        q: queue.Queue = queue.Queue()
        q.put_nowait(1)
        stop = threading.Event()

        def boom(_h, _s, _id):
            stop.set()
            raise RuntimeError("boom")

        with patch.object(sched, "respond_ping", side_effect=boom):
            with patch("scheduler.print") as mock_print:
                sched._ping_responder_loop({}, "sess-1", q, stop)

        assert any("[ERR sse ping]" in c.args[0] for c in mock_print.call_args_list)

    def test_ping_responder_logs_summary_not_every_ping(self) -> None:
        """pong log は N 本ごとの summary に集約する (= issue #374 S5)。"""
        q: queue.Queue = queue.Queue()
        stop = threading.Event()
        total = sched._PING_LOG_SUMMARY_EVERY
        for i in range(total):
            q.put_nowait(i)

        def fake_respond(_h, _s, request_id):
            if request_id == total - 1:
                stop.set()

        with patch.object(sched, "respond_ping", side_effect=fake_respond):
            with patch("scheduler.print") as mock_print:
                sched._ping_responder_loop({}, "sess-1", q, stop)

        pong_logs = [c for c in mock_print.call_args_list if "[sse-pong]" in c.args[0]]
        assert len(pong_logs) == 1
        assert f"answered {total} pings" in pong_logs[0].args[0]

    # ----------------------------------------------------------
    # _inbox_worker_loop
    # ----------------------------------------------------------

    def test_inbox_worker_processes_then_stops(self) -> None:
        """sentinel の前に積まれた通知は処理してから終了する。"""
        q: queue.Queue = queue.Queue()
        q.put_nowait(sched._INBOX_POLL)
        q.put_nowait(sched._STOP_WORKER)
        marked: list = []
        commands: list = []

        with patch.object(
            sched, "fetch_inbox",
            return_value=[{"id": "m1", "from": "@alice", "message": "/ping"}],
        ), patch.object(
            sched, "handle_inbox_command",
            side_effect=lambda *a, **k: commands.append(a[2:4]),
        ), patch.object(
            sched, "mark_message_read", side_effect=lambda h, s, m: marked.append(m)
        ):
            sched._inbox_worker_loop({}, "sess-1", q, [], [], [], Path("x.json"))

        assert commands == [("@alice", "/ping")]
        assert marked == ["m1"]

    def test_inbox_worker_swallows_dispatch_error(self) -> None:
        """dispatch 中の例外は log のみで worker を落とさない。"""
        q: queue.Queue = queue.Queue()
        q.put_nowait(sched._INBOX_POLL)
        q.put_nowait(sched._STOP_WORKER)

        with patch.object(sched, "fetch_inbox", side_effect=RuntimeError("boom")):
            with patch("scheduler.print") as mock_print:
                sched._inbox_worker_loop({}, "sess-1", q, [], [], [], Path("x.json"))

        assert any(
            "[ERR sse inbox-handler]" in c.args[0] for c in mock_print.call_args_list
        )

    # ----------------------------------------------------------
    # starvation 回帰 (= 本丸)
    # ----------------------------------------------------------

    def test_ping_answered_while_inbox_handler_blocks(self, tmp_path: Path) -> None:
        """inbox 処理が長引いても pong は出る (= issue #374 Minor 2 の回帰 test)。

        reviewer 実測の再現条件 (= `fetch_inbox` を長時間ブロック) を event で
        模す。 分離前の実装では reader thread が `fetch_inbox` で止まり後続の
        ping 行を読めないため、 `pong_seen` が set されず timeout する。
        """
        pong_seen = threading.Event()
        pong_during_fetch: list[bool] = []

        def blocking_fetch() -> None:
            # fetch_inbox を長時間ブロックさせ、 その **最中に** pong が出るかを見る。
            # 分離前は reader thread がここで止まるため pong は出ず、 5s 待って
            # False が記録される (= 本 test が fail する)。
            pong_during_fetch.append(pong_seen.wait(timeout=5))

        lines = [
            "event: message",
            "id: 1",
            'data: {"jsonrpc":"2.0","method":"notifications/resources/updated",'
            '"params":{"uri":"inbox://@scheduler"}}',
            "",
            "event: message",
            "id: 2",
            'data: {"jsonrpc":"2.0","id":42,"method":"ping"}',
            "",
        ]

        with patch.object(sched, "respond_ping", side_effect=lambda *a: pong_seen.set()):
            _pongs, fetch_calls, _marked, _cmds = _run_sse_loop_once(
                tmp_path, lines, [], fetch_hook=blocking_fetch
            )

        assert pong_during_fetch == [True], (
            "inbox 処理中に pong が出ていない (= ping starvation)"
        )
        assert fetch_calls == ["sess-fake"]

    # ----------------------------------------------------------
    # _drain_ping_queue (= 切断時の pong 抑止、 issue #374 Minor 3)
    # ----------------------------------------------------------

    def test_drain_ping_queue_returns_when_empty(self) -> None:
        """queue が空なら grace を待たず即 return する。"""
        q: queue.Queue = queue.Queue()
        stop = threading.Event()
        started = time.monotonic()
        sched._drain_ping_queue(q, stop)
        assert time.monotonic() - started < sched._PING_DRAIN_GRACE_SEC

    def test_drain_ping_queue_gives_up_after_grace(self) -> None:
        """responder が捌けないまま grace を越えたら諦めて return する
        (= 以降の pong は stop_event 側で抑止される)。"""
        q: queue.Queue = queue.Queue()
        q.put_nowait(1)
        stop = threading.Event()
        with patch.object(sched, "_PING_DRAIN_GRACE_SEC", 0.3):
            started = time.monotonic()
            sched._drain_ping_queue(q, stop)
            elapsed = time.monotonic() - started
        assert 0.3 <= elapsed < 3
        # 諦めただけで queue の中身は消費していない (= responder が stop で捨てる)
        assert q.qsize() == 1

    def test_stream_close_stops_ping_responder(self, tmp_path: Path) -> None:
        """stream 終了で responder thread が終了する (= 後続 pong を出さない)。"""
        lines = [
            "event: message",
            "id: 1",
            'data: {"jsonrpc":"2.0","id":1,"method":"ping"}',
            "",
        ]
        before = {t.name for t in threading.enumerate()}
        _run_sse_loop_once(tmp_path, lines, [])
        after = {t.name for t in threading.enumerate()}
        assert "sse-ping-responder" not in after - before
        assert "sse-inbox-worker" not in after - before
