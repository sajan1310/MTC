"""Lot Reference: the earlier lots a lot relates to, and connections to them
(migration 057).

The owner's rules (2026-10-30):

  - Only related lots appear: the same size and model as the process, at the
    sequence just before it. Sequence 4 shows sequence 3 and only that.
  - It is optional, and older lots are not affected: nothing is required and
    nothing is back-filled.

A connection is the operator's statement and information only, so nothing a
lot does may depend on it.
"""

from __future__ import annotations

import json
import uuid
from datetime import date, timedelta

import psycopg2.extras
import pytest

import database
from app.erp.registry import RPC_METHODS
from app.erp.services import lot_reference_service, roles_service


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _token() -> str:
    return uuid.uuid4().hex[:8]


def _model(client, name=None) -> str:
    name = name or f"Mdl{_token()}"
    body = _rpc(client, "saveModel", [{"name": name}], mutation=True).get_json()
    assert body["success"] is True, body["message"]
    return name


def _process(client, sequence, output, process_type=""):
    payload = {
        "processName": f"Process {_token()}",
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": output,
        "sequence": sequence,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": process_type,
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    body = _rpc(client, "saveProcess", [payload], mutation=True).get_json()
    assert body["success"] is True, body["message"]
    return body["data"]["processId"]


def _item(client, initial=100):
    name = f"Raw-{_token()}"
    body = _rpc(
        client, "saveItem", [{"itemName": name, "itemInitialStock": initial}], True
    ).get_json()
    assert body["success"] is True, body["message"]
    return name


def _component(name, qty):
    return {
        "itemName": name,
        "qty": qty,
        "sourceType": "ITEM",
        "unit": "Pcs",
        "colorGroup": "COMMON",
    }


def _lot(client, process_id, *, qty=10, status="Completed", raw=None, **form):
    raw = raw or _item(client)
    body = _rpc(
        client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": qty,
                "status": status,
                "componentsConsumed": [_component(raw, qty)],
                **form,
            }
        ],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    return body


def _row(client, process_id, **kwargs):
    return _lot(client, process_id, **kwargs)["data"]["row"]


def _edit(client, row, **form):
    return _lot(
        client,
        row["processId"],
        qty=row["qty"],
        status=row["status"],
        rowIdx=row["rowIdx"],
        **form,
    )


def _related(client, process_id, row_idx=None):
    body = _rpc(client, "getRelatedLots", [process_id, row_idx]).get_json()
    assert body["success"] is True, body["message"]
    return body["data"]


def _numbers(lots):
    return [lot["lotNumber"] for lot in lots]


def _detail(client, row):
    body = _rpc(client, "getLotDetail", [row["rowIdx"]]).get_json()
    assert body["success"] is True, body["message"]
    return body["data"]


def _ref_numbers(client, row):
    return sorted(_numbers(_detail(client, row)["references"]))


def _set_completed_at(row, value):
    with database.get_conn() as (_c, cur):
        cur.execute(
            "UPDATE erp.production SET completed_at = %s WHERE id = %s",
            (value, row["rowIdx"]),
        )


def _set_lot_date(row, value):
    with database.get_conn() as (_c, cur):
        cur.execute(
            "UPDATE erp.production SET production_date = %s WHERE id = %s",
            (value, row["rowIdx"]),
        )


# ── Which lots appear ────────────────────────────────────────────────────


def test_sequence_4_shows_only_sequence_3_of_the_same_size_and_model(erp_client):
    model = _model(erp_client)
    painted = _process(erp_client, 2, f"Painted Frame {model} 14 inch")
    fitted = _process(erp_client, 3, f"Fitted Frame 14 inch {model} S/Rim")
    packing = _process(erp_client, 4, f"14 inch {model} D/Gaddi")

    _row(erp_client, painted)
    wanted = _row(erp_client, fitted)

    data = _related(erp_client, packing)
    assert _numbers(data["lots"]) == [wanted["lotNumber"]]
    assert (data["applicable"], data["sequence"]) == (True, 3)
    assert (data["size"], data["model"]) == ("14 inch", model)


def test_another_size_is_left_out(erp_client):
    model = _model(erp_client)
    packing = _process(erp_client, 4, f"14 inch {model} D/Gaddi")
    other_size = _process(erp_client, 3, f"Fitted Frame 20 inch {model} S/Rim")
    _row(erp_client, other_size)

    assert _related(erp_client, packing)["lots"] == []


