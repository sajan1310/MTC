"""Backup service for MTC ERP.

Handles:
1. Creating local PostgreSQL snapshot backups in backups/
2. Uploading/syncing database tables to Google Sheets via scripts.migration.backup_db_to_sheets
3. Providing RPC methods ('triggerBackup', 'getBackupStatus') for dashboard UI triggers
4. Automated nightly scheduler daemon thread with Postgres advisory locking
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import sys
import threading
import time
import uuid
from typing import Any, Callable, Dict, Optional

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

# ── Durable, cross-worker run state ───────────────────────────────────────
# _LAST_BACKUP_STATUS above is per-process, and gunicorn runs four workers
# (Procfile / deploy/mtc.service) recycled every ~1000 requests. That was
# survivable while the dashboard only read a "last backup at" line off it.
# It is not survivable now that triggerBackup returns before the work is
# done and the browser polls getBackupStatus for the outcome: consecutive
# polls land on different workers, so three polls in four would answer from
# a process that knows nothing about the run.
#
# The authoritative record therefore lives in erp.app_settings, which every
# worker shares, as a JSON document under this key. The in-memory dict is
# kept in step for the process that ran the backup, but it is no longer the
# thing the UI believes.
_RUN_STATE_KEY = "backup:last_run"

# A RUNNING record whose updated_at is older than this is reported as
# abandoned rather than in-flight. Needed because --max-requests 1000 can
# recycle the worker whose thread is mid-backup, and a killed thread writes
# no terminal state; without a staleness rule the dashboard would show a
# backup running forever and refuse to start another one.
_RUN_STALE_AFTER_SECONDS = int(os.getenv("BACKUP_RUN_STALE_AFTER", "1800"))

# Phase -> (label, percent) for the progress the browser renders. The
# percentages are the share of wall-clock each phase actually takes on this
# dataset, not even thirds: the snapshot is ~1.5s while the two Sheets
# phases are ~90s and ~40s, so a bar that jumped to 33% on snapshot
# completion would sit there for two minutes.
_PHASES = {
    "snapshot": ("Creating local database snapshot...", 5),
    "sheets": ("Formatting & syncing to Google Sheets...", 20),
    "mirror": ("Mirroring into the app spreadsheet...", 75),
    "done": ("Finishing up...", 100),
}


def _run_state_doc(
    run_id: str, state: str, phase: str, result: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    label, percent = _PHASES.get(phase, ("Working...", 0))
    return {
        # Identifies WHICH run this record describes. The browser polls for
        # the run it started, and without an id it cannot tell a terminal
        # state belonging to its own click from one left behind by the
        # previous run -- so a backup that failed to start at all would show
        # the last successful run's result and report success.
        "run_id": run_id,
        "state": state,
        "phase": phase,
        "phase_label": label,
        "percent": percent,
        "updated_at": datetime.datetime.now().isoformat(),
        "result": result,
    }


def _write_run_state(cur, doc: Dict[str, Any]) -> None:
    """Persist `doc` under _RUN_STATE_KEY using a caller-supplied cursor.

    Takes a cursor rather than opening its own connection because both
    callers already hold one -- the advisory-lock session that must stay
    open for the whole run. database.get_conn() refuses to nest (see its
    NestedConnectionError), and its own guidance is to pass the cursor down.
    That cursor's connection is autocommit, so each progress write is
    immediately visible to the other workers answering the poll.
    """
    cur.execute(
        """
        INSERT INTO erp.app_settings (key, value, updated_at)
        VALUES (%s, %s, NOW())
        ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = NOW()
        """,
        (_RUN_STATE_KEY, json.dumps(doc, default=str)),
    )


def _read_run_state() -> Optional[Dict[str, Any]]:
    """The shared run record, or None if there is none / it is unreadable.

    Never raises: this is read on the status path, and a status read that
    throws would take out the dashboard panel whose entire job is to tell
    an operator whether backups are healthy.
    """
    try:
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "SELECT value, updated_at FROM erp.app_settings WHERE key = %s",
                (_RUN_STATE_KEY,),
            )
            row = cur.fetchone()
    except Exception:  # noqa: BLE001
        logger.exception("[backup_service] Could not read shared run state")
        return None

    if not row or not row[0]:
        return None
    try:
        doc = json.loads(row[0])
    except (TypeError, ValueError):
        logger.warning("[backup_service] Shared run state is not valid JSON; ignoring")
        return None
    if not isinstance(doc, dict):
        return None

    # Staleness is judged from the row's own updated_at, not from the
    # timestamp inside the JSON: the column is written by Postgres and is
    # immune to a worker whose clock has drifted.
    updated_at = row[1]
    if doc.get("state") == "RUNNING" and updated_at is not None:
        try:
            now = datetime.datetime.now(updated_at.tzinfo)
            if (now - updated_at).total_seconds() > _RUN_STALE_AFTER_SECONDS:
                doc["state"] = "STALE"
                doc["phase_label"] = (
                    "The backup process stopped without reporting a result. "
                    "It is safe to start another one."
                )
        except (TypeError, AttributeError):
            pass
    return doc


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
        base_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "../../../..")
        )
        backup_dir = os.path.join(base_dir, "backups")
    os.makedirs(backup_dir, exist_ok=True)
    return backup_dir


def _migration_module():
    """Imports scripts/migration/backup_db_to_sheets, adding it to sys.path first."""
    migration_dir = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../../scripts/migration")
    )
    if migration_dir not in sys.path:
        sys.path.insert(0, migration_dir)
    import backup_db_to_sheets  # type: ignore

    return backup_db_to_sheets


def _mirror_module():
    """Imports scripts/migration/mirror_db_to_gas_sheets, adding it to sys.path first."""
    migration_dir = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../../scripts/migration")
    )
    if migration_dir not in sys.path:
        sys.path.insert(0, migration_dir)
    import mirror_db_to_gas_sheets  # type: ignore

    return mirror_db_to_gas_sheets


def perform_full_backup(
    config=None, on_phase: Optional[Callable[[str], None]] = None
) -> Dict[str, Any]:
    """Performs a verified local database snapshot plus the Google Sheets sync.

    The local snapshot is now produced by db_backup.create_snapshot(), which
    shells out to pg_dump and then proves the result readable with pg_restore
    before returning. See db_backup's module docstring for what the previous
    hand-rolled INSERT writer got wrong -- in short, it produced files that
    could not be restored and reported them as successful backups.

    `on_phase` is called with 'snapshot' / 'sheets' / 'mirror' as each begins,
    so the caller can publish progress somewhere the browser can poll. It is
    advisory only: this function's contract is unchanged when it is None, and
    an exception from it is swallowed, because a broken progress sink must
    never be able to fail a backup that is otherwise succeeding.
    """
    now_iso = datetime.datetime.now().isoformat()
    backup_dir = get_backup_dir()

    def _phase(name: str) -> None:
        if on_phase is None:
            return
        try:
            on_phase(name)
        except Exception:  # noqa: BLE001 -- see docstring
            logger.exception(
                "[backup_service] Progress callback failed for phase %s", name
            )

    _phase("snapshot")

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
    _phase("sheets")
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
        sheets_error = (
            "GOOGLE_APPLICATION_CREDENTIALS is not configured or file not found."
        )
        logger.warning(
            "[backup_service] Google Sheets backup skipped: %s", sheets_error
        )

    else:
        try:
            backup_db_to_sheets = _migration_module()

            db_url = Config.DATABASE_URL or (
                f"postgresql://{Config.DB_USER}:{Config.DB_PASS}@"
                f"{Config.DB_HOST}:{os.environ.get('DB_PORT', '5432')}/{Config.DB_NAME}"
            )

            drive_folder_id = os.environ.get("DRIVE_FOLDER_ID")
            existing_sid = os.environ.get("BACKUP_SPREADSHEET_ID") or os.environ.get(
                "SPREADSHEET_ID"
            )

            spreadsheet_id = backup_db_to_sheets.run_backup(
                db_url, drive_folder_id, existing_sid
            )
            spreadsheet_url = f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}"
            sheets_success = True
            logger.info(
                "[backup_service] Google Sheets backup created/updated: %s (%s)",
                spreadsheet_id,
                spreadsheet_url,
            )

        except Exception as exc:
            sheets_error = str(exc)
            logger.error("[backup_service] Google Sheets backup failed: %s", exc)

    # 3. Mirror into the legacy GAS app's bound spreadsheet, in its original
    # per-sheet layout, via scripts/migration/mirror_db_to_gas_sheets.py.
    # Independent of step 2's dated-backup spreadsheet -- a different,
    # fixed destination -- so it gets its own success/error tracking rather
    # than overloading spreadsheet_id/spreadsheet_url above.
    _phase("mirror")
    mirror_success = False
    mirror_error = None

    gas_spreadsheet_id = os.environ.get("GAS_MIRROR_SPREADSHEET_ID") or os.environ.get(
        "BACKUP_SPREADSHEET_ID"
    )

    if not creds_path or not os.path.exists(creds_path):
        mirror_error = (
            "GOOGLE_APPLICATION_CREDENTIALS is not configured or file not found."
        )
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

            mapping = mirror_mod.load_mapping(
                mirror_mod.SCRIPT_DIR / "gas_sheet_mapping.yaml"
            )
            results = mirror_mod.run_mirror(
                db_url, gas_spreadsheet_id, mapping["sheets"], dry_run=False
            )
            failed = [r for r in results if r.status in ("error", "skipped_guard")]
            if failed:
                mirror_error = f"{len(failed)}/{len(results)} sheet(s) failed or were guard-skipped"
                logger.error(
                    "[backup_service] GAS sheet mirror partial failure: %s",
                    mirror_error,
                )
            else:
                mirror_success = True
                logger.info(
                    "[backup_service] GAS sheet mirror updated %d sheet(s)",
                    len(results),
                )

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
        messages.append(
            f"DB SNAPSHOT FAILED -- no recoverable backup was produced ({local_error})"
        )

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
        "mirror_message": "GAS app spreadsheet mirrored successfully."
        if mirror_success
        else mirror_error,
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
        result_data["consecutive_failures"] = (
            0 if local_success else previous_failures + 1
        )
        if local_success:
            result_data["last_verified_at"] = now_iso
        else:
            result_data["last_verified_at"] = _LAST_BACKUP_STATUS.get(
                "last_verified_at"
            )
        _LAST_BACKUP_STATUS.update(result_data)

    return result_data


def _execute_backup_run(cur, run_id: str, config=None) -> Optional[Dict[str, Any]]:
    """Run a full backup, publishing progress through `cur` as it goes.

    `cur` must belong to an autocommit session that already holds
    _BACKUP_LOCK_KEY and stays open for the duration -- both callers
    (the manual trigger thread and the nightly scheduler) hold exactly that.
    """
    _write_run_state(cur, _run_state_doc(run_id, "RUNNING", "snapshot"))

    def publish(phase: str) -> None:
        _write_run_state(cur, _run_state_doc(run_id, "RUNNING", phase))

    try:
        res = perform_full_backup(config=config, on_phase=publish)
    except Exception as exc:
        # perform_full_backup already reports a failed snapshot as a FAILED
        # result rather than raising, so reaching here means something
        # further out broke. Either way a terminal state MUST be written:
        # the browser is polling for one, and the alternative is a modal
        # that spins until its own timeout with nothing to show for it.
        logger.exception("[backup_service] Backup run failed")
        _write_run_state(
            cur,
            _run_state_doc(
                run_id,
                "FAILED",
                "done",
                {"status": "FAILED", "message": f"Failed to run backup: {exc}"},
            ),
        )
        return None

    _write_run_state(cur, _run_state_doc(run_id, res["status"], "done", res))
    return res


def _backup_worker(app, run_id: str, config=None) -> None:
    """Body of the thread started by rpc_trigger_backup.

    Pushes an app context because db_backup._resolve_config() prefers
    current_app.config over config.Config, and that preference is what keeps
    a backup pointed at the database the running app is actually using.
    """
    ctx = app.app_context() if app is not None else None
    if ctx is not None:
        ctx.push()
    lock_acquired = False
    try:
        # Session-level, not transaction-level: the lock has to outlive the
        # statement that took it and cover the whole run, which opens its own
        # connections. Same reasoning as _run_scheduled_backup_safely.
        with database.get_conn() as (conn, cur):
            conn.autocommit = True
            cur.execute("SELECT pg_try_advisory_lock(%s)", (_BACKUP_LOCK_KEY,))
            lock_acquired = cur.fetchone()[0]
            if not lock_acquired:
                # Someone else -- another admin's click on another worker, or
                # the nightly job -- got there first between rpc_trigger_backup's
                # check and this thread being scheduled. Exit WITHOUT writing
                # anything: this run_id's record must not overwrite the record
                # the in-flight run is publishing to, or that run's own watcher
                # would lose its result. The client handles this by adopting
                # whichever run it finds RUNNING -- see _pollBackupUntilDone.
                logger.info(
                    "[backup_service] Manual trigger skipped: a backup is already running"
                )
                return
            _execute_backup_run(cur, run_id, config=config)
            cur.execute("SELECT pg_advisory_unlock(%s)", (_BACKUP_LOCK_KEY,))
            lock_acquired = False
    except Exception:
        logger.exception("[backup_service] Backup worker crashed")
    finally:
        if lock_acquired:
            try:
                with database.get_conn() as (_conn, cur):
                    cur.execute("SELECT pg_advisory_unlock(%s)", (_BACKUP_LOCK_KEY,))
            except Exception:
                logger.warning(
                    "[backup_service] Failed to release advisory lock in finally"
                )
        if ctx is not None:
            ctx.pop()


@rpc_method("triggerBackup", mutation=True, roles=frozenset({"admin"}))
def rpc_trigger_backup() -> Dict[str, Any]:
    """Start a backup and return immediately; the client polls getBackupStatus.

    This used to run the whole backup inline and return its result. It could
    not work, and had two independent ceilings below the time the job needs:

      * static/erp/api.js aborts any RPC after REQUEST_TIMEOUT_MS (45s) and
        reports the abort as "The server did not respond within 45s" -- which
        is what the dashboard has been showing.
      * gunicorn runs with --timeout 120, so even without the client abort
        the worker is killed at two minutes and nginx answers 502.

    A full run on this dataset is comfortably past both. The snapshot itself
    is ~1.5s; the cost is the Sheets work, which makes four API round trips
    per table (tab lookup, grid resize, clear, update) across the 46 tables
    in backup_db_to_sheets.TABLES, plus the 28 sheets of the GAS mirror, at
    roughly half a second per round trip. That is ~2 minutes of latency-bound
    work, and no amount of raising the two timeouts turns it into something
    that belongs inside a request.

    So the request now only starts the work. The run publishes its progress
    and its result to erp.app_settings (see _RUN_STATE_KEY), which every
    worker can read, and dashboard.js polls getBackupStatus until it reaches
    a terminal state.
    """
    existing = _read_run_state()
    if existing and existing.get("state") == "RUNNING":
        # Report the id of the run that is ALREADY going, not a new one: the
        # client polls for the id it is given, and this is the run whose
        # result it will actually receive.
        return build_response(
            True,
            {
                "status": "RUNNING",
                "run_id": existing.get("run_id"),
                "already_running": True,
            },
            "A backup is already running. Watching that one instead of starting another.",
        )

    try:
        app = current_app._get_current_object()
    except RuntimeError:
        app = None

    run_id = uuid.uuid4().hex
    threading.Thread(
        target=_backup_worker,
        args=(app, run_id),
        daemon=True,
        name="manual-backup",
    ).start()

    return build_response(
        True,
        {"status": "STARTED", "run_id": run_id},
        "Backup started. This takes a couple of minutes; progress is shown below.",
    )


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

    # The shared record first: it is the only source that can answer for a
    # run happening in ANOTHER worker's thread, which -- with four workers
    # and a browser polling this endpoint -- is the usual case.
    run = _read_run_state()
    if run:
        status_copy["run_id"] = run.get("run_id")
        status_copy["run_state"] = run.get("state")
        status_copy["run_phase"] = run.get("phase")
        status_copy["run_phase_label"] = run.get("phase_label")
        status_copy["run_percent"] = run.get("percent")
        status_copy["run_updated_at"] = run.get("updated_at")
        result = run.get("result")
        if isinstance(result, dict):
            # A finished run's own fields win over this process's memory of
            # whatever it last did itself, which may be nothing at all.
            status_copy.update(result)
    else:
        status_copy["run_id"] = None
        status_copy["run_state"] = None

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

            # "When did a backup last run?" must be answered from the shared
            # record, not from this process's memory. Every worker starts
            # this scheduler, and _LAST_BACKUP_STATUS is empty in a freshly
            # recycled one -- so a worker restart made the answer "never",
            # and the next holder of the advisory lock ran a full backup
            # regardless of the one an hour earlier.
            run = _read_run_state()
            last_time_str = None
            if run and isinstance(run.get("result"), dict):
                last_time_str = run["result"].get("timestamp")
            if not last_time_str:
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
                # Same publishing path as the manual trigger, so the
                # dashboard reflects a scheduled run too rather than only
                # ever showing runs somebody clicked.
                _execute_backup_run(cur, uuid.uuid4().hex)

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
                            "[backup_service] Pruned %d expired mutation record(s)",
                            removed,
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
                logger.warning(
                    "[backup_service] Failed to release advisory lock in finally"
                )


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
        target=_scheduler_loop,
        args=(stop_event,),
        daemon=True,
        name="nightly-backup-scheduler",
    )
    thread.start()
    app.logger.info("[backup_service] Automated nightly backup scheduler started.")
