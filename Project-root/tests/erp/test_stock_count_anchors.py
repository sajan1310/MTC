"""A stock count is where an item's stock starts from (migration 049).

adjustStockManually used to store a count by back-solving initial_stock
against whatever movements existed at that instant. Anything dated before
the count that reached the formula afterwards -- a lot completed after the
count, a backdated issue, an edit to an old lot -- then moved a figure
somebody had counted by hand. On the 2026-10-07 snapshot 78 of 613 counted
items no longer showed their count: BB-AXLE 2-C's 08-04 count of 12,200
read 11,902, because one 298-frame lot dated 07-08 entered the formula after
the count, and every other item counted that day moved by that lot's exact
consumption.

The rule pinned down here: Current Stock = the newest count + only what
takes effect after it. Lots, issues, returns and wastage take effect on
their own date (the start of it, when entered on another day). A bill takes
effect when it was entered -- its date is the supplier's invoice date, and
the bill form already asks whether a count holds those goods.
"""

from __future__ import annotations

import json
import uuid
from datetime import date, timedelta

import psycopg2.extras

import database


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _ok(resp):
    body = resp.get_json()
    assert body["success"] is True, body.get("message")
    return body["data"]


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _make_item(client, name, initial=0):
    _ok(
        _rpc(
            client,
            "saveItem",
            [{"itemName": name, "itemInitialStock": initial}],
            mutation=True,
        )
    )


def _current(client, name, size=""):
    listed = _ok(_rpc(client, "getStockData"))
    return next(r for r in listed if r["name"] == name and r["size"] == size)[
        "currentStock"
    ]


def _count(client, name, qty, size=""):
    return _ok(
        _rpc(
            client,
            "adjustStockManually",
            [name, size, qty, "Physical recount"],
            mutation=True,
        )
    )


def _db_today() -> date:
    """Today as the DATABASE sees it. A lot "dated today" must agree with the
    session's own `created_at::date`, and CI runs in UTC against a session
    pinned to Asia/Kolkata -- for six hours a day the two calendars differ."""
    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT CURRENT_DATE")
        return cur.fetchone()[0]


def _ddmmyyyy(d: date) -> str:
    return d.strftime("%d/%m/%Y")


