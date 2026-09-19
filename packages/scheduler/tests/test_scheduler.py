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
import threading
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
        """4xx/5xx では WARN log を出すが例外は投げない。"""
        with patch("scheduler.requests.post", return_value=_FakePostResponse(404)):
            sched.respond_ping({}, "sess-abc", 1)  # raise しないこと

    # ----------------------------------------------------------
    # _try_handle_ping
    # ----------------------------------------------------------

    def test_try_handle_ping_responds_to_ping(self) -> None:
        """ping 行 → True を返し response を POST する。"""
        with patch.object(sched, "respond_ping") as mock_respond:
            handled = sched._try_handle_ping(
                {}, "sess-1", 'data: {"jsonrpc":"2.0","id":3,"method":"ping"}'
            )
        assert handled is True
        mock_respond.assert_called_once_with({}, "sess-1", 3)

    def test_try_handle_ping_responds_to_id_zero(self) -> None:
        """id=0 の ping にも response を返す (= falsy な id を取りこぼさない)。"""
        with patch.object(sched, "respond_ping") as mock_respond:
            handled = sched._try_handle_ping(
                {}, "sess-1", 'data: {"jsonrpc":"2.0","id":0,"method":"ping"}'
            )
        assert handled is True
        mock_respond.assert_called_once_with({}, "sess-1", 0)

    def test_try_handle_ping_ignores_other_methods(self) -> None:
        """ping 以外の行 → False (= 既存の inbox 判定に素通りさせる)。"""
        with patch.object(sched, "respond_ping") as mock_respond:
            handled = sched._try_handle_ping(
                {},
                "sess-1",
                'data: {"jsonrpc":"2.0","method":"notifications/resources/updated",'
                '"params":{"uri":"inbox://@scheduler"}}',
            )
        assert handled is False
        assert mock_respond.call_count == 0

    def test_try_handle_ping_skips_ping_notification(self) -> None:
        """id 無し ping (= notification) には response を返さない (JSON-RPC 仕様)。"""
        with patch.object(sched, "respond_ping") as mock_respond:
            handled = sched._try_handle_ping(
                {}, "sess-1", 'data: {"jsonrpc":"2.0","method":"ping"}'
            )
        assert handled is True
        assert mock_respond.call_count == 0

    def test_try_handle_ping_swallows_post_failure(self) -> None:
        """response POST が例外を投げても SSE loop を落とさない。"""
        with patch.object(sched, "respond_ping", side_effect=RuntimeError("boom")):
            handled = sched._try_handle_ping(
                {}, "sess-1", 'data: {"jsonrpc":"2.0","id":9,"method":"ping"}'
            )
        assert handled is True

    # ----------------------------------------------------------
    # sse_listen_loop (= fake SSE stream での統合)
    # ----------------------------------------------------------

    def _run_sse_loop_once(self, tmp_path: Path, lines: list[str], inbox: list[dict]):
        """fake SSE stream を 1 周だけ流して (pong POST, fetch 回数, 既読化) を返す。

        loop 末尾の `time.sleep` を sentinel raise に差し替えて 1 周で脱出する。
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

    def test_sse_loop_answers_ping_frame(self, tmp_path: Path) -> None:
        """fake SSE の ping frame → 空 result の response を POST する。"""
        lines = [
            "event: message",
            'data: {"jsonrpc":"2.0","id":11,"method":"ping"}',
            "",
        ]
        pongs, fetch_calls, _marked, _cmds = self._run_sse_loop_once(tmp_path, lines, [])

        assert pongs == [{"jsonrpc": "2.0", "id": 11, "result": {}}]
        # ping は inbox fetch を発生させない
        assert fetch_calls == []

    def test_sse_loop_inbox_push_not_regressed(self, tmp_path: Path) -> None:
        """既存の `notifications/resources/updated` 経路が退行しない。"""
        lines = [
            "event: message",
            'data: {"jsonrpc":"2.0","method":"notifications/resources/updated",'
            '"params":{"uri":"inbox://@scheduler"}}',
            "",
        ]
        inbox = [{"id": "msg-1", "from": "@alice", "message": "/ping"}]
        pongs, fetch_calls, marked, commands = self._run_sse_loop_once(
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
            'data: {"jsonrpc":"2.0","id":5,"method":"ping"}',
            "",
            "event: message",
            'data: {"jsonrpc":"2.0","method":"notifications/resources/updated",'
            '"params":{"uri":"inbox://@scheduler"}}',
            "",
        ]
        inbox = [{"id": "msg-2", "from": "@bob", "message": "/list"}]
        pongs, fetch_calls, marked, commands = self._run_sse_loop_once(
            tmp_path, lines, inbox
        )

        assert pongs == [{"jsonrpc": "2.0", "id": 5, "result": {}}]
        assert fetch_calls == ["sess-fake"]
        assert marked == ["msg-2"]
        assert commands == [("@bob", "/list")]
