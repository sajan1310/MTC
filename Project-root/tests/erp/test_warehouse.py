"""Warehouse Pool Opening / Warehouse Pool RPC tests, ported behavior from
Apps_Script/module_warehouse.js.

Also proves the three "validating moment" cascades/guards this round
activates: a Color Master rename reaching warehouse_pool_opening.color
(tags_service._rename_color_everywhere), a Process Output Item Name
rename reaching warehouse_pool_opening.output_item_name
(process_service._rename_pool_output_item_name_everywhere), and a Process
delete blocked once a Warehouse Pool Opening entry references it
(process_service._get_process_ids_in_use) -- all three were guarded
no-ops since Phase 3a, with zero code changes needed to activate them.
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import database


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
        "outputItemName": _unique_name("Output"),
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
    resp = _rpc(client, "saveProcess", [payload], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return payload, body["data"]["processId"]


def test_get_warehouse_pool_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getWarehousePoolData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_warehouse_pool_opening_requires_process(erp_client):
    resp = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": "", "qty": 5}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "Process is required" in body["message"]


def test_save_warehouse_pool_opening_process_must_exist(erp_client):
    resp = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": "PRC-999999", "qty": 5}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "was not found" in body["message"]


def test_save_warehouse_pool_opening_rejects_zero_qty(erp_client):
    _payload, process_id = _save_process(erp_client)
    resp = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 0}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "cannot be zero" in body["message"]


def test_save_warehouse_pool_opening_requires_color_when_process_tracks_colors(
    erp_client,
):
    """A process whose own recipe pulls from a colored upstream Pool (the
    same pattern test_production.py's _make_color_process uses) has known
    colors of its own -- an opening balance for it must pick one, same as
    the form's Color dropdown would require (see the matching client-side
    `required` toggle in App.Stock.handleWarehouseOpeningProcessChange).
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": upstream_id, "qty": 10, "color": "Black"}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": upstream_id, "qty": 10, "color": "Blue"}],
        mutation=True,
    )

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
        ],
    )

    no_color = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": downstream_id, "qty": 5}],
        mutation=True,
    )
    body = no_color.get_json()
    assert body["success"] is False
    assert "per-color" in body["message"]

    with_color = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": downstream_id, "qty": 5, "color": "Black"}],
        mutation=True,
    )
    assert with_color.get_json()["success"] is True


def test_save_warehouse_pool_opening_credits_pool_bucket(erp_client):
    payload, process_id = _save_process(erp_client)

    resp = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [
            {
                "processId": process_id,
                "qty": 25,
                "date": "01/01/2026",
                "remarks": "Initial seed",
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    match = next(b for b in listed if b["outputItemName"] == payload["outputItemName"])
    assert match["producedQty"] == 25
    assert match["consumedQty"] == 0
    assert match["availableQty"] == 25
    assert match["processId"] == process_id


def test_save_warehouse_pool_opening_product_tag_blanked_for_non_final_stage(
    erp_client,
):
    payload, process_id = _save_process(erp_client, isFinalStage=False)
    resp = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 10, "productTag": "PRD-1234"}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    match = next(o for o in listed if o["outputItemName"] == payload["outputItemName"])
    assert match["productTag"] == ""


def test_save_warehouse_pool_opening_product_tag_kept_for_final_stage(erp_client):
    payload, process_id = _save_process(erp_client, isFinalStage=True)
    resp = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 10, "productTag": "PRD-1234"}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    match = next(o for o in listed if o["outputItemName"] == payload["outputItemName"])
    assert match["productTag"] == "PRD-1234"


def test_save_warehouse_pool_opening_output_item_name_override_ignored_for_non_final_stage(
    erp_client,
):
    payload, process_id = _save_process(erp_client, isFinalStage=False)
    override_name = f"{payload['outputItemName']} (Sports)"
    resp = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 10, "outputItemName": override_name}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    match = next(o for o in listed if o["processId"] == process_id)
    assert match["outputItemName"] == payload["outputItemName"]


def test_save_warehouse_pool_opening_output_item_name_override_segregates_for_final_stage(
    erp_client,
):
    """A final-stage Opening Stock entry's own name (default or a per-entry
    override) is credited to its own Ready to Dispatch row, not merged with
    the process default -- same rule as a Production lot's own override
    (see test_dispatch.py's test_ready_to_dispatch_untagged_final_stage_
    keeps_per_lot_override_separate)."""
    payload, process_id = _save_process(erp_client, isFinalStage=True)
    override_name = f"{payload['outputItemName']} (123)"

    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 10}],
        mutation=True,
    )
    resp = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 20, "outputItemName": override_name}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    default_bucket = next(
        b for b in pool if b["outputItemName"] == payload["outputItemName"]
    )
    override_bucket = next(b for b in pool if b["outputItemName"] == override_name)
    assert default_bucket["producedQty"] == 10
    assert override_bucket["producedQty"] == 20

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    default_row = next(r for r in listed if r["productId"] == payload["outputItemName"])
    override_row = next(r for r in listed if r["productId"] == override_name)
    assert default_row["readyQty"] == 10
    assert override_row["readyQty"] == 20