def _process(client):
    payload = {
        "processName": _unique_name("AnchorProcess"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique_name("AnchorOutput"),
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    return _ok(_rpc(client, "saveProcess", [payload], mutation=True))["processId"]


def _lot(client, process_id, item, consumed, status, lot_date):
    data = _ok(
        _rpc(
            client,
            "saveProduction",
            [
                {
                    "processId": process_id,
                    "assignedTo": "Worker A",
                    "qty": consumed,
                    "status": status,
                    "date": lot_date,
                    "componentsConsumed": [
                        {
                            "itemName": item,
                            "qty": consumed,
                            "sourceType": "ITEM",
                            "unit": "Pcs",
                        }
                    ],
                }
            ],
            mutation=True,
        )
    )
    return data["row"]["rowIdx"], data["lotNumber"]


def _set_status(client, row_idx, lot_qty, status):
    _ok(
        _rpc(
            client,
            "updateProductionStatus",
            [row_idx, lot_qty, status],
            mutation=True,
        )
    )


def _issue(client, item, qty, issue_date):
    _ok(
        _rpc(
            client,
            "saveIssueStock",
            [
                {
                    "date": issue_date,
                    "issuedTo": "Contractor A",
                    "items": [{"name": item, "qty": qty, "unit": "Pcs"}],
                }
            ],
            mutation=True,
        )
    )


def _bill(client, item, qty, bill_date, ledger_only=False):
    number = _unique_name("ANC")
    _ok(
        _rpc(
            client,
            "saveBill",
            [
                {
                    "vendor": _unique_name("AnchorVendor"),
                    "billNumber": number,
                    "billDate": bill_date,
                    "items": [{"name": item, "qty": qty, "price": 2}],
                    "excludeFromStockKeys": [f"{item.lower()}|"] if ledger_only else [],
                }
            ],
            mutation=True,
        )
    )
    return number


def _ledger(client, name):
    return _ok(_rpc(client, "getItemLedgerData", [name]))


# ─────────────────────────────────────────────────────────────────────────
# What a count holds
# ─────────────────────────────────────────────────────────────────────────


def test_a_lot_completed_after_a_count_but_dated_before_it_leaves_the_count(
    erp_client,
):
    """The BB-AXLE case. The lot's components left the shelf on its own
    date, so the count saw them gone; completing the lot later must not
    take them off a second time."""
    name = _unique_name("AnchorLot")
    _make_item(erp_client, name, initial=100)
    process_id = _process(erp_client)

    row_idx, lot = _lot(erp_client, process_id, name, 30, "Pending", "2026-01-05")
    assert _current(erp_client, name) == 100  # a Pending lot moves nothing yet

    _count(erp_client, name, 70)  # the shelf, without the 30 the lot took
    _set_status(erp_client, row_idx, 30, "Completed")

    assert _current(erp_client, name) == 70  # read 40 before migration 049

    data = _ledger(erp_client, name)
    lot_row = next(e for e in data["entries"] if e["ref"] == lot)
    assert lot_row["superseded"] is True
    assert lot_row["countsTowardStock"] is False
    assert lot_row["balance"] == 70  # the book's own history, up to the count

    count_row = next(e for e in data["entries"] if e["kind"] == "ADJUSTMENT")
    assert count_row["type"] == "Stock Count"
    assert count_row["balance"] == 70
    assert count_row["countsTowardStock"] is True
    assert count_row["superseded"] is False
    assert count_row["computedBalance"] == 70
    # The Stock page showed 100 when the count was entered: the lot reached
    # the books after the count, and the ledger says so.
    assert count_row["bookAtCount"] == 100

    recon = data["reconciliation"][0]
    assert recon["countedStock"] == 70
    assert recon["countedAt"]
    assert recon["currentStock"] == 70
    assert recon["balanced"] is True


def test_a_lot_logged_after_a_count_still_comes_off_it(erp_client):
    name = _unique_name("AnchorLater")
    _make_item(erp_client, name, initial=50)
    process_id = _process(erp_client)
    _count(erp_client, name, 40)

    _row_idx, lot = _lot(
        erp_client, process_id, name, 8, "Completed", _db_today().isoformat()
    )

    assert _current(erp_client, name) == 32

    data = _ledger(erp_client, name)
    assert data["entries"][0]["ref"] == lot  # newest first
    assert data["entries"][0]["superseded"] is False
    assert data["entries"][0]["countsTowardStock"] is True
    assert data["entries"][0]["balance"] == 32
    assert data["reconciliation"][0]["balanced"] is True


def test_a_backdated_issue_entered_after_a_count_is_already_inside_it(erp_client):
    name = _unique_name("AnchorIssue")
    _make_item(erp_client, name, initial=50)
    _count(erp_client, name, 40)

    _issue(erp_client, name, 5, "05/01/2026")

    assert _current(erp_client, name) == 40

    data = _ledger(erp_client, name)
    issue_row = next(e for e in data["entries"] if e["kind"] == "ISSUE")
    assert issue_row["superseded"] is True
    assert data["reconciliation"][0]["balanced"] is True


def test_editing_a_lot_dated_before_a_count_does_not_move_it(erp_client):
    name = _unique_name("AnchorEdit")
    _make_item(erp_client, name, initial=100)
    process_id = _process(erp_client)
    row_idx, _lot_number = _lot(
        erp_client, process_id, name, 10, "Completed", "2026-01-05"
    )
    assert _current(erp_client, name) == 90
    _count(erp_client, name, 85)

    # The lot's consumption is corrected afterwards -- the shelf was
    # counted after those components left it, whatever the lot now says.
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.production SET components_consumed = %s WHERE id = %s",
            (
                json.dumps(
                    [{"itemName": name, "qty": 25, "sourceType": "ITEM", "unit": "Pcs"}]
                ),
                row_idx,
            ),
        )

    assert _current(erp_client, name) == 85


def test_a_bill_entered_after_a_count_adds_to_it_whatever_its_date(erp_client):
    """A bill takes effect when it is entered. The bill form asks, for an
    invoice dated on or before a count, whether the count already holds
    the goods; "Update Stock" means they arrived after it."""
    name = _unique_name("AnchorBill")
    _make_item(erp_client, name, initial=50)
    _count(erp_client, name, 40)

    _bill(erp_client, name, 12, "05/01/2026")
    assert _current(erp_client, name) == 52

    # "Ledger only": the operator said the count already holds these.
    _bill(erp_client, name, 7, "05/01/2026", ledger_only=True)
    assert _current(erp_client, name) == 52

    data = _ledger(erp_client, name)
    assert data["reconciliation"][0]["balanced"] is True


def test_a_bill_with_no_recorded_entry_time_counts_from_the_end_of_its_day(
    erp_client,
):
    """Bills written before migration 046 had created_at backfilled to
    midnight of their own date, so their entry time is unknown. Every bill
    dated on a count day since the activity log began was entered after
    the count, so such a bill takes the END of its day: after a same-day
    count, still inside a count taken the day after."""
    name = _unique_name("AnchorLegacyBill")
    _make_item(erp_client, name, initial=50)
    _count(erp_client, name, 40)

    today = _db_today()
    same_day = _bill(erp_client, name, 10, _ddmmyyyy(today))
    day_before = _bill(erp_client, name, 6, _ddmmyyyy(today - timedelta(days=1)))
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.bill_headers SET created_at = bill_date::timestamptz "
            "WHERE bill_number IN (%s, %s)",
            (same_day, day_before),
        )

    assert _current(erp_client, name) == 50  # +10, and the day-before 6 is inside


