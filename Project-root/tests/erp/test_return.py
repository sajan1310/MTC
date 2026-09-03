"""Return Ledger RPC tests, ported behavior from Apps_Script/module_return.js."""

from __future__ import annotations

import re
import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_get_return_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getReturnData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_return_rejects_zero_items(erp_client):
    resp = _rpc(
        erp_client,
        "saveReturn",
        [{"vendor": "V", "returnDate": "01/01/2026", "items": []}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "zero items" in body["message"]


def test_save_return_auto_generates_return_number(erp_client):
    vendor = _unique_name("ReturnVendor")
    resp = _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnDate": "01/01/2026",
                "items": [{"name": "X", "qty": 2, "price": 5, "reason": "Defective"}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert re.match(r"^RET-\d{8}-\d{6}$", body["data"]["returnNumber"])


def test_save_return_returns_fresh_row_for_in_place_patch(erp_client):
    vendor = _unique_name("Vendor")
    return_number = _unique_name("RET")
    item1 = _unique_name("Item1")
    item2 = _unique_name("Item2")

    create = _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnNumber": return_number,
                "returnDate": "01/01/2026",
                "items": [{"name": item1, "qty": 5, "price": 2}],
            }
        ],
        mutation=True,
    )
    create_body = create.get_json()
    assert create_body["data"]["ret"]["returnNumber"] == return_number
    assert create_body["data"]["ret"]["items"][0]["name"] == item1

    edit = _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "existingReturnNumber": return_number,
                "returnNumber": return_number,
                "vendor": vendor,
                "returnDate": "01/01/2026",
                "items": [{"name": item2, "qty": 3, "price": 4}],
            }
        ],
        mutation=True,
    )
    edit_body = edit.get_json()
    fresh_return = edit_body["data"]["ret"]
    assert fresh_return["returnNumber"] == return_number
    assert fresh_return["vendor"] == vendor
    assert len(fresh_return["items"]) == 1
    assert fresh_return["items"][0]["name"] == item2


def test_save_return_with_explicit_number_and_computes_totals(erp_client):
    vendor = _unique_name("ExplicitReturnVendor")
    return_number = _unique_name("RET")
    item = _unique_name("ReturnItem")

    resp = _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnNumber": return_number,
                "returnDate": "15/03/2026",
                "billNumber": "INV-100",
                "items": [
                    {
                        "name": item,
                        "size": "L",
                        "qty": 3,
                        "price": 10,
                        "reason": "Excess",
                    }
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["returnNumber"] == return_number

    listed = _rpc(erp_client, "getReturnData").get_json()["data"]
    match = next(r for r in listed if r["returnNumber"] == return_number)
    assert match["returnDateRaw"] == "2026-03-15"
    assert match["billNumber"] == "INV-100"
    assert match["items"][0]["lineTotal"] == 30  # no GST
    assert match["totalAmount"] == 30
    assert match["items"][0]["reason"] == "Excess"


def test_save_return_qty_zero_rejected_but_price_zero_allowed(erp_client):
    # Explicit return numbers -- the auto-generated RET-<date>-<time> scheme
    # only has second-level precision (matches the source exactly), so two
    # rapid saves without one could otherwise collide with each other.
    vendor = _unique_name("ZeroQtyVendor")
    zero_qty_resp = _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnNumber": _unique_name("ZeroQty"),
                "returnDate": "01/01/2026",
                "items": [{"name": "X", "qty": 0, "price": 5}],
            }
        ],
        mutation=True,
    )
    assert zero_qty_resp.get_json()["success"] is False

    zero_price_resp = _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnNumber": _unique_name("ZeroPrice"),
                "returnDate": "01/01/2026",
                "items": [{"name": "X", "qty": 1, "price": 0}],
            }
        ],
        mutation=True,
    )
    assert zero_price_resp.get_json()["success"] is True


def test_save_return_rejects_duplicate_return_number_globally(erp_client):
    return_number = _unique_name("DupeReturn")
    vendor_a = _unique_name("VendorA")
    vendor_b = _unique_name("VendorB")

    first = _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor_a,
                "returnNumber": return_number,
                "returnDate": "01/01/2026",
                "items": [{"name": "X", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )
    assert first.get_json()["success"] is True

    # Unlike Bill (unique per vendor), Return numbers are globally unique --
    # even a different vendor reusing the same number is rejected.
    dupe = _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor_b,
                "returnNumber": return_number,
                "returnDate": "01/01/2026",
                "items": [{"name": "Y", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )
    body = dupe.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_save_return_requires_date(erp_client):
    resp = _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": "V",
                "returnDate": "not a date",
                "items": [{"name": "X", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "date" in body["message"].lower()


def test_delete_return_success_and_not_found(erp_client):
    vendor = _unique_name("DeleteReturnVendor")
    return_number = _unique_name("DeleteReturn")
    _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnNumber": return_number,
                "returnDate": "01/01/2026",
                "items": [{"name": "X", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )

    deleted = _rpc(erp_client, "deleteReturn", [return_number], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getReturnData").get_json()["data"]
    assert not any(r["returnNumber"] == return_number for r in listed)

    missing = _rpc(erp_client, "deleteReturn", [return_number], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_returns_bulk(erp_client):
    vendor = _unique_name("BulkReturnVendor")
    a = _unique_name("BulkReturnA")
    b = _unique_name("BulkReturnB")
    _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnNumber": a,
                "returnDate": "01/01/2026",
                "items": [{"name": "X", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnNumber": b,
                "returnDate": "01/01/2026",
                "items": [{"name": "Y", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteReturnsBulk", [[a, b]], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getReturnData").get_json()["data"]
    numbers = [r["returnNumber"] for r in listed]
    assert a not in numbers
    assert b not in numbers


def test_item_rename_cascades_into_return_lines(erp_client):
    old_item = _unique_name("OldReturnItem")
    new_item = _unique_name("NewReturnItem")
    vendor = _unique_name("ItemCascadeReturnVendor")
    _rpc(
        erp_client, "saveItem", [{"itemName": old_item, "itemSize": "M"}], mutation=True
    )

    return_number = _unique_name("ItemCascadeReturn")
    _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnNumber": return_number,
                "returnDate": "01/01/2026",
                "items": [{"name": old_item, "size": "M", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )

    rename = _rpc(
        erp_client,
        "saveItem",
        [
            {
                "itemName": new_item,
                "itemSize": "M",
                "originalName": old_item,
                "originalSize": "M",
            }
        ],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getReturnData").get_json()["data"]
    match = next(r for r in listed if r["returnNumber"] == return_number)
    assert match["items"][0]["name"] == new_item


def test_vendor_rename_cascades_into_return_headers(erp_client):
    old_vendor = _unique_name("OldReturnVendor")
    new_vendor = _unique_name("NewReturnVendor")
    _rpc(erp_client, "saveVendor", [{"vendorName": old_vendor}], mutation=True)

    return_number = _unique_name("CascadeReturn")
    _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": old_vendor,
                "returnNumber": return_number,
                "returnDate": "01/01/2026",
                "items": [{"name": "X", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )

    rename = _rpc(
        erp_client,
        "saveVendor",
        [{"vendorName": new_vendor, "originalVendorName": old_vendor}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getReturnData").get_json()["data"]
    match = next(r for r in listed if r["returnNumber"] == return_number)
    assert match["vendor"] == new_vendor
