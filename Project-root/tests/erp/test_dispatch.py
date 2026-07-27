"""Dispatch RPC tests, ported behavior from Apps_Script/module_dispatch.js
-- opens Phase 4.

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
        "lotPrefix": uuid.uuid4().hex[:5].upper(),
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


def test_save_dispatch_requires_product(erp_client):
    resp = _rpc(erp_client, "saveDispatch", [{"qty": 5}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Product ID and Product Name are required" in body["message"]


def test_save_dispatch_rejects_zero_qty(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    resp = _rpc(erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 0}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "greater than zero" in body["message"]


def test_save_dispatch_blocks_over_dispatch(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 5)

    resp = _rpc(erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 10}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Ready to Dispatch" in body["message"]


def test_save_dispatch_debits_warehouse_pool(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    resp = _rpc(erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 4}], mutation=True)
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
    fall back to that same prefixed key -- module_dispatch.js's saveDispatch
    does this explicitly (`readyMap[productIdKey] || readyMap['__output__'
    + productIdKey]`). Without the fallback this always looks up 0 Ready
    to Dispatch and rejects every dispatch of untagged output, even though
    getReadyToDispatchData correctly lists it as available.
    """
    payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, "", 10)

    output_name = payload["outputItemName"]
    resp = _rpc(erp_client, "saveDispatch", [{"productId": output_name, "productName": output_name, "qty": 4}], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    listed = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    match = next(r for r in listed if r["productId"] == output_name)
    assert match["dispatchedQty"] == 4
    assert match["readyQty"] == 6


def test_save_dispatch_edit_product_id_mismatch(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name_a, product_id_a = _save_bom_product(erp_client, token)
    product_name_b, product_id_b = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id_a, 10)
    _complete_production_lot(erp_client, process_id, product_id_b, 10)

    create = _rpc(
        erp_client, "saveDispatch", [{"productId": product_id_a, "productName": product_name_a, "qty": 2}], mutation=True
    ).get_json()
    listed = _rpc(erp_client, "getDispatchData").get_json()["data"]
    row = next(r for r in listed if r["dispatchNumber"] == create["data"]["dispatchNumber"])

    edit = _rpc(
        erp_client,
        "saveDispatch",
        [{"rowIdx": row["rowIdx"], "productId": product_id_b, "productName": product_name_b, "qty": 2}],
        mutation=True,
    )
    body = edit.get_json()
    assert body["success"] is False
    assert "Data mismatch" in body["message"]


def test_save_dispatch_edit_adds_back_own_qty(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    create = _rpc(
        erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 8}], mutation=True
    ).get_json()
    listed = _rpc(erp_client, "getDispatchData").get_json()["data"]
    row = next(r for r in listed if r["dispatchNumber"] == create["data"]["dispatchNumber"])

    # Only 2 units remain "Ready" (10 - 8), but editing back to the same
    # qty (8) must succeed -- the row's own original qty is added back
    # before checking availability, so it's not double-counted against
    # itself.
    edit = _rpc(
        erp_client,
        "saveDispatch",
        [{"rowIdx": row["rowIdx"], "productId": product_id, "productName": product_name, "qty": 8, "remarks": "updated"}],
        mutation=True,
    )
    assert edit.get_json()["success"] is True


def test_save_dispatch_returns_fresh_row_for_in_place_patch(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    create = _rpc(
        erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 4}], mutation=True
    ).get_json()
    assert create["data"]["row"]["productId"] == product_id
    assert create["data"]["row"]["qty"] == 4
    row_idx = create["data"]["row"]["rowIdx"]

    edit = _rpc(
        erp_client,
        "saveDispatch",
        [{"rowIdx": row_idx, "productId": product_id, "productName": product_name, "qty": 6, "transport": "By Road"}],
        mutation=True,
    ).get_json()
    fresh_row = edit["data"]["row"]
    assert fresh_row["rowIdx"] == row_idx
    assert fresh_row["qty"] == 6
    assert fresh_row["transport"] == "By Road"


