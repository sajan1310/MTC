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
from typing import Any, Dict, Optional

import psycopg2.sql

import database
from config import Config
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
}

_STATUS_LOCK = threading.Lock()


def get_backup_dir() -> str:
    """Returns absolute path to project backups/ directory."""
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


def export_local_sql_snapshot(cur, backup_filepath: str) -> None:
    """Exports a simple SQL dump of all erp.* tables into backup_filepath.

    Writes INSERT statements for each row so the backup file is actually
    restorable, not just comment headers. Uses psycopg2.sql.Identifier
    for table names to avoid SQL injection from unusual table names.

    Reuses backup_db_to_sheets.TABLES for the table list so this backup
    stays in sync with the curated list there (which deliberately excludes
    internal/runtime tables such as erp.bom_access_tokens).
    """
    tables = [qualified.split(".", 1)[1] for qualified in _migration_module().TABLES]

    with open(backup_filepath, "w", encoding="utf-8") as f:
        f.write(f"-- MTC ERP Database Backup\n-- Generated: {datetime.datetime.now().isoformat()}\n\n")
        for table in tables:
            qualified = psycopg2.sql.SQL("{}.{}").format(
                psycopg2.sql.Identifier("erp"),
                psycopg2.sql.Identifier(table),
            )
            full_table = f"erp.{table}"
            f.write(f"-- Table: {full_table}\n")
            try:
                cur.execute(psycopg2.sql.SQL("SELECT * FROM {}").format(qualified))
                cols = [d[0] for d in cur.description]
                rows = cur.fetchall()
                f.write(f"-- Rows count: {len(rows)}\n")
                for row in rows:
                    values = []
                    for val in row:
                        if val is None:
                            values.append("NULL")
                        elif isinstance(val, (int, float)):
                            values.append(str(val))
                        elif isinstance(val, (datetime.date, datetime.datetime)):
                            values.append(f"'{val.isoformat()}'")
                        elif isinstance(val, bool):
                            values.append("TRUE" if val else "FALSE")
                        else:
                            # Escape single quotes for SQL safety
                            escaped = str(val).replace("'", "''")
                            values.append(f"'{escaped}'")
                    col_list = ", ".join(cols)
                    val_list = ", ".join(values)
                    f.write(f"INSERT INTO {full_table} ({col_list}) VALUES ({val_list});\n")
            except Exception as e:
                f.write(f"-- Error exporting {full_table}: {e}\n")
                continue
            f.write("\n")


def perform_full_backup() -> Dict[str, Any]:
    """Performs both a local database snapshot backup and Google Sheets upload."""
    now_iso = datetime.datetime.now().isoformat()
    timestamp_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = get_backup_dir()
    local_backup_file = os.path.join(backup_dir, f"db_backup_{timestamp_str}.sql")

    # 1. Local Postgres snapshot backup
    local_success = False
    local_error = None
    try:
        with database.get_conn() as (_conn, cur):
            export_local_sql_snapshot(cur, local_backup_file)
            local_success = True
            logger.info("[backup_service] Local database snapshot saved to: %s", local_backup_file)
    except Exception as exc:
        local_error = str(exc)
        logger.error("[backup_service] Local snapshot backup failed: %s", exc)

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

    # Build final status summary
    all_succeeded = local_success and sheets_success and mirror_success
    status_str = "SUCCESS" if all_succeeded else ("PARTIAL" if local_success else "FAILED")

    messages = []
    if local_success:
        messages.append(f"Local DB snapshot created ({os.path.basename(local_backup_file)})")
    else:
        messages.append(f"Local DB snapshot failed ({local_error})")

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
    }

    with _STATUS_LOCK:
        _LAST_BACKUP_STATUS.update(result_data)

    return result_data


@rpc_method("triggerBackup", mutation=True, roles=frozenset({"admin"}))
def rpc_trigger_backup() -> Dict[str, Any]:
    """RPC method to manually trigger a database backup & Google Sheets upload."""
    try:
        res = perform_full_backup()
        is_ok = res["status"] in ("SUCCESS", "PARTIAL")
        return build_response(is_ok, res, res["message"])
    except Exception as exc:
        logger.exception("[backup_service] Manual backup trigger error")
        return build_response(False, None, f"Failed to run backup: {exc}")


@rpc_method("getBackupStatus")
def rpc_get_backup_status() -> Dict[str, Any]:
    """RPC method to fetch the current backup status and last run timestamp."""
    with _STATUS_LOCK:
        status_copy = dict(_LAST_BACKUP_STATUS)
    return build_response(True, status_copy, "Backup status loaded.")


def _run_scheduled_backup_safely() -> None:
    """Attempt a nightly backup if enough time has elapsed.

    Uses a session-level advisory lock (pg_try_advisory_lock) instead of
    pg_try_advisory_xact_lock so the lock remains held while
    perform_full_backup() runs (which opens its own DB connections).
    The lock is explicitly released in the finally block.
    """
    conn_for_lock = None
    cur_for_lock = None
    lock_acquired = False
    try:
        # Acquire a session-level advisory lock that persists across
        # transactions until explicitly released or the session ends.
        with database.get_conn() as (_conn, cur):
            conn_for_lock = _conn
            cur_for_lock = cur
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

            # Release the advisory lock explicitly
            cur.execute("SELECT pg_advisory_unlock(%s)", (_BACKUP_LOCK_KEY,))
            lock_acquired = False
    except Exception as exc:
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
