"""PO Tracker RPC tests, ported behavior from Apps_Script/module_po.js."""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_get_po_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getPOData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_po_rejects_zero_items(erp_client):
    resp = _rpc(erp_client, "savePO", [{"vendor": "Anyone", "items": []}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "zero items" in body["message"]


def test_save_po_creates_with_sequence_generated_number(erp_client):
    vendor = _unique_name("Hero MotoCorp")
    item = _unique_name("Chain Sprocket")
    resp = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "contact": "Ludhiana", "items": [{"name": item, "size": "Std", "qty": 10, "unit": "Pcs", "price": 5}]}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    po_number = body["data"]["poNumber"]
    assert int(po_number) >= 1001

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert match["vendor"] == vendor
    assert match["grandTotal"] == 50
    assert match["totalQty"] == 10
    assert match["status"] == "PO Issued"
    assert match["items"][0]["name"] == item


def test_save_po_edit_replaces_lines_and_preserves_date_when_omitted(erp_client):
    vendor = _unique_name("Vendor")
    item1 = _unique_name("Item1")
    item2 = _unique_name("Item2")

    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/01/2026", "items": [{"name": item1, "qty": 5, "price": 2}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    edit = _rpc(
        erp_client,
        "savePO",
        [{"existingPoNumber": po_number, "vendor": vendor, "items": [{"name": item2, "qty": 3, "price": 4}]}],
        mutation=True,
    )
    body = edit.get_json()
    assert body["success"] is True

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert len(match["items"]) == 1
    assert match["items"][0]["name"] == item2
    assert match["poDateRaw"] == "2026-01-01"  # preserved, not overwritten to today


def test_save_po_renumber_collision_is_rejected(erp_client):
    vendor = _unique_name("Vendor")
    first = _rpc(erp_client, "savePO", [{"vendor": vendor, "items": [{"name": "A", "qty": 1, "price": 1}]}], mutation=True)
    second = _rpc(erp_client, "savePO", [{"vendor": vendor, "items": [{"name": "B", "qty": 1, "price": 1}]}], mutation=True)
    first_num = first.get_json()["data"]["poNumber"]
    second_num = second.get_json()["data"]["poNumber"]

    collide = _rpc(
        erp_client,
        "savePO",
        [{"existingPoNumber": second_num, "poNumber": first_num, "vendor": vendor, "items": [{"name": "B", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    body = collide.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_save_po_auto_extracts_vendor_and_item(erp_client):
    vendor = _unique_name("AutoVendor")
    item = _unique_name("AutoItem")

    _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "contact": "9999999999", "items": [{"name": item, "size": "L", "qty": 2, "unit": "Pcs", "price": 25}]}],
        mutation=True,
    )

    vendors = _rpc(erp_client, "getVendorsData").get_json()["data"]
    vmatch = next(v for v in vendors if v["name"] == vendor)
    assert vmatch["contact"] == "9999999999"

    items = _rpc(erp_client, "getItemsData").get_json()["data"]
    imatch = next(i for i in items if i["name"] == item)
    assert imatch["baseUnit"] == "Pcs"
    assert imatch["purchaseUnit"] == "Pcs"
    assert any(v["vendor"] == vendor and v["rate"] == 25 for v in imatch["vendors"])


def test_save_po_skips_extraction_for_line_below_min_vendor_rate(erp_client):
    vendor = _unique_name("ZeroRateVendor")
    item = _unique_name("ZeroRateItem")

    resp = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": item, "qty": 1, "price": 0}]}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    # The PO line itself still saves...
    po_number = resp.get_json()["data"]["poNumber"]
    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert match["items"][0]["name"] == item

    # ...and the vendor is still registered (vendor upsert in the source
    # happens once, unconditionally, before the per-line rate check)...
    vendors = _rpc(erp_client, "getVendorsData").get_json()["data"]
    assert vendor in [v["name"] for v in vendors]

    # ...but no item/rate-history extraction happened for this line, since
    # only the item-upsert half is gated by MIN_VENDOR_RATE per line.
    items = _rpc(erp_client, "getItemsData").get_json()["data"]
    assert item not in [i["name"] for i in items]


def test_delete_po_success_and_not_found(erp_client):
    vendor = _unique_name("DeleteVendor")
    create = _rpc(erp_client, "savePO", [{"vendor": vendor, "items": [{"name": "X", "qty": 1, "price": 1}]}], mutation=True)
    po_number = create.get_json()["data"]["poNumber"]

    deleted = _rpc(erp_client, "deletePO", [po_number], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    assert po_number not in [po["poNumber"] for po in listed]

    missing = _rpc(erp_client, "deletePO", [po_number], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_pos_bulk(erp_client):
    vendor = _unique_name("BulkVendor")
    a = _rpc(erp_client, "savePO", [{"vendor": vendor, "items": [{"name": "A", "qty": 1, "price": 1}]}], mutation=True)
    b = _rpc(erp_client, "savePO", [{"vendor": vendor, "items": [{"name": "B", "qty": 1, "price": 1}]}], mutation=True)
    a_num = a.get_json()["data"]["poNumber"]
    b_num = b.get_json()["data"]["poNumber"]

    resp = _rpc(erp_client, "deletePOsBulk", [[a_num, b_num]], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    numbers = [po["poNumber"] for po in listed]
    assert a_num not in numbers
    assert b_num not in numbers


def test_vendor_rename_cascades_into_po_headers(erp_client):
    old_vendor = _unique_name("OldPoVendor")
    new_vendor = _unique_name("NewPoVendor")
    _rpc(erp_client, "saveVendor", [{"vendorName": old_vendor}], mutation=True)

    create = _rpc(erp_client, "savePO", [{"vendor": old_vendor, "items": [{"name": "X", "qty": 1, "price": 1}]}], mutation=True)
    po_number = create.get_json()["data"]["poNumber"]

    rename = _rpc(erp_client, "saveVendor", [{"vendorName": new_vendor, "originalVendorName": old_vendor}], mutation=True)
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert match["vendor"] == new_vendor


def test_item_rename_cascades_into_po_lines(erp_client):
    old_item = _unique_name("OldPoItem")
    new_item = _unique_name("NewPoItem")
    _rpc(erp_client, "saveItem", [{"itemName": old_item, "itemSize": "M"}], mutation=True)

    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": _unique_name("V"), "items": [{"name": old_item, "size": "M", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    rename = _rpc(
        erp_client,
        "saveItem",
        [{"itemName": new_item, "itemSize": "M", "originalName": old_item, "originalSize": "M"}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert match["items"][0]["name"] == new_item
