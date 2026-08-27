"""Backup service for MTC ERP.

Handles:
1. Creating local PostgreSQL snapshot backups in backups/
2. Uploading/syncing database tables to Google Sheets via scripts.migration.backup_db_to_sheets
3. Providing RPC methods ('triggerBackup', 'getBackupStatus') for dashboard UI triggers
4. Automated nightly scheduler daemon thread with Postgres advisory locking
"""

from __future__ import annotations

import datetime
import logging
import os
import sys
import threading
import time
from typing import Any, Dict

from flask import current_app

import database
from config import Config
from . import db_backup
from ..envelope import build_response
from ..registry import rpc_method

logger = logging.getLogger(__name__)

# Advisory lock key for PostgreSQL to guarantee single execution across workers
_BACKUP_LOCK_KEY = 918_273_646

# Check interval (in seconds) for the background scheduler (1 hour)
_SCHEDULER_CHECK_INTERVAL = 3600

# Nightly backup interval in seconds (24 hours)
_NIGHTLY_INTERVAL_SECONDS = 24 * 3600

# In-memory record of the last backup attempt
_LAST_BACKUP_STATUS: Dict[str, Any] = {
    "timestamp": None,
    "status": "NEVER",
    "message": "No backup has been executed yet.",
    "spreadsheet_id": None,
    "spreadsheet_url": None,
    "local_file": None,
    "mirror_status": None,
    "mirror_message": None,
    "nightly_scheduler_active": False,
    # DATA-001 health fields. Defaults are deliberately the pessimistic ones:
    # before any run has happened, "is there a verified backup?" must answer
    # False, not None-that-renders-as-blank-and-looks-fine.
    "snapshot_verified": False,
    "snapshot_size_bytes": None,
    "snapshot_sha256": None,
    "snapshot_table_count": None,
    "snapshot_error": None,
    "consecutive_failures": 0,
    "last_verified_at": None,
    "pruned_count": 0,
}

_STATUS_LOCK = threading.Lock()


def get_backup_dir() -> str:
    """Absolute path to the directory snapshots are written to.

    Configurable via BACKUP_DIR (DEPLOY-001). The historical default -- a
    `backups/` directory beside the checkout -- is correct for the systemd
    deployment, where deploy.sh gives the app user ownership of that tree.
    It is NOT correct inside the container: the same "four directories up"
    computation resolves to `/backups`, the filesystem root, which only
    worked because the container ran as root. It runs as an unprivileged
    user now, so the image sets BACKUP_DIR explicitly.
    """
    configured = None
    try:
        configured = current_app.config.get("BACKUP_DIR")
    except RuntimeError:
        # No application context (a CLI invocation, a scheduled job outside
        # the app). Fall through to the environment, then to the default.
        pass
    backup_dir = configured or os.getenv("BACKUP_DIR")
    if not backup_dir:
        base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
        backup_dir = os.path.join(base_dir, "backups")
    os.makedirs(backup_dir, exist_ok=True)
    return backup_dir


def _migration_module():
    """Imports scripts/migration/backup_db_to_sheets, adding it to sys.path first."""
    migration_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../scripts/migration"))
    if migration_dir not in sys.path:
        sys.path.insert(0, migration_dir)
    import backup_db_to_sheets  # type: ignore

    return backup_db_to_sheets


def _mirror_module():
    """Imports scripts/migration/mirror_db_to_gas_sheets, adding it to sys.path first."""
    migration_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../scripts/migration"))
    if migration_dir not in sys.path:
        sys.path.insert(0, migration_dir)
    import mirror_db_to_gas_sheets  # type: ignore

    return mirror_db_to_gas_sheets