def test_another_model_is_left_out(erp_client):
    model, other = _model(erp_client), _model(erp_client)
    packing = _process(erp_client, 4, f"14 inch {model} D/Gaddi")
    other_model = _process(erp_client, 3, f"Fitted Frame 14 inch {other} S/Rim")
    _row(erp_client, other_model)

    assert _related(erp_client, packing)["lots"] == []


def test_every_variant_of_the_size_and_model_appears(erp_client):
    model = _model(erp_client)
    packing = _process(erp_client, 4, f"14 inch {model} D/Gaddi Steel Rim")
    steel = _process(erp_client, 3, f"Fitted Frame 14 inch {model} Steel Rim")
    plain = _process(erp_client, 3, f"Fitted Frame 14 inch {model} S/Rim")
    lots = {_row(erp_client, steel)["lotNumber"], _row(erp_client, plain)["lotNumber"]}

    assert set(_numbers(_related(erp_client, packing)["lots"])) == lots


def test_sequence_1_has_nothing_before_it(erp_client):
    model = _model(erp_client)
    first = _process(erp_client, 1, f"Painted Frame {model} 14 inch")

    data = _related(erp_client, first)
    assert data["applicable"] is False
    assert data["lots"] == []


def test_a_process_with_no_sequence_3_process_lists_nothing(erp_client):
    """14 of 103 Packing processes on the 29 Oct 2026 snapshot are like this
    (24/26 inch, which skip fitting). The field is optional, so it only means
    an empty dropdown."""
    model = _model(erp_client)
    painted = _process(erp_client, 2, f"Painted Frame {model} 26 inch")
    packing = _process(erp_client, 4, f"26 inch {model} Unbranded")
    _row(erp_client, painted)

    data = _related(erp_client, packing)
    assert data["applicable"] is True
    assert data["lots"] == []


def test_the_longest_model_name_wins():
    names = ["Eagle Pro", "Eagle"]
    get = lot_reference_service._get_model_from_output_item_name
    assert get("Fitted Frame 14 inch Eagle Pro S/Rim", names) == "Eagle Pro"
    assert get("Fitted Frame 14 inch EAGLE S/Rim", names) == "Eagle"


def test_a_name_with_no_model_is_general():
    get = lot_reference_service._get_model_from_output_item_name
    assert get("Fitted Rim 14 inch", ["Eagle"]) == "General"


def test_a_process_that_does_not_exist_is_refused(erp_client):
    body = _rpc(erp_client, "getRelatedLots", ["NOT-A-PROCESS"]).get_json()
    assert body["success"] is False


# ── What each lot shows ──────────────────────────────────────────────────


@pytest.fixture
def chain(erp_client):
    """A fitting process and the packing process that follows it."""
    model = _model(erp_client)
    return (
        _process(erp_client, 3, f"Fitted Frame 14 inch {model} S/Rim"),
        _process(erp_client, 4, f"14 inch {model} D/Gaddi"),
    )


def test_newest_first(erp_client, chain):
    fitted, packing = chain
    older = _row(erp_client, fitted)
    newer = _row(erp_client, fitted)
    _set_completed_at(older, date.today() - timedelta(days=5))

    assert _numbers(_related(erp_client, packing)["lots"]) == [
        newer["lotNumber"],
        older["lotNumber"],
    ]


def test_a_completed_lot_shows_when_it_was_completed(erp_client, chain):
    fitted, packing = chain
    row = _row(erp_client, fitted)
    _set_completed_at(row, date(2026, 10, 27))

    lot = _related(erp_client, packing)["lots"][0]
    assert (lot["dateLabel"], lot["date"]) == ("Completed", "27/10/2026")


def test_a_lot_finished_before_the_stamp_existed_says_lot_date(erp_client, chain):
    """Only 933 of 1,348 Completed lots have completed_at, so the label says
    which date this is rather than claiming a completion date."""
    fitted, packing = chain
    row = _row(erp_client, fitted, date="2026-08-02")
    _set_completed_at(row, None)

    lot = _related(erp_client, packing)["lots"][0]
    assert (lot["dateLabel"], lot["date"]) == ("Lot date", "02/08/2026")


