"""Dispatch RPC tests, ported behavior from Apps_Script/module_dispatch.js
-- opens Phase 4.

Header+lines (migration 023): saveDispatch now takes a `lines` array
instead of a single productId/productName/qty, and edit-identity is
`existingDispatchNumber` (matching PO/Bill's own convention) instead of a
flat row's `rowIdx`. Delete is header-level, guarded by an item-count +
total-qty fingerprint of the whole bill (`expectedItemCount`/
`expectedTotalQty`) instead of a single row's qty.

Also proves the three "activates automatically" cascades/guards that were
already-shipped guarded stubs before this round: Warehouse Pool's Pass 3
(finished-goods debit) actually running, a Dispatch logistics payable
entry surfacing in the Contractor Ledger
(contractors_service._get_dispatch_logistics_payable_rows), and a BOM
Product delete blocked by a Dispatch reference
(bom_service._get_product_ids_in_use's DISPATCH leg).
"""

from __future__ import annotations

import uuid

from app.erp.services import bom_service


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


def _get_bom_token(erp_app, erp_client) -> str:
    with erp_app.app_context():
        bom_service.set_bom_password("test-only-bom-password")
    resp = _rpc(erp_client, "verifyBOMAccess", ["test-only-bom-password"])
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body["data"]["token"]