def test_get_warehouse_pool_opening_data_lists_entries(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [
            {
                "processId": process_id,
                "qty": 8,
                "date": "05/02/2026",
                "color": "Red",
                "remarks": "note",
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    match = next(o for o in listed if o["outputItemName"] == payload["outputItemName"])
    assert match["processName"] == payload["processName"]
    assert match["qty"] == 8
    assert match["dateRaw"] == "2026-02-05"
    assert match["color"] == "Red"
    assert match["remarks"] == "note"


def test_delete_warehouse_pool_opening_success_and_mismatch(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 12}],
        mutation=True,
    )

    listed = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    entry = next(o for o in listed if o["outputItemName"] == payload["outputItemName"])

    mismatch = _rpc(
        erp_client,
        "deleteWarehousePoolOpening",
        [entry["rowIdx"], entry["outputItemName"], 999],
        mutation=True,
    )
    body = mismatch.get_json()
    assert body["success"] is False
    assert "Data mismatch" in body["message"]

    success = _rpc(
        erp_client,
        "deleteWarehousePoolOpening",
        [entry["rowIdx"], entry["outputItemName"], 12],
        mutation=True,
    )
    assert success.get_json()["success"] is True

    remaining = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    assert not any(o["rowIdx"] == entry["rowIdx"] for o in remaining)

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    assert not any(b["outputItemName"] == payload["outputItemName"] for b in pool)


def test_adjust_warehouse_pool_manually_computes_delta(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 20}],
        mutation=True,
    )

    resp = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [payload["outputItemName"], process_id, "", "", 15, "Physical recount"],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    # newAvailableQty is now read back from the recalculated pool rather
    # than echoed from the request, and appliedDelta/expectedDelta say
    # whether the correction had to be widened to make the entered figure
    # hold -- see test_manual_correction_supersedes_the_calculation.
    # Nothing re-allocates here, so it did not.
    assert body["data"] == {
        "oldAvailableQty": 20,
        "newAvailableQty": 15,
        "requestedQty": 15,
        "appliedDelta": -5,
        "expectedDelta": -5,
    }

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    match = next(b for b in pool if b["outputItemName"] == payload["outputItemName"])
    assert match["availableQty"] == 15


def test_adjust_warehouse_pool_manually_same_value_is_noop(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 20}],
        mutation=True,
    )

    resp = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [payload["outputItemName"], process_id, "", "", 20, "No change"],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert body["data"] == {"oldAvailableQty": 20, "newAvailableQty": 20}


def test_manual_correction_cannot_drive_produced_below_zero(erp_client):
    """produced_qty is the SUM OF CREDITS -- opening balances plus completed
    lots -- so a negative one is arithmetically impossible, not merely
    unwelcome. Neither manual write path had a floor: "14 inch Ford D/Gaddi
    Steel Rim" [Blue] reached produced = -19 in production through exactly
    this sequence (+20, then -20, then a third correction of -19 whose own
    remark reads "bug"), and became uncorrectable once its process was
    deleted.
    """
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 20}],
        mutation=True,
    )

    # Down to zero is fine -- that is an ordinary correction.
    ok = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [payload["outputItemName"], process_id, "", "", 0, "Nothing entered yet"],
        mutation=True,
    )
    assert ok.get_json()["success"] is True

    # Past zero is not: produced would go to -19.
    resp = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [payload["outputItemName"], process_id, "", "", -19, "bug"],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "never be negative" in body["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    match = next(b for b in pool if b["outputItemName"] == payload["outputItemName"])
    assert match["producedQty"] == 0
    assert match["availableQty"] == 0


def test_opening_entry_cannot_drive_produced_below_zero(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 10}],
        mutation=True,
    )

    resp = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": -15, "remarks": "over-correction"}],
        mutation=True,
    )
    assert resp.get_json()["success"] is False

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    match = next(b for b in pool if b["outputItemName"] == payload["outputItemName"])
    assert match["producedQty"] == 10


def test_negative_available_from_consumption_is_left_alone(erp_client):
    """The guard above must not touch the legitimate signal. A negative
    AVAILABLE qty means stock was consumed that was never entered -- that is
    how an operator learns a physical recount is owed, and it has to survive.
    Only the impossible arithmetic (produced < 0) is rejected.
    """
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 5}],
        mutation=True,
    )

    # Setting available BELOW zero is refused only when it would take
    # produced with it; here produced stays at 5 and consumed does the work,
    # so a genuine shortfall recorded by production is untouched. Assert the
    # bucket still reports its own produced credit rather than being zeroed.
    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    match = next(b for b in pool if b["outputItemName"] == payload["outputItemName"])
    assert match["producedQty"] == 5
    assert match["availableQty"] == 5


def test_adjust_warehouse_pool_manually_requires_reason(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 20}],
        mutation=True,
    )

    resp = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [payload["outputItemName"], process_id, "", "", 5, ""],
        mutation=True,
    )
    assert resp.get_json()["success"] is False