def test_a_partly_received_lot_shows_its_last_receipt(erp_client, chain):
    fitted, packing = chain
    row = _row(erp_client, fitted, status="In Progress", date="2026-10-19")
    for when in ("2026-10-20", "2026-10-22"):
        body = _rpc(
            erp_client,
            "saveProductionReceipt",
            [
                {
                    "rowIdx": row["rowIdx"],
                    "date": when,
                    "lines": [{"color": "", "size": "", "qty": 2}],
                }
            ],
            mutation=True,
        ).get_json()
        assert body["success"] is True, body["message"]

    lot = _related(erp_client, packing)["lots"][0]
    assert (lot["dateLabel"], lot["date"]) == ("Last received", "22/10/2026")


def test_open_lots_appear_and_a_cancelled_one_does_not(erp_client, chain):
    fitted, packing = chain
    pending = _row(erp_client, fitted, status="Pending")
    running = _row(erp_client, fitted, status="In Progress")
    _row(erp_client, fitted, status="Cancelled")

    lots = _related(erp_client, packing)["lots"]
    assert set(_numbers(lots)) == {pending["lotNumber"], running["lotNumber"]}
    assert {lot["status"] for lot in lots} == {"Pending", "In Progress"}


def test_a_cancelled_lot_that_received_goods_still_appears(erp_client, chain):
    fitted, packing = chain
    row = _row(erp_client, fitted, status="In Progress")
    body = _rpc(
        erp_client,
        "saveProductionReceipt",
        [{"rowIdx": row["rowIdx"], "lines": [{"color": "", "size": "", "qty": 2}]}],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    body = _rpc(
        erp_client,
        "updateProductionStatus",
        [row["rowIdx"], row["qty"], "Cancelled"],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]

    assert _numbers(_related(erp_client, packing)["lots"]) == [row["lotNumber"]]


def test_a_deleted_lot_does_not_appear(erp_client, chain):
    fitted, packing = chain
    row = _row(erp_client, fitted)
    body = _rpc(
        erp_client, "deleteProduction", [row["rowIdx"]], mutation=True
    ).get_json()
    assert body["success"] is True, body["message"]

    assert _related(erp_client, packing)["lots"] == []


def test_when_editing_a_lot_finished_later_ones_are_left_out(erp_client, chain):
    fitted, packing = chain
    before = _row(erp_client, fitted)
    after = _row(erp_client, fitted)
    _set_completed_at(before, date(2026, 9, 1))
    _set_completed_at(after, date(2026, 9, 20))
    packed = _row(erp_client, packing)
    _set_completed_at(packed, date(2026, 9, 10))

    assert _numbers(_related(erp_client, packing, packed["rowIdx"])["lots"]) == [
        before["lotNumber"]
    ]


def test_an_open_lot_being_edited_has_no_such_limit(erp_client, chain):
    fitted, packing = chain
    source = _row(erp_client, fitted)
    packed = _row(erp_client, packing, status="In Progress")

    assert _numbers(_related(erp_client, packing, packed["rowIdx"])["lots"]) == [
        source["lotNumber"]
    ]


# ── Connections are optional ─────────────────────────────────────────────


def test_a_lot_saves_with_no_reference_at_all(erp_client, chain):
    _fitted, packing = chain
    row = _row(erp_client, packing)

    assert _detail(erp_client, row)["references"] == []


def test_an_old_lot_is_untouched_by_an_edit_that_sends_no_references(erp_client, chain):
    fitted, packing = chain
    source = _row(erp_client, fitted)
    row = _row(erp_client, packing, lotRefs=json.dumps([source["rowIdx"]]))

    _edit(erp_client, row)

    assert _ref_numbers(erp_client, row) == [source["lotNumber"]]


def test_nothing_is_back_filled(erp_client, chain):
    """A lot only gets a connection someone made: the rule offers lots, and
    never writes one on its own."""
    fitted, packing = chain
    _row(erp_client, fitted)
    row = _row(erp_client, packing)

    with database.get_conn() as (_c, cur):
        cur.execute(
            "SELECT count(*) FROM erp.production_lot_refs WHERE production_id = %s",
            (row["rowIdx"],),
        )
        assert cur.fetchone()[0] == 0


# ── Saving connections ───────────────────────────────────────────────────


def test_connections_are_saved_with_the_lot(erp_client, chain):
    fitted, packing = chain
    one, two = _row(erp_client, fitted), _row(erp_client, fitted)

    row = _row(erp_client, packing, lotRefs=json.dumps([one["rowIdx"], two["rowIdx"]]))

    assert _ref_numbers(erp_client, row) == sorted([one["lotNumber"], two["lotNumber"]])


def test_an_empty_list_clears_them(erp_client, chain):
    fitted, packing = chain
    source = _row(erp_client, fitted)
    row = _row(erp_client, packing, lotRefs=json.dumps([source["rowIdx"]]))

    _edit(erp_client, row, lotRefs="[]")

    assert _ref_numbers(erp_client, row) == []


def test_a_blank_field_is_treated_as_no_field(erp_client, chain):
    fitted, packing = chain
    source = _row(erp_client, fitted)
    row = _row(erp_client, packing, lotRefs=json.dumps([source["rowIdx"]]))

    _edit(erp_client, row, lotRefs="")

    assert _ref_numbers(erp_client, row) == [source["lotNumber"]]


def test_an_edit_replaces_the_list(erp_client, chain):
    fitted, packing = chain
    one, two = _row(erp_client, fitted), _row(erp_client, fitted)
    row = _row(erp_client, packing, lotRefs=json.dumps([one["rowIdx"]]))

    _edit(erp_client, row, lotRefs=json.dumps([two["rowIdx"]]))

    assert _ref_numbers(erp_client, row) == [two["lotNumber"]]


def test_a_lot_cannot_reference_itself(erp_client, chain):
    _fitted, packing = chain
    row = _row(erp_client, packing)

    _edit(erp_client, row, lotRefs=json.dumps([row["rowIdx"]]))

    assert _ref_numbers(erp_client, row) == []


def test_duplicates_and_junk_are_ignored(erp_client, chain):
    fitted, packing = chain
    source = _row(erp_client, fitted)

    row = _row(
        erp_client,
        packing,
        lotRefs=json.dumps([source["rowIdx"], source["rowIdx"], "x", None]),
    )

    assert _ref_numbers(erp_client, row) == [source["lotNumber"]]


def test_a_lot_deleted_before_an_offline_save_synced_never_blocks_it(erp_client, chain):
    fitted, packing = chain
    source = _row(erp_client, fitted)
    gone = _row(erp_client, fitted)
    body = _rpc(
        erp_client, "deleteProduction", [gone["rowIdx"]], mutation=True
    ).get_json()
    assert body["success"] is True, body["message"]

    body = _lot(
        erp_client, packing, lotRefs=json.dumps([source["rowIdx"], gone["rowIdx"]])
    )

    assert "1 connected lot no longer exists and was left out." in body["message"]
    assert _ref_numbers(erp_client, body["data"]["row"]) == [source["lotNumber"]]


def test_a_saved_connection_to_a_lot_deleted_later_is_kept_and_marked(
    erp_client, chain
):
    fitted, packing = chain
    source = _row(erp_client, fitted)
    row = _row(erp_client, packing, lotRefs=json.dumps([source["rowIdx"]]))
    body = _rpc(
        erp_client, "deleteProduction", [source["rowIdx"]], mutation=True
    ).get_json()
    assert body["success"] is True, body["message"]

    body = _edit(erp_client, row, lotRefs=json.dumps([source["rowIdx"]]))

    assert "no longer exists" not in body["message"]
    [reference] = _detail(erp_client, row)["references"]
    assert (reference["lotNumber"], reference["deleted"]) == (source["lotNumber"], True)


def test_malformed_references_are_refused(erp_client, chain):
    _fitted, packing = chain
    raw = _item(erp_client)
    body = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": packing,
                "assignedTo": "Worker A",
                "qty": 10,
                "status": "Pending",
                "componentsConsumed": [_component(raw, 10)],
                "lotRefs": "{not json",
            }
        ],
        mutation=True,
    ).get_json()
    assert body["success"] is False
    assert "Invalid lot reference" in body["message"]


