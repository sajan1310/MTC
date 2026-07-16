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


def test_process_delete_blocked_by_warehouse_pool_opening_reference(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 3}], mutation=True)

    resp = _rpc(erp_client, "deleteProcess", [process_id], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Warehouse Pool" in body["message"]
