#!/usr/bin/env python
"""Mirror current Postgres ERP data into the legacy Google Apps Script (GAS)
app's EXISTING bound spreadsheet, in that app's ORIGINAL per-sheet column
layout -- so the GAS app (c:\\Users\\erkar\\my-app-script-project) keeps
working as a read-only backup/viewer, unmodified, showing current MTC data
instead of stale historical data.

This is NOT the same as backup_db_to_sheets.py, which dumps every erp.*
table into a NEW dated spreadsheet, one tab per raw table, for disaster
recovery. This script instead overwrites data rows (below the existing
header row(s)) of a FIXED, already-populated spreadsheet, in the exact
column layout config.js expects, driven by gas_sheet_mapping.yaml.

SAFETY MODEL
------------
- Default mode is --dry-run: reports what would be written (row counts per
  sheet) without touching the spreadsheet.
- --execute is required to actually write.
- Row-count sanity guard: before wiping a sheet's data rows, if the sheet
  currently has more than ~20 rows and the new row count would be less than
  half the old count, that sheet's write is SKIPPED (not the whole run) and
  logged loudly -- protects against a transient empty/partial Postgres
  query silently nuking data the business is actively viewing.
- Each sheet is independent: one sheet failing (or being guard-skipped)
  does not block the rest. Exit code is 1 if anything failed/was skipped,
  0 if every sheet mirrored cleanly.

USAGE
-----
  # Dry run, all sheets:
  python mirror_db_to_gas_sheets.py --database-url $DATABASE_URL

  # Dry run, one sheet, while iterating on the mapping:
  python mirror_db_to_gas_sheets.py --only UNITS

  # Actually write:
  python mirror_db_to_gas_sheets.py --only UNITS --execute

Required env vars: GOOGLE_APPLICATION_CREDENTIALS (service account JSON key
with Editor access to the target spreadsheet).
"""

from __future__ import annotations

import argparse
import contextlib
import os
import sys
from pathlib import Path

import yaml

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

try:
    import sheets_client  # type: ignore
except ImportError:
    from . import sheets_client  # type: ignore


# ─────────────────────────────────────────────────────────────────────────
# Mapping load
# ─────────────────────────────────────────────────────────────────────────