def test_a_newer_count_replaces_the_older_one(erp_client):
    name = _unique_name("AnchorRecount")
    _make_item(erp_client, name, initial=50)
    _count(erp_client, name, 30)
    _issue(erp_client, name, 4, _ddmmyyyy(_db_today()))
    assert _current(erp_client, name) == 26

    _count(erp_client, name, 25)
    assert _current(erp_client, name) == 25

    data = _ledger(erp_client, name)
    counts = [e for e in data["entries"] if e["kind"] == "ADJUSTMENT"]
    newest, older = counts  # newest first
    assert newest["countsTowardStock"] is True and newest["superseded"] is False
    assert older["countsTowardStock"] is False and older["superseded"] is True
    assert newest["computedBalance"] == 26
    assert newest["outgoingQty"] == 1  # counted 25 against a book of 26
    issue_row = next(e for e in data["entries"] if e["kind"] == "ISSUE")
    assert issue_row["superseded"] is True  # inside the newer count
    assert data["entries"][0]["balance"] == 25
    assert data["reconciliation"][0]["balanced"] is True


# ─────────────────────────────────────────────────────────────────────────
# Renames, merges and imports keep the counts they should
# ─────────────────────────────────────────────────────────────────────────


def _counted_item_with_a_late_lot(client, name):
    """An item whose count only holds because counts are anchors: counted at
    70 with a 30-unit lot out on the floor, the lot completed afterwards.
    Read from initial_stock alone it would say 40."""
    _make_item(client, name, initial=100)
    process_id = _process(client)
    row_idx, _lot_number = _lot(client, process_id, name, 30, "Pending", "2026-01-05")
    _count(client, name, 70)
    _set_status(client, row_idx, 30, "Completed")
    assert _current(client, name) == 70


def test_renaming_a_counted_item_keeps_its_count(erp_client):
    original = _unique_name("AnchorRenameFrom")
    renamed = _unique_name("AnchorRenameTo")
    _counted_item_with_a_late_lot(erp_client, original)

    _ok(
        _rpc(
            erp_client,
            "saveItem",
            [{"itemName": renamed, "originalName": original, "originalSize": ""}],
            mutation=True,
        )
    )

    assert _current(erp_client, renamed) == 70
    data = _ledger(erp_client, renamed)
    assert any(e["kind"] == "ADJUSTMENT" for e in data["entries"])
    assert data["reconciliation"][0]["countedStock"] == 70
    assert data["reconciliation"][0]["balanced"] is True


