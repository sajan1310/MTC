"""Tests for backup_service and backup RPC endpoints."""

import os
import unittest
from unittest.mock import MagicMock, patch

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


if __name__ == "__main__":
    unittest.main()
