"""Tests for backup_service and backup RPC endpoints."""

import os
import unittest
from unittest.mock import patch

import database
from app.erp.services import backup_service


def _test_db_config():
    """The disposable test database, stated explicitly.

    Never resolved from the ambient environment: config.py's
    load_dotenv(override=True) puts the production DATABASE_URL back on every
    import, and a backup test that silently snapshots production is exactly
    the kind of accident TestingConfig's own constructor assertion exists to
    prevent.
    """
    from types import SimpleNamespace

    return SimpleNamespace(
        DATABASE_URL=None,
        DB_HOST=os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1")),
        DB_NAME=os.getenv("TEST_DB_NAME", "testdb"),
        DB_USER=os.getenv("TEST_DB_USER", os.getenv("DB_USER", "postgres")),
        DB_PASS=os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", "abcd")),
        TESTING=True,
    )


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

    def test_perform_full_backup_local_only(self):
        """A real pg_dump against the test database, with the Sheets exports
        skipped: PARTIAL, and a file pg_restore has confirmed it can read.

        Rewritten for DATA-001. The previous version mocked database.get_conn
        and fed the hand-rolled INSERT writer a MagicMock cursor -- so it
        asserted that a file appeared, which is the exact property that was
        never evidence of a backup. It also did
        ``patch.dict(os.environ, {}, clear=True)``, which wipes PATH; with the
        real implementation that means pg_dump cannot be found, and the run
        correctly reports FAILED. Only GOOGLE_APPLICATION_CREDENTIALS needs
        clearing to exercise "local snapshot only".
        """
        env = {k: v for k, v in os.environ.items()}
        env.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
        env.pop("GAS_MIRROR_SPREADSHEET_ID", None)
        env.pop("BACKUP_SPREADSHEET_ID", None)

        # Explicit config, not the ambient one. A plain unittest.TestCase has
        # no Flask app context, so db_backup._resolve_config() would fall back
        # to config.Config -- whose DATABASE_URL config.py's load_dotenv()
        # repopulates from .env, i.e. the PRODUCTION database. pg_dump is
        # read-only so nothing would be corrupted, but the test would be slow
        # and would drop a copy of live business data into backups/.
        with patch.dict(os.environ, env, clear=True):
            res = backup_service.perform_full_backup(config=_test_db_config())

        self.assertEqual(res["status"], "PARTIAL")
        self.assertIsNotNone(res["timestamp"])
        self.assertIsNotNone(res["local_file"])
        self.assertTrue(os.path.exists(res["local_file"]))

        # The properties that make it a backup rather than a file.
        self.assertTrue(res["snapshot_verified"])
        self.assertGreater(res["snapshot_table_count"], 0)
        self.assertGreater(res["snapshot_size_bytes"], 0)
        self.assertEqual(len(res["snapshot_sha256"]), 64)
        self.assertEqual(res["consecutive_failures"], 0)
        self.assertIn("Verified DB snapshot created", res["message"])
        self.assertIn("GOOGLE_APPLICATION_CREDENTIALS is not configured", res["message"])

        for path in (res["local_file"], res["local_file"] + ".sha256"):
            try:
                os.remove(path)
            except OSError:
                pass

    def test_snapshot_failure_is_reported_as_failed_not_partial(self):
        """The heart of DATA-001.

        The old code caught a per-table export error, wrote it into the output
        file as an SQL comment, and set ``local_success = True`` regardless --
        so a backup that captured three of fifty tables showed green on the
        dashboard. Nothing about "a convenience export was skipped" may ever
        make a missing snapshot look survivable.

        Clearing PATH makes pg_dump unfindable, which is a faithful stand-in
        for every way the dump can fail.
        """
        with patch.dict(os.environ, {}, clear=True):
            res = backup_service.perform_full_backup()

        self.assertEqual(res["status"], "FAILED")
        self.assertFalse(res["snapshot_verified"])
        self.assertIsNone(res["local_file"])
        self.assertIsNotNone(res["snapshot_error"])
        self.assertGreaterEqual(res["consecutive_failures"], 1)
        self.assertIn("SNAPSHOT FAILED", res["message"])

    def test_trigger_backup_rpc_reports_failure_to_the_caller(self):
        """A failed backup must not come back as success:true."""
        with patch.dict(os.environ, {}, clear=True):
            envelope = backup_service.rpc_trigger_backup()
        self.assertFalse(envelope["success"])

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
