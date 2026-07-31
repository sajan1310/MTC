"""Dashboard RPC tests, ported behavior from Apps_Script/module_dashboard.js
-- closes out the port's "real feature" surface.

Most assertions use a before/after delta pattern rather than exact
totals: getDashboardData aggregates across the ENTIRE database, and this
test suite runs in a shared DB alongside every other module's tests
(unique names avoid collisions, but don't isolate aggregate KPIs). A
delta proves this test's own contribution is counted correctly without
depending on what else happened to exist at the time.
"""

from __future__ import annotations

import uuid
from datetime import date

from app.erp.services import bom_service


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _today_display() -> str:
    d = date.today()
    return f"{d.day:02d}/{d.month:02d}/{d.year}"


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
        "productName": _unique_name("DashBomProduct"),
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


def _dashboard_kpis(client):
    return _rpc(client, "getDashboardData").get_json()["data"]["kpis"]


def test_get_dashboard_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getDashboardData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    data = body["data"]
    assert "kpis" in data
    assert isinstance(data["pipeline"], list)
    assert isinstance(data["productionStatusBreakdown"], list)
    assert isinstance(data["dispatchTrend"], list)
    assert isinstance(data["lowStockItems"], list)
    assert isinstance(data["contractorPayables"], list)
    assert isinstance(data["readyToDispatchItems"], list)
    assert data["generatedAt"]


def test_dashboard_open_po_summary_reflects_unbilled_po(erp_client):
    before = _dashboard_kpis(erp_client)

    vendor = _unique_name("DashPoVendor")
    item = _unique_name("DashPoItem")
    po = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": item, "size": "Std", "qty": 10, "unit": "Pcs", "price": 5}]}],
        mutation=True,
    ).get_json()
    po_number = po["data"]["poNumber"]

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("DashBill"),
                "billDate": "01/01/2026",
                "items": [{"name": item, "size": "Std", "qty": 4, "price": 5, "po": po_number}],
            }
        ],
        mutation=True,
    )

    after = _dashboard_kpis(erp_client)
    assert after["openPoCount"] == before["openPoCount"] + 1
    assert after["openPoValue"] == round(before["openPoValue"] + 30, 2)  # remaining 6 * rate 5


def test_dashboard_bills_this_month_kpi(erp_client):
    before = _dashboard_kpis(erp_client)

    vendor = _unique_name("DashBillVendor")
    resp = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("DashBillNum"),
                "billDate": _today_display(),
                "items": [{"name": _unique_name("Item"), "qty": 2, "price": 50}],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    after = _dashboard_kpis(erp_client)
    assert after["billsThisMonthCount"] == before["billsThisMonthCount"] + 1
    assert after["billsThisMonthValue"] == round(before["billsThisMonthValue"] + 118, 2)  # 100 + default 18% GST


def test_dashboard_low_stock_deficit_kpi(erp_client):
    before = _dashboard_kpis(erp_client)

    item = _unique_name("DashLowStockDeficit")
    _rpc(erp_client, "saveItem", [{"itemName": item, "itemInitialStock": 2}], mutation=True)
    _rpc(erp_client, "updateThreshold", [item, "", 10], mutation=True)

    after = _dashboard_kpis(erp_client)
    assert after["lowStockCount"] == before["lowStockCount"] + 1
    assert after["lowStockTotalDeficit"] == round(before["lowStockTotalDeficit"] + 8, 2)


def test_dashboard_low_stock_items_capped_at_ten(erp_client):
    for i in range(11):
        item = _unique_name(f"CapLowStock{i}")
        _rpc(erp_client, "saveItem", [{"itemName": item, "itemInitialStock": 1}], mutation=True)
        _rpc(erp_client, "updateThreshold", [item, "", 5], mutation=True)

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    assert len(dash["lowStockItems"]) <= 10
    assert dash["lowStockTotalCount"] >= 11


def test_dashboard_pending_production_count(erp_client):
    before = _dashboard_kpis(erp_client)

    _payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "status": "Pending", "componentsConsumed": [_item_component()]}],
        mutation=True,
    )

    after = _dashboard_kpis(erp_client)
    assert after["pendingProductionCount"] == before["pendingProductionCount"] + 1
    assert after["oldestPendingProductionDays"] is not None
    assert after["oldestPendingProductionDays"] >= 0