def test_get_warehouse_pool_adjustment_history(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 20}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [payload["outputItemName"], process_id, "", "", 30, "Recount"],
        mutation=True,
    )

    history = _rpc(erp_client, "getWarehousePoolAdjustmentHistory").get_json()["data"]
    record = next(
        h for h in history if h["outputItemName"] == payload["outputItemName"]
    )
    assert record["oldValue"] == 20
    assert record["newValue"] == 30
    assert record["reason"] == "Recount"


def test_get_pool_available_qty_returns_bare_number(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 7}],
        mutation=True,
    )

    resp = _rpc(erp_client, "getPoolAvailableQty", [payload["outputItemName"]])
    body = resp.get_json()
    assert isinstance(body, (int, float))
    assert body == 7

    missing = _rpc(erp_client, "getPoolAvailableQty", [_unique_name("NoSuchItem")])
    assert missing.get_json() == 0


def test_color_rename_cascades_into_warehouse_pool_opening(erp_client):
    old_color = _unique_name("OldPoolColor")
    new_color = _unique_name("NewPoolColor")
    _rpc(erp_client, "saveColor", [{"name": old_color}], mutation=True)

    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 5, "color": old_color}],
        mutation=True,
    )

    rename = _rpc(
        erp_client,
        "saveColor",
        [{"name": new_color, "originalName": old_color}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    match = next(o for o in listed if o["outputItemName"] == payload["outputItemName"])
    assert match["color"] == new_color


def test_process_output_item_name_rename_cascades_into_warehouse_pool_opening(
    erp_client,
):
    payload, process_id = _save_process(erp_client)
    old_output_name = payload["outputItemName"]
    new_output_name = _unique_name("RenamedOutput")

    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 9}],
        mutation=True,
    )

    edit_payload = dict(payload, processId=process_id, outputItemName=new_output_name)
    rename = _rpc(erp_client, "saveProcess", [edit_payload], mutation=True)
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    assert any(o["outputItemName"] == new_output_name for o in listed)
    assert not any(o["outputItemName"] == old_output_name for o in listed)


def test_process_output_item_name_rename_cascades_into_dispatch(erp_client):
    """An untagged final-stage lot is dispatched under its Output Item
    Name (see dispatch_service._compute_ready_to_dispatch_map), which
    _recalculate_warehouse_pool's Pass 3 matches back against
    bucket["outputItemName"] to debit the pool. A rename that skips
    erp.dispatch leaves that debit keyed to a name no bucket answers to
    anymore, so it silently vanishes and every already-shipped unit
    reappears as Ready to Dispatch. Ports module_process.js's 6a22f0e fix
    for the Dispatch leg of _renamePoolOutputItemNameEverywhere.
    """
    payload, process_id = _save_process(erp_client, isFinalStage=True)
    old_output_name = payload["outputItemName"]
    new_output_name = _unique_name("RenamedFinalOutput")

    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 10}],
        mutation=True,
    )

    dispatch = _rpc(
        erp_client,
        "saveDispatch",
        [
            {
                "lines": [
                    {
                        "productId": old_output_name,
                        "productName": old_output_name,
                        "qty": 4,
                    }
                ]
            }
        ],
        mutation=True,
    )
    assert dispatch.get_json()["success"] is True, dispatch.get_json()["message"]

    pool_before = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    bucket_before = next(
        b for b in pool_before if b["outputItemName"] == old_output_name
    )
    assert bucket_before["consumedQty"] == 4
    assert bucket_before["availableQty"] == 6

    edit_payload = dict(payload, processId=process_id, outputItemName=new_output_name)
    rename = _rpc(erp_client, "saveProcess", [edit_payload], mutation=True)
    assert rename.get_json()["success"] is True

    dispatched = _rpc(erp_client, "getDispatchData").get_json()["data"]
    renamed_row = next(d for d in dispatched if d["productId"] == new_output_name)
    assert renamed_row["productName"] == new_output_name
    assert not any(d["productId"] == old_output_name for d in dispatched)

    pool_after = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    bucket_after = next(b for b in pool_after if b["outputItemName"] == new_output_name)
    # The dispatch debit is still attributed to this bucket under the new
    # name -- not silently lost (which would show availableQty == 10, i.e.
    # the shipped 4 units reappearing as Ready to Dispatch).
    assert bucket_after["consumedQty"] == 4
    assert bucket_after["availableQty"] == 6
    assert not any(b["outputItemName"] == old_output_name for b in pool_after)


