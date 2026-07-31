"""Bill Ledger RPC tests, ported behavior from Apps_Script/module_bill.js."""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_get_bill_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getBillData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_bill_returns_fresh_row_for_in_place_patch(erp_client):
    vendor = _unique_name("Vendor")
    bill_number = _unique_name("INV")
    item1 = _unique_name("Item1")
    item2 = _unique_name("Item2")

    create = _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": item1, "qty": 5, "price": 2}]}],
        mutation=True,
    )
    create_body = create.get_json()
    assert create_body["data"]["bill"]["billNumber"] == bill_number
    assert create_body["data"]["bill"]["items"][0]["name"] == item1

    edit = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "existingVendor": vendor,
                "existingBillNumber": bill_number,
                "vendor": vendor,
                "billNumber": bill_number,
                "billDate": "01/01/2026",
                "items": [{"name": item2, "qty": 3, "price": 4}],
            }
        ],
        mutation=True,
    )
    edit_body = edit.get_json()
    fresh_bill = edit_body["data"]["bill"]
    assert fresh_bill["billNumber"] == bill_number
    assert fresh_bill["vendor"] == vendor
    assert len(fresh_bill["items"]) == 1
    assert fresh_bill["items"][0]["name"] == item2


def test_save_bill_rejects_zero_items(erp_client):
    resp = _rpc(erp_client, "saveBill", [{"vendor": "V", "billNumber": "B1", "billDate": "01/01/2026", "items": []}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "zero items" in body["message"]


def test_save_bill_creates_and_computes_totals_with_default_gst(erp_client):
    vendor = _unique_name("Hero MotoCorp")
    bill_number = _unique_name("INV")
    item = _unique_name("BrakePad")

    resp = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": bill_number,
                "billDate": "25/05/2026",
                "items": [{"name": item, "size": "Std", "qty": 10, "unit": "Pcs", "price": 100}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["billNumber"] == bill_number

    listed = _rpc(erp_client, "getBillData").get_json()["data"]
    match = next(b for b in listed if b["billNumber"] == bill_number and b["vendor"] == vendor)
    assert match["billDateRaw"] == "2026-05-25"
    # qty=10, price=100 -> subtotal=1000, default GST 18% -> lineTotal=1180
    assert match["items"][0]["gstRatePct"] == 18
    assert match["items"][0]["lineTotal"] == 1180
    assert match["totalAmount"] == 1180
    assert match["totalQty"] == 10


def test_save_bill_preserves_explicit_zero_gst(erp_client):
    vendor = _unique_name("ExemptVendor")
    bill_number = _unique_name("INV")
    resp = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": bill_number,
                "billDate": "01/01/2026",
                "items": [{"name": "X", "qty": 5, "price": 10, "gst": 0}],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getBillData").get_json()["data"]
    match = next(b for b in listed if b["billNumber"] == bill_number and b["vendor"] == vendor)
    assert match["items"][0]["gstRatePct"] == 0
    assert match["items"][0]["lineTotal"] == 50  # no GST added


def test_save_bill_same_bill_number_different_vendors_allowed(erp_client):
    bill_number = _unique_name("SharedNum")
    vendor_a = _unique_name("VendorA")
    vendor_b = _unique_name("VendorB")

    first = _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor_a, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": "X", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    second = _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor_b, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": "Y", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    assert first.get_json()["success"] is True
    assert second.get_json()["success"] is True


def test_save_bill_rejects_duplicate_vendor_bill_number_pair(erp_client):
    vendor = _unique_name("DupeVendor")
    bill_number = _unique_name("DupeBill")
    first = _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": "X", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    assert first.get_json()["success"] is True

    dupe = _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": "Y", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    body = dupe.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_save_bill_multi_po_per_bill(erp_client):
    vendor = _unique_name("MultiPoVendor")
    bill_number = _unique_name("MultiPoBill")
    resp = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": bill_number,
                "billDate": "01/01/2026",
                "items": [
                    {"name": "A", "qty": 1, "price": 1, "po": "1001"},
                    {"name": "B", "qty": 1, "price": 1, "po": "1002"},
                    {"name": "C", "qty": 1, "price": 1},  # no PO -> DIRECT
                ],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getBillData").get_json()["data"]
    match = next(b for b in listed if b["billNumber"] == bill_number and b["vendor"] == vendor)
    # 'DIRECT' is a legitimate per-line PO reference here, not a sentinel
    # filtered out of poNumbers -- getBillData tracks every non-blank
    # per-line value (that filtering only happens in the billed-qty
    # aggregation used for PO status, a different function).
    assert set(match["poNumbers"]) == {"1001", "1002", "DIRECT"}
    po_numbers_by_item = {i["name"]: i["poNumber"] for i in match["items"]}
    assert po_numbers_by_item["A"] == "1001"
    assert po_numbers_by_item["B"] == "1002"
    assert po_numbers_by_item["C"] == "DIRECT"


def test_save_bill_exclude_from_stock_keys_sets_affects_stock_false(erp_client):
    vendor = _unique_name("ExcludeVendor")
    bill_number = _unique_name("ExcludeBill")
    item = _unique_name("ExcludeItem")

    resp = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": bill_number,
                "billDate": "01/01/2026",
                "items": [{"name": item, "size": "", "qty": 1, "price": 1}],
                "excludeFromStockKeys": [f"{item.lower()}|"],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getBillData").get_json()["data"]
    match = next(b for b in listed if b["billNumber"] == bill_number and b["vendor"] == vendor)
    assert match["items"][0]["affectsStock"] is False


def test_save_bill_auto_extracts_vendor_item_and_rate_history(erp_client):
    vendor = _unique_name("AutoBillVendor")
    item = _unique_name("AutoBillItem")
    bill_number = _unique_name("AutoBill")

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": bill_number,
                "billDate": "01/01/2026",
                "contact": "5551234",
                "items": [{"name": item, "qty": 2, "unit": "Pcs", "price": 30}],
            }
        ],
        mutation=True,
    )

    vendors = _rpc(erp_client, "getVendorsData").get_json()["data"]
    assert any(v["name"] == vendor and v["contact"] == "5551234" for v in vendors)

    items = _rpc(erp_client, "getItemsData").get_json()["data"]
    imatch = next(i for i in items if i["name"] == item)
    assert any(v["vendor"] == vendor and v["rate"] == 30 for v in imatch["vendors"])


