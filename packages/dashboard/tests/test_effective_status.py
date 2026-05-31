"""
packages/dashboard/tests/test_effective_status.py

effective_status() のユニットテスト (issue #205)

テスト区分:
  A. auto-revert: done/stash 後に新メッセージが届いたら running に自動戻し
  B. no auto-revert: done/stash 後に新メッセージなし → status 維持
  C. no row + stale 時間超過 → stale
  D. no row + 最近活動あり → running
  E. no row + thread_end なし → running
  F. tenant_id=None フォールバック (= 'default' でキー lookup)

実行:
  python3 -m pytest packages/dashboard/tests/
  python3 -m unittest discover -s packages/dashboard/tests
"""
import os
import sys
import unittest

# packages/dashboard/ を sys.path に追加 (server.py を直接 import するため)
_DASHBOARD_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _DASHBOARD_DIR not in sys.path:
    sys.path.insert(0, _DASHBOARD_DIR)

from server import effective_status  # noqa: E402

# ── テスト用固定タイムスタンプ ──────────────────────────────────────────────
# 実時刻に依存しない絶対値を使用 (datetime.now() モック不要)
_TS_OLD    = "2020-01-01T00:00:00.000Z"   # 遠い過去 → STALE_HOURS (24h) を確実に超過
_TS_FUTURE = "2099-01-01T00:00:00.000Z"   # 遠い未来 → stale にならない
_TS_MARK   = "2026-06-01T00:00:00.000Z"   # mark 時刻 (固定)
_TS_AFTER  = "2026-06-01T01:00:00.000Z"   # mark より 1 時間後 (新メッセージ到達)
_TS_BEFORE = "2026-05-31T23:00:00.000Z"   # mark より 1 時間前 (旧メッセージ)
_TS_SAME   = "2026-06-01T00:00:00.000Z"   # mark と同時刻 (境界値)

ROOT   = "test-root-0000-0000-0000-000000000001"
TENANT = "default"


def _row(status, updated_at=_TS_MARK):
    """status_map の value dict を生成するヘルパー"""
    return {
        "status":     status,
        "updated_at": updated_at,
        "updated_by": None,
        "note":       None,
    }


def _smap(status, updated_at=_TS_MARK, tenant=TENANT):
    """root_id / tenant_id キーで 1 行持つ status_map を生成"""
    return {(ROOT, tenant): _row(status, updated_at)}


# ── A/B: auto-revert ロジック ──────────────────────────────────────────────

class TestAutoRevert(unittest.TestCase):
    """done/stash 後の新メッセージ到達で running に自動戻し (issue #202 仕様)"""

    def test_done_new_message_reverts_to_running(self):
        """done + last_ts > mark_ts (新メッセージあり) → running"""
        result = effective_status(ROOT, TENANT, _TS_AFTER, _smap("done"))
        self.assertEqual(result, "running")

    def test_stash_new_message_reverts_to_running(self):
        """stash + last_ts > mark_ts (新メッセージあり) → running"""
        result = effective_status(ROOT, TENANT, _TS_AFTER, _smap("stash"))
        self.assertEqual(result, "running")

    def test_done_no_new_message_stays_done(self):
        """done + last_ts < mark_ts (新メッセージなし) → done 維持"""
        result = effective_status(ROOT, TENANT, _TS_BEFORE, _smap("done"))
        self.assertEqual(result, "done")

    def test_stash_no_new_message_stays_stash(self):
        """stash + last_ts < mark_ts (新メッセージなし) → stash 維持"""
        result = effective_status(ROOT, TENANT, _TS_BEFORE, _smap("stash"))
        self.assertEqual(result, "stash")

    def test_done_same_ts_boundary_stays_done(self):
        """done + last_ts == mark_ts (境界値: 同時刻) → done 維持 (> でなく ==)"""
        result = effective_status(ROOT, TENANT, _TS_SAME, _smap("done"))
        self.assertEqual(result, "done")

    def test_running_row_not_subject_to_auto_revert(self):
        """running 行は auto-revert 対象外 → running のまま"""
        result = effective_status(ROOT, TENANT, _TS_AFTER, _smap("running"))
        self.assertEqual(result, "running")

    def test_done_thread_end_none_no_revert(self):
        """done + thread_end=None → auto-revert 不発、done 維持"""
        result = effective_status(ROOT, TENANT, None, _smap("done"))
        self.assertEqual(result, "done")

    def test_done_updated_at_none_no_revert(self):
        """done + updated_at=None → mark_ts 取得不可、auto-revert 不発、done 維持"""
        smap = {(ROOT, TENANT): _row("done", updated_at=None)}
        result = effective_status(ROOT, TENANT, _TS_AFTER, smap)
        self.assertEqual(result, "done")


# ── C/D/E: no row (status 未設定) ─────────────────────────────────────────

class TestNoRow(unittest.TestCase):
    """status_map に行がない場合の stale / running 判定"""

    def test_old_thread_end_returns_stale(self):
        """status 未設定 + thread_end が遠い過去 → stale (STALE_HOURS 超過)"""
        result = effective_status(ROOT, TENANT, _TS_OLD, {})
        self.assertEqual(result, "stale")

    def test_future_thread_end_returns_running(self):
        """status 未設定 + thread_end が未来 → running (stale でない)"""
        result = effective_status(ROOT, TENANT, _TS_FUTURE, {})
        self.assertEqual(result, "running")

    def test_no_thread_end_returns_running(self):
        """status 未設定 + thread_end=None → running"""
        result = effective_status(ROOT, TENANT, None, {})
        self.assertEqual(result, "running")


# ── F: tenant_id フォールバック ────────────────────────────────────────────

class TestTenantFallback(unittest.TestCase):
    """tenant_id=None は 'default' として lookup する"""

    def test_tenant_none_no_row_returns_running(self):
        """tenant_id=None + 行なし → 'default' キーで lookup → 行なし → running"""
        result = effective_status(ROOT, None, _TS_FUTURE, {})
        self.assertEqual(result, "running")

    def test_tenant_none_with_default_row_matches(self):
        """tenant_id=None + (ROOT, 'default') 行あり → done を返す"""
        smap = {(ROOT, "default"): _row("done", _TS_MARK)}
        result = effective_status(ROOT, None, _TS_BEFORE, smap)
        self.assertEqual(result, "done")

    def test_tenant_none_done_with_new_message_reverts(self):
        """tenant_id=None + done 行 + 新メッセージ → running (auto-revert 適用)"""
        smap = {(ROOT, "default"): _row("done", _TS_MARK)}
        result = effective_status(ROOT, None, _TS_AFTER, smap)
        self.assertEqual(result, "running")


if __name__ == "__main__":
    unittest.main(verbosity=2)