# ── Information only ─────────────────────────────────────────────────────


def _figures(client, output, raw):
    pool = _rpc(client, "getWarehousePoolData").get_json()["data"]
    stock = _rpc(client, "getStockData").get_json()["data"]
    return (
        sorted(
            (b["color"] or "", b["availableQty"])
            for b in pool
            if b["outputItemName"] == output
        ),
        next(r for r in stock if r["name"] == raw)["currentStock"],
    )


def test_a_connection_changes_no_pool_stock_or_payable_figure(erp_client, chain):
    fitted, packing = chain
    source = _row(erp_client, fitted)
    process = next(
        p
        for p in _rpc(erp_client, "getProcessData").get_json()["data"]
        if p["processId"] == packing
    )
    output = process["outputItemName"]

    raw = _item(erp_client)
    row = _row(erp_client, packing, raw=raw)
    before = _figures(erp_client, output, raw)

    _edit(erp_client, row, raw=raw, lotRefs=json.dumps([source["rowIdx"]]))

    assert _figures(erp_client, output, raw) == before
    rows = _rpc(erp_client, "getProductionData").get_json()["data"]
    saved = next(r for r in rows if r["rowIdx"] == row["rowIdx"])
    assert saved["contractorPayable"] == row["contractorPayable"]


# ── The side window ──────────────────────────────────────────────────────


