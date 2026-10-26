#!/usr/bin/env python
"""One-time repair: put the Apps Script app's own heading row back on the
five sheets the backup used to overwrite -- Vendors, Contractors, Clients,
Stock and Production.

Until 2026-10-26 backup_db_to_sheets wrote erp.vendors (and the other four)
INTO those sheets whenever the backup and the GAS mirror shared one
spreadsheet, as they do on the production server; the mirror then rewrote
rows 2+ but left row 1 holding database column names. The backup now writes
those tables to db_* tabs (backup_db_to_sheets.tab_name_for), so row 1 only
needs restoring once.

USAGE (from Project-root)
-----
  python scripts/migration/restore_gas_sheet_headings.py            # read-only
  python scripts/migration/restore_gas_sheet_headings.py --execute

Read-only by default: prints each sheet's row 1 beside the heading it should
have. --execute writes, and refuses unless the db_* tabs exist -- proof the
fixed backup has already run, so it will not overwrite row 1 again.

Needs GOOGLE_APPLICATION_CREDENTIALS and GAS_MIRROR_SPREADSHEET_ID (or
BACKUP_SPREADSHEET_ID), from the environment or Project-root/.env.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import sheets_client  # type: ignore  # noqa: E402

# Copied from the Apps Script project, from the code that creates each sheet
# (file:line in my-app-script-project). Widths match gas_sheet_mapping.yaml.
HEADINGS = {
    # module_vendors.js:19
    "Vendors": ["Vendor Name", "Contact Number", "Address", "GSTIN", "Remarks"],
    # module_contractors.js:45
    "Contractors": [
        "Contractor Name",
        "Contact Number",
        "Address",
        "GST/PAN",
        "Remarks",
    ],
    # module_clients.js:54
    "Clients": ["Client Name", "Contact Number", "Address", "GSTIN", "Remarks"],
    # module_stock.js:44
    "Stock": [
        "Item Name",
        "Size",
        "Initial Stock",
        "Current Stock",
        "Threshold",
        "Dead Stock",
    ],
    # module_production.js:47, and 'Order Number' (column 20) from line 209
    "Production": [
        "Date",
        "Product_ID (Tag)",
        "Product Name (Tag)",
        "Quantity",
        "Assigned by",
        "Assigned to",
        "Status",
        "Remarks",
        "Custom Components (JSON)",
        "Sheet Remarks",
        "Process ID",
        "Lot Number",
        "Consumed From Process Qty",
        "Contractor Rate",
        "Contractor Payable",
        "Output Item Name",
        "Components Consumed (JSON)",
        "Color",
        "Color Breakdown (JSON)",
        "Order Number",
    ],
}


def _setting(key: str) -> str:
    """The environment first, then Project-root/.env (read, never sourced)."""
    if os.environ.get(key):
        return os.environ[key]
    env_file = SCRIPT_DIR.parents[1] / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip("\"'")
    return ""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--execute", action="store_true", help="write row 1")
    args = parser.parse_args()

    creds = _setting("GOOGLE_APPLICATION_CREDENTIALS")
    if creds:
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = creds
    spreadsheet_id = _setting("GAS_MIRROR_SPREADSHEET_ID") or _setting(
        "BACKUP_SPREADSHEET_ID"
    )
    if not spreadsheet_id:
        sys.exit("Neither GAS_MIRROR_SPREADSHEET_ID nor BACKUP_SPREADSHEET_ID is set.")
    print(f"Spreadsheet ...{spreadsheet_id[-4:]}")

    read = sheets_client.sheets_read_client()
    meta = sheets_client.with_retry(
        lambda: (
            read.spreadsheets()
            .get(spreadsheetId=spreadsheet_id, fields="sheets.properties.title")
            .execute()
        )
    )
    tabs = {s["properties"]["title"] for s in meta.get("sheets", [])}
    db_tabs = sorted(t for t in tabs if t.startswith("db_"))
    print(f"db_ tabs: {', '.join(db_tabs) or 'none -- the fixed backup has not run'}")

    wrong = []
    for sheet, heading in HEADINGS.items():
        got = sheets_client.with_retry(
            lambda sheet=sheet: (
                read.spreadsheets()
                .values()
                .get(spreadsheetId=spreadsheet_id, range=f"'{sheet}'!1:1")
                .execute()
            )
        )
        row = (got.get("values") or [[]])[0]
        if row == heading:
            print(f"{sheet}: OK")
            continue
        wrong.append(sheet)
        print(f"{sheet}: WRONG -- now {row[:6]}{' ...' if len(row) > 6 else ''}")

    if not args.execute:
        print("Read-only run; nothing written.")
        return
    if not wrong:
        print("Nothing to restore.")
        return
    if len(db_tabs) < len(HEADINGS):
        sys.exit(
            "Refusing to write: the fixed backup has not run yet (no db_ tabs), "
            "so its next run would overwrite row 1 again."
        )

    write = sheets_client.sheets_write_client()
    for sheet in wrong:
        target = f"'{sheet}'!1:1"
        sheets_client.with_retry(
            lambda target=target: (
                write.spreadsheets()
                .values()
                .clear(spreadsheetId=spreadsheet_id, range=target)
                .execute()
            )
        )
        sheets_client.with_retry(
            lambda sheet=sheet: (
                write.spreadsheets()
                .values()
                .update(
                    spreadsheetId=spreadsheet_id,
                    range=f"'{sheet}'!A1",
                    valueInputOption="RAW",
                    body={"values": [HEADINGS[sheet]]},
                )
                .execute()
            )
        )
        print(f"{sheet}: heading row restored")


if __name__ == "__main__":
    main()