def test_merging_into_a_counted_item_keeps_both_items_stock(erp_client):
    keep = _unique_name("AnchorKeep")
    remove = _unique_name("AnchorRemove")
    _make_item(erp_client, keep, initial=20)
    _make_item(erp_client, remove, initial=6)
    _bill(erp_client, remove, 4, "05/01/2026")
    assert _current(erp_client, remove) == 10

    _count(erp_client, keep, 15)
    _ok(
        _rpc(
            erp_client,
            "mergeSelectedItems",
            [[{"name": keep, "size": ""}, {"name": remove, "size": ""}]],
            mutation=True,
        )
    )

    assert _current(erp_client, keep) == 25  # 15 + 10

    data = _ledger(erp_client, keep)
    merge_row = next(e for e in data["entries"] if e["kind"] == "MERGE")
    assert merge_row["type"] == "Merged In"
    assert merge_row["countsTowardStock"] is True
    assert remove in merge_row["narration"]
    assert data["entries"][0]["balance"] == 25
    assert data["reconciliation"][0]["balanced"] is True


def test_a_merge_is_never_taken_for_a_count(erp_client):
    """The merged-in item was counted and the kept one never was. Its stock
    arrives as a MERGE movement, and a MERGE row is not a count -- the bill
    form must not warn that the kept item was counted."""
    keep = _unique_name("AnchorKeepPlain")
    remove = _unique_name("AnchorRemoveCounted")
    _make_item(erp_client, keep, initial=5)
    _make_item(erp_client, remove, initial=10)
    process_id = _process(erp_client)
    row_idx, _lot_number = _lot(
        erp_client, process_id, remove, 4, "Pending", "2026-01-05"
    )
    _count(erp_client, remove, 6)
    _set_status(erp_client, row_idx, 4, "Completed")
    assert _current(erp_client, remove) == 6

    _ok(
        _rpc(
            erp_client,
            "mergeSelectedItems",
            [[{"name": keep, "size": ""}, {"name": remove, "size": ""}]],
            mutation=True,
        )
    )
    assert _current(erp_client, keep) == 11  # 5 + 6

    conflicts = _ok(
        _rpc(
            erp_client,
            "checkStockAdjustmentConflicts",
            [[{"name": keep, "size": ""}], "05/01/2026"],
        )
    )
    assert conflicts == []
    assert _ledger(erp_client, keep)["reconciliation"][0]["balanced"] is True


def test_a_reimported_figure_is_a_count(erp_client):
    name = _unique_name("AnchorImport")
    _make_item(erp_client, name, initial=5)
    process_id = _process(erp_client)
    row_idx, _lot_number = _lot(
        erp_client, process_id, name, 3, "Pending", "2026-01-05"
    )

    _ok(
        _rpc(
            erp_client,
            "importStockData",
            [[{"name": name, "size": "", "initialStock": 50}]],
            mutation=True,
        )
    )
    _set_status(erp_client, row_idx, 3, "Completed")

    assert _current(erp_client, name) == 50
    reset = next(
        e for e in _ledger(erp_client, name)["entries"] if e["kind"] == "ADJUSTMENT"
    )
    assert reset["type"] == "Stock Reset"


def test_the_paginated_stock_page_agrees_with_the_full_list(erp_client):
    name = _unique_name("AnchorPage")
    _counted_item_with_a_late_lot(erp_client, name)

    page = _ok(_rpc(erp_client, "getStockData", [1, 50, name.lower(), "name", "asc"]))
    row = next(r for r in page["rows"] if r["name"] == name)
    assert row["currentStock"] == 70
    assert row["lastCountQty"] == 70
    assert row["lastCountAt"]


def test_an_adjustment_reports_the_anchored_figure_as_its_old_value(erp_client):
    """The old value an adjustment records is what the Stock page showed --
    the anchored figure -- not initial_stock + every movement."""
    name = _unique_name("AnchorOldValue")
    _counted_item_with_a_late_lot(erp_client, name)

    data = _count(erp_client, name, 64)
    assert data == {"oldCurrentStock": 70, "newCurrentStock": 64}

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute(
            "SELECT old_value, new_value FROM erp.stock_adjustments "
            "WHERE item_name = %s ORDER BY id DESC LIMIT 1",
            (name,),
        )
        newest = cur.fetchone()
    assert float(newest["old_value"]) == 70
    assert float(newest["new_value"]) == 64
