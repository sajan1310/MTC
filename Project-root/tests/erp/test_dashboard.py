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
    assert isinstance(data["upcoming"], list)
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
    # The new lot is Pending, so it lands in the queued half of the split --
    # the "in progress" half must not move.
    assert after["queuedProductionCount"] == before["queuedProductionCount"] + 1
    assert after["inProgressProductionCount"] == before["inProgressProductionCount"]
    assert after["oldestPendingProductionDays"] is not None
    assert after["oldestPendingProductionDays"] >= 0


def test_dashboard_in_progress_count_tracks_the_in_progress_status(erp_client):
    before = _dashboard_kpis(erp_client)

    _payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveProduction",
        [{"processId": process_id, "assignedTo": "Worker A", "qty": 5, "status": "In Progress", "componentsConsumed": [_item_component()]}],
        mutation=True,
    )

    after = _dashboard_kpis(erp_client)
    assert after["inProgressProductionCount"] == before["inProgressProductionCount"] + 1
    assert after["queuedProductionCount"] == before["queuedProductionCount"]
    # The combined open-lot total still counts both halves.
    assert after["pendingProductionCount"] == before["pendingProductionCount"] + 1


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

    process_type = _unique_name("DashPayableType")
    _payload, process_id = _save_process(erp_client, processType=process_type)
    contractor = _unique_name("DashPayableContractor")
    _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processType": process_type, "size": "General", "ratePerUnit": 20}],
        mutation=True,
    )
    _complete_production_lot(erp_client, process_id, "", 5, contractor=contractor)

    after = _dashboard_kpis(erp_client)
    assert after["contractorPayablesDue"] == round(before["contractorPayablesDue"] + 100, 2)  # 20 rate * 5 qty
    assert after["contractorPayablesCount"] == before["contractorPayablesCount"] + 1


