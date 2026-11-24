"""Tests for backup_service and backup RPC endpoints."""

import os
import unittest
from unittest.mock import MagicMock, patch

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
                    "local_file": None,
                    "nightly_scheduler_active": False,
                }
            )

    def test_get_backup_dir(self):
        backup_dir = backup_service.get_backup_dir()
        self.assertTrue(os.path.exists(backup_dir))
        self.assertTrue(backup_dir.endswith("backups"))

    def test_perform_full_backup_takes_a_verified_snapshot(self):
        """A real pg_dump against the test database: SUCCESS, and a file
        pg_restore has confirmed it can read.

        Rewritten for DATA-001. The previous version mocked database.get_conn
        and fed the hand-rolled INSERT writer a MagicMock cursor -- so it
        asserted that a file appeared, which is the exact property that was
        never evidence of a backup. The snapshot is the whole backup since the
        Google Sheets export was retired (2026-11-24), so it alone decides
        SUCCESS; nothing about Google is configured, tried or reported.
        """
        # Explicit config, not the ambient one. A plain unittest.TestCase has
        # no Flask app context, so db_backup._resolve_config() would fall back
        # to config.Config -- whose DATABASE_URL config.py's load_dotenv()
        # repopulates from .env, i.e. the PRODUCTION database. pg_dump is
        # read-only so nothing would be corrupted, but the test would be slow
        # and would drop a copy of live business data into backups/.
        res = backup_service.perform_full_backup(config=_test_db_config())

        self.assertEqual(res["status"], "SUCCESS")
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
        self.assertNotIn("Google", res["message"])
        for gone in ("spreadsheet_url", "mirror_status"):
            self.assertNotIn(gone, res)

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

        Emptying PATH makes pg_dump unfindable, which is a faithful
        stand-in for every way the dump can fail.
        """
        # PATH is set EMPTY, not removed. shutil.which() -- which
        # db_backup._require_tool uses -- falls back to os.defpath when
        # PATH is ABSENT from the environment, and on Linux that is
        # ":/bin:/usr/bin". CI installs postgresql-client, so clear=True
        # alone left /usr/bin/pg_dump perfectly findable: the snapshot
        # succeeded and the run did not report FAILED. It passed on
        # Windows only because os.defpath there is ".;C:\bin".
        # An empty string takes the bpo-35755 path, which does not fall
        # back, so the tool is unfindable on every platform.
        with patch.dict(os.environ, {"PATH": ""}, clear=True):
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

        This was the fix for the dashboard's "The server did not respond
        within 45s" error, when a run took ~2 minutes of Google Sheets round
        trips. A snapshot alone is quicker, but its time grows with the
        database, so the request still only starts the job and hands back an
        id to poll on.
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
            # Emptying PATH makes pg_dump unfindable -- a faithful
            # stand-in for every way the dump can fail. Empty, not
            # removed: shutil.which() falls back to os.defpath when
            # PATH is absent, and on Linux that finds /usr/bin/pg_dump,
            # so the dump succeeded in CI and the run did not fail.
            with patch.dict(os.environ, {"PATH": ""}, clear=True):
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
                    on_phase("snapshot")
                    return {"status": "SUCCESS", "message": "ok"}

                mock_perform.side_effect = _run
                backup_service._execute_backup_run(cur, "run-2")

        phases = [d["phase"] for d in writes]
        self.assertEqual(phases, ["snapshot", "snapshot", "done"])
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