def test_process_output_item_name_rename_leaves_dispatch_alone_when_also_a_bom_product_id(
    erp_app, erp_client
):
    """A Dispatch row's Product ID is either a BOM Product ID (a tagged
    final-stage lot) or an Output Item Name (an untagged one) -- the
    column doesn't record which. A rename must not rewrite a Dispatch row
    that is really a Product Tag reference which merely happens to share
    the renamed string with an unrelated process's Output Item Name.
    """
    payload, process_id = _save_process(erp_client, isFinalStage=True)
    shared_name = payload["outputItemName"]
    new_output_name = _unique_name("RenamedFinalOutput2")

    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 10}],
        mutation=True,
    )

    # A real BOM Product whose Product ID happens to collide with this
    # process's Output Item Name -- saveBOM auto-generates PRD-N ids, so
    # this is inserted directly to control the exact colliding string.
    with erp_app.app_context(), database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.bom_products (product_id, product_name, sequence) VALUES (%s, %s, 1)",
            (shared_name, "Unrelated BOM Product"),
        )

    dispatch = _rpc(
        erp_client,
        "saveDispatch",
        [
            {
                "lines": [
                    {
                        "productId": shared_name,
                        "productName": "Unrelated BOM Product",
                        "qty": 2,
                    }
                ]
            }
        ],
        mutation=True,
    )
    assert dispatch.get_json()["success"] is True, dispatch.get_json()["message"]

    edit_payload = dict(payload, processId=process_id, outputItemName=new_output_name)
    rename = _rpc(erp_client, "saveProcess", [edit_payload], mutation=True)
    assert rename.get_json()["success"] is True

    dispatched = _rpc(erp_client, "getDispatchData").get_json()["data"]
    untouched = next(
        d for d in dispatched if d["productName"] == "Unrelated BOM Product"
    )
    assert untouched["productId"] == shared_name


def test_composite_bucket_credit_combines_two_independent_axes(erp_client):
    """A lot with exactly one primary-axis entry and at most one
    independent non-primary entry credits ONE combined bucket
    ("PrimaryColor / OtherColor"), not two separate single-color buckets
    -- see warehouse_service._recalculate_warehouse_pool Pass 1.
    """
    frame_payload, frame_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": frame_id, "qty": 10, "color": "Black"}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": frame_id, "qty": 10, "color": "Blue"}],
        mutation=True,
    )

    rim_payload, rim_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": rim_id, "qty": 10, "color": "Red"}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": rim_id, "qty": 10, "color": "Green"}],
        mutation=True,
    )

    down_payload, down_id = _save_process(
        erp_client,
        # save_process now REFUSES a 2+-axis process with no Primary Axis
        # (it is a real choice, not something to default silently). The
        # first axis in recipe order is exactly what it used to pick on
        # its own, so naming it here keeps this test asserting the same
        # behaviour it always did.
        primaryColorAxis=frame_payload["outputItemName"],
        components=[
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": rim_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "primaryColorAxis": frame_payload["outputItemName"],
                "status": "Completed",
                "colorBreakdown": [
                    {"color": "Black", "qty": 10, "countsTowardTotal": True},
                    {"color": "Red", "qty": 10, "countsTowardTotal": False},
                ],
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    own_buckets = [
        b for b in pool if b["outputItemName"] == down_payload["outputItemName"]
    ]
    combined = [b for b in own_buckets if b["color"] == "Black / Red"]
    assert len(combined) == 1
    assert combined[0]["producedQty"] == 10
    assert not any(b["color"] == "Black" for b in own_buckets)
    assert not any(b["color"] == "Red" for b in own_buckets)


def test_composite_bucket_debit_resolves_single_token_to_composite(erp_client):
    """A manually-configured single-token Color Sub-Group (e.g. "Black")
    on a downstream recipe resolves to the one composite bucket
    containing that token ("Black / Red"), rather than debiting a
    phantom single-token bucket that was never credited -- see
    warehouse_service._resolve_composite_color_token.
    """
    frame_payload, frame_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": frame_id, "qty": 10, "color": "Black"}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": frame_id, "qty": 10, "color": "Blue"}],
        mutation=True,
    )

    rim_payload, rim_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": rim_id, "qty": 10, "color": "Red"}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": rim_id, "qty": 10, "color": "Green"}],
        mutation=True,
    )

    combo_payload, combo_id = _save_process(
        erp_client,
        # save_process now REFUSES a 2+-axis process with no Primary Axis
        # (it is a real choice, not something to default silently). The
        # first axis in recipe order is exactly what it used to pick on
        # its own, so naming it here keeps this test asserting the same
        # behaviour it always did.
        primaryColorAxis=frame_payload["outputItemName"],
        components=[
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": rim_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )
    _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": combo_id,
                "assignedTo": "Worker A",
                "primaryColorAxis": frame_payload["outputItemName"],
                "status": "Completed",
                "colorBreakdown": [
                    {"color": "Black", "qty": 10, "countsTowardTotal": True},
                    {"color": "Red", "qty": 10, "countsTowardTotal": False},
                ],
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
            }
        ],
        mutation=True,
    )

    # Downstream recipe scopes a component to just the "Black" token, not
    # the full composite "Black / Red" string. That same POOL row also
    # makes combo's output a color axis of `final`'s own recipe (GAS
    # 1288076's _poolItemIsColorAxis: combo has settled into exactly ONE
    # color so far, but that color is itself a composite, so it still
    # counts -- excluding it would truncate the chain). `final`'s own lot
    # color is therefore keyed to that axis's real value, "Black / Red";
    # the token-vs-composite resolution under test here is entirely on the
    # componentsConsumed side (colorGroup "Black" resolving against the
    # live "Black / Red" bucket), not the lot's own colorBreakdown.
    _final_payload, final_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": combo_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "Black",
            },
        ],
    )
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": final_id,
                "assignedTo": "Worker A",
                "status": "Completed",
                "colorBreakdown": [{"color": "Black / Red", "qty": 4}],
                "componentsConsumed": [
                    {
                        "itemName": combo_payload["outputItemName"],
                        "qty": 4,
                        "sourceType": "POOL",
                        "colorGroup": "Black",
                    }
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    combo_buckets = [
        b for b in pool if b["outputItemName"] == combo_payload["outputItemName"]
    ]
    assert len(combo_buckets) == 1
    assert combo_buckets[0]["color"] == "Black / Red"
    assert combo_buckets[0]["consumedQty"] == 4
    assert combo_buckets[0]["availableQty"] == 6
    # No phantom single-token "Black" bucket was created.
    assert not any(b["color"] == "Black" for b in combo_buckets)


def test_per_lot_output_item_name_override_merges_into_process_bucket(erp_client):
    """Two Completed lots of the SAME process -- one logged under the
    process's own default Output Item Name, one under a per-lot override
    (e.g. "<name> (Sports)") -- must credit ONE warehouse pool bucket keyed
    to the process's own Output Item Name, not two buckets that read like
    duplicate combinations in the Warehouse Pool modal. See
    _build_warehouse_pool_buckets's process_output_item_map normalization.
    """
    payload, process_id = _save_process(erp_client)
    override_name = f"{payload['outputItemName']} (Sports)"

    default_lot = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 4,
                "status": "Completed",
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
            }
        ],
        mutation=True,
    )
    assert default_lot.get_json()["success"] is True

    override_lot = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 3,
                "status": "Completed",
                "outputItemName": override_name,
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
            }
        ],
        mutation=True,
    )
    body = override_lot.get_json()
    assert body["success"] is True, body["message"]
    # The override name is still stamped on the lot row itself...
    assert body["data"]["row"]["outputItemName"] == override_name

    # ...but the pool bucket it credits is the process's own name -- one
    # bucket for this process, carrying both lots' qty.
    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    matching = [b for b in pool if b["processId"] == process_id]
    assert len(matching) == 1
    assert matching[0]["outputItemName"] == payload["outputItemName"]
    assert matching[0]["producedQty"] == 7
    assert matching[0]["availableQty"] == 7
    assert not any(b["outputItemName"] == override_name for b in pool)


