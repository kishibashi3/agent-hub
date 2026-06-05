"""
packages/dashboard/tests/test_shs_phase2.py

CDS（会話密度スコア）と MOR（meta-overhead 比率）のユニットテスト (issue #230)

テスト対象:
  - compute_cds_from_db()  : CDS 計算ロジック
  - compute_mor_from_db()  : MOR 計算ロジック
  - _sanitize_* / signal lists: 定数値チェック

テスト方式:
  Phase 1 テストと同様に、SQLite DB を一時ファイルに作成してテストデータを
  投入し compute_*_from_db() を直接呼ぶ。

実行:
  python3 -m pytest packages/dashboard/tests/test_shs_phase2.py -v
  python3 -m unittest discover -s packages/dashboard/tests
"""

from __future__ import annotations

import importlib
import os
import sqlite3
import sys
import tempfile
import unittest

# packages/dashboard/ を sys.path に追加 (server.py を直接 import するため)
_DASHBOARD_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _DASHBOARD_DIR not in sys.path:
    sys.path.insert(0, _DASHBOARD_DIR)

import server as _srv_module  # noqa: E402

# ============================================================
# DB fixture helpers
# ============================================================

_SCHEMA_MESSAGES = """
CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL DEFAULT 'default',
    sender     TEXT NOT NULL,
    recipient  TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    created_at TEXT
)
"""


def _create_db(rows: list[tuple]) -> str:
    """一時 SQLite DB を作成してメッセージ行を投入し、パスを返す。

    rows: [(id, tenant_id, sender, recipient, body, created_at), ...]
    """
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    con = sqlite3.connect(path)
    con.execute(_SCHEMA_MESSAGES)
    con.executemany(
        "INSERT INTO messages (id, tenant_id, sender, recipient, body, created_at) "
        "VALUES (?,?,?,?,?,?)",
        rows,
    )
    con.commit()
    con.close()
    return path


def _reload_server(db_path: str, tenant: str | None = None) -> None:
    """server.py のモジュールグローバル (DB_PATH, TENANT) を書き換えて再ロード。"""
    _srv_module.DB_PATH = db_path
    _srv_module.TENANT = tenant


# ============================================================
# TestCDSFromDB
# ============================================================

