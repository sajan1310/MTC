#!/usr/bin/env python
"""Nightly backup: snapshot every erp.* table into a dated Google Sheets
spreadsheet (MTC-backup-YYYY-MM-DD), one tab per table. Postgres stays the
canonical/primary store -- this is a read-only export, it never writes back
to Postgres.

USAGE
-----
  python backup_db_to_sheets.py --database-url $DATABASE_URL

Required env vars: GOOGLE_APPLICATION_CREDENTIALS (service account JSON key
with Sheets + Drive API access). Optional: DRIVE_FOLDER_ID to file backups
into a specific Drive folder instead of the service account's My Drive root.

Retention: pass --retention-days N (default 90) to delete backup
spreadsheets older than N days from the same Drive folder. Skipped
entirely if DRIVE_FOLDER_ID is not set (can't safely scope the deletion
query to "our" backups without it).

Scheduling: see README.md for cron and Google Cloud Scheduler examples.
"""

from __future__ import annotations

import argparse
import datetime
import os
import sys


_script_dir = os.path.dirname(os.path.abspath(__file__))
if _script_dir not in sys.path:
    sys.path.insert(0, _script_dir)

try:
    import sheets_client  # type: ignore
except ImportError:
    from . import sheets_client  # type: ignore


# Every erp.* table worth backing up. Deliberately excludes:
#   - erp.migrations_applied, erp.bom_access_tokens, erp.rpc_mutations
#     (internal/runtime state -- the last is a replay-idempotency cache for
#     mutating RPC calls, not business data worth restoring)
#   - erp.dispatch_legacy: the pre-023 flat dispatch table, renamed (never
#     dropped) as a one-time safety net by 023_dispatch_header_lines.sql's
#     migration DO block. It only exists on databases that had an
#     erp.dispatch table at the moment 023 ran -- a fresh/newer-provisioned
#     DB never creates it, so `SELECT *` against it would raise
#     UndefinedTable and abort the whole run. Its rows are frozen duplicates
#     already carried forward into erp.dispatch_headers/erp.dispatch_lines,
#     so nothing is actually lost by leaving it out.
#   - Nothing else is excluded -- unlike the Sheets->PG migration (which
#     skips computed caches on the READ side), a backup should capture
#     Postgres's actual current state including materialized tables like
#     erp.warehouse_pool, so a restore has everything.
#
# Keep this list in sync with migrations/erp/*.sql -- it's a plain Python
# list, not derived from information_schema, so a new CREATE TABLE there
# needs a corresponding entry here or its data silently never gets backed
# up (nothing errors; the table is just absent from the backup spreadsheet).
TABLES = [
    "erp.units", "erp.color_master", "erp.model_master", "erp.process_type_master",
    "erp.vendors", "erp.contractors", "erp.contractor_rates", "erp.contractor_service_charges",
    "erp.contractor_payments",
    "erp.clients", "erp.items", "erp.item_vendors", "erp.stock", "erp.stock_adjustments",
    "erp.stock_group_master", "erp.stock_group_items",
    "erp.rate_history", "erp.process_master", "erp.process_components",
    "erp.process_color_links", "erp.process_color_overrides",
    "erp.warehouse_pool_opening", "erp.warehouse_pool", "erp.warehouse_pool_adjustments",
    "erp.po_headers", "erp.po_lines", "erp.bill_headers", "erp.bill_lines",
    "erp.return_headers", "erp.return_lines", "erp.wastage_headers", "erp.wastage_lines",
    "erp.issue_headers", "erp.issue_lines", "erp.bom_products", "erp.bom_lines",
    "erp.bom_additional_costs", "erp.client_orders_headers",
    "erp.client_orders_lines", "erp.production",
    "erp.dispatch_headers", "erp.dispatch_lines", "erp.dispatch_plan_lines",
    "erp.company_settings", "erp.ledger_audit_log", "erp.app_settings",
]


def _get_pk_columns(cur, table: str) -> list[str]:
    """Return the primary-key column(s) for *table* (schema-qualified)."""
    schema, tbl = table.split(".", 1)
    cur.execute(
        """
        SELECT a.attname
          FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid
                              AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = %s::regclass
           AND i.indisprimary
         ORDER BY array_position(i.indkey, a.attnum)
        """,
        (table,),
    )
    return [r[0] for r in cur.fetchall()]


def fetch_table_rows(cur, table: str) -> tuple[list[str], list[list]]:
    pk_cols = _get_pk_columns(cur, table)
    if pk_cols:
        order_clause = "ORDER BY " + ", ".join(pk_cols)
    else:
        order_clause = ""
    cur.execute(f"SELECT * FROM {table} {order_clause}")
    columns = [d[0] for d in cur.description]
    rows = []
    for record in cur.fetchall():
        rows.append([_cell(v) for v in record])
    return columns, rows


# Alias, not a re-implementation: the actual coercion logic lives in
# sheets_client.to_cell_value so every script in this directory that writes
# Postgres data into Sheets shares one implementation instead of drifting.
_cell = sheets_client.to_cell_value



