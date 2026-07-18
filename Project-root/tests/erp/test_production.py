"""Production RPC tests, ported behavior from Apps_Script/module_production.js
-- the capstone of Phase 3 manufacturing.

Also proves three "activates automatically" cascades/guards that were
already-shipped guarded stubs before this round: a Contractor rename
reaching production.assigned_to and a Contractor delete blocked by a
Production reference (contractors_service), and a BOM Product delete
blocked by a Production reference (bom_service).
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


def _seed_pool(client, process_id, qty, color=""):
    resp = _rpc(client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": qty, "color": color}], mutation=True)
    assert resp.get_json()["success"] is True


def _make_color_process(client):
    """One upstream process with 2 pool colors -> exactly one Color Axis on
    the downstream process that consumes it (colors_by_item length 2)."""
    upstream_payload, upstream_id = _save_process(client)
    _seed_pool(client, upstream_id, 10, color="Black")
    _seed_pool(client, upstream_id, 10, color="Blue")
    downstream_payload, downstream_id = _save_process(
        client,
        components=[{"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )
    return upstream_payload, upstream_id, downstream_payload, downstream_id


def _item_component(item_name="RawMat", qty=1):
    return {"itemName": item_name, "qty": qty, "sourceType": "ITEM"}


def _get_bom_token(erp_app, erp_client) -> str:
    with erp_app.app_context():
        bom_service.set_bom_password("test-only-bom-password")
    resp = _rpc(erp_client, "verifyBOMAccess", ["test-only-bom-password"])
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body["data"]["token"]


def test_get_production_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getProductionData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_production_requires_process(erp_client):
    resp = _rpc(erp_client, "saveProduction", [{"assignedTo": "Someone"}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Process must be selected" in body["message"]


def test_save_production_requires_assigned_to(erp_client):
    _payload, process_id = _save_process(erp_client)
    resp = _rpc(erp_client, "saveProduction", [{"processId": process_id}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Contractor (Assigned To) is required" in body["message"]


def test_save_production_process_not_found(erp_client):
    resp = _rpc(erp_client, "saveProduction", [{"processId": "PRC-999999", "assignedTo": "X"}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "was not found" in body["message"]


def test_save_production_no_color_process_requires_component(erp_client):
    _payload, process_id = _save_process(erp_client)
    resp = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "componentsConsumed": []}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "At least one component consumed" in body["message"]


def test_save_production_no_color_process_rejects_zero_qty(erp_client):
    _payload, process_id = _save_process(erp_client)
    resp = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 0, "componentsConsumed": [_item_component()]}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "cannot be zero" in body["message"]


def test_save_production_no_color_process_allows_negative_qty(erp_client):
    _payload, process_id = _save_process(erp_client)
    resp = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": -3, "componentsConsumed": [_item_component()]}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True

    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    match = next(r for r in listed if r["lotNumber"] == body["data"]["lotNumber"])
    assert match["qty"] == -3


def test_save_production_color_breakdown_rejects_unknown_color(erp_client):
    *_ignored, down_id = _make_color_process(erp_client)
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "colorBreakdown": [{"color": "Purple", "qty": 5}],
                "componentsConsumed": [_item_component()],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "not a configured color sub-group" in body["message"]


def test_save_production_color_breakdown_custom_subgroup_exempt(erp_client):
    *_ignored, down_id = _make_color_process(erp_client)
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "colorBreakdown": [{"color": "SpecialBatch", "qty": 5, "isCustom": True}],
                "componentsConsumed": [_item_component()],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True


def test_color_rename_cascades_into_production_and_warehouse_pool(erp_client):
    """tags_service._rename_color_everywhere's Production/Warehouse Pool
    targets: a real gap found by an Apps-Script-parity audit (deferred
    since Phase 1a's own comment said "Production/Warehouse Pool don't
    exist yet" -- both now do). Proves the rename reaches production's
    color (comma-joined display string) and color_breakdown (the
    authoritative JSON array), and that it also triggers an immediate
    Warehouse Pool recalculation rather than leaving the bucket keyed on
    the old name until some unrelated write happens to rebuild it.
    """
    old_color = _unique_name("OldProdColor")
    new_color = _unique_name("NewProdColor")
    _rpc(erp_client, "saveColor", [{"name": old_color}], mutation=True)

    payload, process_id = _save_process(erp_client)
    _seed_pool(erp_client, process_id, 10, color=old_color)

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "colorBreakdown": [{"color": old_color, "qty": 5, "isCustom": True}],
                "componentsConsumed": [_item_component()],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    lot_number = body["data"]["lotNumber"]

    rename = _rpc(erp_client, "saveColor", [{"name": new_color, "originalName": old_color}], mutation=True)
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    match = next(r for r in listed if r["lotNumber"] == lot_number)
    assert match["color"] == new_color
    assert match["colorBreakdown"][0]["color"] == new_color

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    own_buckets = [b for b in pool if b["outputItemName"] == payload["outputItemName"]]
    assert not any(b["color"] == old_color for b in own_buckets)  # old key gone, not left stale
    assert any(b["color"] == new_color for b in own_buckets)  # recalculated immediately under the new key


def test_save_production_primary_axis_qty_summation_excludes_other_axis(erp_client):
    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    rim_payload, rim_id = _save_process(erp_client)
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    _down_payload, down_id = _save_process(
        erp_client,
        components=[
            {"itemName": frame_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
            {"itemName": rim_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
        ],
    )

    axis_label = frame_payload["outputItemName"]
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "primaryColorAxis": axis_label,
                "colorBreakdown": [
                    {"color": "Black", "qty": 4},
                    {"color": "Blue", "qty": 6},
                    {"color": "Red", "qty": 100},
                ],
                "componentsConsumed": [_item_component()],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    match = next(r for r in listed if r["lotNumber"] == body["data"]["lotNumber"])
    assert match["qty"] == 10  # Red (100) excluded -- not on the Primary Axis, not custom

    axes_data = _rpc(erp_client, "getProcessColorAxes", [down_id]).get_json()["data"]
    assert axes_data["primaryColorAxis"] == axis_label


def test_save_production_process_cannot_change_on_edit(erp_client):
    _p1, id1 = _save_process(erp_client)
    _p2, id2 = _save_process(erp_client)

    create = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": id1, "assignedTo": "Worker A", "qty": 5, "componentsConsumed": [_item_component()]}],
        mutation=True,
    ).get_json()
    assert create["success"] is True
    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row = next(r for r in listed if r["lotNumber"] == create["data"]["lotNumber"])

    edit = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "rowIdx": row["rowIdx"],
                "processId": id2,
                "assignedTo": "Worker A",
                "qty": 5,
                "componentsConsumed": [_item_component()],
            }
        ],
        mutation=True,
    )
    body = edit.get_json()
    assert body["success"] is False
    assert "cannot be changed" in body["message"]


def test_save_production_lot_number_scoped_per_prefix(erp_client):
    payload, process_id = _save_process(erp_client)
    prefix = payload["lotPrefix"]

    first = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "componentsConsumed": [_item_component()]}],
        mutation=True,
    ).get_json()
    second = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "componentsConsumed": [_item_component()]}],
        mutation=True,
    ).get_json()

    assert first["data"]["lotNumber"].startswith(f"LOT-{prefix}-")
    assert first["data"]["lotNumber"] != second["data"]["lotNumber"]


def test_save_production_contractor_payable_computed_from_rate(erp_client):
    payload, process_id = _save_process(erp_client)
    contractor = _unique_name("RateWorker")
    _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processName": payload["processName"], "ratePerUnit": 15}],
        mutation=True,
    )

    resp = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": contractor, "qty": 4, "componentsConsumed": [_item_component()]}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True

    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    match = next(r for r in listed if r["lotNumber"] == body["data"]["lotNumber"])
    assert match["contractorPayable"] == 60  # 15 rate * 4 qty


def test_save_production_contractor_payable_defaults_zero_without_rate(erp_client):
    _payload, process_id = _save_process(erp_client)
    resp = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": _unique_name("NoRateContractor"), "qty": 4, "componentsConsumed": [_item_component()]}],
        mutation=True,
    )
    body = resp.get_json()
    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    match = next(r for r in listed if r["lotNumber"] == body["data"]["lotNumber"])
    assert match["contractorPayable"] == 0


def test_save_production_warns_non_blocking_on_insufficient_pool(erp_client):
    upstream_payload, upstream_id = _save_process(erp_client)
    _downstream_payload, down_id = _save_process(
        erp_client,
        components=[{"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "componentsConsumed": [
                    {"itemName": upstream_payload["outputItemName"], "qty": 3, "sourceType": "POOL", "colorGroup": "COMMON"}
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True  # non-blocking
    assert "Warning" in body["message"]
    assert "Warehouse Pool" in body["message"]


def test_completed_lot_credits_pool_and_debits_stock(erp_client):
    stock_item = _unique_name("ProdStockItem")
    _rpc(erp_client, "saveItem", [{"itemName": stock_item, "itemInitialStock": 50}], mutation=True)

    payload, process_id = _save_process(erp_client)

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 10,
                "status": "Completed",
                "componentsConsumed": [{"itemName": stock_item, "qty": 6, "sourceType": "ITEM", "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    match = next(b for b in pool if b["outputItemName"] == payload["outputItemName"])
    assert match["availableQty"] == 10

    stock = _rpc(erp_client, "getStockData").get_json()["data"]
    stock_match = next(r for r in stock if r["name"] == stock_item)
    assert stock_match["currentStock"] == 44  # 50 initial - 6 consumed by the Completed lot


def test_uncompleting_lot_reverses_pool_and_stock(erp_client):
    stock_item = _unique_name("ReverseStockItem")
    _rpc(erp_client, "saveItem", [{"itemName": stock_item, "itemInitialStock": 50}], mutation=True)

    payload, process_id = _save_process(erp_client)

    create = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 10,
                "status": "Completed",
                "componentsConsumed": [{"itemName": stock_item, "qty": 6, "sourceType": "ITEM", "unit": "Pcs"}],
            }
        ],
        mutation=True,
    ).get_json()
    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row = next(r for r in listed if r["lotNumber"] == create["data"]["lotNumber"])

    update = _rpc(erp_client, "updateProductionStatus", [row["rowIdx"], row["qty"], "Pending"], mutation=True)
    assert update.get_json()["success"] is True

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    assert not any(b["outputItemName"] == payload["outputItemName"] for b in pool)

    stock = _rpc(erp_client, "getStockData").get_json()["data"]
    stock_match = next(r for r in stock if r["name"] == stock_item)
    assert stock_match["currentStock"] == 50  # fully reversed


def test_update_production_status_enforces_enum(erp_client):
    _payload, process_id = _save_process(erp_client)
    create = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "componentsConsumed": [_item_component()]}],
        mutation=True,
    ).get_json()
    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row = next(r for r in listed if r["lotNumber"] == create["data"]["lotNumber"])

    resp = _rpc(erp_client, "updateProductionStatus", [row["rowIdx"], row["qty"], "NotARealStatus"], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Invalid status" in body["message"]


def test_update_production_status_rechecks_pool_on_entering_completed(erp_client):
    upstream_payload, upstream_id = _save_process(erp_client)
    _seed_pool(erp_client, upstream_id, 5)

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[{"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )

    # Sufficient pool (5 available) at save time -- lot stays Pending, no warning.
    create = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": downstream_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "status": "Pending",
                "componentsConsumed": [
                    {"itemName": upstream_payload["outputItemName"], "qty": 5, "sourceType": "POOL", "colorGroup": "COMMON"}
                ],
            }
        ],
        mutation=True,
    ).get_json()
    assert "Warning" not in create["message"]

    # Drain the pool via a second, unrelated Completed lot before completing the first.
    _drain_downstream_payload, drain_downstream_id = _save_process(
        erp_client,
        components=[{"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )
    _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": drain_downstream_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "status": "Completed",
                "componentsConsumed": [
                    {"itemName": upstream_payload["outputItemName"], "qty": 5, "sourceType": "POOL", "colorGroup": "COMMON"}
                ],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row = next(r for r in listed if r["lotNumber"] == create["data"]["lotNumber"])

    update = _rpc(erp_client, "updateProductionStatus", [row["rowIdx"], row["qty"], "Completed"], mutation=True)
    body = update.get_json()
    assert body["success"] is True
    assert "Warning" in body["message"]


def test_delete_production_optimistic_check(erp_client):
    _payload, process_id = _save_process(erp_client)
    create = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "componentsConsumed": [_item_component()]}],
        mutation=True,
    ).get_json()
    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row = next(r for r in listed if r["lotNumber"] == create["data"]["lotNumber"])

    mismatch = _rpc(erp_client, "deleteProduction", [row["rowIdx"], row["productId"], 999], mutation=True)
    body = mismatch.get_json()
    assert body["success"] is False
    assert "Data mismatch" in body["message"]

    success = _rpc(erp_client, "deleteProduction", [row["rowIdx"], row["productId"], row["qty"]], mutation=True)
    assert success.get_json()["success"] is True

    remaining = _rpc(erp_client, "getProductionData").get_json()["data"]
    assert not any(r["rowIdx"] == row["rowIdx"] for r in remaining)


def test_delete_production_pool_credit_removal_warning(erp_client):
    upstream_payload, upstream_id = _save_process(erp_client)

    create = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": upstream_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "status": "Completed",
                "componentsConsumed": [_item_component()],
            }
        ],
        mutation=True,
    ).get_json()
    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row = next(r for r in listed if r["lotNumber"] == create["data"]["lotNumber"])

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[{"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )
    _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": downstream_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "status": "Completed",
                "componentsConsumed": [
                    {"itemName": upstream_payload["outputItemName"], "qty": 5, "sourceType": "POOL", "colorGroup": "COMMON"}
                ],
            }
        ],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteProduction", [row["rowIdx"]], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "negative" in body["message"]


def test_delete_production_bulk_skip_and_report(erp_client):
    _payload, process_id = _save_process(erp_client)
    a = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "componentsConsumed": [_item_component()]}],
        mutation=True,
    ).get_json()
    b = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "componentsConsumed": [_item_component()]}],
        mutation=True,
    ).get_json()

    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row_a = next(r for r in listed if r["lotNumber"] == a["data"]["lotNumber"])
    row_b = next(r for r in listed if r["lotNumber"] == b["data"]["lotNumber"])

    resp = _rpc(
        erp_client,
        "deleteProductionBulk",
        [
            [row_a["rowIdx"], row_b["rowIdx"]],
            [
                {"rowIdx": row_a["rowIdx"], "expectedProductId": row_a["productId"], "expectedQty": 999},
                {"rowIdx": row_b["rowIdx"], "expectedProductId": row_b["productId"], "expectedQty": row_b["qty"]},
            ],
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert "Deleted 1" in body["message"]
    assert "Skipped 1" in body["message"]

    remaining = _rpc(erp_client, "getProductionData").get_json()["data"]
    remaining_ids = {r["rowIdx"] for r in remaining}
    assert row_a["rowIdx"] in remaining_ids
    assert row_b["rowIdx"] not in remaining_ids


def test_save_production_sheet_independent_of_components_consumed(erp_client):
    _payload, process_id = _save_process(erp_client)
    create = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "componentsConsumed": [_item_component()]}],
        mutation=True,
    ).get_json()
    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row = next(r for r in listed if r["lotNumber"] == create["data"]["lotNumber"])

    resp = _rpc(
        erp_client,
        "saveProductionSheet",
        [
            row["rowIdx"],
            row["productId"],
            row["qty"],
            [{"itemName": "SheetOnlyPart", "size": "M", "narration": "n", "color": "Red", "requiredQty": 3}],
            "printout remark",
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["customComponents"][0]["itemName"] == "SheetOnlyPart"

    refreshed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row2 = next(r for r in refreshed if r["rowIdx"] == row["rowIdx"])
    assert row2["sheetRemarks"] == "printout remark"
    assert row2["componentsConsumed"][0]["itemName"] == "RawMat"  # untouched


def test_contractor_rename_cascades_into_production_assigned_to(erp_client):
    old_name = _unique_name("OldProdContractor")
    new_name = _unique_name("NewProdContractor")
    _rpc(erp_client, "saveContractor", [{"contractorName": old_name}], mutation=True)

    _payload, process_id = _save_process(erp_client)
    create = _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": old_name, "qty": 5, "componentsConsumed": [_item_component()]}],
        mutation=True,
    ).get_json()

    rename = _rpc(erp_client, "saveContractor", [{"contractorName": new_name, "originalContractorName": old_name}], mutation=True)
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    row = next(r for r in listed if r["lotNumber"] == create["data"]["lotNumber"])
    assert row["assignedTo"] == new_name


def test_contractor_delete_blocked_by_production_reference(erp_client):
    contractor = _unique_name("BlockedProdContractor")
    _rpc(erp_client, "saveContractor", [{"contractorName": contractor}], mutation=True)

    _payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": contractor, "qty": 5, "componentsConsumed": [_item_component()]}],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteContractor", [contractor], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Production" in body["message"]


def test_bom_product_delete_blocked_by_production_reference(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name = _unique_name("ProdBlockedBomProduct")
    create_bom = _rpc(
        erp_client,
        "saveBOM",
        [{"productName": product_name, "components": [{"itemName": _unique_name("BomItem"), "qtyPerProduct": 1}]}, token],
        mutation=True,
    )
    product_id = create_bom.get_json()["data"]["productId"]

    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "productId": product_id,
                "componentsConsumed": [_item_component()],
            }
        ],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteBOM", [product_id, token], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