def load_mapping(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


# ─────────────────────────────────────────────────────────────────────────
# Computed columns (pure functions, no DB/Sheets access -- see
# gas_sheet_mapping.yaml's header comment for what each one mirrors)
# ─────────────────────────────────────────────────────────────────────────


def _num(value) -> float:
    try:
        return float(value) if value is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _fn_line_total(line: dict, group: list[dict]) -> float:
    return round(_num(line.get("qty")) * _num(line.get("price")), 2)


def _fn_bill_line_total(line: dict, group: list[dict]) -> float:
    subtotal = _num(line.get("qty")) * _num(line.get("price"))
    gst = _num(line.get("gst_rate_pct"))
    return round(subtotal + subtotal * (gst / 100), 2)


def _fn_po_header_total_qty(line: dict, group: list[dict]) -> float:
    return round(sum(_num(gl.get("qty")) for gl in group), 2)


COMPUTED_FNS = {
    "line_total": _fn_line_total,
    "bill_line_total": _fn_bill_line_total,
    "po_header_total_qty": _fn_po_header_total_qty,
}


# ─────────────────────────────────────────────────────────────────────────
# Pure row-builders (no DB/Sheets access -- unit-testable with plain dicts)
# ─────────────────────────────────────────────────────────────────────────


def _width(col_defs: list[dict]) -> int:
    return max((c["col"] for c in col_defs), default=0)


def build_flat_row(entry: dict, db_row: dict) -> list:
    """entry['columns'] + db_row (a dict keyed by db column name) -> one
    sheet row, 0-filled with '' for any gap column."""
    col_defs = entry["columns"]
    width = _width(col_defs)
    row = [""] * width
    for c in col_defs:
        row[c["col"] - 1] = sheets_client.to_cell_value(db_row.get(c["db"]))
    return row


def build_flat_sheet_rows(entry: dict, db_rows: list[dict]) -> list[list]:
    return [build_flat_row(entry, r) for r in db_rows]


def build_header_lines_rows(entry: dict, groups: list[tuple[dict, list[dict]]]) -> list[list]:
    """groups: ordered list of (header_values, [line_values, ...]) --
    header_values/line_values are dicts keyed by db column name. Returns one
    output row per line, with header columns repeated on every line row of
    its group (the GAS app's own denormalized layout) and `computed`
    columns evaluated per line against its own group."""
    header_defs = entry["header_columns"]
    line_defs = entry["line_columns"]
    computed_defs = entry.get("computed", [])
    width = max(_width(header_defs), _width(line_defs), _width(computed_defs))

    rows = []
    for header_values, lines in groups:
        for line_values in lines:
            row = [""] * width
            for c in header_defs:
                row[c["col"] - 1] = sheets_client.to_cell_value(header_values.get(c["db"]))
            for c in line_defs:
                row[c["col"] - 1] = sheets_client.to_cell_value(line_values.get(c["db"]))
            for c in computed_defs:
                fn = COMPUTED_FNS[c["fn"]]
                row[c["col"] - 1] = sheets_client.to_cell_value(fn(line_values, lines))
            rows.append(row)
    return rows


def build_items_master_rows(entry: dict, items: list[dict], pairs_by_item_id: dict[int, list[tuple]]) -> list[list]:
    """items: list of dicts (id + entry['columns']' db fields). pairs_by_item_id:
    item id -> ordered list of (vendor, rate) tuples from erp.item_vendors."""
    col_defs = entry["columns"]
    base_width = _width(col_defs)
    start_col = entry["vendor_pairs"]["start_col"]

    rows = []
    for item in items:
        pairs = pairs_by_item_id.get(item["id"], [])
        width = max(base_width, start_col - 1 + len(pairs) * 2)
        row = [""] * width
        for c in col_defs:
            row[c["col"] - 1] = sheets_client.to_cell_value(item.get(c["db"]))
        for i, (vendor, rate) in enumerate(pairs):
            row[start_col - 1 + i * 2] = sheets_client.to_cell_value(vendor)
            row[start_col - 1 + i * 2 + 1] = sheets_client.to_cell_value(rate)
        rows.append(row)
    return rows


def build_stock_rows(entry: dict, records: list[dict]) -> list[list]:
    """records: stock_service.get_stock_data()'s already-computed rows
    (name/size/initialStock/currentStock/threshold/deadStock/...) -- reused
    directly rather than re-deriving the Current Stock formula here."""
    col_defs = entry["columns"]
    width = max(_width(col_defs), 4)  # col 4 (currentStock) is always used
    field_by_col = {c["col"]: c["db"] for c in col_defs}
    # Postgres db-column name -> stock_service's camelCase record key.
    record_key = {
        "item_name": "name",
        "size": "size",
        "initial_stock": "initialStock",
        "threshold": "threshold",
        "dead_stock": "deadStock",
    }
    rows = []
    for rec in records:
        row = [""] * width
        for col, db in field_by_col.items():
            row[col - 1] = sheets_client.to_cell_value(rec.get(record_key[db]))
        row[3] = sheets_client.to_cell_value(rec.get("currentStock"))  # col 4
        rows.append(row)
    return rows


# ─────────────────────────────────────────────────────────────────────────
# Row-count sanity guard (pure)
# ─────────────────────────────────────────────────────────────────────────


def would_wipe_unsafely(old_count: int, new_count: int, min_base: int = 20) -> bool:
    """True if writing `new_count` rows over `old_count` existing rows looks
    like it could be an accidental near-wipe (a transient empty/partial
    Postgres query) rather than a real drop in row count. Sheets with few
    rows to begin with (<= min_base) are exempt -- a tiny master shrinking
    is not inherently suspicious."""
    return old_count > min_base and new_count < old_count * 0.5


# ─────────────────────────────────────────────────────────────────────────
# DB fetchers (impure -- one per `kind`)
# ─────────────────────────────────────────────────────────────────────────


def _dict_cursor(conn):
    import psycopg2.extras

    return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)


def fetch_flat_db_rows(conn, entry: dict) -> list[dict]:
    with _dict_cursor(conn) as cur:
        if "query" in entry:
            cur.execute(entry["query"])
        else:
            where = "WHERE deleted_at IS NULL" if entry.get("has_soft_delete") else ""
            cur.execute(f"SELECT * FROM {entry['table']} {where} ORDER BY {entry['order_by']}")
        return [dict(r) for r in cur.fetchall()]