def _save_lot(client, process_id, status, **overrides):
    form = {
        "processId": process_id,
        "assignedTo": "Worker A",
        "qty": 5,
        "status": status,
        "componentsConsumed": [_item_component()],
    }
    form.update(overrides)
    resp = _rpc(client, "saveProduction", [form], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body


def test_dashboard_pipeline_groups_by_model_and_size(erp_client):
    _payload, process_id = _save_process(erp_client)
    _save_lot(erp_client, process_id, "In Progress")

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    stage = next(p for p in dash["pipeline"] if p["processId"] == process_id)
    assert stage["totalLotCount"] == 1
    assert stage["totalQty"] == 5
    assert stage["groups"][0]["title"] == "Unspecified"  # non-final-stage lot: no product tag, no size


def test_dashboard_pipeline_shows_only_in_progress_lots(erp_client):
    """A Pending lot belongs to Upcoming Lots, never to the WIP pipeline.

    "Active" used to mean Pending OR In Progress, so every pipeline stage
    total mixed material actually being worked with lots nobody had started
    -- the one number a floor supervisor reads to decide where to go next,
    systematically overstated.
    """
    _payload, process_id = _save_process(erp_client)
    _save_lot(erp_client, process_id, "Pending", qty=7)

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    assert not any(p["processId"] == process_id for p in dash["pipeline"])

    queued = next(p for p in dash["upcoming"] if p["processId"] == process_id)
    assert queued["totalQty"] == 7
    assert queued["totalLotCount"] == 1


def test_dashboard_splits_the_same_stage_across_both_lists(erp_client):
    _payload, process_id = _save_process(erp_client)
    _save_lot(erp_client, process_id, "In Progress", qty=4)
    _save_lot(erp_client, process_id, "Pending", qty=9)

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    running = next(p for p in dash["pipeline"] if p["processId"] == process_id)
    queued = next(p for p in dash["upcoming"] if p["processId"] == process_id)
    assert running["totalQty"] == 4
    assert queued["totalQty"] == 9


def test_dashboard_stage_reports_the_age_of_its_oldest_lot(erp_client):
    _payload, process_id = _save_process(erp_client)
    _save_lot(erp_client, process_id, "In Progress")

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    stage = next(p for p in dash["pipeline"] if p["processId"] == process_id)
    assert stage["oldestDays"] == 0  # logged today


def test_dashboard_stage_counts_a_colour_split_lot_once(erp_client):
    """One lot in four colours is one lot, not four.

    Lot counts used to be counts of colour-breakdown ENTRIES, so the
    summary's "N lots" was inflated by exactly the amount of colour tracking
    the shop does.
    """
    _payload, process_id = _save_process(erp_client)
    _save_lot(
        erp_client,
        process_id,
        "In Progress",
        colorBreakdown=[
            {"color": "DashCountRed", "size": "", "qty": 2, "isCustom": True},
            {"color": "DashCountBlue", "size": "", "qty": 3, "isCustom": True},
            {"color": "DashCountGreen", "size": "", "qty": 4, "isCustom": True},
        ],
    )

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    stage = next(p for p in dash["pipeline"] if p["processId"] == process_id)
    assert stage["totalLotCount"] == 1
    assert stage["totalQty"] == 9
    assert all(g["lotCount"] == 1 for g in stage["groups"])


def test_dashboard_pipeline_group_title_includes_color(erp_client):
    """A colour-tracked lot on a NON-final stage must group by its colour.

    This is what used to make almost every WIP pipeline stage render a single
    group titled "Unspecified": _get_pipeline_data built its title from
    productName + size only, and on an intermediate process productName is
    always blank (production_service writes it only when isFinalStage) while
    size is optional on a breakdown entry -- colour, the one field
    save_production actually requires there, went unread.
    """
    _payload, process_id = _save_process(erp_client)
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "status": "In Progress",
                "componentsConsumed": [_item_component()],
                "colorBreakdown": [
                    {"color": "DashPipelineRed", "size": "", "qty": 7, "isCustom": True},
                    {"color": "DashPipelineBlue", "size": "", "qty": 3, "isCustom": True},
                ],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True, resp.get_json()["message"]

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    stage = next(p for p in dash["pipeline"] if p["processId"] == process_id)

    titles = {g["title"]: g["qty"] for g in stage["groups"]}
    assert titles == {"DashPipelineRed": 7, "DashPipelineBlue": 3}
    assert "Unspecified" not in titles


def test_dashboard_pipeline_group_title_keeps_size_alongside_color(erp_client):
    _payload, process_id = _save_process(erp_client)
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "status": "In Progress",
                "componentsConsumed": [_item_component()],
                "colorBreakdown": [
                    {"color": "DashSizedGreen", "size": "14 inch", "qty": 5, "isCustom": True},
                ],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True, resp.get_json()["message"]

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    stage = next(p for p in dash["pipeline"] if p["processId"] == process_id)
    assert stage["groups"][0]["title"] == "DashSizedGreen 14 inch"


def test_dashboard_stage_carries_its_process_type(erp_client):
    """The stage chart bands its columns by processType, so a stage without
    one lands in "Other" and the banding silently stops meaning anything."""
    payload, process_id = _save_process(erp_client, processType="Fitting Frame")
    _save_lot(erp_client, process_id, "In Progress")

    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    stage = next(p for p in dash["pipeline"] if p["processId"] == process_id)
    assert stage["processType"] == payload["processType"]


def test_dashboard_pipeline_omits_process_with_no_active_lots(erp_client):
    _payload, process_id = _save_process(erp_client)
    dash = _rpc(erp_client, "getDashboardData").get_json()["data"]
    assert not any(p["processId"] == process_id for p in dash["pipeline"])
    assert not any(p["processId"] == process_id for p in dash["upcoming"])


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
    _rpc(erp_client, "saveDispatch", [{"lines": [{"productId": product_id, "productName": product_name, "qty": 3}]}], mutation=True)

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
    _rpc(erp_client, "saveDispatch", [{"lines": [{"productId": product_id, "productName": product_name, "qty": 2}]}], mutation=True)

    after = _rpc(erp_client, "getMobileDashboard").get_json()["data"]["todaysDispatchCount"]
    assert after == before + 1


def test_mobile_dashboard_recent_activity_sorted_newest_first(erp_client):
    dash = _rpc(erp_client, "getMobileDashboard").get_json()["data"]
    dates = [a["dateRaw"] for a in dash["recentActivity"]]
    assert dates == sorted(dates, reverse=True)