def perform_full_backup(config=None) -> Dict[str, Any]:
    """Performs a verified local database snapshot plus the Google Sheets sync.

    The local snapshot is now produced by db_backup.create_snapshot(), which
    shells out to pg_dump and then proves the result readable with pg_restore
    before returning. See db_backup's module docstring for what the previous
    hand-rolled INSERT writer got wrong -- in short, it produced files that
    could not be restored and reported them as successful backups.
    """
    now_iso = datetime.datetime.now().isoformat()
    backup_dir = get_backup_dir()

    # 1. Local Postgres snapshot -- dumped AND verified, or not a backup.
    local_success = False
    local_error = None
    local_backup_file = None
    snapshot_detail: Dict[str, Any] = {}
    pruned: list = []
    try:
        # config=None lets db_backup resolve it -- current_app.config when
        # there is an app context, config.Config otherwise. Callers that know
        # which database they mean (tests, and any future admin CLI) pass it
        # explicitly rather than relying on ambient state.
        snapshot = db_backup.create_snapshot(backup_dir, config=config)
        local_backup_file = snapshot.path
        local_success = True
        snapshot_detail = {
            "sizeBytes": snapshot.size_bytes,
            "sha256": snapshot.sha256,
            "tableCount": snapshot.table_count,
            "verified": snapshot.verified,
        }
        logger.info(
            "[backup_service] Verified snapshot %s (%s bytes, %d tables, sha256=%s)",
            snapshot.filename,
            f"{snapshot.size_bytes:,}",
            snapshot.table_count,
            snapshot.sha256[:16],
        )
        # Retention runs only after a good snapshot exists, so a run of
        # failures can never delete the last known-good file.
        pruned = db_backup.prune_snapshots(backup_dir)
        if pruned:
            logger.info("[backup_service] Pruned %d old snapshot(s)", len(pruned))
    except Exception as exc:
        local_error = str(exc)
        # ERROR, not warning, and the run is FAILED below regardless of what
        # the Sheets sync does. The old code set local_success = True even
        # when individual tables had failed to export, writing the error into
        # the output file as an SQL comment -- so a backup that captured three
        # of fifty tables was reported green on the dashboard.
        logger.error("[backup_service] Local snapshot FAILED: %s", exc)

    # 2. Google Sheets sync via scripts/migration/backup_db_to_sheets.py
    sheets_success = False
    spreadsheet_id = None
    spreadsheet_url = None
    sheets_error = None

    # GOOGLE_APPLICATION_CREDENTIALS is the single source of truth here,
    # same as scripts/migration/sheets_client.py -- no fallback path
    # scanning, so unsetting it (e.g. to disable Sheets sync) reliably
    # skips this branch instead of silently picking up a stray gcp-key.json.
    creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")

    if not creds_path or not os.path.exists(creds_path):
        sheets_error = "GOOGLE_APPLICATION_CREDENTIALS is not configured or file not found."
        logger.warning("[backup_service] Google Sheets backup skipped: %s", sheets_error)

    else:
        try:
            backup_db_to_sheets = _migration_module()

            db_url = Config.DATABASE_URL or (
                f"postgresql://{Config.DB_USER}:{Config.DB_PASS}@"
                f"{Config.DB_HOST}:{os.environ.get('DB_PORT', '5432')}/{Config.DB_NAME}"
            )

            drive_folder_id = os.environ.get("DRIVE_FOLDER_ID")
            existing_sid = os.environ.get("BACKUP_SPREADSHEET_ID") or os.environ.get("SPREADSHEET_ID")

            spreadsheet_id = backup_db_to_sheets.run_backup(db_url, drive_folder_id, existing_sid)
            spreadsheet_url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}"
            sheets_success = True
            logger.info("[backup_service] Google Sheets backup created/updated: %s (%s)", spreadsheet_id, spreadsheet_url)

        except Exception as exc:
            sheets_error = str(exc)
            logger.error("[backup_service] Google Sheets backup failed: %s", exc)

    # 3. Mirror into the legacy GAS app's bound spreadsheet, in its original
    # per-sheet layout, via scripts/migration/mirror_db_to_gas_sheets.py.
    # Independent of step 2's dated-backup spreadsheet -- a different,
    # fixed destination -- so it gets its own success/error tracking rather
    # than overloading spreadsheet_id/spreadsheet_url above.
    mirror_success = False
    mirror_error = None

    gas_spreadsheet_id = os.environ.get("GAS_MIRROR_SPREADSHEET_ID") or os.environ.get("BACKUP_SPREADSHEET_ID")

    if not creds_path or not os.path.exists(creds_path):
        mirror_error = "GOOGLE_APPLICATION_CREDENTIALS is not configured or file not found."
        logger.warning("[backup_service] GAS sheet mirror skipped: %s", mirror_error)
    elif not gas_spreadsheet_id:
        mirror_error = "GAS_MIRROR_SPREADSHEET_ID is not configured."
        logger.warning("[backup_service] GAS sheet mirror skipped: %s", mirror_error)
    else:
        try:
            mirror_mod = _mirror_module()

            db_url = Config.DATABASE_URL or (
                f"postgresql://{Config.DB_USER}:{Config.DB_PASS}@"
                f"{Config.DB_HOST}:{os.environ.get('DB_PORT', '5432')}/{Config.DB_NAME}"
            )

            mapping = mirror_mod.load_mapping(mirror_mod.SCRIPT_DIR / "gas_sheet_mapping.yaml")
            results = mirror_mod.run_mirror(db_url, gas_spreadsheet_id, mapping["sheets"], dry_run=False)
            failed = [r for r in results if r.status in ("error", "skipped_guard")]
            if failed:
                mirror_error = f"{len(failed)}/{len(results)} sheet(s) failed or were guard-skipped"
                logger.error("[backup_service] GAS sheet mirror partial failure: %s", mirror_error)
            else:
                mirror_success = True
                logger.info("[backup_service] GAS sheet mirror updated %d sheet(s)", len(results))

        except Exception as exc:
            mirror_error = str(exc)
            logger.error("[backup_service] GAS sheet mirror failed: %s", exc)

    # Build final status summary.
    #
    # The local snapshot is the backup. The Sheets sync and the GAS mirror are
    # convenience exports of the same data into a human-readable form -- losing
    # one of those is an inconvenience; losing the snapshot is losing the
    # ability to recover. So a failed snapshot is FAILED, never PARTIAL,
    # whatever else succeeded.
    all_succeeded = local_success and sheets_success and mirror_success
    if not local_success:
        status_str = "FAILED"
    elif all_succeeded:
        status_str = "SUCCESS"
    else:
        status_str = "PARTIAL"

    messages = []
    if local_success:
        messages.append(
            f"Verified DB snapshot created ({os.path.basename(local_backup_file)}, "
            f"{snapshot_detail.get('tableCount', 0)} tables, "
            f"{snapshot_detail.get('sizeBytes', 0):,} bytes)"
        )
        if pruned:
            messages.append(f"Pruned {len(pruned)} snapshot(s) past retention")
    else:
        messages.append(f"DB SNAPSHOT FAILED -- no recoverable backup was produced ({local_error})")

    if sheets_success:
        messages.append("Synced to Google Sheets successfully.")
    else:
        messages.append(f"Google Sheets upload: {sheets_error}")

    if mirror_success:
        messages.append("GAS app spreadsheet mirrored successfully.")
    else:
        messages.append(f"GAS sheet mirror: {mirror_error}")

    full_message = ". ".join(messages)

    result_data = {
        "timestamp": now_iso,
        "status": status_str,
        "message": full_message,
        "spreadsheet_id": spreadsheet_id,
        "spreadsheet_url": spreadsheet_url,
        "local_file": local_backup_file,
        "mirror_status": "SUCCESS" if mirror_success else "FAILED",
        "mirror_message": "GAS app spreadsheet mirrored successfully." if mirror_success else mirror_error,
        # Health surface (DATA-001). "A file was written" is not evidence of a
        # backup; these are. snapshot_verified is the one an operator should
        # look at, and it is only ever True when pg_restore has read the file
        # back and found every table in db_backup.REQUIRED_TABLES.
        "snapshot_verified": bool(snapshot_detail.get("verified")),
        "snapshot_size_bytes": snapshot_detail.get("sizeBytes"),
        "snapshot_sha256": snapshot_detail.get("sha256"),
        "snapshot_table_count": snapshot_detail.get("tableCount"),
        "snapshot_error": local_error,
        "pruned_count": len(pruned),
    }

    with _STATUS_LOCK:
        # consecutive_failures survives across runs so "it has not worked for
        # four nights" is visible, rather than each night independently
        # reporting one failure that nobody correlates.
        previous_failures = int(_LAST_BACKUP_STATUS.get("consecutive_failures") or 0)
        result_data["consecutive_failures"] = 0 if local_success else previous_failures + 1
        if local_success:
            result_data["last_verified_at"] = now_iso
        else:
            result_data["last_verified_at"] = _LAST_BACKUP_STATUS.get("last_verified_at")
        _LAST_BACKUP_STATUS.update(result_data)

    return result_data


