"""Wastage Log RPC tests, ported behavior from Apps_Script/module_wastage.js."""

from __future__ import annotations

import re
import time
import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _settle():
    """wastageId is a second-precision timestamp (WST-YYYYMMDD-HHMMSS) with
    no override field and, matching the source exactly, no uniqueness
    constraint -- see wastage_service's module docstring. Without this, two
    saves landing in the same wall-clock second (trivially possible between
    two adjacent tests, not just within one) silently merge under one
    getWastageData group, exactly as production would. Called before any
    test's first real save to decouple it from whatever the previous test
    did.
    """
    time.sleep(1.05)


def test_get_wastage_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getWastageData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_wastage_rejects_zero_items(erp_client):
    resp = _rpc(erp_client, "saveWastage", [{"date": "01/01/2026", "items": []}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "zero items" in body["message"]


def test_save_wastage_requires_date(erp_client):
    resp = _rpc(
        erp_client,
        "saveWastage",
        [{"date": "not a date", "items": [{"name": "X", "qty": 1, "unit": "Pcs", "reason": "Damaged"}]}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "date" in body["message"].lower()


def test_save_wastage_rejects_zero_qty(erp_client):
    resp = _rpc(
        erp_client,
        "saveWastage",
        [{"date": "01/01/2026", "items": [{"name": "X", "qty": 0, "unit": "Pcs", "reason": "Damaged"}]}],
        mutation=True,
    )
    assert resp.get_json()["success"] is False


def test_save_wastage_all_blank_names_rejected(erp_client):
    resp = _rpc(
        erp_client,
        "saveWastage",
        [{"date": "01/01/2026", "items": [{"name": "", "qty": 1, "unit": "Pcs"}]}],
        mutation=True,
    )
    assert resp.get_json()["success"] is False


def test_save_wastage_computes_base_qty_and_totals(erp_client):
    _settle()
    vendor = _unique_name("WastageVendor")
    item = _unique_name("WastageItem")

    resp = _rpc(
        erp_client,
        "saveWastage",
        [
            {
                "date": "15/03/2026",
                "vendor": vendor,
                "remarks": "Batch defect",
                "items": [{"name": item, "size": "L", "qty": 3, "unit": "Pcs", "reason": "Damaged in transit"}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    wastage_id = body["data"]["wastageId"]
    assert re.match(r"^WST-\d{8}-\d{6}$", wastage_id)

    listed = _rpc(erp_client, "getWastageData").get_json()["data"]
    match = next(w for w in listed if w["wastageId"] == wastage_id)
    assert match["dateRaw"] == "2026-03-15"
    assert match["vendor"] == vendor
    assert match["remarks"] == "Batch defect"
    assert match["totalQty"] == 3
    assert match["items"][0]["name"] == item
    assert match["items"][0]["baseQty"] == 3
    assert match["items"][0]["reason"] == "Damaged in transit"
    # Wastage's response redundantly repeats header-level remarks on every
    # item too -- matches getWastageData's own shape exactly.
    assert match["items"][0]["remarks"] == "Batch defect"


def test_save_wastage_drops_blank_name_item_from_mixed_batch(erp_client):
    _settle()
    valid_item = _unique_name("ValidWastageItem")
    resp = _rpc(
        erp_client,
        "saveWastage",
        [
            {
                "date": "01/01/2026",
                "items": [
                    {"name": valid_item, "qty": 2, "unit": "Pcs", "reason": "Damaged"},
                    {"name": "", "qty": 1, "unit": "Pcs", "reason": "Damaged"},
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    wastage_id = body["data"]["wastageId"]

    listed = _rpc(erp_client, "getWastageData").get_json()["data"]
    match = next(w for w in listed if w["wastageId"] == wastage_id)
    assert len(match["items"]) == 1
    assert match["items"][0]["name"] == valid_item


def test_delete_wastage_bulk(erp_client):
    _settle()
    a_item = _unique_name("BulkWastageA")
    b_item = _unique_name("BulkWastageB")

    save_a = _rpc(
        erp_client,
        "saveWastage",
        [{"date": "01/01/2026", "items": [{"name": a_item, "qty": 1, "unit": "Pcs", "reason": "R"}]}],
        mutation=True,
    )
    a_id = save_a.get_json()["data"]["wastageId"]

    # Second internal save -- needs its own settle to differ from a_id too.
    _settle()

    save_b = _rpc(
        erp_client,
        "saveWastage",
        [{"date": "01/01/2026", "items": [{"name": b_item, "qty": 1, "unit": "Pcs", "reason": "R"}]}],
        mutation=True,
    )
    b_id = save_b.get_json()["data"]["wastageId"]
    assert a_id != b_id

    resp = _rpc(erp_client, "deleteWastageBulk", [[a_id, b_id]], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getWastageData").get_json()["data"]
    ids = [w["wastageId"] for w in listed]
    assert a_id not in ids
    assert b_id not in ids


def test_vendor_rename_cascades_into_wastage_headers(erp_client):
    _settle()
    old_vendor = _unique_name("OldWastageVendor")
    new_vendor = _unique_name("NewWastageVendor")
    _rpc(erp_client, "saveVendor", [{"vendorName": old_vendor}], mutation=True)

    item = _unique_name("VendorCascadeWastageItem")
    save = _rpc(
        erp_client,
        "saveWastage",
        [{"date": "01/01/2026", "vendor": old_vendor, "items": [{"name": item, "qty": 1, "unit": "Pcs", "reason": "R"}]}],
        mutation=True,
    )
    wastage_id = save.get_json()["data"]["wastageId"]

    rename = _rpc(erp_client, "saveVendor", [{"vendorName": new_vendor, "originalVendorName": old_vendor}], mutation=True)
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getWastageData").get_json()["data"]
    match = next(w for w in listed if w["wastageId"] == wastage_id)
    assert match["vendor"] == new_vendor


def test_unit_rename_cascades_into_wastage_lines(erp_client):
    _settle()
    old_unit = _unique_name("OldWastageUnit")
    new_unit = _unique_name("NewWastageUnit")
    _rpc(erp_client, "saveUnit", [{"unitName": old_unit, "family": "Count", "factorToBase": 1}], mutation=True)

    item = _unique_name("UnitCascadeWastageItem")
    save = _rpc(
        erp_client,
        "saveWastage",
        [{"date": "01/01/2026", "items": [{"name": item, "qty": 1, "unit": old_unit, "reason": "R"}]}],
        mutation=True,
    )
    wastage_id = save.get_json()["data"]["wastageId"]

    rename = _rpc(erp_client, "saveUnit", [{"unitName": new_unit, "family": "Count", "factorToBase": 1, "originalUnitName": old_unit}], mutation=True)
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getWastageData").get_json()["data"]
    match = next(w for w in listed if w["wastageId"] == wastage_id)
    assert match["items"][0]["unit"] == new_unit


def test_wastage_subtracts_from_current_stock(erp_client):
    _settle()
    name = _unique_name("WastageStockItem")
    resp = _rpc(erp_client, "saveItem", [{"itemName": name, "itemInitialStock": 10}], mutation=True)
    assert resp.get_json()["success"] is True

    _rpc(
        erp_client,
        "saveWastage",
        [{"date": "01/01/2026", "items": [{"name": name, "qty": 4, "unit": "Pcs", "reason": "Damaged"}]}],
        mutation=True,
    )

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    match = next(r for r in listed if r["name"] == name)
    assert match["currentStock"] == 6  # 10 initial - 4 wasted