def test_detail_follows_only_the_lots_someone_picked(erp_client):
    """The owner, 2026-10-30: it links to the lot selected. A related lot nobody
    picked is not offered on the lot's own page."""
    model = _model(erp_client)
    painted = _process(erp_client, 2, f"Painted Frame {model} 14 inch")
    fitted = _process(erp_client, 3, f"Fitted Frame 14 inch {model} S/Rim")
    packing = _process(erp_client, 4, f"14 inch {model} D/Gaddi")

    painted_lot = _row(erp_client, painted)
    _row(erp_client, painted)
    fitted_lot = _row(erp_client, fitted, lotRefs=json.dumps([painted_lot["rowIdx"]]))
    _row(erp_client, fitted)
    packed = _row(erp_client, packing, lotRefs=json.dumps([fitted_lot["rowIdx"]]))

    packed_detail = _detail(erp_client, packed)
    assert _numbers(packed_detail["references"]) == [fitted_lot["lotNumber"]]
    assert _numbers(_detail(erp_client, fitted_lot)["references"]) == [
        painted_lot["lotNumber"]
    ]
    assert "likelySources" not in packed_detail


def test_a_lot_nobody_connected_shows_no_other_lots(erp_client, chain):
    fitted, packing = chain
    _row(erp_client, fitted)
    packed = _row(erp_client, packing)

    assert _detail(erp_client, packed)["references"] == []


def test_detail_says_what_the_lot_is_and_nothing_about_money(erp_client, chain):
    fitted, _packing = chain
    raw = _item(erp_client)
    row = _row(
        erp_client,
        fitted,
        raw=raw,
        date="2026-10-20",
        status="In Progress",
        remarks="Check the welds",
    )
    body = _rpc(
        erp_client,
        "saveProductionReceipt",
        [
            {
                "rowIdx": row["rowIdx"],
                "date": "2026-10-22",
                "lines": [{"color": "", "size": "", "qty": 4}],
            }
        ],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]

    data = _detail(erp_client, row)
    lot = data["lot"]
    assert lot["lotNumber"] == row["lotNumber"]
    assert lot["lotDate"] == "20/10/2026"
    assert (lot["receivedQty"], lot["balanceQty"]) == (4, 6)
    assert lot["remarks"] == "Check the welds"
    assert [m["itemName"] for m in lot["materials"]] == [raw]
    assert [(r["date"], r["qty"]) for r in data["receipts"]] == [("22/10/2026", 4)]

    text = json.dumps(data).lower()
    assert "payable" not in text and "rate" not in text


def test_detail_of_a_deleted_lot_is_refused(erp_client, chain):
    fitted, _packing = chain
    row = _row(erp_client, fitted)
    _rpc(erp_client, "deleteProduction", [row["rowIdx"]], mutation=True)

    assert (
        _rpc(erp_client, "getLotDetail", [row["rowIdx"]]).get_json()["success"] is False
    )


# ── What looks used up ───────────────────────────────────────────────────
#
# The owner, 2026-10-31: lots that look used up drop out of what the dropdown
# shows first, but a wrong quantity, a bad count or a bug must never stop
# someone connecting the right lot.


def _draw(item, qty):
    return {
        "itemName": item,
        "qty": qty,
        "sourceType": "POOL",
        "unit": "Pcs",
        "colorGroup": "COMMON",
    }


def _fitted_lots(client, fitted, *quantities):
    """Completed lots, oldest first, a day apart."""
    rows = []
    for days_ago, qty in zip(range(len(quantities), 0, -1), quantities):
        row = _row(client, fitted, qty=qty)
        _set_completed_at(row, date.today() - timedelta(days=days_ago))
        rows.append(row)
    return rows


def _pack(client, packing, item, qty, *, links=(), status="Completed", **form):
    return _row(
        client,
        packing,
        qty=qty,
        status=status,
        componentsConsumed=[_draw(item, qty)],
        lotRefs=json.dumps([row["rowIdx"] for row in links]),
        **form,
    )