def test_save_dispatch_order_number_note_when_no_client_orders(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    resp = _rpc(
        erp_client,
        "saveDispatch",
        [{"productId": product_id, "productName": product_name, "qty": 3, "orderNumber": "ORD-9999"}],
        mutation=True,
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
    dispatch = _rpc(erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 5}], mutation=True)
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

    resp = _rpc(
        erp_client,
        "saveDispatch",
        [{"productId": product_id, "productName": product_name, "qty": 3, "logisticsContractor": contractor}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True

    listed = _rpc(erp_client, "getDispatchData").get_json()["data"]
    match = next(r for r in listed if r["dispatchNumber"] == body["data"]["dispatchNumber"])
    assert match["logisticsRate"] == 7
    assert match["logisticsCost"] == 21


def test_save_dispatch_logistics_payable_defaults_zero_without_rate(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)

    resp = _rpc(
        erp_client,
        "saveDispatch",
        [{"productId": product_id, "productName": product_name, "qty": 3, "logisticsContractor": _unique_name("NoRateContractor")}],
        mutation=True,
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

    create = _rpc(
        erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 4}], mutation=True
    ).get_json()
    listed = _rpc(erp_client, "getDispatchData").get_json()["data"]
    row = next(r for r in listed if r["dispatchNumber"] == create["data"]["dispatchNumber"])

    mismatch = _rpc(erp_client, "deleteDispatch", [row["rowIdx"], row["dispatchNumber"], 999], mutation=True)
    body = mismatch.get_json()
    assert body["success"] is False
    assert "Data mismatch" in body["message"]

    success = _rpc(erp_client, "deleteDispatch", [row["rowIdx"], row["dispatchNumber"], row["qty"]], mutation=True)
    assert success.get_json()["success"] is True

    remaining = _rpc(erp_client, "getDispatchData").get_json()["data"]
    assert not any(r["rowIdx"] == row["rowIdx"] for r in remaining)

    ready = _rpc(erp_client, "getReadyToDispatchData").get_json()["data"]
    match = next(r for r in ready if r["productId"] == product_id)
    assert match["dispatchedQty"] == 0


def test_delete_dispatch_bulk_skip_and_report(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 20)

    a = _rpc(erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 3}], mutation=True).get_json()
    b = _rpc(erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 4}], mutation=True).get_json()

    listed = _rpc(erp_client, "getDispatchData").get_json()["data"]
    row_a = next(r for r in listed if r["dispatchNumber"] == a["data"]["dispatchNumber"])
    row_b = next(r for r in listed if r["dispatchNumber"] == b["data"]["dispatchNumber"])

    resp = _rpc(
        erp_client,
        "deleteDispatchBulk",
        [
            [row_a["rowIdx"], row_b["rowIdx"]],
            [
                {"rowIdx": row_a["rowIdx"], "expectedDispatchNumber": row_a["dispatchNumber"], "expectedQty": 999},
                {"rowIdx": row_b["rowIdx"], "expectedDispatchNumber": row_b["dispatchNumber"], "expectedQty": row_b["qty"]},
            ],
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert "Deleted 1" in body["message"]
    assert "Skipped 1" in body["message"]

    remaining = _rpc(erp_client, "getDispatchData").get_json()["data"]
    remaining_ids = {r["rowIdx"] for r in remaining}
    assert row_a["rowIdx"] in remaining_ids
    assert row_b["rowIdx"] not in remaining_ids


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
    _rpc(
        erp_client,
        "saveDispatch",
        [{"productId": product_id, "productName": product_name, "qty": 2, "logisticsContractor": contractor}],
        mutation=True,
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
    _rpc(erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 2}], mutation=True)

    # Clear the Production reference so this specifically isolates the
    # Dispatch leg of _get_product_ids_in_use, not Production's own guard.
    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row = next(r for r in listed if r["productId"] == product_id)
    _rpc(erp_client, "deleteProduction", [row["rowIdx"]], mutation=True)

    resp = _rpc(erp_client, "deleteBOM", [product_id, token], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
