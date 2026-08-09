"""Tests for scripts/migration/mirror_db_to_gas_sheets.py and its new
sheets_client.py helpers.

Pure row-builder / guard logic is tested with plain dicts (no DB/Sheets
call). The mapping/schema compatibility check exercises the real fetch
functions against the test database, so it doubles as a drift detector: if
a future migration renames/drops a column gas_sheet_mapping.yaml still
references, this fails loudly instead of silently mirroring wrong/blank
data -- the same class of gap test_backup.py's
test_backup_tables_list_covers_every_erp_table already guards on the
Postgres->dated-backup side.
"""

import os
import sys
from unittest.mock import MagicMock

import database

_MIGRATION_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../scripts/migration")
)
if _MIGRATION_DIR not in sys.path:
    sys.path.insert(0, _MIGRATION_DIR)

import mirror_db_to_gas_sheets as mirror  # noqa: E402
import sheets_client  # noqa: E402

MAPPING_PATH = os.path.join(_MIGRATION_DIR, "gas_sheet_mapping.yaml")


# ─────────────────────────────────────────────────────────────────────────
# Mapping / schema compatibility (real DB, no Sheets call)
# ─────────────────────────────────────────────────────────────────────────


def test_mapping_loads_and_has_28_sheets():
    mapping = mirror.load_mapping(MAPPING_PATH)
    assert mapping["gas_spreadsheet_id"]
    assert len(mapping["sheets"]) == 28
    keys = [e["key"] for e in mapping["sheets"]]
    assert len(keys) == len(set(keys)), "duplicate sheet keys in gas_sheet_mapping.yaml"


def test_every_sheet_entry_builds_rows_without_error(app):
    """Runs every entry's real fetch+build path against the live test
    schema. A renamed/dropped column or table shows up here as a hard
    failure instead of silently producing blank/wrong mirrored data."""
    mapping = mirror.load_mapping(MAPPING_PATH)
    with app.app_context():
        with database.get_conn() as (conn, _cur):
            failures = []
            for entry in mapping["sheets"]:
                try:
                    mirror.build_rows_for_entry(conn, entry)
                except Exception as exc:
                    failures.append(f"{entry['key']}: {exc}")
    assert not failures, "sheet(s) failed to build:\n" + "\n".join(failures)


# ─────────────────────────────────────────────────────────────────────────
# Pure row-builders (no DB/Sheets)
# ─────────────────────────────────────────────────────────────────────────


def test_build_flat_row_maps_columns_and_fills_gaps():
    entry = {"columns": [{"col": 1, "db": "unit_name"}, {"col": 2, "db": "family"}, {"col": 4, "db": "remarks"}]}
    row = mirror.build_flat_row(entry, {"unit_name": "Pcs", "family": "count", "remarks": "note"})
    assert row == ["Pcs", "count", "", "note"]


def test_build_flat_row_coerces_none_and_decimal():
    import decimal

    entry = {"columns": [{"col": 1, "db": "a"}, {"col": 2, "db": "b"}]}
    row = mirror.build_flat_row(entry, {"a": None, "b": decimal.Decimal("2.50")})
    assert row == ["", 2.5]


def test_build_header_lines_rows_repeats_header_and_computes_totals():
    entry = {
        "header_columns": [{"col": 1, "db": "po_number"}, {"col": 3, "db": "vendor"}],
        "line_columns": [{"col": 5, "db": "item_name"}, {"col": 8, "db": "qty"}, {"col": 12, "db": "price"}],
        "computed": [{"col": 13, "fn": "line_total"}, {"col": 14, "fn": "po_header_total_qty"}],
    }
    groups = [
        (
            {"po_number": "PO-1", "vendor": "Acme"},
            [
                {"item_name": "Bolt", "qty": 10, "price": 2.5},
                {"item_name": "Nut", "qty": 5, "price": 1.0},
            ],
        )
    ]
    rows = mirror.build_header_lines_rows(entry, groups)
    assert len(rows) == 2
    # header fields repeated on both lines
    assert rows[0][0] == "PO-1" and rows[1][0] == "PO-1"
    assert rows[0][2] == "Acme" and rows[1][2] == "Acme"
    # per-line total (qty * price)
    assert rows[0][12] == 25.0   # Bolt: 10 * 2.5
    assert rows[1][12] == 5.0    # Nut: 5 * 1.0
    # group total qty, same on every line of the group
    assert rows[0][13] == 15.0
    assert rows[1][13] == 15.0


def test_bill_line_total_includes_gst():
    entry = {
        "header_columns": [{"col": 4, "db": "vendor"}],
        "line_columns": [{"col": 9, "db": "qty"}, {"col": 11, "db": "price"}, {"col": 12, "db": "gst_rate_pct"}],
        "computed": [{"col": 13, "fn": "bill_line_total"}],
    }
    groups = [({"vendor": "Acme"}, [{"qty": 2, "price": 100, "gst_rate_pct": 18}])]
    rows = mirror.build_header_lines_rows(entry, groups)
    assert rows[0][12] == 236.0  # 2*100 = 200, +18% = 236


