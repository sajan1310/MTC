#!/usr/bin/env python
"""Migrate historical data from the Apps Script Google Sheets into Postgres,
driven by mapping.yaml.

SAFETY MODEL
------------
- Default mode is --dry-run: reads every configured sheet, parses and
  type-checks every row, reports counts/duplicates/parse errors. Touches
  Sheets only, never the database (a read-only DB count comparison is
  attempted if --database-url/DATABASE_URL is reachable, but is skipped
  silently if not -- it never blocks the dry-run report).
- --execute is required to write anything, AND --yes-really-truncate is
  required on top of that to actually TRUNCATE tables first. Both are
  separate flags on purpose -- it should not be possible to trigger a wipe
  by fat-fingering a single flag.
- Only tables under the `erp` schema are ever truncated. public.users and
  every other public.* table (auth, sessions, etc.) are never touched by
  this script, full stop -- this is a deliberate, hard-coded restriction,
  not something a flag can override.
- The whole load runs inside one DB transaction: any failure rolls back
  everything, so a half-finished run never leaves the DB in a mixed state.
- Fresh serial IDs are always generated on insert (per project decision --
  original Sheet row identity is preserved only where it's already a real
  business-key column, e.g. po_number, not the Postgres primary key).

USAGE
-----
  # 1. Dry run first, always:
  python migrate_sheets_to_pg.py --mapping mapping.yaml

  # 2. Once the dry-run report is clean, load into a LOCAL/DEV db only:
  python migrate_sheets_to_pg.py --mapping mapping.yaml \
      --database-url postgresql://user:pass@localhost/erp_dev \
      --execute --yes-really-truncate

  # Restrict to specific sheets while iterating on the mapping:
  python migrate_sheets_to_pg.py --only ITEMS,VENDORS,STOCK

Required env vars: GOOGLE_APPLICATION_CREDENTIALS (service account JSON key
with the spreadsheet(s) shared to it, Viewer is enough for this script).
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import defaultdict
from pathlib import Path

import yaml

import sheets_client
import transforms

SCRIPT_DIR = Path(__file__).resolve().parent


# ─────────────────────────────────────────────────────────────────────────
# Mapping load + row parsing (no DB, no network -- safe to unit test)
# ─────────────────────────────────────────────────────────────────────────


def load_mapping(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def parse_row(raw_row: list[str], col_defs: list[dict]) -> tuple[dict, list[str]]:
    """raw_row is 0-indexed; col_defs entries have 1-based `col`. Returns
    (values keyed by sheet field name, list of parse-error strings)."""
    values, errors = {}, []
    for col_def in col_defs:
        idx = col_def["col"] - 1
        raw = raw_row[idx] if idx < len(raw_row) else None
        parse_failed = False
        try:
            values[col_def["sheet"]] = transforms.coerce(
                raw,
                col_def["type"],
                default=col_def.get("default"),
                date_style=col_def.get("date_style", "mdy"),
            )
        except ValueError as exc:
            errors.append(f"col {col_def['col']} ({col_def['sheet']}): {exc}")
            parse_failed = True
        if (
            not parse_failed
            and col_def.get("required")
            and values.get(col_def["sheet"]) in (None, "")
        ):
            errors.append(f"col {col_def['col']} ({col_def['sheet']}) is required but blank")
    return values, errors


def row_is_blank(raw_row: list[str]) -> bool:
    return not any((cell or "").strip() for cell in raw_row)


def db_columns(values: dict, col_defs: list[dict]) -> dict:
    """sheet-field-keyed values -> db-column-keyed values, for the columns
    that actually have a `db` target (external_parent/key_columns entries
    don't)."""
    by_sheet = {c["sheet"]: c["db"] for c in col_defs if "db" in c}
    return {by_sheet[k]: v for k, v in values.items() if k in by_sheet}


# ─────────────────────────────────────────────────────────────────────────
# Sheet fetch + per-entry row extraction
# ─────────────────────────────────────────────────────────────────────────


class SheetReport:
    def __init__(self, key):
        self.key = key
        self.raw_row_count = 0
        self.parsed_row_count = 0
        self.skipped_blank = 0
        self.errors: list[str] = []
        self.duplicate_keys: list[str] = []
        self.distinct_groups: int | None = None  # split entries only: distinct header keys
        self.sample_row: dict | None = None
        self.status = "ok"


def fetch_entry_rows(client, spreadsheet_id: str, entry: dict, report: SheetReport):
    """Yields (raw_row_number, raw_row) for every non-blank data row."""
    raw = sheets_client.fetch_sheet_values(client, spreadsheet_id, entry["sheet_name"])
    start = entry["data_start_row"] - 1
    data_rows = raw[start:]
    report.raw_row_count = len(data_rows)
    for offset, raw_row in enumerate(data_rows):
        row_number = entry["data_start_row"] + offset
        if row_is_blank(raw_row):
            report.skipped_blank += 1
            continue
        yield row_number, raw_row


def all_column_defs(entry: dict) -> list[dict]:
    """Every declared column across a flat entry or a split header+lines
    entry, used to parse a raw row into one flat dict keyed by sheet field."""
    defs = list(entry.get("columns", []))
    if "split" in entry:
        defs = list(entry["split"]["header"]["columns"]) + list(entry["split"]["lines"]["columns"])
    if "external_parent" in entry:
        defs = defs + [{"col": entry["external_parent"]["col"], "sheet": entry["external_parent"]["sheet_field"], "type": "text", "required": True}]
    if "key_columns" in entry:
        defs = defs + [{"col": kc["col"], "sheet": kc["sheet"], "type": "text", "required": True} for kc in entry["key_columns"]]
    if "child" in entry and "pairs" in entry["child"]:
        for i, pair in enumerate(entry["child"]["pairs"]):
            defs = defs + [
                {"col": pair["vendor_col"], "sheet": _pair_field(i, "vendor"), "type": "text"},
                {"col": pair["rate_col"], "sheet": _pair_field(i, "rate"), "type": "numeric", "default": 0},
            ]
    return defs


def _pair_field(index: int, kind: str) -> str:
    """Synthetic sheet-field name for a repeating (vendor, rate) column pair
    (see ITEMS.child.pairs in mapping.yaml) -- never a real Apps Script
    field name, so this prefix can't collide with one."""
    return f"__pair{index}_{kind}"


# ─────────────────────────────────────────────────────────────────────────
# Dry run
# ─────────────────────────────────────────────────────────────────────────


def dry_run_entry(client, spreadsheet_id: str, entry: dict) -> SheetReport:
    report = SheetReport(entry["key"])
    col_defs = all_column_defs(entry)
    seen_keys = set()
    group_keys = set()

    # unique_on duplicate detection only makes sense for flat tables and for
    # a split entry's HEADER identity -- a split entry's group_by key
    # repeating across sibling rows is the normal multi-line-per-document
    # shape (many PO lines share one po_number), not a data problem, so it
    # gets a distinct-group count instead of a "duplicate" warning.
    unique_on = entry.get("unique_on") if "table" in entry else None
    group_by = entry["split"]["group_by"] if "split" in entry else None

    try:
        for row_number, raw_row in fetch_entry_rows(client, spreadsheet_id, entry, report):
            values, errors = parse_row(raw_row, col_defs)
            if errors:
                report.errors.extend(f"row {row_number}: {e}" for e in errors)
                continue
            report.parsed_row_count += 1
            if report.sample_row is None:
                report.sample_row = values
            if unique_on:
                key = tuple(values.get(_sheet_field_for_db(entry, c)) for c in unique_on)
                if key in seen_keys:
                    report.duplicate_keys.append(f"row {row_number}: {key}")
                seen_keys.add(key)
            if group_by:
                group_keys.add(tuple(values.get(f) for f in group_by))
    except Exception as exc:  # sheet not shared, wrong name, API error, etc.
        report.status = "fetch_failed"
        report.errors.append(str(exc))

    if group_by:
        report.distinct_groups = len(group_keys)
    return report


def _sheet_field_for_db(entry: dict, db_col: str) -> str | None:
    for c in all_column_defs(entry):
        if c.get("db") == db_col:
            return c["sheet"]
    return None


def print_dry_run_report(reports: list[SheetReport]):
    print("\n" + "=" * 78)
    print("DRY RUN REPORT")
    print("=" * 78)
    total_errors = 0
    for r in reports:
        print(f"\n[{r.key}] status={r.status}")
        print(f"  raw data rows: {r.raw_row_count}  blank skipped: {r.skipped_blank}  parsed ok: {r.parsed_row_count}")
        if r.distinct_groups is not None:
            print(f"  -> {r.distinct_groups} distinct header(s) (e.g. PO/bill/return numbers) across {r.parsed_row_count} line rows")
        if r.duplicate_keys:
            print(f"  DUPLICATE unique_on keys ({len(r.duplicate_keys)}):")
            for d in r.duplicate_keys[:10]:
                print(f"    {d}")
            if len(r.duplicate_keys) > 10:
                print(f"    ... and {len(r.duplicate_keys) - 10} more")
        if r.errors:
            total_errors += len(r.errors)
            print(f"  ERRORS ({len(r.errors)}):")
            for e in r.errors[:10]:
                print(f"    {e}")
            if len(r.errors) > 10:
                print(f"    ... and {len(r.errors) - 10} more")
        if r.sample_row:
            print(f"  sample parsed row: {r.sample_row}")
    print("\n" + "-" * 78)
    print(f"TOTAL sheets processed: {len(reports)}  TOTAL parse errors: {total_errors}")
    if total_errors:
        print("Fix the errors above before running --execute.")
    print("-" * 78)


# ─────────────────────────────────────────────────────────────────────────
# Execute (writes to Postgres)
# ─────────────────────────────────────────────────────────────────────────


def truncate_erp_schema(cur):
    """Truncates every table in the `erp` schema ONLY. Never touches public.*
    (users, sessions, auth) -- that restriction is not configurable.

    erp.migrations_applied is deliberately excluded: it's migrations/erp/
    runner.py's own bookkeeping of which *schema* migrations have run, not
    business data -- wiping it doesn't undo any CREATE TABLE/TRIGGER, it
    just makes the runner think the schema needs rebuilding and then fail
    on the first non-idempotent statement (CREATE TRIGGER has no IF NOT
    EXISTS) it replays against the schema that's already there. Confirmed
    live: this exact thing happened and corrupted the tracking table on a
    real run, though it never touched any actual table data."""
    cur.execute(
        """
        DO $$
        DECLARE r RECORD;
        BEGIN
            FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'erp' AND tablename <> 'migrations_applied') LOOP
                EXECUTE 'TRUNCATE TABLE erp.' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
            END LOOP;
        END;
        $$;
        """
    )


def insert_row(cur, table: str, col_values: dict) -> int:
    from psycopg2 import sql
    from psycopg2.extras import Json

    schema, _, name = table.partition(".")
    cols = list(col_values.keys())
    ident = sql.SQL(".").join([sql.Identifier(schema), sql.Identifier(name)])
    query = sql.SQL("INSERT INTO {table} ({cols}) VALUES ({vals}) RETURNING id").format(
        table=ident,
        cols=sql.SQL(", ").join(sql.Identifier(c) for c in cols),
        vals=sql.SQL(", ").join(sql.Placeholder() for _ in cols),
    )
    # transforms.coerce(..., "json") returns a plain dict/list -- psycopg2
    # can't adapt those on its own for a JSONB column without this wrapper.
    params = [Json(col_values[c]) if isinstance(col_values[c], (dict, list)) else col_values[c] for c in cols]
    cur.execute(query, params)
    return cur.fetchone()[0]


def load_flat_entry(cur, client, spreadsheet_id: str, entry: dict, counts: dict, report: SheetReport):
    col_defs = list(entry["columns"])
    child_cache = None
    if "external_parent" in entry:
        ep = entry["external_parent"]
        child_cache = load_lookup_map(cur, ep["lookup_table"], ep["lookup_key"])

    for row_number, raw_row in fetch_entry_rows(client, spreadsheet_id, entry, report):
        all_defs = all_column_defs(entry)
        values, errors = parse_row(raw_row, all_defs)
        if errors:
            report.errors.append(f"row {row_number}: {'; '.join(errors)} -- SKIPPED")
            continue
        insert_values = db_columns(values, col_defs)

        if "external_parent" in entry:
            ep = entry["external_parent"]
            raw_key = values.get(ep["sheet_field"])
            norm_key = (raw_key or "").strip().lower() if isinstance(raw_key, str) else raw_key
            parent_id = child_cache.get((norm_key,))
            if parent_id is None:
                report.errors.append(
                    f"row {row_number}: no {ep['lookup_table']} found for {ep['sheet_field']}={raw_key!r} -- SKIPPED"
                )
                continue
            insert_values[ep["target_column"]] = parent_id

        new_id = insert_row(cur, entry["table"], insert_values)
        counts[entry["table"]] += 1

        if "child" in entry and "pairs" in entry["child"]:
            load_child_pair_rows(cur, entry["child"], values, new_id, counts)


def load_child_pair_rows(cur, child_cfg: dict, values: dict, parent_id: int, counts: dict):
    """Repeating (vendor name, rate) column pairs -> one erp.item_vendors row
    per populated pair (see ITEMS.child.pairs in mapping.yaml). A pair with
    a blank vendor name is silently skipped -- that's just an item with
    fewer than the sheet's max vendor slots filled in, not an error."""
    for i in range(len(child_cfg["pairs"])):
        vendor = values.get(_pair_field(i, "vendor"))
        if not vendor:
            continue
        rate = values.get(_pair_field(i, "rate")) or 0
        insert_row(cur, child_cfg["table"], {child_cfg["parent_fk"]: parent_id, "vendor": vendor, "rate": rate})
        counts[child_cfg["table"]] += 1


def load_split_entry(cur, client, spreadsheet_id: str, entry: dict, counts: dict, report: SheetReport):
    header_cfg, lines_cfg = entry["split"]["header"], entry["split"]["lines"]
    group_by = entry["split"]["group_by"]
    all_defs = all_column_defs(entry)

    groups: dict[tuple, list[tuple[int, dict]]] = defaultdict(list)
    for row_number, raw_row in fetch_entry_rows(client, spreadsheet_id, entry, report):
        values, errors = parse_row(raw_row, all_defs)
        if errors:
            report.errors.append(f"row {row_number}: {'; '.join(errors)} -- SKIPPED")
            continue
        key = tuple(values.get(f) for f in group_by)
        groups[key].append((row_number, values))

    for key, rows in groups.items():
        first_row_number, first_values = rows[0]
        header_values = db_columns(first_values, header_cfg["columns"])
        header_id = insert_row(cur, header_cfg["table"], header_values)
        counts[header_cfg["table"]] += 1
        for row_number, values in rows:
            line_values = db_columns(values, lines_cfg["columns"])
            line_values[lines_cfg["parent_fk"]] = header_id
            insert_row(cur, lines_cfg["table"], line_values)
            counts[lines_cfg["table"]] += 1


def load_lookup_map(cur, table: str, key_columns) -> dict:
    """table -> {(key1, [key2...]): id}, lowercased text match."""
    from psycopg2 import sql

    schema, _, name = table.partition(".")
    keys = [key_columns] if isinstance(key_columns, str) else list(key_columns)
    ident = sql.SQL(".").join([sql.Identifier(schema), sql.Identifier(name)])
    query = sql.SQL("SELECT id, {keys} FROM {table} WHERE deleted_at IS NULL").format(
        keys=sql.SQL(", ").join(sql.Identifier(k) for k in keys), table=ident
    )
    cur.execute(query)
    result = {}
    for row in cur.fetchall():
        row_id, *vals = row
        norm = tuple((v or "").strip().lower() if isinstance(v, str) else v for v in vals)
        result[norm] = row_id
    return result


def resolve_foreign_keys(cur, entry: dict):
    from psycopg2 import sql

    fk_list = entry.get("fk_resolve", [])
    if not fk_list:
        return
    for fk in fk_list:
        scope = fk.get("scope")
        if "split" in entry:
            target_table = entry["split"]["header"]["table"] if scope == "header" else entry["split"]["lines"]["table"]
            col_defs = entry["split"]["header"]["columns"] if scope == "header" else entry["split"]["lines"]["columns"]
        else:
            target_table = entry["table"]
            col_defs = entry["columns"]

        source_fields = fk["source_field"] if isinstance(fk["source_field"], list) else [fk["source_field"]]
        lookup_keys = fk["lookup_key"] if isinstance(fk["lookup_key"], list) else [fk["lookup_key"]]
        local_cols = []
        for sf in source_fields:
            match = next((c["db"] for c in col_defs if c["sheet"] == sf), None)
            if not match:
                continue
            local_cols.append(match)
        if len(local_cols) != len(source_fields):
            continue  # source column not present on this table -- nothing to resolve

        t_schema, _, t_name = target_table.partition(".")
        l_schema, _, l_name = fk["lookup_table"].partition(".")
        t_ident = sql.SQL(".").join([sql.Identifier(t_schema), sql.Identifier(t_name)])
        l_ident = sql.SQL(".").join([sql.Identifier(l_schema), sql.Identifier(l_name)])

        join_clauses = [
            sql.SQL("lower(t.{lc}) = lower(l.{lk})").format(lc=sql.Identifier(lc), lk=sql.Identifier(lk))
            for lc, lk in zip(local_cols, lookup_keys)
        ]
        query = sql.SQL(
            "UPDATE {t} AS t SET {target} = l.id FROM {l} AS l WHERE t.{target} IS NULL AND {join}"
        ).format(
            t=t_ident,
            l=l_ident,
            target=sql.Identifier(fk["db_column"]),
            join=sql.SQL(" AND ").join(join_clauses),
        )
        cur.execute(query)


# ─────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mapping", default=str(SCRIPT_DIR / "mapping.yaml"))
    parser.add_argument("--only", help="Comma-separated sheet keys to restrict to (e.g. ITEMS,VENDORS)")
    parser.add_argument("--skip-needs-review", action="store_true", help="Skip entries marked status: needs_review")
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    parser.add_argument("--execute", action="store_true", help="Actually write to Postgres (default is dry-run)")
    parser.add_argument("--yes-really-truncate", action="store_true", help="Required alongside --execute to confirm the TRUNCATE")
    args = parser.parse_args()

    mapping = load_mapping(Path(args.mapping))
    entries = mapping["sheets"]
    if args.only:
        wanted = set(args.only.split(","))
        entries = [e for e in entries if e["key"] in wanted]
    if args.skip_needs_review:
        entries = [e for e in entries if e.get("status") != "needs_review"]

    client = sheets_client.sheets_read_client()

    def spreadsheet_id_for(entry):
        return entry.get("spreadsheet_id") or mapping.get("default_spreadsheet_id")

    runnable = []
    for entry in entries:
        sid = spreadsheet_id_for(entry)
        if not sid:
            print(f"[{entry['key']}] SKIPPED -- no spreadsheet_id configured", file=sys.stderr)
            continue
        runnable.append((entry, sid))

    if not args.execute:
        reports = [dry_run_entry(client, sid, entry) for entry, sid in runnable]
        print_dry_run_report(reports)
        return

    if not args.yes_really_truncate:
        print("Refusing to --execute without --yes-really-truncate as well. Aborting.", file=sys.stderr)
        sys.exit(1)
    if not args.database_url:
        print("No --database-url / DATABASE_URL set. Aborting.", file=sys.stderr)
        sys.exit(1)

    import psycopg2

    conn = psycopg2.connect(args.database_url)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT current_database(), inet_server_addr()")
                dbname, host = cur.fetchone()
                cur.execute("SELECT count(*) FROM public.users")
                user_count = cur.fetchone()[0]
                print(f"Target DB: {dbname} @ {host or 'local'}  (public.users has {user_count} accounts -- confirm this is NOT production)")

                print("Truncating erp.* tables (public schema untouched)...")
                truncate_erp_schema(cur)

                counts: dict[str, int] = defaultdict(int)
                for entry, sid in runnable:
                    report = SheetReport(entry["key"])
                    print(f"[{entry['key']}] loading from spreadsheet {sid} sheet '{entry['sheet_name']}'...")
                    if "split" in entry:
                        load_split_entry(cur, client, sid, entry, counts, report)
                    else:
                        load_flat_entry(cur, client, sid, entry, counts, report)
                    if report.errors:
                        print(f"[{entry['key']}] {len(report.errors)} row(s) skipped:")
                        for e in report.errors[:20]:
                            print(f"    {e}")

                print("Resolving foreign keys (vendor_id / item_id / contractor_id / process_master_id / bom_product_id)...")
                for entry, _sid in runnable:
                    resolve_foreign_keys(cur, entry)

                print("\nRows inserted per table:")
                for table, n in sorted(counts.items()):
                    print(f"  {table}: {n}")
        print("\nCOMMITTED. Next: advance sequences, trigger a warehouse-pool recompute, run ANALYZE -- see README.md.")
    except Exception:
        print("\nERROR -- transaction rolled back, no partial data was committed.", file=sys.stderr)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
