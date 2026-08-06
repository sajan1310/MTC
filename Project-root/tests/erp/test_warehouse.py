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

import database


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


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
    resp = _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": "", "qty": 5}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Process is required" in body["message"]


def test_save_warehouse_pool_opening_process_must_exist(erp_client):
    resp = _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": "PRC-999999", "qty": 5}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "was not found" in body["message"]


def test_save_warehouse_pool_opening_rejects_zero_qty(erp_client):
    _payload, process_id = _save_process(erp_client)
    resp = _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 0}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "cannot be zero" in body["message"]


def test_save_warehouse_pool_opening_requires_color_when_process_tracks_colors(erp_client):
    """A process whose own recipe pulls from a colored upstream Pool (the
    same pattern test_production.py's _make_color_process uses) has known
    colors of its own -- an opening balance for it must pick one, same as
    the form's Color dropdown would require (see the matching client-side
    `required` toggle in App.Stock.handleWarehouseOpeningProcessChange).
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 10, "color": "Black"}], mutation=True)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 10, "color": "Blue"}], mutation=True)

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[{"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )

    no_color = _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": downstream_id, "qty": 5}], mutation=True)
    body = no_color.get_json()
    assert body["success"] is False
    assert "per-color" in body["message"]

    with_color = _rpc(
        erp_client, "saveWarehousePoolOpening", [{"processId": downstream_id, "qty": 5, "color": "Black"}], mutation=True
    )
    assert with_color.get_json()["success"] is True


def test_save_warehouse_pool_opening_credits_pool_bucket(erp_client):
    payload, process_id = _save_process(erp_client)

    resp = _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 25, "date": "01/01/2026", "remarks": "Initial seed"}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    match = next(b for b in listed if b["outputItemName"] == payload["outputItemName"])
    assert match["producedQty"] == 25
    assert match["consumedQty"] == 0
    assert match["availableQty"] == 25
    assert match["processId"] == process_id


def test_save_warehouse_pool_opening_product_tag_blanked_for_non_final_stage(erp_client):
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


def test_get_warehouse_pool_opening_data_lists_entries(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": 8, "date": "05/02/2026", "color": "Red", "remarks": "note"}],
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
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 12}], mutation=True)

    listed = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    entry = next(o for o in listed if o["outputItemName"] == payload["outputItemName"])

    mismatch = _rpc(
        erp_client, "deleteWarehousePoolOpening", [entry["rowIdx"], entry["outputItemName"], 999], mutation=True
    )
    body = mismatch.get_json()
    assert body["success"] is False
    assert "Data mismatch" in body["message"]

    success = _rpc(
        erp_client, "deleteWarehousePoolOpening", [entry["rowIdx"], entry["outputItemName"], 12], mutation=True
    )
    assert success.get_json()["success"] is True

    remaining = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    assert not any(o["rowIdx"] == entry["rowIdx"] for o in remaining)

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    assert not any(b["outputItemName"] == payload["outputItemName"] for b in pool)


def test_adjust_warehouse_pool_manually_computes_delta(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 20}], mutation=True)

    resp = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [payload["outputItemName"], process_id, "", "", 15, "Physical recount"],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"] == {"oldAvailableQty": 20, "newAvailableQty": 15}

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    match = next(b for b in pool if b["outputItemName"] == payload["outputItemName"])
    assert match["availableQty"] == 15


def test_adjust_warehouse_pool_manually_same_value_is_noop(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 20}], mutation=True)

    resp = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [payload["outputItemName"], process_id, "", "", 20, "No change"],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert body["data"] == {"oldAvailableQty": 20, "newAvailableQty": 20}


def test_adjust_warehouse_pool_manually_requires_reason(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 20}], mutation=True)

    resp = _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [payload["outputItemName"], process_id, "", "", 5, ""],
        mutation=True,
    )
    assert resp.get_json()["success"] is False


def test_get_warehouse_pool_adjustment_history(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 20}], mutation=True)
    _rpc(
        erp_client,
        "adjustWarehousePoolManually",
        [payload["outputItemName"], process_id, "", "", 30, "Recount"],
        mutation=True,
    )

    history = _rpc(erp_client, "getWarehousePoolAdjustmentHistory").get_json()["data"]
    record = next(h for h in history if h["outputItemName"] == payload["outputItemName"])
    assert record["oldValue"] == 20
    assert record["newValue"] == 30
    assert record["reason"] == "Recount"


def test_get_pool_available_qty_returns_bare_number(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 7}], mutation=True)

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

    rename = _rpc(erp_client, "saveColor", [{"name": new_color, "originalName": old_color}], mutation=True)
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
    match = next(o for o in listed if o["outputItemName"] == payload["outputItemName"])
    assert match["color"] == new_color


def test_process_output_item_name_rename_cascades_into_warehouse_pool_opening(erp_client):
    payload, process_id = _save_process(erp_client)
    old_output_name = payload["outputItemName"]
    new_output_name = _unique_name("RenamedOutput")

    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 9}], mutation=True)

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

    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 10}], mutation=True)

    dispatch = _rpc(
        erp_client,
        "saveDispatch",
        [{"lines": [{"productId": old_output_name, "productName": old_output_name, "qty": 4}]}],
        mutation=True,
    )
    assert dispatch.get_json()["success"] is True, dispatch.get_json()["message"]

    pool_before = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    bucket_before = next(b for b in pool_before if b["outputItemName"] == old_output_name)
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


def test_process_output_item_name_rename_leaves_dispatch_alone_when_also_a_bom_product_id(erp_app, erp_client):
    """A Dispatch row's Product ID is either a BOM Product ID (a tagged
    final-stage lot) or an Output Item Name (an untagged one) -- the
    column doesn't record which. A rename must not rewrite a Dispatch row
    that is really a Product Tag reference which merely happens to share
    the renamed string with an unrelated process's Output Item Name.
    """
    payload, process_id = _save_process(erp_client, isFinalStage=True)
    shared_name = payload["outputItemName"]
    new_output_name = _unique_name("RenamedFinalOutput2")

    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 10}], mutation=True)

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
        [{"lines": [{"productId": shared_name, "productName": "Unrelated BOM Product", "qty": 2}]}],
        mutation=True,
    )
    assert dispatch.get_json()["success"] is True, dispatch.get_json()["message"]

    edit_payload = dict(payload, processId=process_id, outputItemName=new_output_name)
    rename = _rpc(erp_client, "saveProcess", [edit_payload], mutation=True)
    assert rename.get_json()["success"] is True

    dispatched = _rpc(erp_client, "getDispatchData").get_json()["data"]
    untouched = next(d for d in dispatched if d["productName"] == "Unrelated BOM Product")
    assert untouched["productId"] == shared_name


def test_composite_bucket_credit_combines_two_independent_axes(erp_client):
    """A lot with exactly one primary-axis entry and at most one
    independent non-primary entry credits ONE combined bucket
    ("PrimaryColor / OtherColor"), not two separate single-color buckets
    -- see warehouse_service._recalculate_warehouse_pool Pass 1.
    """
    frame_payload, frame_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": frame_id, "qty": 10, "color": "Black"}], mutation=True)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": frame_id, "qty": 10, "color": "Blue"}], mutation=True)

    rim_payload, rim_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": rim_id, "qty": 10, "color": "Red"}], mutation=True)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": rim_id, "qty": 10, "color": "Green"}], mutation=True)

    down_payload, down_id = _save_process(
        erp_client,
        components=[
            {"itemName": frame_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
            {"itemName": rim_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
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
                "componentsConsumed": [{"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    own_buckets = [b for b in pool if b["outputItemName"] == down_payload["outputItemName"]]
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
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": frame_id, "qty": 10, "color": "Black"}], mutation=True)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": frame_id, "qty": 10, "color": "Blue"}], mutation=True)

    rim_payload, rim_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": rim_id, "qty": 10, "color": "Red"}], mutation=True)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": rim_id, "qty": 10, "color": "Green"}], mutation=True)

    combo_payload, combo_id = _save_process(
        erp_client,
        components=[
            {"itemName": frame_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
            {"itemName": rim_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
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
                "componentsConsumed": [{"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}],
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
            {"itemName": combo_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "Black"},
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
                    {"itemName": combo_payload["outputItemName"], "qty": 4, "sourceType": "POOL", "colorGroup": "Black"}
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    combo_buckets = [b for b in pool if b["outputItemName"] == combo_payload["outputItemName"]]
    assert len(combo_buckets) == 1
    assert combo_buckets[0]["color"] == "Black / Red"
    assert combo_buckets[0]["consumedQty"] == 4
    assert combo_buckets[0]["availableQty"] == 6
    # No phantom single-token "Black" bucket was created.
    assert not any(b["color"] == "Black" for b in combo_buckets)


def test_pool_debit_converts_component_unit_before_debiting(erp_client):
    """A POOL-sourced component with a non-blank Unit is converted to the
    item's Base Unit before debiting (blank unit means "already in Base
    Unit") -- previously a Dozen-unit row would silently debit as if it
    were 1 Pcs.
    """
    dozen = _unique_name("PoolDozenUnit")
    _rpc(erp_client, "saveUnit", [{"unitName": dozen, "family": "Count", "factorToBase": 12}], mutation=True)

    upstream_payload, upstream_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 100}], mutation=True)

    down_payload, down_id = _save_process(
        erp_client,
        components=[{"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON", "unit": dozen}],
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
                    {"itemName": upstream_payload["outputItemName"], "qty": 2, "sourceType": "POOL", "colorGroup": "COMMON", "unit": dozen}
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    upstream_bucket = next(b for b in pool if b["outputItemName"] == upstream_payload["outputItemName"] and not b["color"])
    assert upstream_bucket["consumedQty"] == 24  # 2 Dozen -> 24 Pcs, not 2


def test_process_delete_blocked_by_warehouse_pool_opening_reference(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 3}], mutation=True)

    resp = _rpc(erp_client, "deleteProcess", [process_id], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Warehouse Pool" in body["message"]