def test_save_bill_warns_when_billed_beyond_po_line(erp_client):
    """_compute_bill_overage_warnings: an advisory, non-blocking warning
    appended to the save message when a line's cumulative billed base qty
    now exceeds what was ordered -- bills are allowed to exceed a PO
    (freight corrections, renegotiated quantities), this only surfaces it.
    """
    vendor = _unique_name("OverageVendor")
    item = _unique_name("OverageItem")

    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": item, "size": "", "qty": 5, "unit": "Pcs", "price": 1}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    within = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("WithinBill"),
                "billDate": "01/01/2026",
                "items": [{"name": item, "size": "", "qty": 3, "price": 1, "po": po_number}],
            }
        ],
        mutation=True,
    )
    assert "warning" not in within.get_json()["message"].lower()

    over = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("OverBill"),
                "billDate": "02/01/2026",
                "items": [{"name": item, "size": "", "qty": 4, "price": 1, "po": po_number}],
            }
        ],
        mutation=True,
    )
    over_body = over.get_json()
    assert over_body["success"] is True
    assert "Warning" in over_body["message"]
    assert po_number in over_body["message"]
    assert "2.00 over" in over_body["message"]  # 3 + 4 = 7 billed vs 5 ordered


def test_delete_bill_success_and_not_found(erp_client):
    vendor = _unique_name("DeleteBillVendor")
    bill_number = _unique_name("DeleteBill")
    _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": "X", "qty": 1, "price": 1}]}],
        mutation=True,
    )

    deleted = _rpc(erp_client, "deleteBill", [vendor, bill_number], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getBillData").get_json()["data"]
    assert not any(b["billNumber"] == bill_number and b["vendor"] == vendor for b in listed)

    missing = _rpc(erp_client, "deleteBill", [vendor, bill_number], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_bills_bulk(erp_client):
    vendor = _unique_name("BulkBillVendor")
    a = _unique_name("BulkBillA")
    b = _unique_name("BulkBillB")
    _rpc(erp_client, "saveBill", [{"vendor": vendor, "billNumber": a, "billDate": "01/01/2026", "items": [{"name": "X", "qty": 1, "price": 1}]}], mutation=True)
    _rpc(erp_client, "saveBill", [{"vendor": vendor, "billNumber": b, "billDate": "01/01/2026", "items": [{"name": "Y", "qty": 1, "price": 1}]}], mutation=True)

    resp = _rpc(erp_client, "deleteBillsBulk", [[{"vendor": vendor, "billNumber": a}, {"vendor": vendor, "billNumber": b}]], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getBillData").get_json()["data"]
    numbers = [bill["billNumber"] for bill in listed if bill["vendor"] == vendor]
    assert a not in numbers
    assert b not in numbers


def test_vendor_rename_cascades_into_bill_headers(erp_client):
    old_vendor = _unique_name("OldBillVendor")
    new_vendor = _unique_name("NewBillVendor")
    _rpc(erp_client, "saveVendor", [{"vendorName": old_vendor}], mutation=True)

    bill_number = _unique_name("CascadeBill")
    _rpc(
        erp_client,
        "saveBill",
        [{"vendor": old_vendor, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": "X", "qty": 1, "price": 1}]}],
        mutation=True,
    )

    rename = _rpc(erp_client, "saveVendor", [{"vendorName": new_vendor, "originalVendorName": old_vendor}], mutation=True)
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getBillData").get_json()["data"]
    assert any(b["billNumber"] == bill_number and b["vendor"] == new_vendor for b in listed)


def test_item_rename_cascades_into_bill_lines(erp_client):
    old_item = _unique_name("OldBillItem")
    new_item = _unique_name("NewBillItem")
    _rpc(erp_client, "saveItem", [{"itemName": old_item, "itemSize": "M"}], mutation=True)

    vendor = _unique_name("V")
    bill_number = _unique_name("ItemCascadeBill")
    _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": old_item, "size": "M", "qty": 1, "price": 1}]}],
        mutation=True,
    )

    rename = _rpc(
        erp_client,
        "saveItem",
        [{"itemName": new_item, "itemSize": "M", "originalName": old_item, "originalSize": "M"}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getBillData").get_json()["data"]
    match = next(b for b in listed if b["billNumber"] == bill_number and b["vendor"] == vendor)
    assert match["items"][0]["name"] == new_item


# ── Labor Job bills (GAS c63771d / 9eba5a8) ─────────────────────────────
# billType 'LABOR' lines carry a Process (server-resolved, item_name forced
# to that process's Output Item Name) and an optional Color, plus
# header-level Issuing Party / Manufacturing Vendor.


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


def test_save_labor_bill_resolves_process_and_forces_output_item_name(erp_client):
    process_payload, _process_id = _save_process(erp_client)
    contractor = _unique_name("Contractor")
    bill_number = _unique_name("LABOR")

    resp = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "billType": "LABOR",
                "vendor": contractor,
                "billNumber": bill_number,
                "billDate": "01/01/2026",
                "issuingParty": "Issuing Co",
                "manufacturingVendor": "Mfg Co",
                "items": [{"processName": process_payload["processName"], "color": "Black", "qty": 10, "price": 5}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    bill = body["data"]["bill"]
    assert bill["billType"] == "LABOR"
    assert bill["issuingParty"] == "Issuing Co"
    assert bill["manufacturingVendor"] == "Mfg Co"
    line = bill["items"][0]
    # item_name is forced to the process's own Output Item Name, never
    # whatever the client sent -- same "server owns the canonical value"
    # rule save_production applies.
    assert line["name"] == process_payload["outputItemName"]
    assert line["processName"] == process_payload["processName"]
    assert line["color"] == "Black"
    assert line["billType"] == "LABOR"


def test_save_labor_bill_rejects_unrecognized_process(erp_client):
    resp = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "billType": "LABOR",
                "vendor": _unique_name("Contractor"),
                "billNumber": _unique_name("LABOR"),
                "billDate": "01/01/2026",
                "items": [{"processName": "Not A Real Process", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "not a recognized active Process" in body["message"]


def test_save_labor_bill_rejects_inactive_process(erp_client):
    process_payload, _process_id = _save_process(erp_client, active=False)
    resp = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "billType": "LABOR",
                "vendor": _unique_name("Contractor"),
                "billNumber": _unique_name("LABOR"),
                "billDate": "01/01/2026",
                "items": [{"processName": process_payload["processName"], "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "not a recognized active Process" in body["message"]


def test_goods_bill_defaults_stay_unaffected_by_labor_columns(erp_client):
    vendor = _unique_name("Vendor")
    bill_number = _unique_name("GOODS")
    item = _unique_name("Item")

    resp = _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": item, "qty": 1, "price": 1}]}],
        mutation=True,
    )
    bill = resp.get_json()["data"]["bill"]
    assert bill["billType"] == "GOODS"
    assert bill["issuingParty"] == ""
    assert bill["manufacturingVendor"] == ""
    line = bill["items"][0]
    assert line["billType"] == "GOODS"
    assert line["processName"] == ""
    assert line["color"] == ""


def test_labor_bill_survives_edit_round_trip(erp_client):
    process_payload, _process_id = _save_process(erp_client)
    contractor = _unique_name("Contractor")
    bill_number = _unique_name("LABOR")

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "billType": "LABOR",
                "vendor": contractor,
                "billNumber": bill_number,
                "billDate": "01/01/2026",
                "issuingParty": "Original Issuer",
                "items": [{"processName": process_payload["processName"], "color": "Blue", "qty": 5, "price": 2}],
            }
        ],
        mutation=True,
    )

    edit = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "existingVendor": contractor,
                "existingBillNumber": bill_number,
                "billType": "LABOR",
                "vendor": contractor,
                "billNumber": bill_number,
                "billDate": "01/01/2026",
                "issuingParty": "Updated Issuer",
                "items": [{"processName": process_payload["processName"], "color": "Red", "qty": 8, "price": 3}],
            }
        ],
        mutation=True,
    )
    body = edit.get_json()
    assert body["success"] is True, body["message"]
    bill = body["data"]["bill"]
    assert bill["issuingParty"] == "Updated Issuer"
    assert bill["items"][0]["color"] == "Red"
    assert bill["items"][0]["qty"] == 8


def test_bill_search_haystack_covers_labor_fields(erp_client):
    """getBillData's list is what the client search-filters -- process
    name and color must be retrievable so App.Bill.applyFilters's haystack
    (which includes them) actually has something to match against.
    """
    process_payload, _process_id = _save_process(erp_client)
    bill_number = _unique_name("LABOR")
    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "billType": "LABOR",
                "vendor": _unique_name("Contractor"),
                "billNumber": bill_number,
                "billDate": "01/01/2026",
                "items": [{"processName": process_payload["processName"], "color": "Kraft", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getBillData").get_json()["data"]
    match = next(b for b in listed if b["billNumber"] == bill_number)
    assert match["items"][0]["processName"] == process_payload["processName"]
    assert match["items"][0]["color"] == "Kraft"