def _shown_first(client, process_id, row_idx=None):
    """What the dropdown shows before anyone types."""
    lots = _related(client, process_id, row_idx)["lots"]
    return [lot["lotNumber"] for lot in lots if not lot["usedUp"]]


def test_every_lot_stays_while_the_pool_holds_them_all(erp_client, chain):
    fitted, packing = chain
    older, newer = _fitted_lots(erp_client, fitted, 10, 10)

    assert _shown_first(erp_client, packing) == [
        newer["lotNumber"],
        older["lotNumber"],
    ]


def test_lots_older_than_the_pool_can_cover_look_used_up(erp_client, chain):
    """Packed with no connection at all: this is what stops an old lot staying
    listed for ever."""
    fitted, packing = chain
    oldest, middle, newest = _fitted_lots(erp_client, fitted, 10, 10, 10)

    _pack(erp_client, packing, newest["outputItemName"], 15)

    assert _shown_first(erp_client, packing) == [
        newest["lotNumber"],
        middle["lotNumber"],
    ]


def test_a_connected_lot_is_used_up_by_what_was_drawn(erp_client, chain):
    fitted, packing = chain
    older, newer = _fitted_lots(erp_client, fitted, 10, 10)

    _pack(erp_client, packing, newer["outputItemName"], 10, links=[newer])

    assert _shown_first(erp_client, packing) == [older["lotNumber"]]


def test_a_partly_taken_lot_stays(erp_client, chain):
    fitted, packing = chain
    [lot] = _fitted_lots(erp_client, fitted, 10)

    _pack(erp_client, packing, lot["outputItemName"], 4, links=[lot])

    assert _shown_first(erp_client, packing) == [lot["lotNumber"]]


def test_two_connected_lots_are_taken_oldest_first(erp_client, chain):
    fitted, packing = chain
    older, newer = _fitted_lots(erp_client, fitted, 10, 10)

    _pack(erp_client, packing, older["outputItemName"], 15, links=[newer, older])

    assert _shown_first(erp_client, packing) == [newer["lotNumber"]]


def test_a_lot_recording_no_draw_of_the_item_takes_one_per_unit(erp_client, chain):
    fitted, packing = chain
    [lot] = _fitted_lots(erp_client, fitted, 10)

    _row(erp_client, packing, qty=10, lotRefs=json.dumps([lot["rowIdx"]]))

    assert _shown_first(erp_client, packing) == []


def test_an_open_packing_lot_already_takes_its_frames(erp_client, chain):
    fitted, packing = chain
    [lot] = _fitted_lots(erp_client, fitted, 10)

    _pack(erp_client, packing, lot["outputItemName"], 10, links=[lot], status="Pending")

    assert _shown_first(erp_client, packing) == []


def test_an_open_lot_stays_when_the_pool_holds_none(erp_client, chain):
    fitted, packing = chain
    row = _row(erp_client, fitted, status="In Progress")

    assert _shown_first(erp_client, packing) == [row["lotNumber"]]


def test_a_lot_being_received_counts_what_has_come_back(erp_client, chain):
    fitted, packing = chain
    [older] = _fitted_lots(erp_client, fitted, 10)
    running = _row(erp_client, fitted, status="In Progress")
    body = _rpc(
        erp_client,
        "saveProductionReceipt",
        [
            {
                "rowIdx": running["rowIdx"],
                "lines": [{"color": "", "size": "", "qty": 6}],
            }
        ],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]

    _pack(erp_client, packing, older["outputItemName"], 14)

    # 2 left in the pool, and the 6 that came back are newer than the old lot.
    assert _shown_first(erp_client, packing) == [running["lotNumber"]]


def test_a_used_up_lot_stays_in_the_reply_and_goes_last(erp_client, chain):
    """Search finds it there, which is what keeps it within reach."""
    fitted, packing = chain
    older, newer = _fitted_lots(erp_client, fitted, 10, 10)

    _pack(erp_client, packing, newer["outputItemName"], 10, links=[newer])

    lots = _related(erp_client, packing)["lots"]
    assert [(lot["lotNumber"], lot["usedUp"]) for lot in lots] == [
        (older["lotNumber"], False),
        (newer["lotNumber"], True),
    ]