@rpc_method("triggerBackup", mutation=True, roles=frozenset({"admin"}))
def rpc_trigger_backup() -> Dict[str, Any]:
    """RPC method to manually trigger a database backup & Google Sheets upload."""
    try:
        res = perform_full_backup()
        # PARTIAL still counts as success here because, per perform_full_backup,
        # PARTIAL can now only mean "the verified snapshot exists but a
        # convenience export did not". A failed snapshot is FAILED and reports
        # as a failure to the caller.
        is_ok = res["status"] in ("SUCCESS", "PARTIAL")
        return build_response(is_ok, res, res["message"])
    except Exception as exc:
        logger.exception("[backup_service] Manual backup trigger error")
        return build_response(False, None, f"Failed to run backup: {exc}")


@rpc_method("getBackupStatus")
def rpc_get_backup_status() -> Dict[str, Any]:
    """Current backup health.

    _LAST_BACKUP_STATUS is per-process in-memory state, so it resets to
    "NEVER" every time a gunicorn worker is recycled -- and the systemd unit
    recycles workers every 1000 requests. Answering "when did a backup last
    succeed?" from that alone is therefore unreliable in exactly the direction
    that matters. The on-disk snapshot is the durable record, so it is
    consulted too and wins when it is newer.
    """
    with _STATUS_LOCK:
        status_copy = dict(_LAST_BACKUP_STATUS)

    try:
        newest = db_backup.latest_snapshot(get_backup_dir())
    except Exception:  # noqa: BLE001 -- a status read must never raise
        newest = None

    if newest is not None:
        status_copy["latest_snapshot_file"] = newest.filename
        status_copy["latest_snapshot_at"] = newest.created_at
        status_copy["latest_snapshot_size_bytes"] = newest.size_bytes
        # A worker that has itself never run a backup still reports the truth.
        if not status_copy.get("last_verified_at"):
            status_copy["last_verified_at"] = newest.created_at
            status_copy["snapshot_verified"] = newest.verified
        age_days = None
        try:
            age_days = (
                datetime.datetime.now()
                - datetime.datetime.fromisoformat(newest.created_at)
            ).days
        except ValueError:
            pass
        status_copy["latest_snapshot_age_days"] = age_days
        # Absence of a recent backup produces no error of its own -- nothing
        # fails, nothing logs, and that silence is the whole problem. Say it.
        status_copy["stale"] = age_days is not None and age_days >= 2
    else:
        status_copy["latest_snapshot_file"] = None
        status_copy["latest_snapshot_at"] = None
        status_copy["latest_snapshot_age_days"] = None
        status_copy["stale"] = True

    return build_response(True, status_copy, "Backup status loaded.")