def fetch_header_lines_groups(conn, entry: dict) -> list[tuple[dict, list[dict]]]:
    header_dbs = sorted({c["db"] for c in entry["header_columns"]})
    line_dbs = sorted({c["db"] for c in entry["line_columns"]})
    select_parts = ["h.id AS __header_id"] + [f"h.{db} AS h__{db}" for db in header_dbs]
    select_parts += ["l.id AS __line_id"] + [f"l.{db} AS l__{db}" for db in line_dbs]
    where = "WHERE h.deleted_at IS NULL" if entry.get("has_soft_delete") else ""
    query = (
        f"SELECT {', '.join(select_parts)} "
        f"FROM {entry['header_table']} h "
        f"JOIN {entry['lines_table']} l ON l.{entry['parent_fk']} = h.id "
        f"{where} "
        f"ORDER BY h.id, l.id"
    )
    with _dict_cursor(conn) as cur:
        cur.execute(query)
        raw_rows = [dict(r) for r in cur.fetchall()]

    groups: dict[int, tuple[dict, list[dict]]] = {}
    order: list[int] = []
    for r in raw_rows:
        hid = r["__header_id"]
        if hid not in groups:
            header_values = {db: r[f"h__{db}"] for db in header_dbs}
            groups[hid] = (header_values, [])
            order.append(hid)
        line_values = {db: r[f"l__{db}"] for db in line_dbs}
        groups[hid][1].append(line_values)
    return [groups[hid] for hid in order]


def fetch_items_master_data(conn, entry: dict) -> tuple[list[dict], dict[int, list[tuple]]]:
    col_dbs = sorted({c["db"] for c in entry["columns"]})
    with _dict_cursor(conn) as cur:
        cur.execute(
            f"SELECT id, {', '.join(col_dbs)} FROM erp.items WHERE deleted_at IS NULL ORDER BY id"
        )
        items = [dict(r) for r in cur.fetchall()]

        vp = entry["vendor_pairs"]
        cur.execute(
            f"SELECT {vp['parent_fk']} AS item_id, {vp['vendor_db']} AS vendor, {vp['rate_db']} AS rate "
            f"FROM {vp['table']} ORDER BY {vp['parent_fk']}, {vp['order_by']}"
        )
        pairs_by_item_id: dict[int, list[tuple]] = {}
        for r in cur.fetchall():
            pairs_by_item_id.setdefault(r["item_id"], []).append((r["vendor"], r["rate"]))
    return items, pairs_by_item_id


@contextlib.contextmanager
def _stock_app_context():
    """stock_service.get_stock_data() needs a live database.db_pool (set by
    database.init_app() inside a running Flask app). When this script is
    invoked embedded from backup_service.perform_full_backup(), that's
    already true -- has_app_context() is True and this is a no-op. When run
    standalone, boot a throwaway app the same way tests/conftest.py already
    does (create_app("testing") -- TESTING=True keeps it from starting the
    nightly backup scheduler thread or registering production-only
    machinery)."""
    from flask import has_app_context

    if has_app_context():
        yield
        return

    from app import create_app

    app = create_app("testing")
    with app.app_context():
        yield


def fetch_stock_records() -> list[dict]:
    from app.erp.services import stock_service

    with _stock_app_context():
        resp = stock_service.get_stock_data()
    if not resp.get("success"):
        raise RuntimeError(f"stock_service.get_stock_data() failed: {resp.get('message')}")
    return resp["data"]


# ─────────────────────────────────────────────────────────────────────────
# Orchestration
# ─────────────────────────────────────────────────────────────────────────


class SheetMirrorResult:
    def __init__(self, key: str):
        self.key = key
        self.status = "ok"  # ok | skipped_guard | skipped_no_id | error | dry_run
        self.old_row_count: int | None = None
        self.new_row_count: int | None = None
        self.error: str | None = None


def _current_data_row_count(sheets, spreadsheet_id: str, sheet_name: str, data_start_row: int) -> int:
    try:
        raw = sheets_client.fetch_sheet_values(sheets, spreadsheet_id, sheet_name)
    except Exception:
        return 0
    data_rows = raw[data_start_row - 1 :]
    return sum(1 for row in data_rows if any((cell or "").strip() if isinstance(cell, str) else cell for cell in row))


