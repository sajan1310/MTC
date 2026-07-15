"""Stock RPC tests, ported behavior from Apps_Script/module_stock.js."""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _create_item_with_stock(client, name: str, initial_stock: float = 10):
    resp = _rpc(
        client,
        "saveItem",
        [{"itemName": name, "itemInitialStock": initial_stock}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True


def test_get_stock_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getStockData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_stock_row_created_alongside_item_and_is_low_stock_derived(erp_client):
    name = _unique_name("Widget")
    _create_item_with_stock(erp_client, name, initial_stock=5)

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    match = next(r for r in listed if r["name"] == name)
    assert match["initialStock"] == 5
    assert match["currentStock"] == 5  # no bills/returns/etc. yet
    assert match["threshold"] == 0
    assert match["isLowStock"] is False  # 5 is not < 0
    assert match["deadStock"] is False


def test_update_threshold(erp_client):
    name = _unique_name("Bracket")
    _create_item_with_stock(erp_client, name, initial_stock=3)

    resp = _rpc(erp_client, "updateThreshold", [name, "", 10], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    match = next(r for r in listed if r["name"] == name)
    assert match["threshold"] == 10
    assert match["isLowStock"] is True  # 3 < 10


def test_update_threshold_rejects_negative(erp_client):
    name = _unique_name("Negative")
    _create_item_with_stock(erp_client, name)
    resp = _rpc(erp_client, "updateThreshold", [name, "", -5], mutation=True)
    assert resp.get_json()["success"] is False


def test_update_dead_stock(erp_client):
    name = _unique_name("Obsolete")
    _create_item_with_stock(erp_client, name)

    resp = _rpc(erp_client, "updateDeadStock", [name, "", True], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["deadStock"] is True

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    match = next(r for r in listed if r["name"] == name)
    assert match["deadStock"] is True


def test_adjust_stock_manually_records_adjustment(erp_client):
    name = _unique_name("Adjustable")
    _create_item_with_stock(erp_client, name, initial_stock=20)

    resp = _rpc(erp_client, "adjustStockManually", [name, "", 15, "Physical recount"], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"] == {"oldCurrentStock": 20, "newCurrentStock": 15}

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    match = next(r for r in listed if r["name"] == name)
    assert match["currentStock"] == 15

    history = _rpc(erp_client, "getStockAdjustmentHistory").get_json()["data"]
    record = next(h for h in history if h["itemName"] == name)
    assert record["action"] == "ADJUST"
    assert record["oldValue"] == 20
    assert record["newValue"] == 15
    assert record["reason"] == "Physical recount"


def test_adjust_stock_manually_requires_reason(erp_client):
    name = _unique_name("NoReason")
    _create_item_with_stock(erp_client, name, initial_stock=20)
    resp = _rpc(erp_client, "adjustStockManually", [name, "", 15, ""], mutation=True)
    assert resp.get_json()["success"] is False


def test_adjust_stock_manually_same_value_is_a_noop(erp_client):
    name = _unique_name("SameValue")
    _create_item_with_stock(erp_client, name, initial_stock=20)

    resp = _rpc(erp_client, "adjustStockManually", [name, "", 20, "No change"], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert body["data"] == {"oldCurrentStock": 20, "newCurrentStock": 20}


def test_import_stock_data_adds_new_and_updates_existing(erp_client):
    existing_name = _unique_name("ImportExisting")
    new_name = _unique_name("ImportNew")
    _create_item_with_stock(erp_client, existing_name, initial_stock=5)

    resp = _rpc(
        erp_client,
        "importStockData",
        [[{"name": existing_name, "size": "", "initialStock": 50}, {"name": new_name, "size": "", "initialStock": 8}]],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"] == {"updatedCount": 1, "addedCount": 1}

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    updated = next(r for r in listed if r["name"] == existing_name)
    added = next(r for r in listed if r["name"] == new_name)
    assert updated["currentStock"] == 50
    assert added["currentStock"] == 8

    # importStockData also syncs Items Master for any newly-added Stock row.
    items = _rpc(erp_client, "getItemsData").get_json()["data"]
    assert new_name in [i["name"] for i in items]


def test_check_stock_adjustment_conflicts_flags_adjustment_on_or_after_bill_date(erp_client):
    name = _unique_name("ConflictItem")
    _create_item_with_stock(erp_client, name, initial_stock=20)
    _rpc(erp_client, "adjustStockManually", [name, "", 15, "Recount"], mutation=True)

    # Today's date (ISO), on/after the adjustment made just now -> conflict.
    import datetime as _dt

    today_iso = _dt.date.today().isoformat()
    conflict_resp = _rpc(erp_client, "checkStockAdjustmentConflicts", [[{"name": name, "size": ""}], today_iso])
    conflicts = conflict_resp.get_json()["data"]
    assert any(c["itemName"] == name for c in conflicts)

    # A bill dated after the adjustment (a genuinely later delivery) -> no
    # conflict. (A bill dated *before* the adjustment IS a conflict -- it may
    # represent goods the recount already counted -- so the "no conflict"
    # case here is a future-dated bill, not a past-dated one.)
    future_resp = _rpc(erp_client, "checkStockAdjustmentConflicts", [[{"name": name, "size": ""}], "01/01/2099"])
    future_conflicts = future_resp.get_json()["data"]
    assert not any(c["itemName"] == name for c in future_conflicts)


def test_check_stock_adjustment_conflicts_empty_when_no_history(erp_client):
    name = _unique_name("NeverAdjusted")
    _create_item_with_stock(erp_client, name)
    resp = _rpc(erp_client, "checkStockAdjustmentConflicts", [[{"name": name, "size": ""}], "15/07/2026"])
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"] == []