def test_a_used_up_lot_can_still_be_connected(erp_client, chain):
    fitted, packing = chain
    older, newer = _fitted_lots(erp_client, fitted, 10, 10)
    _pack(erp_client, packing, newer["outputItemName"], 15)
    assert _shown_first(erp_client, packing) == [newer["lotNumber"]]

    row = _pack(erp_client, packing, newer["outputItemName"], 1, links=[older])

    assert _ref_numbers(erp_client, row) == [older["lotNumber"]]


def test_connecting_more_than_a_lot_held_is_not_refused(erp_client, chain):
    fitted, packing = chain
    [lot] = _fitted_lots(erp_client, fitted, 10)

    row = _pack(erp_client, packing, lot["outputItemName"], 25, links=[lot])

    assert _ref_numbers(erp_client, row) == [lot["lotNumber"]]
    assert _shown_first(erp_client, packing) == []


def test_a_wrong_packing_quantity_corrects_itself_when_edited(erp_client, chain):
    fitted, packing = chain
    [lot] = _fitted_lots(erp_client, fitted, 10)
    row = _pack(erp_client, packing, lot["outputItemName"], 10, links=[lot])
    assert _shown_first(erp_client, packing) == []

    body = _edit(
        erp_client,
        {**row, "qty": 4},
        componentsConsumed=[_draw(lot["outputItemName"], 4)],
    )
    assert body["success"] is True, body["message"]

    assert _shown_first(erp_client, packing) == [lot["lotNumber"]]


def test_a_cancelled_packing_lot_gives_its_lot_back(erp_client, chain):
    fitted, packing = chain
    [lot] = _fitted_lots(erp_client, fitted, 10)
    row = _pack(
        erp_client, packing, lot["outputItemName"], 10, links=[lot], status="Pending"
    )
    assert _shown_first(erp_client, packing) == []

    body = _rpc(
        erp_client,
        "updateProductionStatus",
        [row["rowIdx"], row["qty"], "Cancelled"],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]

    assert _shown_first(erp_client, packing) == [lot["lotNumber"]]


def test_a_deleted_packing_lot_gives_its_lot_back(erp_client, chain):
    fitted, packing = chain
    [lot] = _fitted_lots(erp_client, fitted, 10)
    row = _pack(erp_client, packing, lot["outputItemName"], 10, links=[lot])
    assert _shown_first(erp_client, packing) == []

    body = _rpc(
        erp_client, "deleteProduction", [row["rowIdx"]], mutation=True
    ).get_json()
    assert body["success"] is True, body["message"]

    assert _shown_first(erp_client, packing) == [lot["lotNumber"]]


def test_a_lot_being_edited_does_not_count_against_itself(erp_client, chain):
    """Otherwise removing its link on the form could not bring the lot back."""
    fitted, packing = chain
    [lot] = _fitted_lots(erp_client, fitted, 10)
    row = _pack(
        erp_client, packing, lot["outputItemName"], 10, links=[lot], status="Pending"
    )

    assert _shown_first(erp_client, packing, row["rowIdx"]) == [lot["lotNumber"]]


def test_nothing_looks_used_up_to_a_finished_lot(erp_client, chain):
    """What is left today says nothing about what was there when it was made."""
    fitted, packing = chain
    [lot] = _fitted_lots(erp_client, fitted, 10)
    row = _pack(erp_client, packing, lot["outputItemName"], 10, links=[lot])

    assert _shown_first(erp_client, packing, row["rowIdx"]) == [lot["lotNumber"]]


def test_painting_lots_never_look_used_up(erp_client):
    """Below sequence 3 a lot is mixed (the owner, 2026-10-31)."""
    model = _model(erp_client)
    painting = _process(erp_client, 2, f"Painted Frame 14 inch {model}")
    fitting = _process(erp_client, 3, f"Fitted Frame 14 inch {model} S/Rim")
    painted = _row(erp_client, painting, qty=10)
    _pack(erp_client, fitting, painted["outputItemName"], 10, links=[painted])

    assert _shown_first(erp_client, fitting) == [painted["lotNumber"]]


