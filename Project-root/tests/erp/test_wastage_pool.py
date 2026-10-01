"""Wastage written off the Warehouse Pool (migration 048).

A processed item -- a painted frame, a fitted rim -- can come out
defective, and those units live in a Warehouse Pool bucket, not in Items
Stock. A wastage line with sourceType 'POOL' names that bucket (Output Item
Name, Product Tag, Color) and is debited in _recalculate_warehouse_pool's
Pass 2b. Items Stock, the Item Ledger and the ledger audit never see it.

Every pool test here leans on the invariant test_warehouse_ledger.py
explains: the pool's own ledger closes on the bucket's Available Qty.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import psycopg2.extras

import database
from app.erp.services import warehouse_service


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
    }
    payload.update(overrides)
    body = _rpc(client, "saveProcess", [payload], mutation=True).get_json()
    assert body["success"] is True, body["message"]
    return payload, body["data"]["processId"]


def _seed(client, qty, color="", **process_overrides):
    """A process whose output bucket holds `qty` units of `color`."""
    payload, process_id = _save_process(client, **process_overrides)
    body = _rpc(
        client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": qty, "color": color}],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    return payload, process_id


def _bucket(client, name, color="", tag=""):
    rows = _rpc(client, "getWarehousePoolData").get_json()["data"]
    return next(
        b
        for b in rows
        if b["outputItemName"] == name
        and (b["color"] or "") == color
        and (b["productTag"] or "") == tag
    )


def _ledger(client, name, color=""):
    body = _rpc(client, "getWarehousePoolLedger", [name, "", color]).get_json()
    assert body["success"] is True, body["message"]
    return body["data"]


def _pool_line(name, qty, color="", reason="Paint run", tag=""):
    return {
        "sourceType": "POOL",
        "name": name,
        "color": color,
        "productTag": tag,
        "qty": qty,
        "reason": reason,
    }


def _log(client, lines, when=None, existing_id=None):
    form = {"date": (when or date.today()).isoformat(), "items": lines}
    if existing_id:
        form["existingWastageId"] = existing_id
    return _rpc(client, "saveWastage", [form], mutation=True).get_json()


def _record(client, wastage_id):
    rows = _rpc(client, "getWastageData").get_json()["data"]
    return next(w for w in rows if w["wastageId"] == wastage_id)


def test_pool_wastage_takes_units_out_of_its_bucket(erp_client):
    payload, _ = _seed(erp_client, 50, "Blue-White")
    name = payload["outputItemName"]

    body = _log(erp_client, [_pool_line(name, 3, "Blue-White")])
    assert body["success"] is True, body["message"]
    assert "Warning" not in body["message"]

    bucket = _bucket(erp_client, name, "Blue-White")
    assert bucket["producedQty"] == 50
    assert bucket["consumedQty"] == 3
    assert bucket["availableQty"] == 47


def test_pool_wastage_is_a_line_in_the_pools_own_ledger(erp_client):
    payload, _ = _seed(erp_client, 50, "Blue-White")
    name = payload["outputItemName"]
    wastage_id = _log(erp_client, [_pool_line(name, 3, "Blue-White")])["data"][
        "wastageId"
    ]

    rows = _ledger(erp_client, name, "Blue-White")
    assert [r["type"] for r in rows] == ["Wastage", "Opening Stock"]
    wastage = rows[0]
    assert wastage["ref"] == wastage_id
    assert wastage["remarks"] == "Paint run"
    assert (wastage["inQty"], wastage["outQty"]) == (0, 3)
    assert wastage["balance"] == _bucket(erp_client, name, "Blue-White")["availableQty"]


def test_pool_wastage_never_touches_items_stock(erp_client):
    """An Items Master item that happens to share the output's name keeps
    its stock, and its Item Ledger lists no wastage: the line belongs to
    the pool's identity space, not Items Master's."""
    payload, _ = _seed(erp_client, 50)
    name = payload["outputItemName"]
    saved = _rpc(
        erp_client,
        "saveItem",
        [{"itemName": name, "itemInitialStock": 10}],
        mutation=True,
    ).get_json()
    assert saved["success"] is True, saved["message"]

    assert _log(erp_client, [_pool_line(name, 3)])["success"] is True

    stock = _rpc(erp_client, "getStockData").get_json()["data"]
    assert next(r for r in stock if r["name"] == name)["currentStock"] == 10

    ledger = _rpc(erp_client, "getItemLedgerData", [name]).get_json()["data"]
    assert not [e for e in ledger["entries"] if e["kind"] == "WASTAGE"]
    assert all(r["balanced"] for r in ledger["reconciliation"])

    assert _bucket(erp_client, name)["availableQty"] == 47


def test_editing_and_deleting_pool_wastage_rebuilds_the_bucket(erp_client):
    payload, _ = _seed(erp_client, 50, "Blue-White")
    name = payload["outputItemName"]
    wastage_id = _log(erp_client, [_pool_line(name, 3, "Blue-White")])["data"][
        "wastageId"
    ]
    assert _bucket(erp_client, name, "Blue-White")["availableQty"] == 47

    edited = _log(
        erp_client, [_pool_line(name, 5, "Blue-White")], existing_id=wastage_id
    )
    assert edited["success"] is True, edited["message"]
    assert _bucket(erp_client, name, "Blue-White")["availableQty"] == 45

    # An edit that takes the record off the pool entirely has to rebuild it
    # too, or the bucket stays down by units nothing takes any more.
    item_line = {
        "name": _unique_name("Paint"),
        "qty": 2,
        "unit": "Pcs",
        "reason": "Spilt",
    }
    edited = _log(erp_client, [item_line], existing_id=wastage_id)
    assert edited["success"] is True, edited["message"]
    assert _bucket(erp_client, name, "Blue-White")["availableQty"] == 50

    edited = _log(
        erp_client, [_pool_line(name, 2, "Blue-White")], existing_id=wastage_id
    )
    assert edited["success"] is True, edited["message"]
    assert _bucket(erp_client, name, "Blue-White")["availableQty"] == 48

    deleted = _rpc(erp_client, "deleteWastageBulk", [[wastage_id]], mutation=True)
    assert deleted.get_json()["success"] is True
    assert _bucket(erp_client, name, "Blue-White")["availableQty"] == 50


def test_a_line_naming_no_bucket_is_refused(erp_client):
    body = _log(erp_client, [_pool_line(_unique_name("NoSuchOutput"), 1, "Red")])
    assert body["success"] is False
    assert "not in the Warehouse Pool" in body["message"]


def test_a_colour_the_item_was_never_made_in_is_refused(erp_client):
    payload, _ = _seed(erp_client, 50, "Blue-White")
    body = _log(erp_client, [_pool_line(payload["outputItemName"], 1, "Purple")])
    assert body["success"] is False
    assert "not in the Warehouse Pool" in body["message"]


def test_drawing_more_than_the_bucket_holds_warns_and_still_saves(erp_client):
    """Same call Production makes: the negative is the signal that a count
    is owed, so it is reported rather than refused."""
    payload, _ = _seed(erp_client, 5, "Blue-White")
    name = payload["outputItemName"]

    body = _log(erp_client, [_pool_line(name, 8, "Blue-White")])
    assert body["success"] is True, body["message"]
    assert "Warning" in body["message"]
    assert "Only 5 unit(s)" in body["message"]
    assert _bucket(erp_client, name, "Blue-White")["availableQty"] == -3

    # An edit is judged without this record's own draw in the pool: 4 of
    # the 5 there were before it is fine.
    wastage_id = body["data"]["wastageId"]
    edited = _log(
        erp_client, [_pool_line(name, 4, "Blue-White")], existing_id=wastage_id
    )
    assert edited["success"] is True, edited["message"]
    assert "Warning" not in edited["message"]
    assert _bucket(erp_client, name, "Blue-White")["availableQty"] == 1


def test_wastage_dated_before_a_recount_is_already_inside_it(erp_client):
    payload, process_id = _seed(erp_client, 20)
    name = payload["outputItemName"]
    counted = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [name, process_id, "", "", 12, "Physical recount"],
        mutation=True,
    ).get_json()
    assert counted["success"] is True, counted["message"]

    # Found yesterday, logged now: those frames were already off the shelf
    # when it was counted, so taking them off again would count them twice.
    # Saying so is the point -- otherwise the operator logs three frames and
    # watches the pool not move. And 30 against a bucket of 12 is no
    # shortfall when none of it is drawn.
    yesterday = date.today() - timedelta(days=1)
    body = _log(erp_client, [_pool_line(name, 30)], when=yesterday)
    assert body["success"] is True, body["message"]
    assert f"was recounted on {date.today():%d/%m/%Y}" in body["message"]
    assert "Warning" not in body["message"]
    assert _bucket(erp_client, name)["availableQty"] == 12

    # Logged today, after the count: carried forward on top of it.
    body = _log(erp_client, [_pool_line(name, 2)])
    assert body["success"] is True, body["message"]
    assert "recounted" not in body["message"]
    assert _bucket(erp_client, name)["availableQty"] == 10


def test_finished_goods_wastage_is_not_reported_as_dispatched(erp_client):
    payload, _ = _seed(erp_client, 20, isFinalStage=True)
    name = payload["outputItemName"]

    assert _log(erp_client, [_pool_line(name, 2, reason="Crushed carton")])["success"]

    ready = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    row = next(r for r in ready if r["productId"] == name)
    assert row["producedQty"] == 20
    assert row["dispatchedQty"] == 0
    assert row["wastedQty"] == 2
    assert row["readyQty"] == 18


def test_a_sub_group_bucket_cannot_take_wastage(erp_client):
    """A non-counting bucket is a packing set recorded per colour on units
    the primary axis already counted (migration 043). It holds no stock of
    its own, and a write-off there would vanish from every total."""
    payload, process_id = _seed(erp_client, 10, "Black")
    name = payload["outputItemName"]
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 10, "color": 'Kit Bag 24"'}],
        mutation=True,
    )
    flagged = _rpc(
        erp_client,
        "setWarehousePoolBucketCountsTowardTotal",
        [name, process_id, "", 'Kit Bag 24"', False],
        mutation=True,
    ).get_json()
    assert flagged["success"] is True, flagged["message"]

    body = _log(erp_client, [_pool_line(name, 1, 'Kit Bag 24"')])
    assert body["success"] is False
    assert "sub-group" in body["message"]


def test_a_line_is_stored_under_its_buckets_own_spelling(erp_client):
    payload, _ = _seed(erp_client, 50, "Blue-White")
    name = payload["outputItemName"]

    body = _log(erp_client, [_pool_line(name.upper(), 1, "blue-white")])
    assert body["success"] is True, body["message"]

    line = _record(erp_client, body["data"]["wastageId"])["items"][0]
    assert (line["name"], line["color"]) == (name, "Blue-White")


def test_wastage_data_says_where_each_line_came_from(erp_client):
    payload, _ = _seed(erp_client, 50, "Blue-White")
    name = payload["outputItemName"]
    paint = _unique_name("Paint")

    body = _log(
        erp_client,
        [
            {"name": paint, "qty": 2, "unit": "Pcs", "reason": "Spilt"},
            _pool_line(name, 3, "Blue-White"),
        ],
    )
    assert body["success"] is True, body["message"]

    items = {
        i["name"]: i for i in _record(erp_client, body["data"]["wastageId"])["items"]
    }
    assert items[paint]["sourceType"] == "ITEM"
    assert items[name]["sourceType"] == "POOL"
    assert items[name]["color"] == "Blue-White"
    assert items[name]["productTag"] == ""
    assert (items[name]["unit"], items[name]["baseQty"]) == ("Pcs", 3)


def test_renaming_the_output_item_carries_the_write_off_with_it(erp_client):
    payload, process_id = _seed(erp_client, 50)
    old_name = payload["outputItemName"]
    wastage_id = _log(erp_client, [_pool_line(old_name, 3)])["data"]["wastageId"]

    new_name = _unique_name("RenamedFrame")
    renamed = _rpc(
        erp_client,
        "saveProcess",
        [dict(payload, processId=process_id, outputItemName=new_name)],
        mutation=True,
    ).get_json()
    assert renamed["success"] is True, renamed["message"]

    assert _record(erp_client, wastage_id)["items"][0]["name"] == new_name
    assert _bucket(erp_client, new_name)["availableQty"] == 47


def test_renaming_a_colour_carries_the_write_off_with_it(erp_client):
    old_color = _unique_name("OldFrameColor")
    new_color = _unique_name("NewFrameColor")
    _rpc(erp_client, "saveColor", [{"name": old_color}], mutation=True)

    payload, _ = _seed(erp_client, 50, old_color)
    name = payload["outputItemName"]
    wastage_id = _log(erp_client, [_pool_line(name, 3, old_color)])["data"]["wastageId"]

    renamed = _rpc(
        erp_client,
        "saveColor",
        [{"name": new_color, "originalName": old_color}],
        mutation=True,
    ).get_json()
    assert renamed["success"] is True, renamed["message"]

    assert _record(erp_client, wastage_id)["items"][0]["color"] == new_color
    assert _bucket(erp_client, name, new_color)["availableQty"] == 47


def test_an_items_master_rename_leaves_pool_lines_alone(erp_client):
    payload, _ = _seed(erp_client, 50)
    name = payload["outputItemName"]
    _rpc(erp_client, "saveItem", [{"itemName": name}], mutation=True)
    wastage_id = _log(erp_client, [_pool_line(name, 3)])["data"]["wastageId"]

    renamed = _rpc(
        erp_client,
        "saveItem",
        [
            {
                "itemName": _unique_name("RenamedItem"),
                "originalName": name,
                "originalSize": "",
            }
        ],
        mutation=True,
    ).get_json()
    assert renamed["success"] is True, renamed["message"]

    assert _record(erp_client, wastage_id)["items"][0]["name"] == name
    assert _bucket(erp_client, name)["availableQty"] == 47


def test_the_item_reference_check_does_not_flag_pool_lines(erp_client):
    """getItemIdentityDriftReport flags references that resolve to no Items
    Master row. A pool line's name is an Output Item Name, which never
    will -- flagging it would bury real drift under every write-off."""
    payload, _ = _seed(erp_client, 50)
    name = payload["outputItemName"]
    assert _log(erp_client, [_pool_line(name, 3)])["success"] is True

    findings = _rpc(erp_client, "getItemIdentityDriftReport").get_json()["data"]
    assert not [f for f in findings if f["itemName"] == name]


def test_a_write_off_follows_its_bucket_when_the_colour_order_changes(
    erp_client, erp_app
):
    """Reordering a recipe re-spells every lot's composite bucket colour
    (_compose_lot_color_key). The write-off names the same combination in
    the old order and must still land on it, not open a phantom bucket."""
    payload, _ = _seed(erp_client, 50, "Blue-White / Black")
    name = payload["outputItemName"]
    assert _log(erp_client, [_pool_line(name, 3, "Blue-White / Black")])["success"]

    with erp_app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            _conn,
            cur,
        ):
            cur.execute(
                "UPDATE erp.warehouse_pool_opening SET color = %s "
                "WHERE output_item_name = %s",
                ("Black / Blue-White", name),
            )
            warehouse_service._recalculate_warehouse_pool(cur)

    rows = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    mine = [b for b in rows if b["outputItemName"] == name]
    assert [(b["color"], b["availableQty"]) for b in mine] == [
        ("Black / Blue-White", 47)
    ]