def run_backup(database_url: str, drive_folder_id: str | None = None, existing_spreadsheet_id: str | None = None) -> str:
    import psycopg2

    today = datetime.date.today().isoformat()
    title = f"MTC-backup-{today}"

    sheets = sheets_client.sheets_write_client()
    drive = sheets_client.drive_client()

    if existing_spreadsheet_id:
        spreadsheet_id = existing_spreadsheet_id
        print(f"Updating existing backup spreadsheet: {spreadsheet_id}")
    else:
        spreadsheet_id = sheets_client.create_spreadsheet(sheets, drive, title, drive_folder_id)
        print(f"Created backup spreadsheet: {title} ({spreadsheet_id})")

    conn = psycopg2.connect(database_url)
    try:
        with conn:
            with conn.cursor() as cur:
                first = True
                for table in TABLES:
                    columns, rows = fetch_table_rows(cur, table)
                    tab_name = table.split(".", 1)[1][:99]  # Sheets tab-name length cap
                    actual_tab, is_fresh = _ensure_sheet_tab(sheets, spreadsheet_id, tab_name, first)
                    first = False
                    sheets_client.write_values(sheets, spreadsheet_id, actual_tab, [columns] + rows, fresh=is_fresh)
                    print(f"  {table} -> tab '{actual_tab}': {len(rows)} rows")
    finally:
        conn.close()

    return spreadsheet_id


def _ensure_sheet_tab(sheets, spreadsheet_id: str, tab_name: str, first: bool) -> tuple[str, bool]:
    """Returns (actual_tab_name, is_fresh) -- is_fresh is True when the tab was
    just created/renamed into existence this call, so callers know it's
    already empty and don't need to clear it before writing."""
    meta = sheets_client.with_retry(
        lambda: sheets.spreadsheets().get(spreadsheetId=spreadsheet_id, fields="sheets.properties").execute()
    )
    existing_tabs = [s["properties"]["title"] for s in meta.get("sheets", [])]
    lower_map = {t.lower(): t for t in existing_tabs}

    if tab_name.lower() in lower_map:
        return lower_map[tab_name.lower()], False

    if first and len(existing_tabs) == 1 and existing_tabs[0].lower().startswith("sheet"):
        _rename_first_tab(sheets, spreadsheet_id, tab_name)
        return tab_name, True

    sheets_client.add_sheet_tab(sheets, spreadsheet_id, tab_name)
    return tab_name, True




def _rename_first_tab(client, spreadsheet_id: str, new_title: str):
    meta = sheets_client.with_retry(
        lambda: client.spreadsheets().get(spreadsheetId=spreadsheet_id, fields="sheets.properties").execute()
    )
    sheet_id = meta["sheets"][0]["properties"]["sheetId"]
    body = {"requests": [{"updateSheetProperties": {"properties": {"sheetId": sheet_id, "title": new_title}, "fields": "title"}}]}
    sheets_client.with_retry(lambda: client.spreadsheets().batchUpdate(spreadsheetId=spreadsheet_id, body=body).execute())


def apply_retention(drive_folder_id: str, retention_days: int):
    drive = sheets_client.drive_client()
    cutoff = (datetime.datetime.utcnow() - datetime.timedelta(days=retention_days)).isoformat("T") + "Z"
    query = (
        f"'{drive_folder_id}' in parents and name contains 'MTC-backup-' "
        f"and mimeType = 'application/vnd.google-apps.spreadsheet' and createdTime < '{cutoff}'"
    )
    results = sheets_client.with_retry(
        lambda: drive.files().list(q=query, fields="files(id, name, createdTime)").execute()
    )
    for f in results.get("files", []):
        print(f"Retention: deleting {f['name']} ({f['createdTime']})")
        sheets_client.with_retry(lambda fid=f["id"]: drive.files().delete(fileId=fid).execute())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    parser.add_argument("--drive-folder-id", default=os.environ.get("DRIVE_FOLDER_ID"))
    parser.add_argument("--retention-days", type=int, default=90)
    parser.add_argument("--no-retention", action="store_true")
    args = parser.parse_args()

    if not args.database_url:
        print("No --database-url / DATABASE_URL set. Aborting.", file=sys.stderr)
        sys.exit(1)

    try:
        spreadsheet_id = run_backup(args.database_url, args.drive_folder_id)
        print(f"Backup complete: https://docs.google.com/spreadsheets/d/{spreadsheet_id}")
    except Exception as exc:
        print(f"BACKUP FAILED: {exc}", file=sys.stderr)
        sys.exit(1)

    if args.drive_folder_id and not args.no_retention:
        apply_retention(args.drive_folder_id, args.retention_days)
    elif not args.drive_folder_id:
        print("No --drive-folder-id / DRIVE_FOLDER_ID set -- skipping retention cleanup (can't scope it safely).")


if __name__ == "__main__":
    main()
