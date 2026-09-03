"""Tests for backup_service and backup RPC endpoints."""

import os
import unittest
from unittest.mock import MagicMock, patch

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
            backup_service._LAST_BACKUP_STATUS.update(
                {
                    "timestamp": None,
                    "status": "NEVER",
                    "message": "No backup has been executed yet.",
                    "spreadsheet_id": None,
                    "spreadsheet_url": None,
                    "local_file": None,
                    "mirror_status": None,
                    "mirror_message": None,
                    "nightly_scheduler_active": False,
                }
            )

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
        self.assertIn(
            "GOOGLE_APPLICATION_CREDENTIALS is not configured", res["message"]
        )

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

    @patch("app.erp.services.backup_service.threading.Thread")
    @patch("app.erp.services.backup_service._read_run_state", return_value=None)
    def test_rpc_trigger_backup_returns_without_running_the_backup(
        self, _mock_read, mock_thread
    ):
        """triggerBackup starts the work; it must not wait for it.

        This is the fix for the dashboard's "The server did not respond
        within 45s" error. A full run is ~2 minutes of Google Sheets round
        trips, past both static/erp/api.js's 45s abort and gunicorn's
        --timeout 120, so the request can only ever start the job and hand
        back an id to poll on.
        """
        res = backup_service.rpc_trigger_backup()

        self.assertTrue(res["success"])
        self.assertEqual(res["data"]["status"], "STARTED")
        self.assertTrue(res["data"]["run_id"])
        # The run happens on a thread, and the id handed to the client is the
        # id that thread will publish under -- otherwise the client polls for
        # a run that never reports.
        mock_thread.assert_called_once()
        self.assertEqual(mock_thread.call_args.kwargs["args"][1], res["data"]["run_id"])
        mock_thread.return_value.start.assert_called_once()

    @patch("app.erp.services.backup_service.threading.Thread")
    def test_rpc_trigger_backup_watches_a_run_already_in_flight(self, mock_thread):
        """A second click must not start a second concurrent backup.

        It returns the RUNNING run's own id, not a fresh one: the client
        polls for the id it is given, and this is the run whose result it
        will actually see.
        """
        with patch.object(
            backup_service,
            "_read_run_state",
            return_value={"state": "RUNNING", "run_id": "abc123"},
        ):
            res = backup_service.rpc_trigger_backup()

        self.assertTrue(res["success"])
        self.assertEqual(res["data"]["run_id"], "abc123")
        self.assertTrue(res["data"]["already_running"])
        mock_thread.assert_not_called()

    def test_failed_run_publishes_a_terminal_failed_state(self):
        """A failed backup must still reach the operator.

        The trigger envelope no longer carries the outcome, so the guarantee
        that a failure is visible now rests entirely on the run publishing a
        terminal state for the browser to poll. If this record were missing
        or left RUNNING, the dashboard would spin and then time out -- which
        looks identical to a backup that is merely slow, and would let a
        genuinely broken backup pass for a working one.
        """
        writes = []
        cur = MagicMock()
        with patch.object(
            backup_service,
            "_write_run_state",
            side_effect=lambda c, doc: writes.append(doc),
        ):
            # Clearing PATH makes pg_dump unfindable -- a faithful stand-in
            # for every way the dump can fail.
            with patch.dict(os.environ, {}, clear=True):
                backup_service._execute_backup_run(cur, "run-1")

        self.assertTrue(writes, "the run published no state at all")
        self.assertTrue(all(d["run_id"] == "run-1" for d in writes))
        self.assertEqual(writes[0]["state"], "RUNNING")
        self.assertEqual(writes[-1]["state"], "FAILED")
        self.assertEqual(writes[-1]["percent"], 100)
        self.assertIn("SNAPSHOT FAILED", writes[-1]["result"]["message"])

    def test_run_publishes_progress_for_each_phase(self):
        """The browser's progress bar reflects real phases, not a timer.

        It used to be a setInterval in dashboard.js that advanced 15% every
        800ms regardless of what the server was doing, so it reported
        progress on runs that had already died.
        """
        writes = []
        cur = MagicMock()
        with patch.object(
            backup_service,
            "_write_run_state",
            side_effect=lambda c, doc: writes.append(doc),
        ):
            with patch.object(backup_service, "perform_full_backup") as mock_perform:

                def _run(config=None, on_phase=None):
                    for phase in ("snapshot", "sheets", "mirror"):
                        on_phase(phase)
                    return {"status": "SUCCESS", "message": "ok"}

                mock_perform.side_effect = _run
                backup_service._execute_backup_run(cur, "run-2")

        phases = [d["phase"] for d in writes]
        self.assertEqual(phases, ["snapshot", "snapshot", "sheets", "mirror", "done"])
        # Monotonic: a bar that goes backwards reads as a restart.
        percents = [d["percent"] for d in writes]
        self.assertEqual(percents, sorted(percents))
        self.assertEqual(writes[-1]["state"], "SUCCESS")

    def test_progress_callback_failure_cannot_fail_the_backup(self):
        """A broken progress sink is a cosmetic problem, not a backup failure."""
        with patch.object(backup_service, "db_backup") as mock_db_backup:
            mock_db_backup.create_snapshot.return_value = MagicMock(
                path="/tmp/x.dump",
                size_bytes=1,
                sha256="a" * 64,
                table_count=1,
                verified=True,
                filename="x.dump",
            )
            mock_db_backup.prune_snapshots.return_value = []
            res = backup_service.perform_full_backup(
                on_phase=MagicMock(side_effect=RuntimeError("sink is down"))
            )

        self.assertNotEqual(res["status"], "FAILED")
        self.assertTrue(res["snapshot_verified"])

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
    # The activity log (AUDIT-001). Excluded from the SHEETS mirror
    # specifically, not from backups: db_backup.py's pg_dump snapshot takes
    # the whole database with no --schema filter, so the audit trail is
    # captured there -- which is the right place for it. This path re-uploads
    # every listed table in full each night, and a row-per-mutation table with
    # a 90-day window would dominate the spreadsheet's cell budget while
    # telling a business-data restore nothing.
    "erp.activity_log",
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