def test_pool_lookup_by_process_default_name_sees_stock_from_override_named_lot(
    erp_client,
):
    """A downstream recipe references an upstream process's own (default)
    Output Item Name as its POOL source. If every upstream lot happened to
    be logged under a per-lot override name, the downstream availability
    lookup must still see that stock -- not read 0 available -- because
    Pass 1 credits the process's own name regardless of the lot's override.
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    override_name = f"{upstream_payload['outputItemName']} (Sports)"

    lot = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": upstream_id,
                "assignedTo": "Worker A",
                "qty": 8,
                "status": "Completed",
                "outputItemName": override_name,
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
            }
        ],
        mutation=True,
    )
    assert lot.get_json()["success"] is True

    down_payload, down_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
        ],
    )
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "status": "Completed",
                "componentsConsumed": [
                    {
                        "itemName": upstream_payload["outputItemName"],
                        "qty": 5,
                        "sourceType": "POOL",
                        "colorGroup": "COMMON",
                    }
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert "Warning" not in body["message"]  # would warn if pool read 0 available

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    upstream_bucket = next(
        b
        for b in pool
        if b["outputItemName"] == upstream_payload["outputItemName"] and not b["color"]
    )
    assert upstream_bucket["availableQty"] == 3  # 8 produced - 5 consumed


def test_pool_debit_converts_component_unit_before_debiting(erp_client):
    """A POOL-sourced component with a non-blank Unit is converted to the
    item's Base Unit before debiting (blank unit means "already in Base
    Unit") -- previously a Dozen-unit row would silently debit as if it
    were 1 Pcs.
    """
    dozen = _unique_name("PoolDozenUnit")
    _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": dozen, "family": "Count", "factorToBase": 12}],
        mutation=True,
    )

    upstream_payload, upstream_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": upstream_id, "qty": 100}],
        mutation=True,
    )

    down_payload, down_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
                "unit": dozen,
            }
        ],
    )
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "status": "Completed",
                "componentsConsumed": [
                    {
                        "itemName": upstream_payload["outputItemName"],
                        "qty": 2,
                        "sourceType": "POOL",
                        "colorGroup": "COMMON",
                        "unit": dozen,
                    }
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    upstream_bucket = next(
        b
        for b in pool
        if b["outputItemName"] == upstream_payload["outputItemName"] and not b["color"]
    )
    assert upstream_bucket["consumedQty"] == 24  # 2 Dozen -> 24 Pcs, not 2


def test_process_delete_blocked_by_warehouse_pool_opening_reference(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 3}],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteProcess", [process_id], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Warehouse Pool" in body["message"]


def _uc(base: str) -> str:
    """A colour name unique to this run.

    save_production auto-registers every isCustom colour into the GLOBAL
    Color Master (production_service, "+ Add Custom Sub-Group"), and
    _compute_color_groups_with_overrides_for_process widens any
    colour-enabled process's valid colours to that whole master. A literal
    "Purple" here therefore stops being an unknown colour for every later
    test in the shared database -- which is exactly how this file broke
    test_production.py::test_save_production_color_breakdown_rejects_unknown_color,
    a file that runs after this one and asserts precisely that rejection.
    """
    return f"{base}-{uuid.uuid4().hex[:8]}"


def _sub_group_breakdown(primary_qty=10, kit_qty=10, small_qty=10):
    """A lot shaped like the live "Packing Zara IBC" runs: one primary
    color carrying the lot, plus a sub-group axis whose values ('Kit Bag
    24"' / 'Small Kit 24"') are recorded PER COLOR on those same units --
    a packing set every unit got, not output of its own.

    Both sub-group entries share one axisKey, so Pass 1 sees a single axis
    contributing two values, cannot infer which pairs with the primary,
    and takes the bare-color fallback that gives every entry its own
    bucket. That is where a non-counting entry used to become units.

    isCustom marks them as operator-added one-offs so save_production
    accepts the breakdown on a process with no configured color groups --
    countsTowardTotal reaches warehouse_service identically either way.
    """
    return [
        {
            "color": _uc("Blue-White"),
            "qty": primary_qty,
            "countsTowardTotal": True,
            "axisKey": "own:frame",
            "isCustom": True,
        },
        {
            "color": _uc('Kit Bag 24"'),
            "qty": kit_qty,
            "countsTowardTotal": False,
            "axisKey": "other",
            "isCustom": True,
        },
        {
            "color": _uc('Small Kit 24"'),
            "qty": small_qty,
            "countsTowardTotal": False,
            "axisKey": "other",
            "isCustom": True,
        },
    ]


def _save_sub_group_lot(client, process_id, breakdown):
    resp = _rpc(
        client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "status": "Completed",
                "colorBreakdown": breakdown,
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body


def test_sub_group_buckets_are_kept_but_marked_not_units(erp_client):
    """A sub-group keeps its own bucket -- it carries its own movement and
    the per-combination modal lists it -- but is flagged as not units, so
    nothing sums it as though it were.

    The lot made 10. Its two sub-group entries restate those same 10, so
    counting all three buckets claims 30.
    """
    payload, process_id = _save_process(erp_client)
    breakdown = _sub_group_breakdown(10, 10, 10)
    primary, kit, small = (c["color"] for c in breakdown)
    _save_sub_group_lot(erp_client, process_id, breakdown)

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    own = {
        b["color"]: b for b in pool if b["outputItemName"] == payload["outputItemName"]
    }

    assert set(own) == {primary, kit, small}
    assert own[primary]["countsTowardTotal"] is True
    assert own[kit]["countsTowardTotal"] is False
    assert own[small]["countsTowardTotal"] is False

    counted = [b for b in own.values() if b["countsTowardTotal"]]
    assert sum(b["producedQty"] for b in counted) == 10


def test_sub_group_flag_holds_when_the_values_divide_the_lot(erp_client):
    """The flag follows countsTowardTotal, not the arithmetic. Whether the
    sub-group values each carry the whole lot (co-consumption) or divide it
    (6 + 4 of 10), neither is output, and neither may be summed as units.
    """
    payload, process_id = _save_process(erp_client)
    breakdown = _sub_group_breakdown(10, 6, 4)
    primary, kit, small = (c["color"] for c in breakdown)
    _save_sub_group_lot(erp_client, process_id, breakdown)

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    own = {
        b["color"]: b for b in pool if b["outputItemName"] == payload["outputItemName"]
    }
    assert own[kit]["producedQty"] == 6  # its own movement, intact
    assert own[kit]["countsTowardTotal"] is False
    assert own[small]["countsTowardTotal"] is False
    assert own[primary]["countsTowardTotal"] is True


def test_a_color_used_as_primary_elsewhere_stays_units(erp_client):
    """One counting credit anywhere makes the bucket units, whatever else
    landed there. A color can be a sub-group on one lot and the primary
    axis on another; marking the shared bucket as not-units because of the
    first would erase real output recorded by the second.
    """
    payload, process_id = _save_process(erp_client)
    breakdown = _sub_group_breakdown(10, 10, 10)
    kit_color = breakdown[1]["color"]
    _save_sub_group_lot(erp_client, process_id, breakdown)
    _save_sub_group_lot(
        erp_client,
        process_id,
        [
            {
                "color": kit_color,
                "qty": 5,
                "countsTowardTotal": True,
                "axisKey": "own:frame",
                "isCustom": True,
            }
        ],
    )

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    kit = next(
        b
        for b in pool
        if b["outputItemName"] == payload["outputItemName"] and b["color"] == kit_color
    )
    assert kit["producedQty"] == 15
    assert kit["countsTowardTotal"] is True


def test_opening_stock_bucket_counts_as_units(erp_client):
    """A bucket with no production credit at all -- an opening balance --
    is units. Only a bucket whose every credit was a sub-group entry is not.
    """
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 7, "color": _uc("Blue-White")}],
        mutation=True,
    )

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    bucket = next(b for b in pool if b["outputItemName"] == payload["outputItemName"])
    assert bucket["producedQty"] == 7
    assert bucket["countsTowardTotal"] is True


def _pool_by_color(client, item_name):
    data = _rpc(client, "getWarehousePoolData").get_json()["data"]
    return {(b["color"] or ""): b for b in data if b["outputItemName"] == item_name}


def _common_shortfall_fixture(client):
    """An item whose colour-agnostic consumption exceeds everything it was
    ever credited: 10 Black opened, 15 drawn COMMON. The drain takes the 10
    and dumps the remaining 5 on the blank bucket as the shortfall.
    """
    frame_payload, frame_id = _save_process(client)
    frame_name = frame_payload["outputItemName"]
    _rpc(
        client,
        "saveWarehousePoolOpening",
        [{"processId": frame_id, "qty": 10, "color": "Black"}],
        mutation=True,
    )

    _, down_id = _save_process(
        client,
        components=[
            {
                "itemName": frame_name,
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
        ],
    )
    body = _rpc(
        client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "status": "Completed",
                "qty": 15,
                "componentsConsumed": [
                    {"itemName": frame_name, "qty": 15, "sourceType": "POOL"}
                ],
            }
        ],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    return frame_name, frame_id


def test_manual_correction_supersedes_the_calculation(erp_client):
    """A hand-entered figure wins. It is entered for a reason, and it is
    how corrupted history gets repaired as entries are audited.

    It holds because it is stored as a COUNT and not as a difference
    (migration 045). The recount says what was on the shelf at that moment,
    so the pool seeds the bucket with it and discards everything dated at
    or before it -- including the colour-agnostic draw that used to eat
    part of the correction the instant it was credited.

    This test used to assert the opposite mechanism: the correction was
    widened from 10 to 15 until the entered figure survived the drain. That
    forced the number to hold but hid why it did not, by inventing 15 units
    of production on the Black bucket and paying the blank bucket's
    shortfall off to zero. The shortfall is real -- 15 frames were consumed
    and the 10 the pool knew about are still on the shelf, so all 15 came
    from stock this pool never recorded -- and a negative that says so is
    worth more than a zero that does not.
    """
    frame_name, frame_id = _common_shortfall_fixture(erp_client)

    before = _pool_by_color(erp_client, frame_name)
    assert before["Black"]["availableQty"] == 0
    assert before[""]["availableQty"] == -5  # the shortfall, still visible

    body = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [frame_name, frame_id, "", "Black", 10, "physical recount"],
        mutation=True,
    ).get_json()

    assert body["success"] is True
    assert body["data"]["newAvailableQty"] == 10  # what was entered, full stop
    assert body["data"]["requestedQty"] == 10
    # No widening: the drain cannot reach a figure it predates, so the
    # delta the count implied is the delta that was applied.
    assert body["data"]["expectedDelta"] == 10
    assert body["data"]["appliedDelta"] == 10
    assert body["message"] == "Warehouse Pool stock adjusted successfully."

    after = _pool_by_color(erp_client, frame_name)
    assert after["Black"]["availableQty"] == 10
    # Seeded by the count, not accumulated through it.
    assert after["Black"]["producedQty"] == 10
    # All 15 came from stock the pool never recorded -- the 10 it did know
    # about are still on the shelf. The negative is the signal.
    assert after[""]["availableQty"] == -15

    openings = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    corrections = [
        o
        for o in openings
        if o["outputItemName"] == frame_name and o["remarks"].startswith("Correction: ")
    ]
    assert len(corrections) == 1
    assert corrections[0]["qty"] == 10

    # The audit log keeps the figure that actually holds.
    history = _rpc(erp_client, "getWarehousePoolAdjustmentHistory").get_json()["data"]
    entry = next(h for h in history if h["outputItemName"] == frame_name)
    assert entry["oldValue"] == 0
    assert entry["newValue"] == 10


def test_manual_correction_with_nothing_to_settle_lands_on_the_entered_figure(
    erp_client,
):
    """The ordinary case is unchanged: no outstanding colour-agnostic
    shortfall means nothing re-allocates, so the entered number sticks and
    the message stays the plain one.
    """
    frame_payload, frame_id = _save_process(erp_client)
    frame_name = frame_payload["outputItemName"]
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": frame_id, "qty": 10, "color": "Black"}],
        mutation=True,
    )

    body = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [frame_name, frame_id, "", "Black", 25, "physical recount"],
        mutation=True,
    ).get_json()

    assert body["success"] is True
    assert body["data"]["newAvailableQty"] == 25
    assert body["data"]["appliedDelta"] == body["data"]["expectedDelta"] == 15
    assert body["message"] == "Warehouse Pool stock adjusted successfully."
    assert _pool_by_color(erp_client, frame_name)["Black"]["availableQty"] == 25


def test_manual_correction_downward_still_cannot_drive_produced_negative(erp_client):
    """The one thing a hand-entered figure does not supersede: produced
    stock is the sum of what was opened and made, so it cannot go below
    zero however the count reads. The widening loop is guarded the same
    way the first delta is.
    """
    frame_payload, frame_id = _save_process(erp_client)
    frame_name = frame_payload["outputItemName"]
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": frame_id, "qty": 10, "color": "Black"}],
        mutation=True,
    )

    body = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [frame_name, frame_id, "", "Black", -5, "physical recount"],
        mutation=True,
    ).get_json()

    assert body["success"] is False
    assert "produced stock" in body["message"]
    assert _pool_by_color(erp_client, frame_name)["Black"]["availableQty"] == 10
# --- Recounts are counts, not differences (migration 045) --------------------
#
# The audit that produced these: 57 of 314 recounted buckets in the live
# database no longer matched what the floor had counted, 691 units gross,
# because a correction was stored as `new - old` and anything dated earlier
# that arrived later landed underneath it. These four pin the shape of the
# fix -- a recount states a shelf at a moment, and only what genuinely
# follows that moment may move it again.


def _stage_fed_by_pool(client, upstream_qty=500):
    """An upstream process holding stock and a downstream one that consumes
    it -- the smallest shape in which a lot can be saved at all, since every
    lot must consume something."""
    up_payload, up_id = _save_process(client)
    up_name = up_payload["outputItemName"]
    _rpc(
        client,
        "saveWarehousePoolOpening",
        [{"processId": up_id, "qty": upstream_qty}],
        mutation=True,
    )
    down_payload, down_id = _save_process(
        client,
        components=[
            {
                "itemName": up_name,
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "",
            }
        ],
    )
    return up_name, down_payload["outputItemName"], down_id


def _make_lot(client, down_id, up_name, qty, when=None):
    payload = {
        "processId": down_id,
        "assignedTo": "Worker A",
        "status": "Completed",
        "qty": qty,
        "componentsConsumed": [
            {"itemName": up_name, "qty": qty, "sourceType": "POOL"}
        ],
    }
    if when is not None:
        payload["date"] = when.isoformat()
    body = _rpc(client, "saveProduction", [payload], mutation=True).get_json()
    assert body["success"] is True, body["message"]
    return body


def test_a_recount_is_not_moved_by_a_lot_dated_before_it(erp_client):
    """The exact defect: a lot dated three weeks ago, completed today.

    Those units were already on the shelf when somebody counted it, so
    crediting them again invents stock that was never made.
    """
    up_name, name, down_id = _stage_fed_by_pool(erp_client)

    body = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [name, down_id, "", "", 40, "physical recount"],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    assert _pool_by_color(erp_client, name)[""]["availableQty"] == 40

    _make_lot(erp_client, down_id, up_name, 12, date.today() - timedelta(days=21))

    assert _pool_by_color(erp_client, name)[""]["availableQty"] == 40


def test_a_recount_still_carries_everything_after_it_forward(erp_client):
    """The other half: freezing the past must not freeze the future, or a
    recount would turn the bucket into a permanent constant."""
    up_name, name, down_id = _stage_fed_by_pool(erp_client)

    _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [name, down_id, "", "", 40, "physical recount"],
        mutation=True,
    )
    _make_lot(erp_client, down_id, up_name, 12)

    assert _pool_by_color(erp_client, name)[""]["availableQty"] == 52


def test_the_newest_recount_wins(erp_client):
    """Two counts of the same shelf: the later one is the current truth and
    replaces the earlier one rather than stacking on it."""
    payload, proc_id = _save_process(erp_client)
    name = payload["outputItemName"]

    for counted in (40, 33):
        body = _rpc(
            erp_client,
            "adjustWarehousePoolManually",
            [name, proc_id, "", "", counted, "physical recount"],
            mutation=True,
        ).get_json()
        assert body["success"] is True, body["message"]

    assert _pool_by_color(erp_client, name)[""]["availableQty"] == 33


def test_colour_agnostic_consumption_cannot_reach_a_later_recount(erp_client):
    """Option A, settled draw by draw in date order.

    The drain used to be one undated lump applied after every dated entry
    and sized to the balance, so a recounted bucket was emptied by
    consumption that had left the shelf before it was counted. Against the
    live database 1,810 of the 2,003 units it drained were dated before the
    count they drained.
    """
    frame_name, frame_id = _common_shortfall_fixture(erp_client)
    assert _pool_by_color(erp_client, frame_name)["Black"]["availableQty"] == 0

    _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [frame_name, frame_id, "", "Black", 10, "physical recount"],
        mutation=True,
    )

    after = _pool_by_color(erp_client, frame_name)
    assert after["Black"]["availableQty"] == 10
    # The draw did not vanish -- it moved to where it belongs. All 15 came
    # from stock the pool never recorded, and that stays visible.
    assert after[""]["availableQty"] == -15