def build_rows_for_entry(conn, entry: dict) -> list[list]:
    kind = entry["kind"]
    if kind == "flat":
        return build_flat_sheet_rows(entry, fetch_flat_db_rows(conn, entry))
    if kind == "header_lines":
        return build_header_lines_rows(entry, fetch_header_lines_groups(conn, entry))
    if kind == "dynamic_pairs":
        items, pairs = fetch_items_master_data(conn, entry)
        return build_items_master_rows(entry, items, pairs)
    if kind == "stock":
        return build_stock_rows(entry, fetch_stock_records())
    raise ValueError(f"Unknown sheet kind: {kind!r}")


def mirror_sheet(conn, sheets, spreadsheet_id: str, entry: dict, dry_run: bool) -> SheetMirrorResult:
    result = SheetMirrorResult(entry["key"])
    try:
        new_rows = build_rows_for_entry(conn, entry)
        result.new_row_count = len(new_rows)
        result.old_row_count = _current_data_row_count(
            sheets, spreadsheet_id, entry["sheet_name"], entry["data_start_row"]
        )

        if not entry.get("skip_guard") and would_wipe_unsafely(result.old_row_count, result.new_row_count):
            result.status = "skipped_guard"
            return result

        if dry_run:
            result.status = "dry_run"
            return result

        if new_rows:
            sheets_client.write_values_from_row(
                sheets, spreadsheet_id, entry["sheet_name"], new_rows, entry["data_start_row"]
            )
        elif result.old_row_count:
            # write_values_from_row no-ops on an empty list (nothing to
            # size the write range from) -- clear explicitly so a table
            # that's genuinely gone to zero rows doesn't leave stale ghost
            # rows behind in the mirror.
            sheets_client.clear_values_from_row(
                sheets, spreadsheet_id, entry["sheet_name"], entry["data_start_row"]
            )
        result.status = "ok"
    except Exception as exc:  # one sheet's failure must not block the rest
        result.status = "error"
        result.error = str(exc)
    return result


def run_mirror(database_url: str, spreadsheet_id: str, entries: list[dict], dry_run: bool) -> list[SheetMirrorResult]:
    import psycopg2

    sheets = sheets_client.sheets_write_client()
    conn = psycopg2.connect(database_url)
    results = []
    try:
        for entry in entries:
            result = mirror_sheet(conn, sheets, spreadsheet_id, entry, dry_run)
            results.append(result)
            _print_result(entry, result)
    finally:
        conn.close()
    return results


def _print_result(entry: dict, result: SheetMirrorResult):
    label = f"[{entry['key']}] {entry['sheet_name']}"
    if result.status == "dry_run":
        print(f"{label}: would write {result.new_row_count} row(s) (currently {result.old_row_count})")
    elif result.status == "ok":
        print(f"{label}: {result.old_row_count} -> {result.new_row_count} rows")
    elif result.status == "skipped_guard":
        print(
            f"{label}: WOULD WIPE FROM {result.old_row_count} ROWS TO {result.new_row_count} -- SKIPPED, investigate"
        )
    elif result.status == "error":
        print(f"{label}: FAILED: {result.error}")


# ─────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mapping", default=str(SCRIPT_DIR / "gas_sheet_mapping.yaml"))
    parser.add_argument("--only", help="Comma-separated sheet keys to restrict to (e.g. UNITS,ITEMS)")
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    parser.add_argument("--execute", action="store_true", help="Actually write to the spreadsheet (default is dry-run)")
    args = parser.parse_args()

    if not args.database_url:
        print("No --database-url / DATABASE_URL set. Aborting.", file=sys.stderr)
        sys.exit(1)

    mapping = load_mapping(Path(args.mapping))
    entries = mapping["sheets"]
    if args.only:
        wanted = set(args.only.split(","))
        entries = [e for e in entries if e["key"] in wanted]

    spreadsheet_id = mapping["gas_spreadsheet_id"]
    results = run_mirror(args.database_url, spreadsheet_id, entries, dry_run=not args.execute)

    failed = [r for r in results if r.status in ("error", "skipped_guard")]
    print(f"\n{len(results)} sheet(s) processed, {len(failed)} failed/skipped.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