def test_a_colour_gone_negative_does_not_hide_the_others(erp_client, chain):
    """Too many lots listed is harmless, and hiding one is not."""
    fitted, packing = chain
    [lot] = _fitted_lots(erp_client, fitted, 10)
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_c, cur):
        cur.execute(
            """
            INSERT INTO erp.warehouse_pool
                (output_item_name, process_id, produced_qty, consumed_qty,
                 available_qty, color)
            VALUES (%s, %s, 0, 15, -15, 'Red')
            """,
            (lot["outputItemName"], fitted),
        )
        try:
            assert lot_reference_service._pool_on_hand(
                cur, [lot["outputItemName"].lower()]
            ) == {lot["outputItemName"].lower(): 10.0}
        finally:
            cur.execute(
                "DELETE FROM erp.warehouse_pool WHERE output_item_name = %s"
                " AND color = 'Red'",
                (lot["outputItemName"],),
            )


def test_the_limit_cuts_what_looks_used_up_first(erp_client, chain, monkeypatch):
    fitted, packing = chain
    older, newer = _fitted_lots(erp_client, fitted, 10, 10)
    _pack(erp_client, packing, newer["outputItemName"], 10, links=[newer])
    monkeypatch.setattr(lot_reference_service, "MAX_RELATED_LOTS", 1)

    assert _numbers(_related(erp_client, packing)["lots"]) == [older["lotNumber"]]


# ── Tags on the Production Log ───────────────────────────────────────────


def _log_row(client, row):
    body = _rpc(client, "getProductionData").get_json()
    assert body["success"] is True, body["message"]
    return next(r for r in body["data"] if r["rowIdx"] == row["rowIdx"])


def test_the_log_lists_what_a_lot_is_connected_to(erp_client, chain):
    fitted, packing = chain
    first = _row(erp_client, fitted)
    second = _row(erp_client, fitted)

    row = _row(
        erp_client, packing, lotRefs=json.dumps([first["rowIdx"], second["rowIdx"]])
    )

    refs = _log_row(erp_client, row)["lotRefs"]
    assert {ref["lotNumber"] for ref in refs} == {
        first["lotNumber"],
        second["lotNumber"],
    }
    assert {ref["rowIdx"] for ref in refs} == {first["rowIdx"], second["rowIdx"]}


def test_a_saved_lot_comes_back_with_its_tags(erp_client, chain):
    """The form patches the row from this, so the tag shows with no reload."""
    fitted, packing = chain
    source = _row(erp_client, fitted)

    row = _row(erp_client, packing, lotRefs=json.dumps([source["rowIdx"]]))

    assert [ref["lotNumber"] for ref in row["lotRefs"]] == [source["lotNumber"]]


def test_a_lot_with_no_connections_has_no_tags(erp_client, chain):
    fitted, _packing = chain
    row = _row(erp_client, fitted)

    assert row["lotRefs"] == []
    assert _log_row(erp_client, row)["lotRefs"] == []


def test_a_tag_on_a_lot_deleted_since_says_so(erp_client, chain):
    fitted, packing = chain
    source = _row(erp_client, fitted)
    row = _row(erp_client, packing, lotRefs=json.dumps([source["rowIdx"]]))

    body = _rpc(
        erp_client, "deleteProduction", [source["rowIdx"]], mutation=True
    ).get_json()
    assert body["success"] is True, body["message"]

    [ref] = _log_row(erp_client, row)["lotRefs"]
    assert (ref["lotNumber"], ref["deleted"]) == (source["lotNumber"], True)


# ── Who may see it ───────────────────────────────────────────────────────


@pytest.mark.parametrize("method", ["getRelatedLots", "getLotDetail"])
def test_lot_references_need_the_production_tab(method):
    """A module missing from this map skips the custom-role check entirely."""
    assert RPC_METHODS[method].module == "lot_reference_service"
    assert roles_service.TAB_BY_SERVICE_MODULE["lot_reference_service"] == (
        "productionTab"
    )


def test_a_custom_role_with_no_production_access_is_refused(
    erp_client, erp_test_user, erp_app
):
    role = f"no_production_{_token()}"
    with database.get_conn() as (_c, cur):
        cur.execute(
            "INSERT INTO custom_roles (role_key, role_name, permissions) "
            "VALUES (%s, %s, %s)",
            (role, role, json.dumps({"stockTab": "editor"})),
        )
        cur.execute(
            "UPDATE users SET role = %s WHERE user_id = %s", (role, erp_test_user)
        )
    try:
        response = _rpc(erp_client, "getLotDetail", [1])
        assert response.status_code == 403
    finally:
        with database.get_conn() as (_c, cur):
            cur.execute(
                "UPDATE users SET role = 'user' WHERE user_id = %s", (erp_test_user,)
            )
            cur.execute("DELETE FROM custom_roles WHERE role_key = %s", (role,))
