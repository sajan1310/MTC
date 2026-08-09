"""Tests for backup_service and backup RPC endpoints."""

import os
import unittest
from unittest.mock import MagicMock, patch

import database
from app.erp.services import backup_service


class TestBackupService(unittest.TestCase):
    def setUp(self):
        # Reset last backup status for predictable test state
        with backup_service._STATUS_LOCK:
            backup_service._LAST_BACKUP_STATUS.update({
                "timestamp": None,
                "status": "NEVER",
                "message": "No backup has been executed yet.",
                "spreadsheet_id": None,
                "spreadsheet_url": None,
                "local_file": None,
                "mirror_status": None,
                "mirror_message": None,
                "nightly_scheduler_active": False,
            })

    def test_get_backup_dir(self):
        backup_dir = backup_service.get_backup_dir()
        self.assertTrue(os.path.exists(backup_dir))
        self.assertTrue(backup_dir.endswith("backups"))

    @patch("app.erp.services.backup_service.database.get_conn")
    def test_perform_full_backup_local_only(self, mock_get_conn):
        mock_conn = MagicMock()
        mock_cur = MagicMock()
        mock_cur.fetchall.return_value = [("units",)]
        mock_cur.description = [("id",), ("name",)]
        mock_get_conn.return_value.__enter__.return_value = (mock_conn, mock_cur)

        # Clear GOOGLE_APPLICATION_CREDENTIALS so Google Sheets upload is skipped
        with patch.dict(os.environ, {}, clear=True):
            res = backup_service.perform_full_backup()

        self.assertEqual(res["status"], "PARTIAL")
        self.assertIsNotNone(res["timestamp"])
        self.assertIsNotNone(res["local_file"])
        self.assertTrue(os.path.exists(res["local_file"]))
        self.assertIn("Local DB snapshot created", res["message"])
        self.assertIn("GOOGLE_APPLICATION_CREDENTIALS is not configured", res["message"])

        # Cleanup created backup file
        if res["local_file"] and os.path.exists(res["local_file"]):
            try:
                os.remove(res["local_file"])
            except Exception:
                pass

    @patch("app.erp.services.backup_service.perform_full_backup")
    def test_rpc_trigger_backup(self, mock_perform):
        mock_perform.return_value = {
            "status": "SUCCESS",
            "message": "Synced to Google Sheets successfully.",
            "spreadsheet_id": "test_sheet_id_123",
            "spreadsheet_url": "https://docs.google.com/spreadsheets/d/test_sheet_id_123",
            "timestamp": "2026-08-03T12:00:00",
            "local_file": "/path/to/backup.sql",
        }

        res = backup_service.rpc_trigger_backup()
        self.assertTrue(res["success"])
        self.assertEqual(res["data"]["spreadsheet_id"], "test_sheet_id_123")

    def test_rpc_get_backup_status(self):
        res = backup_service.rpc_get_backup_status()
        self.assertTrue(res["success"])
        self.assertIn("status", res["data"])
        self.assertIn("nightly_scheduler_active", res["data"])


# Tables that legitimately have no backup_db_to_sheets.TABLES entry -- keep
# in sync with the exclusion comment above that list.
_KNOWN_EXCLUDED_FROM_BACKUP = {
    "erp.migrations_applied",
    "erp.bom_access_tokens",
    "erp.rpc_mutations",  # replay-idempotency cache, not business data
    "erp.dispatch_legacy",  # only exists on some databases, see comment
}


def test_backup_tables_list_covers_every_erp_table(app):
    """Regression test for the 2026-08-09 gap where erp.dispatch_plan_lines
    and erp.app_settings existed in the schema but were never added to
    backup_db_to_sheets.TABLES, so their data silently never made it into
    nightly backups (no error -- the table was just absent from the sheet).
    """
    backup_mod = backup_service._migration_module()

    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'erp' AND table_type = 'BASE TABLE'"
            )
            actual = {f"erp.{row[0]}" for row in cur.fetchall()}

    listed = set(backup_mod.TABLES)
    missing = actual - listed - _KNOWN_EXCLUDED_FROM_BACKUP

    assert not missing, (
        f"erp table(s) missing from backup_db_to_sheets.TABLES: {sorted(missing)}. "
        "Add them there (or to _KNOWN_EXCLUDED_FROM_BACKUP here with a reason) "
        "so nightly backups don't silently skip their data."
    )


if __name__ == "__main__":
    unittest.main()
