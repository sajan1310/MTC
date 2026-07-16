"""Clients + PI/Estimates (Client Orders) RPC tests, ported behavior from
Apps_Script/module_clients.js -- closes Phase 4.

Also proves three "activates automatically" cascades/guards: a BOM
Product delete blocked by a Client Orders reference
(bom_service._get_product_ids_in_use's Client Orders leg) and
saveDispatch's per-order-line qty guard actually blocking an
over-fulfillment now that Client Orders exists for real
(dispatch_service._get_client_order_line_qty, Phase 4a's own guarded
stub, reachable for the first time).
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
        "productName": _unique_name("ClientsBomProduct"),
        "components": [{"itemName": _unique_name("BomItem"), "qtyPerProduct": 1}],
    }
    payload.update(overrides)
    resp = _rpc(client, "saveBOM", [payload, token], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return payload["productName"], body["data"]["productId"]


def _save_final_stage_process_with_recipe(client):
    item = _unique_name("RecipeItem")
    payload, process_id = _save_process(
        client,
        isFinalStage=True,
        components=[{"itemName": item, "qtyPerUnit": 2, "sourceType": "ITEM", "colorGroup": "COMMON"}],
    )
    return payload, process_id


def _save_pushable_bom_product(client, token, process_id):
    product_name = _unique_name("PushableProduct")
    resp = _rpc(
        client,
        "saveBOM",
        [
            {
                "productName": product_name,
                "components": [{"itemName": _unique_name("BomItem"), "qtyPerProduct": 1, "processId": process_id}],
            },
            token,
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return product_name, body["data"]["productId"]


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


def _save_client(client, **overrides):
    payload = {
        "clientName": _unique_name("Client"),
        "contact": "9876543210",
        "address": "1 Main St",
        "gstin": "ABCDE1234F",
        "remarks": "test",
    }
    payload.update(overrides)
    resp = _rpc(client, "saveClient", [payload], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return payload, body["data"]["name"]


def _save_client_order(client, client_name, lines, **overrides):
    payload = {"clientName": client_name, "status": "Estimate", "lines": lines}
    payload.update(overrides)
    resp = _rpc(client, "saveClientOrder", [payload], mutation=True)
    return resp.get_json()


def test_get_clients_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getClientsData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_client_creates_and_lists_it(erp_client):
    payload, name = _save_client(erp_client)
    listed = _rpc(erp_client, "getClientsData").get_json()["data"]
    match = next(c for c in listed if c["name"] == name)
    assert match["contact"] == payload["contact"]
    assert match["gstin"] == payload["gstin"]


def test_save_client_rejects_case_insensitive_duplicate(erp_client):
    _payload, name = _save_client(erp_client)
    dupe = _rpc(erp_client, "saveClient", [{"clientName": name.upper()}], mutation=True)
    body = dupe.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_save_client_rename_via_original_name(erp_client):
    _payload, original = _save_client(erp_client)
    renamed = _unique_name("RenamedClient")
    edit = _rpc(erp_client, "saveClient", [{"clientName": renamed, "originalClientName": original}], mutation=True)
    body = edit.get_json()
    assert body["success"] is True
    assert body["data"]["name"] == renamed

    listed = _rpc(erp_client, "getClientsData").get_json()["data"]
    names = [c["name"] for c in listed]
    assert renamed in names
    assert original not in names


def test_delete_client_success_and_not_found(erp_client):
    _payload, name = _save_client(erp_client)
    deleted = _rpc(erp_client, "deleteClient", [name], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getClientsData").get_json()["data"]
    assert name not in [c["name"] for c in listed]

    missing = _rpc(erp_client, "deleteClient", [name], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_client_blocked_by_pi_estimate_reference(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    _product_name, product_id = _save_bom_product(erp_client, token)
    _payload, name = _save_client(erp_client)

    _save_client_order(erp_client, name, [{"productId": product_id, "qty": 5}])

    resp = _rpc(erp_client, "deleteClient", [name], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "PI/Estimate" in body["message"]


def test_delete_client_blocked_by_dispatch_reference(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, name = _save_client(erp_client)

    _proc_payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)
    _rpc(
        erp_client,
        "saveDispatch",
        [{"productId": product_id, "productName": product_name, "qty": 2, "clientName": name}],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteClient", [name], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Dispatch" in body["message"]


def test_delete_clients_bulk(erp_client):
    _payload_a, a = _save_client(erp_client)
    _payload_b, b = _save_client(erp_client)

    resp = _rpc(erp_client, "deleteClientsBulk", [[a, b]], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getClientsData").get_json()["data"]
    names = [c["name"] for c in listed]
    assert a not in names
    assert b not in names


def test_client_rename_cascades_into_client_orders_and_dispatch(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, old_name = _save_client(erp_client)
    new_name = _unique_name("RenamedCascadeClient")

    order = _save_client_order(erp_client, old_name, [{"productId": product_id, "qty": 5}])
    assert order["success"] is True

    _proc_payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)
    _rpc(
        erp_client,
        "saveDispatch",
        [{"productId": product_id, "productName": product_name, "qty": 2, "clientName": old_name}],
        mutation=True,
    )

    rename = _rpc(erp_client, "saveClient", [{"clientName": new_name, "originalClientName": old_name}], mutation=True)
    assert rename.get_json()["success"] is True

    orders = _rpc(erp_client, "getClientOrdersData").get_json()["data"]
    match = next(o for o in orders if o["orderNumber"] == order["data"]["orderNumber"])
    assert match["clientName"] == new_name

    dispatches = _rpc(erp_client, "getDispatchData").get_json()["data"]
    match_d = next(d for d in dispatches if d["productId"] == product_id)
    assert match_d["clientName"] == new_name


def test_get_client_orders_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getClientOrdersData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_client_order_requires_client(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    _product_name, product_id = _save_bom_product(erp_client, token)
    resp = _rpc(erp_client, "saveClientOrder", [{"lines": [{"productId": product_id, "qty": 5}]}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Client is required" in body["message"]


def test_save_client_order_rejects_invalid_status(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    _product_name, product_id = _save_bom_product(erp_client, token)
    _payload, name = _save_client(erp_client)

    resp = _rpc(
        erp_client,
        "saveClientOrder",
        [{"clientName": name, "status": "NotAStatus", "lines": [{"productId": product_id, "qty": 5}]}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "Invalid status" in body["message"]


def test_save_client_order_rejects_product_not_in_bom(erp_client):
    _payload, name = _save_client(erp_client)
    resp = _rpc(
        erp_client,
        "saveClientOrder",
        [{"clientName": name, "lines": [{"productId": "PRD-999999", "qty": 5}]}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "not defined in BOM" in body["message"]


def test_save_client_order_drops_zero_qty_lines_requires_at_least_one_valid(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    _product_name, product_id = _save_bom_product(erp_client, token)
    _payload, name = _save_client(erp_client)

    resp = _rpc(
        erp_client,
        "saveClientOrder",
        [{"clientName": name, "lines": [{"productId": product_id, "qty": 0}]}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "at least one valid product line" in body["message"]


def test_save_client_order_creates_and_lists_grouped(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, name = _save_client(erp_client)

    result = _save_client_order(erp_client, name, [{"productId": product_id, "qty": 5, "lineRemarks": "note"}])
    assert result["success"] is True
    order_number = result["data"]["orderNumber"]
    assert order_number.startswith("ORD-")

    listed = _rpc(erp_client, "getClientOrdersData").get_json()["data"]
    match = next(o for o in listed if o["orderNumber"] == order_number)
    assert match["clientName"] == name
    assert match["status"] == "Estimate"
    assert len(match["lines"]) == 1
    assert match["lines"][0]["productId"] == product_id
    assert match["lines"][0]["productName"] == product_name
    assert match["lines"][0]["qty"] == 5
    assert match["lines"][0]["lineRemarks"] == "note"
    assert match["lines"][0]["productionPushed"] is False


def test_save_client_order_edit_preserves_pushed_count_per_product(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    _proc_payload, process_id = _save_final_stage_process_with_recipe(erp_client)
    _product_name, product_id = _save_pushable_bom_product(erp_client, token, process_id)
    _payload, client_name = _save_client(erp_client)

    create = _save_client_order(
        erp_client,
        client_name,
        [{"productId": product_id, "qty": 5}, {"productId": product_id, "qty": 3}],
        status="Order Confirmed",
    )
    assert create["success"] is True
    order_number = create["data"]["orderNumber"]

    lots_after_create = [r for r in _rpc(erp_client, "getProductionData").get_json()["data"] if r["productId"] == product_id]
    assert len(lots_after_create) == 2

    # Edit: the same two lines plus one genuinely new line for the same
    # product. If the pushed-count carry-forward didn't work, the two
    # already-pushed lines would get silently re-queued as "new" --
    # inflating the lot count to 5 instead of the correct 3 (2 kept + 1
    # genuinely new).
    edit = _rpc(
        erp_client,
        "saveClientOrder",
        [
            {
                "orderNumber": order_number,
                "clientName": client_name,
                "status": "Order Confirmed",
                "lines": [
                    {"productId": product_id, "qty": 5},
                    {"productId": product_id, "qty": 3},
                    {"productId": product_id, "qty": 7},
                ],
            }
        ],
        mutation=True,
    )
    assert edit.get_json()["success"] is True

    lots_after_edit = [r for r in _rpc(erp_client, "getProductionData").get_json()["data"] if r["productId"] == product_id]
    assert len(lots_after_edit) == 3


def test_save_client_order_pushes_unambiguous_final_stage_line_into_production(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    proc_payload, process_id = _save_final_stage_process_with_recipe(erp_client)
    _product_name, product_id = _save_pushable_bom_product(erp_client, token, process_id)
    _payload, client_name = _save_client(erp_client)

    result = _save_client_order(erp_client, client_name, [{"productId": product_id, "qty": 5}], status="Order Confirmed")
    assert result["success"] is True
    assert "queued into Production" in result["message"]
    order_number = result["data"]["orderNumber"]

    listed = _rpc(erp_client, "getClientOrdersData").get_json()["data"]
    order = next(o for o in listed if o["orderNumber"] == order_number)
    assert order["lines"][0]["productionPushed"] is True

    prod = _rpc(erp_client, "getProductionData").get_json()["data"]
    lot = next(r for r in prod if r["productId"] == product_id)
    assert lot["status"] == "Pending"
    assert lot["processId"] == process_id
    assert lot["qty"] == 5
    assert lot["outputItemName"] == proc_payload["outputItemName"]
    assert lot["componentsConsumed"][0]["qty"] == 10  # qtyPerUnit(2) * lineQty(5)
    assert "Auto-queued from PI" in lot["remarks"]


def test_save_client_order_needs_manual_production_when_unresolvable(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    _product_name, product_id = _save_bom_product(erp_client, token)  # no processId -> unresolvable

    _payload, client_name = _save_client(erp_client)
    result = _save_client_order(erp_client, client_name, [{"productId": product_id, "qty": 5}], status="Order Confirmed")
    assert result["success"] is True
    assert "manual Production setup" in result["message"]

    listed = _rpc(erp_client, "getClientOrdersData").get_json()["data"]
    order = next(o for o in listed if o["orderNumber"] == result["data"]["orderNumber"])
    assert order["lines"][0]["needsManualProduction"] is True
    assert order["lines"][0]["productionPushed"] is False


def test_save_client_order_needs_manual_production_when_multicolor(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    upstream_payload, upstream_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 10, "color": "Black"}], mutation=True)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 10, "color": "Blue"}], mutation=True)

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        isFinalStage=True,
        components=[{"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )
    _product_name, product_id = _save_pushable_bom_product(erp_client, token, downstream_id)

    _payload, client_name = _save_client(erp_client)
    result = _save_client_order(erp_client, client_name, [{"productId": product_id, "qty": 5}], status="Order Confirmed")
    assert result["success"] is True
    assert "manual Production setup" in result["message"]


def test_delete_client_order_blocked_by_dispatch_reference(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, client_name = _save_client(erp_client)

    order = _save_client_order(erp_client, client_name, [{"productId": product_id, "qty": 5}])
    order_number = order["data"]["orderNumber"]

    _proc_payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)
    _rpc(
        erp_client,
        "saveDispatch",
        [{"productId": product_id, "productName": product_name, "qty": 2, "orderNumber": order_number}],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteClientOrder", [order_number], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "dispatch records" in body["message"]


def test_delete_client_order_blocked_by_production_reference(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    _proc_payload, process_id = _save_final_stage_process_with_recipe(erp_client)
    _product_name, product_id = _save_pushable_bom_product(erp_client, token, process_id)
    _payload, client_name = _save_client(erp_client)

    order = _save_client_order(erp_client, client_name, [{"productId": product_id, "qty": 5}], status="Order Confirmed")
    order_number = order["data"]["orderNumber"]

    resp = _rpc(erp_client, "deleteClientOrder", [order_number], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Production lot" in body["message"]


def test_delete_client_orders_bulk_skip_and_report(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, client_name = _save_client(erp_client)

    a = _save_client_order(erp_client, client_name, [{"productId": product_id, "qty": 5}])
    b = _save_client_order(erp_client, client_name, [{"productId": product_id, "qty": 3}])
    order_a = a["data"]["orderNumber"]
    order_b = b["data"]["orderNumber"]

    _proc_payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 10)
    _rpc(
        erp_client,
        "saveDispatch",
        [{"productId": product_id, "productName": product_name, "qty": 1, "orderNumber": order_a}],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteClientOrdersBulk", [[order_a, order_b]], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "Deleted 1" in body["message"]
    assert "Skipped 1" in body["message"]

    listed = _rpc(erp_client, "getClientOrdersData").get_json()["data"]
    order_numbers = [o["orderNumber"] for o in listed]
    assert order_a in order_numbers
    assert order_b not in order_numbers


def test_bom_product_delete_blocked_by_client_order_reference(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    _product_name, product_id = _save_bom_product(erp_client, token)
    _payload, client_name = _save_client(erp_client)

    _save_client_order(erp_client, client_name, [{"productId": product_id, "qty": 5}])

    resp = _rpc(erp_client, "deleteBOM", [product_id, token], mutation=True)
    body = resp.get_json()
    assert body["success"] is False


def test_save_dispatch_blocks_over_fulfilling_specific_order_line(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, client_name = _save_client(erp_client)

    order = _save_client_order(erp_client, client_name, [{"productId": product_id, "qty": 3}])
    order_number = order["data"]["orderNumber"]

    _proc_payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 100)  # plenty of aggregate stock

    # Aggregate Ready-to-Dispatch has 100 available, but this specific PI
    # line only ordered 3 -- the per-order-line guard (now real, since
    # Client Orders exists) must block a dispatch of 5 against it.
    resp = _rpc(
        erp_client,
        "saveDispatch",
        [{"productId": product_id, "productName": product_name, "qty": 5, "orderNumber": order_number}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "remain pending on PI/Estimate" in body["message"]

    # Exactly the line's remaining qty succeeds, with no "Note:" warning
    # now that a real line was found.
    ok = _rpc(
        erp_client,
        "saveDispatch",
        [{"productId": product_id, "productName": product_name, "qty": 3, "orderNumber": order_number}],
        mutation=True,
    )
    ok_body = ok.get_json()
    assert ok_body["success"] is True
    assert "Note:" not in ok_body["message"]
