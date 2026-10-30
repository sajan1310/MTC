"""Processed items received against a production lot, in parts (migration 055).

The owner's rules (2026-10-29):

  - A receipt puts its items into the Warehouse Pool when they arrive and
    uses up the lot's materials for them, colour by colour.
  - Completed still means the whole lot: completing a partly received lot
    counts its balance as received then. Cancelled keeps what was received
    and drops only the balance.
  - The contractor is owed for what was received.

A lot nobody received against behaves exactly as it did before.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

from app.erp.services import lot_receipts


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _save_process(client, **overrides):
    payload = {
        "processName": _unique_name("Process"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique_name("PaintedFrame"),
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    payload.update(overrides)
    body = _rpc(client, "saveProcess", [payload], mutation=True).get_json()
    assert body["success"] is True, body["message"]
    return payload, body["data"]["processId"]


def _item(client, initial=100):
    name = _unique_name("Raw")
    body = _rpc(
        client,
        "saveItem",
        [{"itemName": name, "itemInitialStock": initial}],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    return name


def _component(name, qty, color_group="COMMON"):
    return {
        "itemName": name,
        "qty": qty,
        "sourceType": "ITEM",
        "unit": "Pcs",
        "colorGroup": color_group,
    }


def _save_lot(client, process_id, **form):
    body = _rpc(
        client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", **form}],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    return body["data"]["row"]


def _lot(client, lot_number):
    rows = _rpc(client, "getProductionData").get_json()["data"]
    return next(r for r in rows if r["lotNumber"] == lot_number)


def _receive(client, row, lines, when=None, remarks=""):
    form = {"rowIdx": row["rowIdx"], "lines": lines, "remarks": remarks}
    if when is not None:
        form["date"] = when.isoformat()
    return _rpc(client, "saveProductionReceipt", [form], mutation=True).get_json()


def _whole(qty):
    """A line for a lot without colours."""
    return [{"color": "", "size": "", "qty": qty}]


def _stock(client, name):
    rows = _rpc(client, "getStockData").get_json()["data"]
    return next(r for r in rows if r["name"] == name)["currentStock"]


def _pool(client, name, color=""):
    rows = _rpc(client, "getWarehousePoolData").get_json()["data"]
    match = [
        b
        for b in rows
        if b["outputItemName"] == name
        and (b["color"] or "") == color
        and not b["productTag"]
    ]
    return match[0]["availableQty"] if match else 0


def _plain_lot(client, qty=10, per_unit=2, status="In Progress"):
    """A lot without colours of `qty`, using `per_unit` of one raw item
    (100 in stock) for each unit."""
    payload, process_id = _save_process(client)
    raw = _item(client)
    row = _save_lot(
        client,
        process_id,
        qty=qty,
        status=status,
        componentsConsumed=[_component(raw, qty * per_unit)],
    )
    return payload["outputItemName"], raw, row, process_id


# ─────────────────────────────────────────────────────────────────────────
# Receiving moves the received part, and only that
# ─────────────────────────────────────────────────────────────────────────


def test_a_receipt_moves_only_what_came_back(erp_client):
    output, raw, row, _ = _plain_lot(erp_client)

    body = _receive(erp_client, row, _whole(4))
    assert body["success"] is True, body["message"]
    assert "Received 4 against Lot #" in body["message"]
    assert "6 still to come" in body["message"]

    assert _pool(erp_client, output) == 4
    assert _stock(erp_client, raw) == 100 - 8

    lot = body["data"]["row"]
    assert lot["status"] == "In Progress"
    assert (lot["receivedQty"], lot["balanceQty"], lot["receiptCount"]) == (4, 6, 1)


def test_receiving_the_rest_completes_the_lot(erp_client):
    output, raw, row, _ = _plain_lot(erp_client)
    assert _receive(erp_client, row, _whole(4))["success"] is True

    body = _receive(erp_client, row, _whole(6))
    assert body["success"] is True, body["message"]
    assert "now Completed" in body["message"]

    lot = _lot(erp_client, row["lotNumber"])
    assert lot["status"] == "Completed"
    assert (lot["receivedQty"], lot["balanceQty"]) == (10, 0)
    assert _pool(erp_client, output) == 10
    assert _stock(erp_client, raw) == 100 - 20


def test_received_in_full_moves_the_same_stock_as_completing(erp_client):
    output_a, raw_a, row_a, _ = _plain_lot(erp_client)
    output_b, raw_b, row_b, _ = _plain_lot(erp_client)

    assert _receive(erp_client, row_a, _whole(3))["success"] is True
    assert _receive(erp_client, row_a, _whole(7))["success"] is True
    done = _rpc(
        erp_client,
        "updateProductionStatus",
        [row_b["rowIdx"], row_b["qty"], "Completed"],
        mutation=True,
    ).get_json()
    assert done["success"] is True

    assert _pool(erp_client, output_a) == _pool(erp_client, output_b) == 10
    assert _stock(erp_client, raw_a) == _stock(erp_client, raw_b) == 80


def test_a_pending_lot_goes_in_progress_on_its_first_receipt(erp_client):
    _output, _raw, row, _ = _plain_lot(erp_client, status="Pending")
    body = _receive(erp_client, row, _whole(2))
    assert body["success"] is True, body["message"]
    assert body["data"]["row"]["status"] == "In Progress"


def test_a_lot_nobody_received_against_shows_its_whole_quantity_as_balance(
    erp_client,
):
    _output, _raw, row, _ = _plain_lot(erp_client)
    lot = _lot(erp_client, row["lotNumber"])
    assert (lot["receivedQty"], lot["balanceQty"], lot["receiptCount"]) == (0, 10, 0)


def test_a_completed_lot_has_no_balance(erp_client):
    _output, _raw, row, _ = _plain_lot(erp_client, status="Completed")
    lot = _lot(erp_client, row["lotNumber"])
    assert (lot["receivedQty"], lot["balanceQty"]) == (0, 0)


# ─────────────────────────────────────────────────────────────────────────
# Colours: each receipt names its colours, and moves only those
# ─────────────────────────────────────────────────────────────────────────


def _colour_lot(client):
    """10 frames: 6 Red + 4 Blue, a raw frame each (COMMON) and a sticker
    per colour."""
    payload, process_id = _save_process(client)
    red, blue = _unique_name("Red"), _unique_name("Blue")
    frame, red_sticker, blue_sticker = _item(client), _item(client), _item(client)
    row = _save_lot(
        client,
        process_id,
        status="In Progress",
        colorBreakdown=[
            {"color": red, "qty": 6, "isCustom": True},
            {"color": blue, "qty": 4, "isCustom": True},
        ],
        componentsConsumed=[
            _component(frame, 10),
            _component(red_sticker, 6, red),
            _component(blue_sticker, 4, blue),
        ],
    )
    return payload["outputItemName"], red, blue, frame, red_sticker, blue_sticker, row


def test_a_colour_receipt_moves_that_colour_and_its_share_of_the_rest(erp_client):
    output, red, blue, frame, red_sticker, blue_sticker, row = _colour_lot(erp_client)

    body = _receive(erp_client, row, [{"color": red, "size": "", "qty": 3}])
    assert body["success"] is True, body["message"]

    assert _pool(erp_client, output, red) == 3
    assert _pool(erp_client, output, blue) == 0
    assert _stock(erp_client, frame) == 97  # COMMON: 3 of the lot's 10
    assert _stock(erp_client, red_sticker) == 97  # Red: 3 of Red's 6
    assert _stock(erp_client, blue_sticker) == 100  # no Blue came back


def test_receipts_detail_lists_each_colour_with_its_balance(erp_client):
    _output, red, blue, *_rest, row = _colour_lot(erp_client)
    assert (
        _receive(
            erp_client,
            row,
            [
                {"color": red, "size": "", "qty": 2},
                {"color": blue, "size": "", "qty": 1},
            ],
            remarks="first van",
        )["success"]
        is True
    )

    data = _rpc(erp_client, "getProductionReceipts", [row["rowIdx"]]).get_json()["data"]
    lines = {line["color"]: line for line in data["lines"]}
    assert (lines[red]["qty"], lines[red]["received"], lines[red]["balance"]) == (
        6,
        2,
        4,
    )
    assert (lines[blue]["qty"], lines[blue]["received"], lines[blue]["balance"]) == (
        4,
        1,
        3,
    )
    assert data["canReceive"] is True
    [receipt] = data["receipts"]
    assert receipt["qty"] == 3
    assert receipt["remarks"] == "first van"
    assert receipt["byName"] == "ERP Test User"
    assert data["lot"]["balanceQty"] == 7


def test_a_receipt_is_a_line_in_the_pools_ledger_dated_when_received(erp_client):
    output, _raw, row, _ = _plain_lot(erp_client)
    yesterday = date.today() - timedelta(days=1)
    lot_day = date.fromisoformat(row["dateRaw"])
    when = yesterday if yesterday >= lot_day else lot_day
    assert _receive(erp_client, row, _whole(4), when=when, remarks="van 1")["success"]

    rows = _rpc(erp_client, "getWarehousePoolLedger", [output, "", ""]).get_json()[
        "data"
    ]
    [credit] = [r for r in rows if r["type"] == "Production Credit"]
    assert credit["ref"] == row["lotNumber"]
    assert credit["remarks"] == "Received 4 of 10 -- van 1"
    assert credit["inQty"] == 4
    assert credit["dateRaw"] == when.isoformat()


# ─────────────────────────────────────────────────────────────────────────
# Completing or cancelling a partly received lot
# ─────────────────────────────────────────────────────────────────────────


def test_completing_a_partly_received_lot_counts_the_balance_as_received(
    erp_client,
):
    output, raw, row, _ = _plain_lot(erp_client)
    assert _receive(erp_client, row, _whole(4))["success"] is True

    body = _rpc(
        erp_client,
        "updateProductionStatus",
        [row["rowIdx"], row["qty"], "Completed"],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    assert "The 6 not received yet are counted as received now." in body["message"]
    assert body["data"]["row"]["balanceQty"] == 0

    assert _pool(erp_client, output) == 10
    assert _stock(erp_client, raw) == 80


def test_cancelling_keeps_what_was_received_and_drops_the_balance(erp_client):
    output, raw, row, _ = _plain_lot(erp_client)
    assert _receive(erp_client, row, _whole(4))["success"] is True

    body = _rpc(
        erp_client,
        "updateProductionStatus",
        [row["rowIdx"], row["qty"], "Cancelled"],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    assert (
        "The 4 received stay received; the 6 not received are dropped."
        in (body["message"])
    )

    assert _pool(erp_client, output) == 4
    assert _stock(erp_client, raw) == 92
    lot = _lot(erp_client, row["lotNumber"])
    assert (lot["receivedQty"], lot["balanceQty"]) == (4, 0)


def test_reopening_a_completed_partly_received_lot_brings_its_balance_back(
    erp_client,
):
    output, raw, row, _ = _plain_lot(erp_client)
    assert _receive(erp_client, row, _whole(4))["success"] is True
    for status in ("Completed", "In Progress"):
        assert _rpc(
            erp_client,
            "updateProductionStatus",
            [row["rowIdx"], row["qty"], status],
            mutation=True,
        ).get_json()["success"]

    lot = _lot(erp_client, row["lotNumber"])
    assert (lot["receivedQty"], lot["balanceQty"]) == (4, 6)
    assert _pool(erp_client, output) == 4
    assert _stock(erp_client, raw) == 92


# ─────────────────────────────────────────────────────────────────────────
# What is refused
# ─────────────────────────────────────────────────────────────────────────


def test_more_than_the_balance_is_refused(erp_client):
    _output, _raw, row, _ = _plain_lot(erp_client)
    assert _receive(erp_client, row, _whole(4))["success"] is True
    body = _receive(erp_client, row, _whole(7))
    assert body["success"] is False
    assert body["message"] == f"Only 6 are still to come on Lot #{row['lotNumber']}."


def test_more_than_a_colours_balance_is_refused(erp_client):
    _output, red, _blue, *_rest, row = _colour_lot(erp_client)
    body = _receive(erp_client, row, [{"color": red, "size": "", "qty": 7}])
    assert body["success"] is False
    assert body["message"] == (
        f"Only 6 of {red} are still to come on Lot #{row['lotNumber']}."
    )


def test_a_colour_the_lot_does_not_have_is_refused(erp_client):
    *_rest, row = _colour_lot(erp_client)
    body = _receive(erp_client, row, [{"color": "Purple", "size": "", "qty": 1}])
    assert body["success"] is False
    assert "is not one of Lot #" in body["message"]


def test_nothing_entered_is_refused(erp_client):
    _output, _raw, row, _ = _plain_lot(erp_client)
    body = _receive(erp_client, row, _whole(0))
    assert body["success"] is False
    assert body["message"] == "Enter how many came back."


def test_a_receipt_dated_before_its_lot_or_in_the_future_is_refused(erp_client):
    _output, _raw, row, _ = _plain_lot(erp_client)
    lot_day = date.fromisoformat(row["dateRaw"])

    early = _receive(erp_client, row, _whole(1), when=lot_day - timedelta(days=1))
    assert early["success"] is False
    assert "can't be dated before its lot" in early["message"]

    late = _receive(erp_client, row, _whole(1), when=date.today() + timedelta(days=1))
    assert late["success"] is False
    assert late["message"] == "A receipt can't be dated in the future."


def test_completed_and_cancelled_lots_take_no_receipts(erp_client):
    _output, _raw, done, _ = _plain_lot(erp_client, status="Completed")
    body = _receive(erp_client, done, _whole(1))
    assert body["success"] is False
    assert "already counts as received" in body["message"]

    _output, _raw, off, _ = _plain_lot(erp_client, status="Cancelled")
    body = _receive(erp_client, off, _whole(1))
    assert body["success"] is False
    assert "Set it back to In Progress" in body["message"]


# ─────────────────────────────────────────────────────────────────────────
# Deleting a receipt, and editing a lot that has some
# ─────────────────────────────────────────────────────────────────────────


def test_deleting_a_receipt_puts_everything_back(erp_client):
    output, raw, row, _ = _plain_lot(erp_client)
    receipt_id = _receive(erp_client, row, _whole(4))["data"]["receiptId"]

    body = _rpc(
        erp_client, "deleteProductionReceipt", [receipt_id], mutation=True
    ).get_json()
    assert body["success"] is True, body["message"]
    assert body["data"]["row"]["balanceQty"] == 10
    assert _pool(erp_client, output) == 0
    assert _stock(erp_client, raw) == 100

    again = _rpc(
        erp_client, "deleteProductionReceipt", [receipt_id], mutation=True
    ).get_json()
    assert again["success"] is False


def test_a_receipt_on_a_completed_lot_cannot_be_deleted(erp_client):
    _output, _raw, row, _ = _plain_lot(erp_client)
    first = _receive(erp_client, row, _whole(4))["data"]["receiptId"]
    assert _receive(erp_client, row, _whole(6))["success"] is True  # completes

    body = _rpc(
        erp_client, "deleteProductionReceipt", [first], mutation=True
    ).get_json()
    assert body["success"] is False
    assert "Set it back to In Progress" in body["message"]


def test_a_lot_edit_cannot_go_below_what_was_received(erp_client):
    _output, raw, row, process_id = _plain_lot(erp_client)
    assert _receive(erp_client, row, _whole(6))["success"] is True

    def edit(qty):
        return _rpc(
            erp_client,
            "saveProduction",
            [
                {
                    "rowIdx": row["rowIdx"],
                    "processId": process_id,
                    "assignedTo": "Worker A",
                    "status": "In Progress",
                    "qty": qty,
                    "componentsConsumed": [_component(raw, qty * 2)],
                }
            ],
            mutation=True,
        ).get_json()

    refused = edit(5)
    assert refused["success"] is False
    assert refused["message"] == (
        "This lot has 6 received, so its quantity can't go below 6. "
        "Delete a receipt first if fewer really came back."
    )

    grown = edit(12)
    assert grown["success"] is True, grown["message"]
    assert grown["data"]["row"]["balanceQty"] == 6


def test_a_lot_edit_cannot_take_off_a_colour_that_has_receipts(erp_client):
    _output, red, blue, frame, red_sticker, blue_sticker, row = _colour_lot(erp_client)
    assert _receive(erp_client, row, [{"color": red, "size": "", "qty": 2}])["success"]

    body = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "rowIdx": row["rowIdx"],
                "processId": row["processId"],
                "assignedTo": "Worker A",
                "status": "In Progress",
                "colorBreakdown": [{"color": blue, "qty": 4, "isCustom": True}],
                "componentsConsumed": [
                    _component(frame, 4),
                    _component(blue_sticker, 4, blue),
                ],
            }
        ],
        mutation=True,
    ).get_json()
    assert body["success"] is False
    assert body["message"] == (
        f"{red} has 2 received, so it can't be taken off this lot. "
        "Delete its receipts first."
    )


def test_a_colour_rename_reaches_the_receipts(erp_client):
    old_color = _unique_name("OldRcptColour")
    new_color = _unique_name("NewRcptColour")
    assert _rpc(erp_client, "saveColor", [{"name": old_color}], mutation=True)
    payload, process_id = _save_process(erp_client)
    raw = _item(erp_client)
    row = _save_lot(
        erp_client,
        process_id,
        status="In Progress",
        colorBreakdown=[{"color": old_color, "qty": 5, "isCustom": True}],
        componentsConsumed=[_component(raw, 5)],
    )
    assert _receive(erp_client, row, [{"color": old_color, "size": "", "qty": 2}])[
        "success"
    ]

    renamed = _rpc(
        erp_client,
        "saveColor",
        [{"name": new_color, "originalName": old_color}],
        mutation=True,
    ).get_json()
    assert renamed["success"] is True, renamed["message"]

    data = _rpc(erp_client, "getProductionReceipts", [row["rowIdx"]]).get_json()["data"]
    [line] = data["lines"]
    assert (line["color"], line["received"], line["balance"]) == (new_color, 2, 3)
    assert data["receipts"][0]["lines"][0]["color"] == new_color
    assert _pool(erp_client, payload["outputItemName"], new_color) == 2


# ─────────────────────────────────────────────────────────────────────────
# Everyone else who reads a lot
# ─────────────────────────────────────────────────────────────────────────


def test_the_contractor_is_owed_for_what_was_received(erp_client):
    process_type = _unique_name("RcptRateType")
    contractor = _unique_name("RcptWorker")
    _payload, process_id = _save_process(erp_client, processType=process_type)
    assert _rpc(
        erp_client,
        "saveContractorRate",
        [
            {
                "contractorName": contractor,
                "processType": process_type,
                "size": "General",
                "ratePerUnit": 15,
            }
        ],
        mutation=True,
    ).get_json()["success"]
    raw = _item(erp_client)
    row = _save_lot(
        erp_client,
        process_id,
        assignedTo=contractor,
        qty=4,
        status="In Progress",
        componentsConsumed=[_component(raw, 4)],
    )

    def summary():
        rows = _rpc(erp_client, "getContractorLedgerData").get_json()["data"]
        match = [c for c in rows if c["contractorName"] == contractor]
        return match[0] if match else None

    assert summary() is None  # nothing received, nothing owed

    assert _receive(erp_client, row, _whole(1))["success"] is True
    owed = summary()
    assert (owed["lotCount"], owed["totalQty"], owed["totalPayable"]) == (1, 1, 15)
    account = _rpc(erp_client, "getContractorAccountLedger", [contractor]).get_json()[
        "data"
    ]
    [entry] = account["entries"]
    assert entry["amount"] == 15
    assert "received 1 of 4" in entry["description"]

    assert _rpc(
        erp_client,
        "updateProductionStatus",
        [row["rowIdx"], row["qty"], "Completed"],
        mutation=True,
    ).get_json()["success"]
    owed = summary()
    assert (owed["totalQty"], owed["totalPayable"]) == (4, 60)
    account = _rpc(erp_client, "getContractorAccountLedger", [contractor]).get_json()[
        "data"
    ]
    assert sorted(e["amount"] for e in account["entries"]) == [15, 45]
    assert account["totalPayable"] == 60


def test_the_item_ledger_agrees_with_stock_on_a_partly_received_lot(erp_client):
    _output, raw, row, _ = _plain_lot(erp_client)
    assert _receive(erp_client, row, _whole(4))["success"] is True

    data = _rpc(erp_client, "getItemLedgerData", [raw]).get_json()["data"]
    [use] = [e for e in data["entries"] if e["kind"] == "PRODUCTION"]
    assert use["ref"] == row["lotNumber"] or row["lotNumber"] in str(use)
    assert use["outgoingQty"] == 8
    assert all(r["balanced"] for r in data["reconciliation"])
    assert _stock(erp_client, raw) == 92


def test_the_dashboard_counts_only_the_balance_as_work_in_progress(erp_client):
    _output, _raw, row, process_id = _plain_lot(erp_client)
    assert _receive(erp_client, row, _whole(4))["success"] is True

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    stage = next(p for p in dash["pipeline"] if p["processId"] == process_id)
    assert stage["totalQty"] == 6


def test_a_lot_cannot_be_dated_after_its_first_receipt(erp_client):
    today = date.today()
    _output, raw, row, process_id = _plain_lot(erp_client)

    def redate(when):
        return _rpc(
            erp_client,
            "saveProduction",
            [
                {
                    "rowIdx": row["rowIdx"],
                    "processId": process_id,
                    "assignedTo": "Worker A",
                    "status": "In Progress",
                    "qty": 10,
                    "date": when.isoformat(),
                    "componentsConsumed": [_component(raw, 20)],
                }
            ],
            mutation=True,
        ).get_json()

    earlier = redate(today - timedelta(days=10))
    assert earlier["success"] is True, earlier["message"]
    received = _receive(erp_client, row, _whole(2), when=today - timedelta(days=5))
    assert received["success"] is True, received["message"]

    refused = redate(today - timedelta(days=4))
    assert refused["success"] is False
    assert "can't be dated after its first receipt" in refused["message"]

    same_day = redate(today - timedelta(days=5))
    assert same_day["success"] is True, same_day["message"]


def test_a_receipt_with_a_date_that_means_nothing_is_refused(erp_client):
    _output, _raw, row, _ = _plain_lot(erp_client)

    body = _rpc(
        erp_client,
        "saveProductionReceipt",
        [{"rowIdx": row["rowIdx"], "lines": _whole(2), "date": "31st of Nowhere"}],
        mutation=True,
    ).get_json()

    assert body["success"] is False
    assert body["message"] == "Enter a valid receipt date."
    assert _lot(erp_client, row["lotNumber"])["balanceQty"] == 10


def test_a_receipt_with_no_date_is_dated_today(erp_client):
    _output, _raw, row, _ = _plain_lot(erp_client)

    body = _receive(erp_client, row, _whole(2))

    assert body["success"] is True, body["message"]


def test_a_line_that_is_not_a_quantity_refuses_the_receipt(erp_client):
    _output, red, blue, _frame, _r, _b, row = _colour_lot(erp_client)

    for bad in ("six", -2, "nan", 99999999):
        body = _receive(
            erp_client,
            row,
            [
                {"color": red, "size": "", "qty": 2},
                {"color": blue, "size": "", "qty": bad},
            ],
        )
        assert body["success"] is False, bad
        assert f'"{bad}" is not a quantity for' in body["message"]
    assert _lot(erp_client, row["lotNumber"])["balanceQty"] == 10


def test_a_blank_or_zero_line_is_still_nothing_received_of_that_colour(erp_client):
    _output, red, blue, _frame, _r, _b, row = _colour_lot(erp_client)

    body = _receive(
        erp_client,
        row,
        [
            {"color": red, "size": "", "qty": 2},
            {"color": blue, "size": "", "qty": ""},
        ],
    )
    assert body["success"] is True, body["message"]

    body = _receive(
        erp_client,
        row,
        [
            {"color": red, "size": "", "qty": 1},
            {"color": blue, "size": "", "qty": "0.0"},
        ],
    )
    assert body["success"] is True, body["message"]
    assert _lot(erp_client, row["lotNumber"])["balanceQty"] == 7


def test_a_quantity_in_a_message_never_reads_in_exponents():
    assert lot_receipts.fmt_qty(1500000) == "1500000"
    assert lot_receipts.fmt_qty(1500000.5) == "1500000.5"
    assert lot_receipts.fmt_qty(60.0) == "60"
    assert lot_receipts.fmt_qty(2.5) == "2.5"