def test_build_items_master_rows_flattens_vendor_pairs():
    entry = {
        "columns": [{"col": 1, "db": "item_name"}, {"col": 2, "db": "size"}],
        "vendor_pairs": {"start_col": 9},
    }
    items = [{"id": 1, "item_name": "Frame", "size": ""}]
    pairs = {1: [("VendorA", 10.5), ("VendorB", 11.0)]}
    rows = mirror.build_items_master_rows(entry, items, pairs)
    assert rows[0][0] == "Frame"
    assert rows[0][8] == "VendorA"   # col 9 (0-indexed 8)
    assert rows[0][9] == 10.5
    assert rows[0][10] == "VendorB"
    assert rows[0][11] == 11.0


def test_build_items_master_rows_handles_zero_vendor_pairs():
    # base columns go up to col 8 (weight_per_base_unit), matching the real
    # ITEMS entry -- the row is padded out to that width even with zero
    # vendor pairs, it just never gets a col-9+ vendor/rate value.
    entry = {"columns": [{"col": 1, "db": "item_name"}, {"col": 8, "db": "weight_per_base_unit"}], "vendor_pairs": {"start_col": 9}}
    rows = mirror.build_items_master_rows(entry, [{"id": 1, "item_name": "Widget", "weight_per_base_unit": 0}], {})
    assert rows == [["Widget", "", "", "", "", "", "", 0]]


def test_build_stock_rows_reuses_service_current_stock():
    entry = {
        "columns": [
            {"col": 1, "db": "item_name"},
            {"col": 2, "db": "size"},
            {"col": 3, "db": "initial_stock"},
            {"col": 5, "db": "threshold"},
            {"col": 6, "db": "dead_stock"},
        ]
    }
    records = [
        {
            "name": "Bolt",
            "size": "M8",
            "initialStock": 100,
            "currentStock": 42,
            "threshold": 10,
            "deadStock": False,
        }
    ]
    rows = mirror.build_stock_rows(entry, records)
    assert rows == [["Bolt", "M8", 100, 42, 10, False]]


# ─────────────────────────────────────────────────────────────────────────
# Row-count sanity guard
# ─────────────────────────────────────────────────────────────────────────


def test_guard_blocks_large_drop_on_a_sheet_with_meaningful_data():
    assert mirror.would_wipe_unsafely(100, 10) is True


def test_guard_allows_small_sheets_to_shrink_freely():
    assert mirror.would_wipe_unsafely(5, 0) is False


def test_guard_allows_moderate_drops():
    assert mirror.would_wipe_unsafely(100, 60) is False


def test_guard_allows_growth():
    assert mirror.would_wipe_unsafely(10, 1000) is False


# ─────────────────────────────────────────────────────────────────────────
# sheets_client.py new helpers (mocked Sheets API client, no real network)
# ─────────────────────────────────────────────────────────────────────────


def _mock_sheets_client(row_count=10, col_count=10):
    client = MagicMock()
    client.spreadsheets.return_value.get.return_value.execute.return_value = {
        "sheets": [
            {
                "properties": {
                    "title": "Unit Master",
                    "sheetId": 0,
                    "gridProperties": {"rowCount": row_count, "columnCount": col_count},
                }
            }
        ]
    }
    return client


def test_clear_values_from_row_uses_row_scoped_range():
    client = MagicMock()
    sheets_client.clear_values_from_row(client, "SHEET_ID", "Unit Master", 2)
    client.spreadsheets.return_value.values.return_value.clear.assert_called_once_with(
        spreadsheetId="SHEET_ID", range="'Unit Master'!A2:ZZ"
    )


def test_write_values_from_row_anchors_at_start_row_and_clears_below_header():
    client = _mock_sheets_client()
    rows = [["Pcs", "count"], ["Kg", "weight"]]
    sheets_client.write_values_from_row(client, "SHEET_ID", "Unit Master", rows, start_row=2)

    clear_call = client.spreadsheets.return_value.values.return_value.clear
    clear_call.assert_called_once_with(spreadsheetId="SHEET_ID", range="'Unit Master'!A2:ZZ")

    update_call = client.spreadsheets.return_value.values.return_value.update
    update_call.assert_called_once()
    _, kwargs = update_call.call_args
    assert kwargs["range"] == "'Unit Master'!A2"
    assert kwargs["valueInputOption"] == "RAW"
    assert kwargs["body"] == {"values": rows}


def test_write_values_from_row_noop_on_empty_rows():
    client = MagicMock()
    sheets_client.write_values_from_row(client, "SHEET_ID", "Unit Master", [], start_row=2)
    client.spreadsheets.return_value.values.return_value.update.assert_not_called()
    client.spreadsheets.return_value.values.return_value.clear.assert_not_called()


def test_to_cell_value_covers_all_types():
    import datetime
    import decimal

    assert sheets_client.to_cell_value(None) == ""
    assert sheets_client.to_cell_value(datetime.date(2026, 8, 9)) == "2026-08-09"
    assert sheets_client.to_cell_value(decimal.Decimal("3.5")) == 3.5
    assert sheets_client.to_cell_value({"a": 1}) == '{"a": 1}'
    assert sheets_client.to_cell_value(True) is True
    assert sheets_client.to_cell_value("text") == "text"