def test_dashboard_ready_to_dispatch_kpi(erp_app, erp_client):
    before = _dashboard_kpis(erp_client)

    token = _get_bom_token(erp_app, erp_client)
    _product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 7)

    after = _dashboard_kpis(erp_client)
    assert after["readyToDispatchUnits"] == round(before["readyToDispatchUnits"] + 7, 2)
    assert after["readyToDispatchProductCount"] == before["readyToDispatchProductCount"] + 1


def test_dashboard_contractor_payables_kpi(erp_client):
    before = _dashboard_kpis(erp_client)

    payload, process_id = _save_process(erp_client)
    contractor = _unique_name("DashPayableContractor")
    _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processName": payload["processName"], "ratePerUnit": 20}],
        mutation=True,
    )
    _complete_production_lot(erp_client, process_id, "", 5, contractor=contractor)

    after = _dashboard_kpis(erp_client)
    assert after["contractorPayablesDue"] == round(before["contractorPayablesDue"] + 100, 2)  # 20 rate * 5 qty
    assert after["contractorPayablesCount"] == before["contractorPayablesCount"] + 1


def test_dashboard_pipeline_groups_by_model_and_size(erp_client):
    _payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "status": "Pending", "componentsConsumed": [_item_component()]}],
        mutation=True,
    )

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    stage = next(p for p in dash["pipeline"] if p["processId"] == process_id)
    assert stage["totalLotCount"] == 1
    assert stage["totalQty"] == 5
    assert stage["groups"][0]["title"] == "Unspecified"  # non-final-stage lot: no product tag, no size


def test_dashboard_pipeline_omits_process_with_no_active_lots(erp_client):
    _payload, process_id = _save_process(erp_client)
    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    assert not any(p["processId"] == process_id for p in dash["pipeline"])


def test_dashboard_production_status_breakdown(erp_client):
    _payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "status": "Cancelled", "componentsConsumed": [_item_component()]}],
        mutation=True,
    )

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    breakdown = {b["status"]: b["count"] for b in dash["productionStatusBreakdown"]}
    assert breakdown.get("Cancelled", 0) >= 1


def test_dashboard_dispatch_trend_covers_30_days(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 20)
    _rpc(erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 3}], mutation=True)

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    trend = dash["dispatchTrend"]
    assert len(trend) == 30

    today_key = date.today().isoformat()
    today_entry = next(t for t in trend if t["date"] == today_key)
    assert today_entry["qty"] >= 3


def test_get_mobile_dashboard_returns_success_envelope_and_shape(erp_client):
    resp = _rpc(erp_client, "getMobileDashboard")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    data = body["data"]
    assert "pendingProductionCount" in data
    assert "todaysDispatchCount" in data
    assert "lowStockCount" in data
    assert isinstance(data["recentActivity"], list)
    assert len(data["recentActivity"]) <= 5
    assert data["appVersion"]
    assert "userEmail" in data


def test_mobile_dashboard_todays_dispatch_count(erp_app, erp_client):
    before = _rpc(erp_client, "getMobileDashboard").get_json()["data"]["todaysDispatchCount"]

    token = _get_bom_token(erp_app, erp_client)
    product_name, product_id = _save_bom_product(erp_client, token)
    _payload, process_id = _save_process(erp_client, isFinalStage=True)
    _complete_production_lot(erp_client, process_id, product_id, 5)
    _rpc(erp_client, "saveDispatch", [{"productId": product_id, "productName": product_name, "qty": 2}], mutation=True)

    after = _rpc(erp_client, "getMobileDashboard").get_json()["data"]["todaysDispatchCount"]
    assert after == before + 1


def test_mobile_dashboard_recent_activity_sorted_newest_first(erp_client):
    dash = _rpc(erp_client, "getMobileDashboard").get_json()["data"]
    dates = [a["dateRaw"] for a in dash["recentActivity"]]
    assert dates == sorted(dates, reverse=True)