def _save_bom_product(client, token, **overrides):
    payload = {
        "productName": _unique_name("DispatchBomProduct"),
        "components": [{"itemName": _unique_name("BomItem"), "qtyPerProduct": 1}],
    }
    payload.update(overrides)
    resp = _rpc(client, "saveBOM", [payload, token], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return payload["productName"], body["data"]["productId"]


def _item_component(item_name="RawMat", qty=1):
    return {"itemName": item_name, "qty": qty, "sourceType": "ITEM"}


def _complete_production_lot(client, process_id, product_id, qty, contractor="Worker A", **overrides):
    form = {
        "processId": process_id,
        "assignedTo": contractor,
        "qty": qty,
        "status": "Completed",
        "productId": product_id,
        "componentsConsumed": [_item_component()],
    }
    form.update(overrides)
    resp = _rpc(client, "saveProduction", [form], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body


def _save_dispatch(client, lines, **header_overrides):
    """Convenience wrapper: `lines` is a list of {productId, productName,
    qty, [rate]} dicts. Mirrors what dispatch.js's serializeDispatchLines()
    hands the server.
    """
    payload = {"lines": lines}
    payload.update(header_overrides)
    return _rpc(client, "saveDispatch", [payload], mutation=True)


def test_get_ready_to_dispatch_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getReadyToDispatchData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_get_dispatch_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getDispatchData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_ready_to_dispatch_tagged_final_stage_surfaces(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    match = next(r for r in listed if r["productId"] == product_id)
    assert match["producedQty"] == 10
    assert match["dispatchedQty"] == 0
    assert match["readyQty"] == 10


def test_ready_to_dispatch_untagged_final_stage_surfaces_under_output_name(erp_client):
    payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, "", 6)

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    match = next(r for r in listed if r["productId"] == payload["outputItemName"])
    assert match["readyQty"] == 6


def test_ready_to_dispatch_non_final_stage_stays_invisible(erp_client):
    payload, process_id = _save_process(erp_client, isFinalStage=False)
    _complete_production_lot(erp_client, process_id, "", 6)

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    assert not any(r["productId"] == payload["outputItemName"] for r in listed)


def test_save_dispatch_rejects_zero_lines(erp_client):
    """An empty (or entirely-invalid, e.g. missing product/qty) `lines`
    array is rejected as a whole -- matches module_dispatch.js's own
    line-cleaning: a bad LINE is dropped silently, only a save with ZERO
    valid lines left is an error.
    """
    resp = _save_dispatch(erp_client, [{"qty": 5}])  # no productId/productName -> dropped
    body = resp.get_json()
    assert body["success"] is False
    assert "at least one valid item" in body["message"]


def test_save_dispatch_rejects_zero_qty(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    resp = _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": 0}])
    body = resp.get_json()
    assert body["success"] is False
    assert "at least one valid item" in body["message"]


def test_save_dispatch_blocks_over_dispatch(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 5)

    resp = _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": 10}])
    body = resp.get_json()
    assert body["success"] is False
    assert "Ready to Dispatch" in body["message"]


def test_save_dispatch_debits_warehouse_pool(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    resp = _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": 4}])
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["dispatchNumber"].startswith("DSP-")

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    match = next(r for r in listed if r["productId"] == product_id)
    assert match["dispatchedQty"] == 4
    assert match["readyQty"] == 6


def test_save_dispatch_debits_warehouse_pool_for_untagged_output(erp_client):
    """Regression: untagged final-stage output is credited in
    _compute_ready_to_dispatch_map under an '__output__'-prefixed key (see
    that function and test_ready_to_dispatch_untagged_final_stage_surfaces_
    under_output_name above), but saveDispatch's own capacity check must
    fall back to that same prefixed key. Without the fallback this always
    looks up 0 Ready to Dispatch and rejects every dispatch of untagged
    output, even though getReadyToDispatchData correctly lists it as
    available.
    """
    payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, "", 10)

    output_name = payload["outputItemName"]
    resp = _save_dispatch(erp_client, [{"productId": output_name, "productName": output_name, "qty": 4}])
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    match = next(r for r in listed if r["productId"] == output_name)
    assert match["dispatchedQty"] == 4
    assert match["readyQty"] == 6


def test_save_dispatch_multi_line_bill_debits_each_products_own_pool(erp_app, erp_client):
    """The core new capability: one bill, two lines, two different
    products -- each line debits its OWN product's pool independently.
    """
    token = _get_bom_token(erp_app, erp_client)
    name_a, id_a = _save_bom_product(erp_client, token)
    name_b, id_b = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, id_a, 10)
    _complete_production_lot(erp_client, process_id, id_b, 10)

    resp = _save_dispatch(
        erp_client,
        [
            {"productId": id_a, "productName": name_a, "qty": 3},
            {"productId": id_b, "productName": name_b, "qty": 5},
        ],
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    assert len(body["data"]["rows"]) == 2

    ready = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    assert next(r for r in ready if r["productId"] == id_a)["readyQty"] == 7
    assert next(r for r in ready if r["productId"] == id_b)["readyQty"] == 5


def test_save_dispatch_two_lines_same_product_share_cumulative_guard(erp_app, erp_client):
    """Two lines of the SAME product in one bill both draw down the same
    pool -- the guard is cumulative across the bill's own lines, not
    per-line independent.
    """
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    # 6 + 6 = 12 > 10 available -- rejected even though neither line alone
    # exceeds availability.
    resp = _save_dispatch(
        erp_client,
        [
            {"productId": product_id, "productName": product_name, "qty": 6},
            {"productId": product_id, "productName": product_name, "qty": 6},
        ],
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "Ready to Dispatch" in body["message"]

    # 6 + 4 = 10 -- exactly at capacity, succeeds.
    ok = _save_dispatch(
        erp_client,
        [
            {"productId": product_id, "productName": product_name, "qty": 6},
            {"productId": product_id, "productName": product_name, "qty": 4},
        ],
    )
    assert ok.get_json()["success"] is True


def test_save_dispatch_edit_replaces_lines(erp_app, erp_client):
    """Editing a bill fully replaces its lines (delete-and-reinsert, same
    pattern as PO/Bill) -- changing a line's product entirely, adding a
    line, or removing one are all just "the new lines array", no per-line
    identity constraint the way the old flat-row model had.
    """
    token = _get_bom_token(erp_app, erp_client)
    name_a, id_a = _save_bom_product(erp_client, token)
    name_b, id_b = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, id_a, 10)
    _complete_production_lot(erp_client, process_id, id_b, 10)

    create = _save_dispatch(erp_client, [{"productId": id_a, "productName": name_a, "qty": 2}]).get_json()
    assert create["success"] is True
    dispatch_number = create["data"]["dispatchNumber"]

    # Swap the one line for a totally different product+qty, and add a
    # second line -- would have been rejected outright by the old
    # "Product ID does not match original row record" guard.
    edit = _save_dispatch(
        erp_client,
        [
            {"productId": id_b, "productName": name_b, "qty": 3},
            {"productId": id_a, "productName": name_a, "qty": 1},
        ],
        existingDispatchNumber=dispatch_number,
    )
    body = edit.get_json()
    assert body["success"] is True, body["message"]
    assert len(body["data"]["rows"]) == 2
    assert {r["productId"] for r in body["data"]["rows"]} == {id_a, id_b}

    # product A's pool: 10 - 2 (original) restored, then - 1 (new line) = 9.
    ready = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    assert next(r for r in ready if r["productId"] == id_a)["readyQty"] == 9
    assert next(r for r in ready if r["productId"] == id_b)["readyQty"] == 7


def test_save_dispatch_edit_adds_back_own_qty(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    create = _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": 8}]).get_json()
    dispatch_number = create["data"]["dispatchNumber"]

    # Only 2 units remain "Ready" (10 - 8), but editing back to the same
    # qty (8) must succeed -- this bill's own original qty for this product
    # is added back before checking availability, so it's not
    # double-counted against itself.
    edit = _save_dispatch(
        erp_client,
        [{"productId": product_id, "productName": product_name, "qty": 8}],
        existingDispatchNumber=dispatch_number,
        remarks="updated",
    )
    assert edit.get_json()["success"] is True


def test_save_dispatch_returns_fresh_rows_for_in_place_patch(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    create = _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": 4}]).get_json()
    assert len(create["data"]["rows"]) == 1
    assert create["data"]["rows"][0]["productId"] == product_id
    assert create["data"]["rows"][0]["qty"] == 4
    dispatch_number = create["data"]["dispatchNumber"]

    edit = _save_dispatch(
        erp_client,
        [{"productId": product_id, "productName": product_name, "qty": 6}],
        existingDispatchNumber=dispatch_number,
        transport="By Road",
    ).get_json()
    fresh_rows = edit["data"]["rows"]
    assert len(fresh_rows) == 1
    assert fresh_rows[0]["dispatchNumber"] == dispatch_number
    assert fresh_rows[0]["qty"] == 6
    assert fresh_rows[0]["transport"] == "By Road"


def test_save_dispatch_order_number_note_when_no_client_orders(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    resp = _save_dispatch(
        erp_client,
        [{"productId": product_id, "productName": product_name, "qty": 3}],
        orderNumber="ORD-9999",
    )
    body = resp.get_json()
    assert body["success"] is True
    assert "Note:" in body["message"]
    assert "ORD-9999" in body["message"]


def test_save_dispatch_greedily_drains_multiple_color_buckets(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    upstream_payload, upstream_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 10, "color": "Black"}], mutation=True)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 10, "color": "Blue"}], mutation=True)

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        isFinalStage=True,
        components=[{"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )

    lot = _complete_production_lot(
        erp_client,
        downstream_id,
        product_id,
        qty=0,  # ignored -- qty is derived from colorBreakdown for a color process
        colorBreakdown=[{"color": "Black", "qty": 3}, {"color": "Blue", "qty": 4}],
    )
    assert lot["success"] is True

    # Total ready qty is 3+4=7 across two color buckets under the same
    # Product Tag. Dispatch 5 -- more than either single color bucket --
    # forcing the greedy drain to pull from both.
    dispatch = _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": 5}])
    assert dispatch.get_json()["success"] is True

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    match = next(r for r in listed if r["productId"] == product_id)
    assert match["readyQty"] == 2  # 7 - 5


def test_save_dispatch_logistics_payable_from_rate(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    contractor = _unique_name("LogisticsContractor")
    _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processName": "Dispatch / Logistics", "ratePerUnit": 7}],
        mutation=True,
    )

    resp = _save_dispatch(
        erp_client,
        [{"productId": product_id, "productName": product_name, "qty": 3}],
        logisticsContractor=contractor,
    )
    body = resp.get_json()
    assert body["success"] is True

    listed = _rpc(erp_client, "getDispatchData").get_json()["data"]
    match = next(r for r in listed if r["dispatchNumber"] == body["data"]["dispatchNumber"])
    assert match["logisticsRate"] == 7
    assert match["logisticsCost"] == 21


def test_save_dispatch_logistics_cost_per_line(erp_app, erp_client):
    """Logistics Rate is one snapshot for the whole bill; Logistics Cost is
    genuinely per-line (rate * that line's own qty), so two lines of
    different qty get different logistics costs summing to rate * totalQty.
    """
    token = _get_bom_token(erp_app, erp_client)
    name_a, id_a = _save_bom_product(erp_client, token)
    name_b, id_b = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, id_a, 10)
    _complete_production_lot(erp_client, process_id, id_b, 10)

    contractor = _unique_name("PerLineLogisticsContractor")
    _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processName": "Dispatch / Logistics", "ratePerUnit": 2}],
        mutation=True,
    )

    resp = _save_dispatch(
        erp_client,
        [
            {"productId": id_a, "productName": name_a, "qty": 3},
            {"productId": id_b, "productName": name_b, "qty": 5},
        ],
        logisticsContractor=contractor,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    rows = {r["productId"]: r for r in body["data"]["rows"]}
    assert rows[id_a]["logisticsRate"] == 2
    assert rows[id_a]["logisticsCost"] == 6  # 2 * 3
    assert rows[id_b]["logisticsCost"] == 10  # 2 * 5


def test_save_dispatch_logistics_payable_defaults_zero_without_rate(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    resp = _save_dispatch(
        erp_client,
        [{"productId": product_id, "productName": product_name, "qty": 3}],
        logisticsContractor=_unique_name("NoRateContractor"),
    )
    body = resp.get_json()
    listed = _rpc(erp_client, "getDispatchData").get_json()["data"]
    match = next(r for r in listed if r["dispatchNumber"] == body["data"]["dispatchNumber"])
    assert match["logisticsRate"] == 0
    assert match["logisticsCost"] == 0


def test_get_next_dispatch_number_returns_bare_string(erp_client):
    resp = _rpc(erp_client, "getNextDispatchNumber")
    body = resp.get_json()
    assert isinstance(body, str)
    assert body.startswith("DSP-")


def test_delete_dispatch_optimistic_check_and_reverses_pool_debit(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    create = _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": 4}]).get_json()
    dispatch_number = create["data"]["dispatchNumber"]

    mismatch = _rpc(erp_client, "deleteDispatch", [dispatch_number, 1, 999], mutation=True)
    body = mismatch.get_json()
    assert body["success"] is False
    assert "Data mismatch" in body["message"]

    # Item-count fingerprint also catches a change even when total qty
    # coincidentally matches.
    mismatch_count = _rpc(erp_client, "deleteDispatch", [dispatch_number, 2, 4], mutation=True)
    assert mismatch_count.get_json()["success"] is False

    success = _rpc(erp_client, "deleteDispatch", [dispatch_number, 1, 4], mutation=True)
    assert success.get_json()["success"] is True

    remaining = _rpc(erp_client, "getDispatchData").get_json()["data"]
    assert not any(r["dispatchNumber"] == dispatch_number for r in remaining)

    ready = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    match = next(r for r in ready if r["productId"] == product_id)
    assert match["dispatchedQty"] == 0


def test_delete_dispatch_not_found(erp_client):
    resp = _rpc(erp_client, "deleteDispatch", ["DSP-DOES-NOT-EXIST"], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "not found" in body["message"]


def test_delete_dispatch_bulk_skip_and_report(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 20)

    a = _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": 3}]).get_json()
    b = _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": 4}]).get_json()
    number_a = a["data"]["dispatchNumber"]
    number_b = b["data"]["dispatchNumber"]

    resp = _rpc(
        erp_client,
        "deleteDispatchBulk",
        [
            [number_a, number_b],
            [
                {"dispatchNumber": number_a, "expectedItemCount": 1, "expectedTotalQty": 999},
                {"dispatchNumber": number_b, "expectedItemCount": 1, "expectedTotalQty": 4},
            ],
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert "Deleted 1" in body["message"]
    assert "Skipped 1" in body["message"]

    remaining = _rpc(erp_client, "getDispatchData").get_json()["data"]
    remaining_numbers = {r["dispatchNumber"] for r in remaining}
    assert number_a in remaining_numbers
    assert number_b not in remaining_numbers


def test_dispatch_logistics_payable_appears_in_contractor_ledger(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    contractor = _unique_name("LedgerLogisticsContractor")
    _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processName": "Dispatch / Logistics", "ratePerUnit": 5}],
        mutation=True,
    )
    _save_dispatch(
        erp_client,
        [{"productId": product_id, "productName": product_name, "qty": 2}],
        logisticsContractor=contractor,
    )

    listed = _rpc(erp_client, "getContractorLedgerData").get_json()["data"]
    match = next(c for c in listed if c["contractorName"] == contractor)
    assert match["totalPayable"] == 10  # 5 rate * 2 qty
    process_bucket = next(b for b in match["byProcess"] if b["processName"] == "Dispatch / Logistics")
    assert process_bucket["payable"] == 10


def test_bom_product_delete_blocked_by_dispatch_reference(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)
    _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": 2}])

    # Clear the Production reference so this specifically isolates the
    # Dispatch leg of _get_product_ids_in_use, not Production's own guard.
    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row = next(r for r in listed if r["productId"] == product_id)
    _rpc(erp_client, "deleteProduction", [row["rowIdx"]], mutation=True)

    resp = _rpc(erp_client, "deleteBOM", [product_id, token], mutation=True)
    body = resp.get_json()
    assert body["success"] is False


# ── Dispatch Differentiator (migration 021) ────────────────────────────
# A final-stage process names ONE color axis whose value identifies the
# product on Ready to Dispatch, so the list shows a row per value of it
# ("<Output Item> / <value>") instead of a single combined row.


def _differentiated_setup(erp_app, erp_client, colors=("Black", "Blue")):
    """Final-stage process whose Dispatch Differentiator is the upstream
    pool axis, with one Completed lot split across `colors`. Returns
    (product_name, product_id, axis_label, qty_by_color).
    """
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    upstream_payload, upstream_id = _save_process(erp_client)
    for color in colors:
        _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 20, "color": color}], mutation=True)

    # A pool axis is labelled by the pool item name driving it -- see
    # process_service._compute_color_axes_for_process.
    axis_label = upstream_payload["outputItemName"]
    _downstream_payload, downstream_id = _save_process(
        erp_client,
        isFinalStage=True,
        dispatchDifferentiator=axis_label,
        components=[{"itemName": axis_label, "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )

    qty_by_color = {color: 3 + i for i, color in enumerate(colors)}
    lot = _complete_production_lot(
        erp_client,
        downstream_id,
        product_id,
        qty=0,  # derived from colorBreakdown for a color process
        colorBreakdown=[{"color": c, "qty": q} for c, q in qty_by_color.items()],
    )
    assert lot["success"] is True
    return product_name, product_id, axis_label, qty_by_color


def test_ready_to_dispatch_splits_rows_by_differentiator(erp_app, erp_client):
    _name, product_id, _axis, qty_by_color = _differentiated_setup(erp_app, erp_client)

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    rows = [r for r in listed if r["productId"] == product_id]

    # One row per differentiator value, not one aggregate row.
    assert len(rows) == len(qty_by_color)
    assert {r["differentiator"] for r in rows} == set(qty_by_color)
    # productId is deliberately NOT unique across variants -- `key` is.
    assert len({r["key"] for r in rows}) == len(rows)
    for row in rows:
        assert row["productName"].endswith(f" / {row['differentiator']}")
        assert row["readyQty"] == qty_by_color[row["differentiator"]]


def test_ready_to_dispatch_reports_color_breakdown(erp_app, erp_client):
    _name, product_id, _axis, qty_by_color = _differentiated_setup(erp_app, erp_client)

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    row = next(r for r in listed if r["productId"] == product_id and r["differentiator"] == "Black")

    breakdown = row["colorBreakdown"]
    assert breakdown, "colorBreakdown must carry each contributing color's own numbers"
    assert sum(c["readyQty"] for c in breakdown) == qty_by_color["Black"]
    assert all("Black" in c["color"] for c in breakdown)


def test_save_dispatch_allowed_when_differentiator_configured(erp_app, erp_client):
    """Regression: a differentiator splits the map key into
    '<baseKey>||<value>', so saveDispatch's literal lookup of the bare
    Product Tag found nothing and read availability as 0 -- rejecting EVERY
    dispatch of a differentiated product with "0 units ready" even though
    Ready to Dispatch listed it as available. _ready_available_qty_for pools
    the bare key with every variant of it.
    """
    product_name, product_id, _axis, qty_by_color = _differentiated_setup(erp_app, erp_client)
    total_ready = sum(qty_by_color.values())

    resp = _save_dispatch(erp_client, [{"productId": product_id, "productName": product_name, "qty": total_ready}])
    body = resp.get_json()
    assert body["success"] is True, body["message"]


def test_save_dispatch_guard_still_caps_at_pooled_total(erp_app, erp_client):
    """The pooled lookup is not a loosening of the guard: one unit beyond
    the combined availability of every variant is still rejected.
    """
    product_name, product_id, _axis, qty_by_color = _differentiated_setup(erp_app, erp_client)

    resp = _save_dispatch(
        erp_client,
        [{"productId": product_id, "productName": product_name, "qty": sum(qty_by_color.values()) + 1}],
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "Ready to Dispatch" in body["message"]


def test_ready_to_dispatch_stays_aggregate_without_differentiator(erp_app, erp_client):
    """Blank Dispatch Differentiator (every pre-existing process) keeps the
    original one-row-per-product behavior.
    """
    token = _get_bom_token(erp_app, erp_client)
    _product_name, product_id = _save_bom_product(erp_client, token)

    upstream_payload, upstream_id = _save_process(erp_client)
    for color in ("Black", "Blue"):
        _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 20, "color": color}], mutation=True)

    _payload, downstream_id = _save_process(
        erp_client,
        isFinalStage=True,
        components=[{"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )
    _complete_production_lot(
        erp_client, downstream_id, product_id, qty=0,
        colorBreakdown=[{"color": "Black", "qty": 3}, {"color": "Blue", "qty": 4}],
    )

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    rows = [r for r in listed if r["productId"] == product_id]
    assert len(rows) == 1
    assert rows[0]["differentiator"] == ""
    assert rows[0]["readyQty"] == 7


def test_save_dispatch_accepts_product_id_longer_than_50_chars(erp_client):
    """Regression (migration 028): an untagged final-stage output is keyed by
    its full Output Item Name, not a short "PRD-<n>" code, and real ones run
    past 50 characters. erp.dispatch_lines.product_id was VARCHAR(50), so
    those products listed fine on Ready to Dispatch but blew up with
    StringDataRightTruncation on save -- an unhandled 500 surfacing as
    "Something went wrong on our end", making them undispatchable.
    """
    long_name = "24 inch Hunter IBC T/Tube 2.40 Unbranded Caliper Break"
    assert len(long_name) > 50

    _payload, process_id = _save_process(erp_client, isFinalStage=True, outputItemName=long_name)
    _complete_production_lot(erp_client, process_id, "", 10)

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    assert any(r["productId"] == long_name for r in listed)

    resp = _save_dispatch(erp_client, [{"productId": long_name, "productName": long_name, "qty": 2}])
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    rows = _rpc(erp_client, "getDispatchData").get_json()["data"]
    assert any(r["productId"] == long_name and r["qty"] == 2 for r in rows)


# ── Dispatch Plan (migration 027) ───────────────────────────────────────
# A day-ahead drag-and-drop staging area, separate from a real Dispatch
# bill -- see dispatch_service.py's module docstring. Flat, independently-
# CRUD'd lines (no header, no delete-and-reinsert) -- see the migration's
# own comment for why.


def _save_plan_line(client, plan_date="2026-08-09", **overrides):
    payload = {"planDate": plan_date, "clientName": _unique_name("Client"), "sortOrder": 0}
    payload.update(overrides)
    return _rpc(client, "saveDispatchPlanLine", [payload], mutation=True)


def test_save_dispatch_plan_line_creates_and_lists(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    client_name = _unique_name("Client")
    resp = _save_plan_line(erp_client, clientName=client_name, productId=product_id, productName=product_name, qty=4)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    line_id = body["data"]["lineId"]

    listed = _rpc(erp_client, "getDispatchPlans").get_json()["data"]
    match = next(r for r in listed if r["lineId"] == line_id)
    assert match["clientName"] == client_name
    assert match["productId"] == product_id
    assert match["qty"] == 4
    assert match["fulfilled"] is False
    assert match["fulfilledDispatchNumber"] == ""


def test_save_dispatch_plan_line_rejects_over_plan(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 5)

    resp = _save_plan_line(erp_client, productId=product_id, productName=product_name, qty=10)
    body = resp.get_json()
    assert body["success"] is False
    assert "available to plan" in body["message"]


def test_save_dispatch_plan_line_pools_across_open_lines_for_same_product(erp_app, erp_client):
    """Two DIFFERENT plan lines (different client cards) for the same
    product both draw down the same availableToPlan pool -- the guard
    isn't per-card independent.
    """
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    first = _save_plan_line(erp_client, productId=product_id, productName=product_name, qty=6)
    assert first.get_json()["success"] is True

    # 6 already claimed, only 4 left -- a second card asking for 5 is over.
    second = _save_plan_line(erp_client, productId=product_id, productName=product_name, qty=5)
    body = second.get_json()
    assert body["success"] is False
    assert "available to plan" in body["message"]

    ok = _save_plan_line(erp_client, productId=product_id, productName=product_name, qty=4)
    assert ok.get_json()["success"] is True


def test_ready_to_dispatch_reports_planned_and_available_to_plan(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    _save_plan_line(erp_client, productId=product_id, productName=product_name, qty=3)

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    match = next(r for r in listed if r["productId"] == product_id)
    assert match["readyQty"] == 10
    assert match["plannedQty"] == 3
    assert match["availableToPlan"] == 7


def test_save_dispatch_plan_line_update_credits_back_own_qty(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    create = _save_plan_line(erp_client, productId=product_id, productName=product_name, qty=8).get_json()
    line_id = create["data"]["lineId"]

    # Only 2 remain "available to plan" (10 - 8), but re-saving this SAME
    # line back at qty 8 must succeed -- its own prior qty is credited back.
    same = _save_plan_line(erp_client, lineId=line_id, productId=product_id, productName=product_name, qty=8)
    assert same.get_json()["success"] is True


def test_delete_dispatch_plan_line_removes_and_frees_availability(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    create = _save_plan_line(erp_client, productId=product_id, productName=product_name, qty=6).get_json()
    line_id = create["data"]["lineId"]

    delete = _rpc(erp_client, "deleteDispatchPlanLine", [line_id], mutation=True)
    assert delete.get_json()["success"] is True

    listed = _rpc(erp_client, "getDispatchPlans").get_json()["data"]
    assert not any(r["lineId"] == line_id for r in listed)

    ready = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    match = next(r for r in ready if r["productId"] == product_id)
    assert match["availableToPlan"] == 10


def test_save_dispatch_with_source_plan_line_ids_marks_fulfilled(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    client_name = _unique_name("Client")
    plan = _save_plan_line(
        erp_client, clientName=client_name, productId=product_id, productName=product_name, qty=4
    ).get_json()
    line_id = plan["data"]["lineId"]

    dispatch = _rpc(
        erp_client,
        "saveDispatch",
        [
            {
                "lines": [{"productId": product_id, "productName": product_name, "qty": 4}],
                "clientName": client_name,
                "sourcePlanLineIds": [line_id],
            }
        ],
        mutation=True,
    )
    body = dispatch.get_json()
    assert body["success"] is True, body["message"]
    dispatch_number = body["data"]["dispatchNumber"]

    listed = _rpc(erp_client, "getDispatchPlans").get_json()["data"]
    match = next(r for r in listed if r["lineId"] == line_id)
    assert match["fulfilled"] is True
    assert match["fulfilledDispatchNumber"] == dispatch_number

    # A fulfilled line can no longer be edited or removed.
    edit_attempt = _save_plan_line(erp_client, lineId=line_id, productId=product_id, productName=product_name, qty=1)
    assert edit_attempt.get_json()["success"] is False

    delete_attempt = _rpc(erp_client, "deleteDispatchPlanLine", [line_id], mutation=True)
    assert delete_attempt.get_json()["success"] is False


def test_client_rename_cascades_to_open_dispatch_plan_lines(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    old_name = _unique_name("Client")
    _rpc(erp_client, "saveClient", [{"clientName": old_name}], mutation=True)
    plan = _save_plan_line(
        erp_client, clientName=old_name, productId=product_id, productName=product_name, qty=2
    ).get_json()
    line_id = plan["data"]["lineId"]

    new_name = _unique_name("RenamedClient")
    rename = _rpc(
        erp_client, "saveClient", [{"clientName": new_name, "originalClientName": old_name}], mutation=True
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getDispatchPlans").get_json()["data"]
    match = next(r for r in listed if r["lineId"] == line_id)
    assert match["clientName"] == new_name


def test_save_dispatch_plan_line_round_trips_rate_remarks_transport(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    resp = _save_plan_line(
        erp_client, productId=product_id, productName=product_name, qty=4,
        rate=12.5, remarks="Handle with care", transport="Truck #7",
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    line_id = body["data"]["lineId"]

    listed = _rpc(erp_client, "getDispatchPlans").get_json()["data"]
    match = next(r for r in listed if r["lineId"] == line_id)
    assert match["rate"] == 12.5
    assert match["remarks"] == "Handle with care"
    assert match["transport"] == "Truck #7"


def test_save_dispatch_plan_line_defaults_rate_remarks_transport_when_omitted(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    resp = _save_plan_line(erp_client, productId=product_id, productName=product_name, qty=4)
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    listed = _rpc(erp_client, "getDispatchPlans").get_json()["data"]
    match = next(r for r in listed if r["lineId"] == body["data"]["lineId"])
    assert match["rate"] == 0
    assert match["remarks"] == ""
    assert match["transport"] == ""


def test_save_dispatch_plan_line_updates_rate_remarks_transport_on_existing_line(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    create = _save_plan_line(erp_client, productId=product_id, productName=product_name, qty=4).get_json()
    line_id = create["data"]["lineId"]

    update = _save_plan_line(
        erp_client, lineId=line_id, productId=product_id, productName=product_name, qty=4,
        rate=7, remarks="Fragile", transport="Van #2",
    )
    assert update.get_json()["success"] is True

    listed = _rpc(erp_client, "getDispatchPlans").get_json()["data"]
    match = next(r for r in listed if r["lineId"] == line_id)
    assert match["rate"] == 7
    assert match["remarks"] == "Fragile"
    assert match["transport"] == "Van #2"


def test_process_round_trips_dispatch_differentiator(erp_client):
    payload, process_id = _save_process(erp_client, isFinalStage=True, dispatchDifferentiator="Frame Color")

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    saved = next(p for p in listed if p["processId"] == process_id)
    assert saved["dispatchDifferentiator"] == "Frame Color"

    # And it survives an edit that doesn't mention it being cleared.
    _rpc(
        erp_client,
        "saveProcess",
        [{**payload, "processId": process_id, "dispatchDifferentiator": ""}],
        mutation=True,
    )
    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    assert next(p for p in listed if p["processId"] == process_id)["dispatchDifferentiator"] == ""