class TestCDSFromDB(unittest.TestCase):
    """compute_cds_from_db() の計算ロジックを確認する。"""

    def tearDown(self) -> None:
        # テスト間で DB_PATH / TENANT が漏れないようにリセット
        _srv_module.DB_PATH = "/app/data/app.db"
        _srv_module.TENANT  = None

    # ── empty DB ──────────────────────────────────────────────────────────────

    def test_empty_db_returns_none_score(self) -> None:
        """メッセージが 0 件のとき cds_score = None を返す。"""
        db = _create_db([])
        _reload_server(db)
        result = _srv_module.compute_cds_from_db()
        self.assertIsNone(result["cds_score"])
        self.assertEqual(result["total_msgs"], 0)
        os.unlink(db)

    def test_empty_db_by_sender_is_empty(self) -> None:
        """メッセージが 0 件のとき by_sender は空リスト。"""
        db = _create_db([])
        _reload_server(db)
        result = _srv_module.compute_cds_from_db()
        self.assertEqual(result["by_sender"], [])
        os.unlink(db)

    # ── 全メッセージが high ────────────────────────────────────────────────────

    def test_all_high_signals_gives_100_percent(self) -> None:
        """全メッセージが高密度シグナルのとき CDS = 100%。"""
        rows = [
            ("id1", "default", "@planner", "@impl", "PR を出しました #123", "2026-01-01T10:00:00Z"),
            ("id2", "default", "@reviewer", "@planner", "LGTM ✅ merge してください", "2026-01-01T10:01:00Z"),
            ("id3", "default", "@impl", "@planner", "実装完了しました", "2026-01-01T10:02:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_cds_from_db()
        self.assertEqual(result["cds_score"], 100.0)
        self.assertEqual(result["high_count"], 3)
        os.unlink(db)

    # ── 全メッセージが low ─────────────────────────────────────────────────────

    def test_all_low_signals_gives_0_percent(self) -> None:
        """全メッセージが低密度シグナルのとき CDS = 0%。"""
        rows = [
            ("id1", "default", "@impl", "@planner", "了解しました", "2026-01-01T10:00:00Z"),
            ("id2", "default", "@planner", "@impl",   "承知しました", "2026-01-01T10:01:00Z"),
            ("id3", "default", "@impl", "@planner", "待機中です", "2026-01-01T10:02:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_cds_from_db()
        self.assertEqual(result["cds_score"], 0.0)
        self.assertEqual(result["high_count"], 0)
        os.unlink(db)

    # ── 混在 ─────────────────────────────────────────────────────────────────

    def test_mixed_gives_correct_ratio(self) -> None:
        """高密度 2 件 / 低密度 2 件 = CDS 50%。"""
        rows = [
            ("id1", "default", "@planner", "@impl", "依頼します: レビューして", "2026-01-01T10:00:00Z"),
            ("id2", "default", "@impl",    "@planner", "完了しました", "2026-01-01T10:01:00Z"),
            ("id3", "default", "@planner", "@impl", "了解しました", "2026-01-01T10:02:00Z"),
            ("id4", "default", "@impl",    "@planner", "待機中", "2026-01-01T10:03:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_cds_from_db()
        self.assertEqual(result["cds_score"], 50.0)
        self.assertEqual(result["high_count"], 2)
        os.unlink(db)

    # ── high が low に優先 ─────────────────────────────────────────────────────

    def test_high_takes_priority_over_low(self) -> None:
        """high と low の両方にマッチするとき high として計上される。"""
        # "完了しました" は high、"了解しました" は low。
        # 両方を含むメッセージは high 優先。
        rows = [
            ("id1", "default", "@impl", "@planner",
             "完了しました。了解しました。", "2026-01-01T10:00:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_cds_from_db()
        self.assertEqual(result["high_count"], 1)
        self.assertEqual(result["cds_score"], 100.0)
        os.unlink(db)

    # ── 未分類は low として扱う ───────────────────────────────────────────────

    def test_unclassified_counted_as_low(self) -> None:
        """高でも低でもないシグナルのないメッセージは low（非進行型）として扱う。"""
        rows = [
            ("id1", "default", "@planner", "@impl",
             "今日の天気はどうですか", "2026-01-01T10:00:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_cds_from_db()
        self.assertEqual(result["cds_score"], 0.0)
        self.assertEqual(result["high_count"], 0)
        self.assertEqual(result["low_count"], 1)
        os.unlink(db)

    # ── by_sender ─────────────────────────────────────────────────────────────

    def test_by_sender_contains_sender_cds(self) -> None:
        """by_sender に各 sender の CDS が含まれる。"""
        rows = [
            ("id1", "default", "@reviewer", "@planner",
             "LGTM ✅ merge してください", "2026-01-01T10:00:00Z"),
            ("id2", "default", "@reviewer", "@planner",
             "了解しました", "2026-01-01T10:01:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_cds_from_db()
        by_sender = {s["sender"]: s for s in result["by_sender"]}
        self.assertIn("@reviewer", by_sender)
        # 高密度 1 / 全体 2 = 50%
        self.assertEqual(by_sender["@reviewer"]["cds"], 50.0)
        os.unlink(db)

    # ── tenant フィルタ ───────────────────────────────────────────────────────

    def test_tenant_filter_excludes_other_tenant(self) -> None:
        """TENANT 設定時は指定テナントのメッセージのみ集計される。"""
        rows = [
            ("id1", "tenant_a", "@planner", "@impl",
             "PR を出しました", "2026-01-01T10:00:00Z"),
            ("id2", "tenant_b", "@planner", "@impl",
             "了解しました", "2026-01-01T10:01:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db, tenant="tenant_a")
        result = _srv_module.compute_cds_from_db()
        self.assertEqual(result["total_msgs"], 1)
        self.assertEqual(result["cds_score"], 100.0)
        os.unlink(db)

    # ── total_msgs ────────────────────────────────────────────────────────────

    def test_total_msgs_equals_row_count(self) -> None:
        """total_msgs が全メッセージ数と一致する。"""
        rows = [
            (f"id{i}", "default", "@p", "@q", f"msg {i}", "2026-01-01T10:00:00Z")
            for i in range(7)
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_cds_from_db()
        self.assertEqual(result["total_msgs"], 7)
        os.unlink(db)


# ============================================================
# TestMORFromDB
# ============================================================

class TestMORFromDB(unittest.TestCase):
    """compute_mor_from_db() の計算ロジックを確認する。"""

    def tearDown(self) -> None:
        _srv_module.DB_PATH = "/app/data/app.db"
        _srv_module.TENANT  = None

    # ── empty DB ──────────────────────────────────────────────────────────────

    def test_empty_db_returns_none_rate(self) -> None:
        """メッセージが 0 件のとき mor_rate = None を返す。"""
        db = _create_db([])
        _reload_server(db)
        result = _srv_module.compute_mor_from_db()
        self.assertIsNone(result["mor_rate"])
        self.assertEqual(result["total_msgs"], 0)
        os.unlink(db)

    def test_empty_db_balance_score_is_none(self) -> None:
        """メッセージが 0 件のとき balance_score = None を返す。"""
        db = _create_db([])
        _reload_server(db)
        result = _srv_module.compute_mor_from_db()
        self.assertIsNone(result["balance_score"])
        os.unlink(db)

    # ── meta なし ────────────────────────────────────────────────────────────

    def test_no_meta_signals_gives_0_percent(self) -> None:
        """meta シグナルが含まれないとき MOR = 0.0%。"""
        rows = [
            ("id1", "default", "@impl",    "@planner", "PR を出しました", "2026-01-01T10:00:00Z"),
            ("id2", "default", "@reviewer", "@planner", "LGTM",           "2026-01-01T10:01:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_mor_from_db()
        self.assertEqual(result["mor_rate"], 0.0)
        self.assertEqual(result["meta_count"], 0)
        os.unlink(db)

    # ── MOR 計算 ──────────────────────────────────────────────────────────────

    def test_meta_ratio_calculation(self) -> None:
        """meta 1 件 / 全体 4 件 = 25.0%。"""
        rows = [
            ("id1", "default", "@ope", "@planner",
             "プロセスを変更します", "2026-01-01T10:00:00Z"),
            ("id2", "default", "@impl",  "@planner",
             "PR を出しました", "2026-01-01T10:01:00Z"),
            ("id3", "default", "@planner", "@impl",
             "依頼します", "2026-01-01T10:02:00Z"),
            ("id4", "default", "@reviewer", "@planner",
             "LGTM", "2026-01-01T10:03:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_mor_from_db()
        self.assertEqual(result["mor_rate"], 25.0)
        self.assertEqual(result["meta_count"], 1)
        os.unlink(db)

    # ── balance_score ────────────────────────────────────────────────────────

    def test_balance_score_max_at_25_percent_or_less(self) -> None:
        """MOR 25% 以下のとき balance_score = 100.0。"""
        # 1/4 = 25%
        rows = [
            ("id1", "default", "@ope", "@planner",
             "プロセスを変更します", "2026-01-01T10:00:00Z"),
            ("id2", "default", "@impl", "@planner",
             "PR を出しました", "2026-01-01T10:01:00Z"),
            ("id3", "default", "@planner", "@impl",
             "依頼します", "2026-01-01T10:02:00Z"),
            ("id4", "default", "@reviewer", "@planner",
             "LGTM", "2026-01-01T10:03:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_mor_from_db()
        self.assertEqual(result["balance_score"], 100.0)
        os.unlink(db)

    def test_balance_score_decreases_above_25_percent(self) -> None:
        """MOR 35% (= 10% 超過) のとき balance_score = 70.0。"""
        # 7/20 = 35%
        meta_row = ("meta", "default", "@ope", "@planner",
                    "CLAUDE.md を修正してください", "2026-01-01T10:00:00Z")
        normal_rows = [
            (f"n{i}", "default", "@impl", "@planner",
             "PR を出しました", "2026-01-01T10:00:00Z")
            for i in range(13)
        ]
        rows = [meta_row] * 7 + normal_rows
        # 7 meta + 13 normal = 20 total, MOR = 35%
        # balance_score = 100 - max(0, 35 - 25) * 3 = 100 - 30 = 70
        db = _create_db([
            (f"id{i}", "default", r[2], r[3], r[4], r[5])
            for i, r in enumerate(rows)
        ])
        _reload_server(db)
        result = _srv_module.compute_mor_from_db()
        self.assertEqual(result["mor_rate"], 35.0)
        self.assertEqual(result["balance_score"], 70.0)
        os.unlink(db)

    def test_balance_score_minimum_is_zero(self) -> None:
        """MOR が非常に高い (58%超) とき balance_score は 0 を下回らない。"""
        # 全メッセージが meta シグナルを含む
        rows = [
            (f"id{i}", "default", "@ope", "@planner",
             "bridge を再起動してください", "2026-01-01T10:00:00Z")
            for i in range(10)
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_mor_from_db()
        self.assertGreaterEqual(result["balance_score"], 0.0)
        os.unlink(db)

    # ── top_meta_senders ─────────────────────────────────────────────────────

    def test_top_meta_senders_sorted_by_meta_count(self) -> None:
        """top_meta_senders が meta 件数降順に並んでいる。"""
        rows = [
            ("id1", "default", "@ope",     "@planner", "respawn してください", "2026-01-01T10:00:00Z"),
            ("id2", "default", "@ope",     "@planner", "プロセスを変更します", "2026-01-01T10:01:00Z"),
            ("id3", "default", "@planner", "@impl",    "CLAUDE.md を修正してください", "2026-01-01T10:02:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_mor_from_db()
        senders = [s["sender"] for s in result["top_meta_senders"]]
        self.assertEqual(senders[0], "@ope")  # 2件 (最多)
        self.assertIn("@planner", senders)
        os.unlink(db)

    def test_no_meta_signals_top_senders_empty(self) -> None:
        """meta シグナルが 0 件のとき top_meta_senders は空リスト。"""
        rows = [
            ("id1", "default", "@impl", "@planner", "PR を出しました", "2026-01-01T10:00:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db)
        result = _srv_module.compute_mor_from_db()
        self.assertEqual(result["top_meta_senders"], [])
        os.unlink(db)

    # ── tenant フィルタ ───────────────────────────────────────────────────────

    def test_tenant_filter_excludes_other_tenant(self) -> None:
        """TENANT 設定時は指定テナントのメッセージのみ集計される。"""
        rows = [
            ("id1", "tenant_a", "@ope", "@planner",
             "プロセスを変更します", "2026-01-01T10:00:00Z"),
            ("id2", "tenant_b", "@impl", "@planner",
             "PR を出しました", "2026-01-01T10:01:00Z"),
        ]
        db = _create_db(rows)
        _reload_server(db, tenant="tenant_a")
        result = _srv_module.compute_mor_from_db()
        self.assertEqual(result["total_msgs"], 1)
        self.assertEqual(result["meta_count"], 1)
        self.assertEqual(result["mor_rate"], 100.0)
        os.unlink(db)


# ============================================================
# TestCDSConstants
# ============================================================

class TestCDSConstants(unittest.TestCase):
    """CDS 定数の基本的な整合性を確認する。"""

    def test_cds_high_signals_nonempty(self) -> None:
        self.assertGreater(len(_srv_module.CDS_HIGH_SIGNALS), 0)

    def test_cds_low_signals_nonempty(self) -> None:
        self.assertGreater(len(_srv_module.CDS_LOW_SIGNALS), 0)

    def test_cds_warning_gt_danger_threshold(self) -> None:
        """WARNING 閾値 > DANGER 閾値 (= 50 > 40) でなければならない。"""
        self.assertGreater(
            _srv_module.CDS_WARNING_THRESHOLD,
            _srv_module.CDS_DANGER_THRESHOLD,
        )

    def test_lgtm_in_high_signals(self) -> None:
        """LGTM は高密度シグナルに含まれる (完了型)。"""
        self.assertIn("LGTM", _srv_module.CDS_HIGH_SIGNALS)

    def test_standby_in_low_signals(self) -> None:
        """standby は低密度シグナルに含まれる。"""
        self.assertIn("standby", _srv_module.CDS_LOW_SIGNALS)


# ============================================================
# TestMORConstants
# ============================================================

class TestMORConstants(unittest.TestCase):
    """MOR 定数の基本的な整合性を確認する。"""

    def test_meta_signals_nonempty(self) -> None:
        self.assertGreater(len(_srv_module.META_SIGNALS), 0)

    def test_mor_ideal_max_lt_warning_lt_danger(self) -> None:
        """MOR_IDEAL_MAX < MOR_WARNING < MOR_DANGER の順序が正しい。"""
        self.assertLess(_srv_module.MOR_IDEAL_MAX, _srv_module.MOR_WARNING)
        self.assertLess(_srv_module.MOR_WARNING,   _srv_module.MOR_DANGER)

    def test_respawn_in_meta_signals(self) -> None:
        """respawn はシステム管理シグナルに含まれる。"""
        self.assertIn("respawn", _srv_module.META_SIGNALS)

    def test_claude_md_in_meta_signals(self) -> None:
        """CLAUDE.md 関連は meta シグナルに含まれる。"""
        any_claude_md = any("CLAUDE.md" in s for s in _srv_module.META_SIGNALS)
        self.assertTrue(any_claude_md)


if __name__ == "__main__":
    unittest.main()
