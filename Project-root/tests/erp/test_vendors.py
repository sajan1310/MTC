"""Vendors master RPC tests, ported behavior from Apps_Script/module_vendors.js."""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_get_vendors_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getVendorsData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_vendor_creates_and_lists_it(erp_client):
    name = _unique_name("Acme Traders")
    resp = _rpc(
        erp_client,
        "saveVendor",
        [{"vendorName": name, "contact": "9876543210", "address": "1 Main St", "gstin": "GST123", "remarks": "test"}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["name"] == name

    listed = _rpc(erp_client, "getVendorsData").get_json()["data"]
    match = next(v for v in listed if v["name"] == name)
    assert match["contact"] == "9876543210"
    assert match["gstin"] == "GST123"


def test_save_vendor_rejects_case_insensitive_duplicate(erp_client):
    name = _unique_name("Bolt Supply")
    first = _rpc(erp_client, "saveVendor", [{"vendorName": name}], mutation=True)
    assert first.get_json()["success"] is True

    dupe = _rpc(erp_client, "saveVendor", [{"vendorName": name.upper()}], mutation=True)
    body = dupe.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_save_vendor_rename_via_original_vendor_name(erp_client):
    original = _unique_name("Original Vendor")
    renamed = _unique_name("Renamed Vendor")

    _rpc(erp_client, "saveVendor", [{"vendorName": original}], mutation=True)

    edit = _rpc(
        erp_client,
        "saveVendor",
        [{"vendorName": renamed, "originalVendorName": original}],
        mutation=True,
    )
    body = edit.get_json()
    assert body["success"] is True
    assert body["data"]["name"] == renamed

    listed = _rpc(erp_client, "getVendorsData").get_json()["data"]
    names = [v["name"] for v in listed]
    assert renamed in names
    assert original not in names


def test_delete_vendor_success_and_not_found(erp_client):
    name = _unique_name("Deletable Vendor")
    _rpc(erp_client, "saveVendor", [{"vendorName": name}], mutation=True)

    deleted = _rpc(erp_client, "deleteVendor", [name], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getVendorsData").get_json()["data"]
    assert name not in [v["name"] for v in listed]

    missing = _rpc(erp_client, "deleteVendor", [name], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_vendors_bulk(erp_client):
    a = _unique_name("BulkVendorA")
    b = _unique_name("BulkVendorB")
    _rpc(erp_client, "saveVendor", [{"vendorName": a}], mutation=True)
    _rpc(erp_client, "saveVendor", [{"vendorName": b}], mutation=True)

    resp = _rpc(erp_client, "deleteVendorsBulk", [[a, b]], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getVendorsData").get_json()["data"]
    names = [v["name"] for v in listed]
    assert a not in names
    assert b not in names


def test_vendor_rename_cascades_into_item_vendors(erp_client):
    """Confirms the vendor rename cascade actually reaches erp.item_vendors
    -- the one real target this round (every other target is a guarded
    no-op since PO/Bill/Return/Wastage/BOM don't exist yet).
    """
    old_vendor = _unique_name("OldVendorName")
    new_vendor = _unique_name("NewVendorName")
    _rpc(erp_client, "saveVendor", [{"vendorName": old_vendor}], mutation=True)

    item_name = _unique_name("VendorCascadeItem")
    _rpc(
        erp_client,
        "saveItem",
        [{"itemName": item_name, "vendors": [{"vendor": old_vendor, "rate": 42}]}],
        mutation=True,
    )

    rename = _rpc(
        erp_client,
        "saveVendor",
        [{"vendorName": new_vendor, "originalVendorName": old_vendor}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    items = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in items if i["name"] == item_name)
    assert match["vendors"][0]["vendor"] == new_vendor
    assert match["vendors"][0]["rate"] == 42