def _run_scheduled_backup_safely() -> None:
    """Attempt a nightly backup if enough time has elapsed.

    Uses a session-level advisory lock (pg_try_advisory_lock) instead of
    pg_try_advisory_xact_lock so the lock remains held while
    perform_full_backup() runs (which opens its own DB connections).
    The lock is explicitly released in the finally block.
    """
    conn_for_lock = None
    lock_acquired = False
    try:
        # Acquire a session-level advisory lock that persists across
        # transactions until explicitly released or the session ends.
        with database.get_conn() as (_conn, cur):
            conn_for_lock = _conn
            conn_for_lock.autocommit = True
            cur.execute("SELECT pg_try_advisory_lock(%s)", (_BACKUP_LOCK_KEY,))
            lock_acquired = cur.fetchone()[0]

            if not lock_acquired:
                return

            with _STATUS_LOCK:
                last_time_str = _LAST_BACKUP_STATUS.get("timestamp")

            should_run = False
            if not last_time_str:
                should_run = True
            else:
                try:
                    last_time = datetime.datetime.fromisoformat(last_time_str)
                    elapsed = (datetime.datetime.now() - last_time).total_seconds()
                    if elapsed >= _NIGHTLY_INTERVAL_SECONDS:
                        should_run = True
                except Exception:
                    should_run = True

            if should_run:
                logger.info("[backup_service] Nightly automated backup triggered")
                perform_full_backup()

                # DATA-005. erp.rpc_mutations had no pruning anywhere, so a
                # full JSONB result envelope -- sometimes a whole result set --
                # was retained for every mutation ever performed, forever.
                # Attached to this job rather than given its own scheduler: it
                # already runs nightly, already holds a single-instance
                # advisory lock, and a housekeeping delete does not warrant a
                # second daemon thread (see REL-003, which argues these should
                # be leaving the web workers entirely).
                #
                # Deliberately after the backup and separately guarded: a
                # failed prune must never make a successful backup look failed.
                try:
                    from ..mutations import prune_old_mutations

                    removed = prune_old_mutations()
                    if removed:
                        logger.info(
                            "[backup_service] Pruned %d expired mutation record(s)", removed
                        )
                except Exception:
                    logger.exception("[backup_service] Mutation pruning failed")

                # Same reasoning for the activity log (AUDIT-001): it gains a
                # row per mutation and per auth event and nothing else deletes
                # from it, so without this it is a disk outage on a schedule.
                # Separately guarded again -- one prune failing must not skip
                # the other or mark the backup failed.
                try:
                    from .activity_service import prune_old_activity

                    removed = prune_old_activity()
                    if removed:
                        logger.info(
                            "[backup_service] Pruned %d expired activity log row(s)",
                            removed,
                        )
                except Exception:
                    logger.exception("[backup_service] Activity log pruning failed")

            # Release the advisory lock explicitly
            cur.execute("SELECT pg_advisory_unlock(%s)", (_BACKUP_LOCK_KEY,))
            lock_acquired = False
    except Exception:
        logger.exception("[backup_service] Error during scheduled backup check")
    finally:
        # Safety net: if lock was acquired but not released (e.g. exception
        # during perform_full_backup), try to release it.
        if lock_acquired:
            try:
                with database.get_conn() as (_conn, cur):
                    cur.execute("SELECT pg_advisory_unlock(%s)", (_BACKUP_LOCK_KEY,))
            except Exception:
                logger.warning("[backup_service] Failed to release advisory lock in finally")


def _scheduler_loop(stop_event: threading.Event) -> None:
    time.sleep(10)
    _run_scheduled_backup_safely()

    while not stop_event.wait(_SCHEDULER_CHECK_INTERVAL):
        _run_scheduled_backup_safely()


def start_backup_scheduler(app) -> None:
    """Starts the nightly backup scheduler thread once from create_app()."""
    if app.config.get("TESTING"):
        return
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return

    with _STATUS_LOCK:
        _LAST_BACKUP_STATUS["nightly_scheduler_active"] = True

    stop_event = threading.Event()
    thread = threading.Thread(
        target=_scheduler_loop, args=(stop_event,), daemon=True, name="nightly-backup-scheduler"
    )
    thread.start()
    app.logger.info("[backup_service] Automated nightly backup scheduler started.")
