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


def test_save_po_returns_fresh_row_for_in_place_patch(erp_client):
    vendor = _unique_name("Vendor")
    item1 = _unique_name("Item1")
    item2 = _unique_name("Item2")

    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": item1, "qty": 5, "price": 2}]}],
        mutation=True,
    )
    create_body = create.get_json()
    po_number = create_body["data"]["poNumber"]
    assert create_body["data"]["po"]["poNumber"] == po_number
    assert create_body["data"]["po"]["items"][0]["name"] == item1

    edit = _rpc(
        erp_client,
        "savePO",
        [{"existingPoNumber": po_number, "vendor": vendor, "items": [{"name": item2, "qty": 3, "price": 4}]}],
        mutation=True,
    )
    edit_body = edit.get_json()
    fresh_po = edit_body["data"]["po"]
    assert fresh_po["poNumber"] == po_number
    assert fresh_po["vendor"] == vendor
    assert len(fresh_po["items"]) == 1
    assert fresh_po["items"][0]["name"] == item2
    assert fresh_po["status"] == "PO Issued"


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


def test_bill_against_po_line_flips_status(erp_client):
    """First real exercise of _attach_po_status's actual formula (Phase 2c)
    -- every PO before this round could only ever show the 'PO Issued'
    stub, since billed_map was always {}.
    """
    vendor = _unique_name("StatusVendor")
    item = _unique_name("StatusItem")

    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": item, "size": "", "qty": 10, "unit": "Pcs", "price": 1}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert match["status"] == "PO Issued"

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("PartialBill"),
                "billDate": "01/01/2026",
                "items": [{"name": item, "size": "", "qty": 4, "price": 1, "po": po_number}],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert match["status"] == "Partially Received"
    assert match["items"][0]["receivedQty"] == 4
    assert match["items"][0]["pendingQty"] == 6

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("FinalBill"),
                "billDate": "02/01/2026",
                "items": [{"name": item, "size": "", "qty": 6, "price": 1, "po": po_number}],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert match["status"] == "Completed"
    assert match["items"][0]["pendingQty"] == 0


def test_pending_qty_goes_negative_when_billed_beyond_ordered(erp_client):
    """pendingQty is no longer clamped to 0 -- a line billed beyond what
    was ordered must surface as a negative value, not silently read as
    "fully pending is 0" (see save_bill's advisory overage warning, which
    depends on this staying unclamped).
    """
    vendor = _unique_name("OverbillVendor")
    item = _unique_name("OverbillItem")

    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": item, "size": "", "qty": 5, "unit": "Pcs", "price": 1}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("OverBill"),
                "billDate": "01/01/2026",
                "items": [{"name": item, "size": "", "qty": 8, "price": 1, "po": po_number}],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert match["items"][0]["receivedQty"] == 8
    assert match["items"][0]["pendingQty"] == -3


# ─────────────────────────────────────────────────────────────────────────
# suggestPoAllocations (Phase 2e)
# ─────────────────────────────────────────────────────────────────────────


def test_suggest_po_allocations_no_vendor_or_items_returns_empty(erp_client):
    resp = _rpc(erp_client, "suggestPoAllocations", ["", [{"name": "X", "qty": 1}], "01/01/2026"])
    assert resp.get_json()["data"] == []

    resp2 = _rpc(erp_client, "suggestPoAllocations", [_unique_name("V"), [], "01/01/2026"])
    assert resp2.get_json()["data"] == []


def test_suggest_po_allocations_no_open_pos_for_vendor_returns_empty(erp_client):
    vendor = _unique_name("NoPoVendor")
    resp = _rpc(erp_client, "suggestPoAllocations", [vendor, [{"name": "X", "qty": 1, "price": 1}], None])
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"] == []


def test_suggest_po_allocations_excludes_po_dated_after_bill_date(erp_client):
    vendor = _unique_name("FutureVendor")
    item = _unique_name("FutureItem")
    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/06/2026", "items": [{"name": item, "qty": 10, "price": 5}]}],
        mutation=True,
    )
    assert create.get_json()["success"] is True

    # Bill dated BEFORE the PO -> the PO can't be fulfilling it yet, excluded.
    # With zero candidate POs left for this vendor, the source short-circuits
    # to a flat empty list (not per-row unmatched entries) -- matches
    # suggestPoAllocations's own `if (vendorPOs.length === 0) return [];`.
    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [vendor, [{"rowIndex": 0, "name": item, "qty": 5, "price": 5}], "01/01/2026"],
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"] == []


def test_suggest_po_allocations_exact_match_single_po(erp_client):
    vendor = _unique_name("ExactVendor")
    item = _unique_name("ExactItem")
    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/01/2026", "items": [{"name": item, "qty": 10, "unit": "Pcs", "price": 5}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [vendor, [{"rowIndex": 0, "name": item, "qty": 10, "unit": "Pcs", "price": 5}], "02/01/2026"],
    )
    result = resp.get_json()["data"][0]
    assert result["allocations"] == [{"poNumber": po_number, "qty": 10}]
    assert result["unmatchedQty"] == 0


def test_suggest_po_allocations_splits_across_two_pos_oldest_first(erp_client):
    vendor = _unique_name("SplitVendor")
    item = _unique_name("SplitItem")

    first = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/01/2026", "items": [{"name": item, "qty": 4, "price": 5}]}],
        mutation=True,
    )
    second = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "05/01/2026", "items": [{"name": item, "qty": 10, "price": 5}]}],
        mutation=True,
    )
    first_num = first.get_json()["data"]["poNumber"]
    second_num = second.get_json()["data"]["poNumber"]

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [vendor, [{"rowIndex": 0, "name": item, "qty": 9, "price": 5}], "10/01/2026"],
    )
    result = resp.get_json()["data"][0]
    assert result["allocations"] == [
        {"poNumber": first_num, "qty": 4},
        {"poNumber": second_num, "qty": 5},
    ]
    assert result["unmatchedQty"] == 0


def test_suggest_po_allocations_excludes_fully_billed_po_lines(erp_client):
    vendor = _unique_name("FullyBilledVendor")
    item = _unique_name("FullyBilledItem")
    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/01/2026", "items": [{"name": item, "qty": 5, "price": 5}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("FullBill"),
                "billDate": "02/01/2026",
                "items": [{"name": item, "qty": 5, "price": 5, "po": po_number}],
            }
        ],
        mutation=True,
    )

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [vendor, [{"rowIndex": 0, "name": item, "qty": 3, "price": 5}], "03/01/2026"],
    )
    result = resp.get_json()["data"][0]
    assert result["allocations"] == []
    assert result["unmatchedQty"] == 3


def test_suggest_po_allocations_narration_disambiguates(erp_client):
    vendor = _unique_name("NarrationVendor")
    item = _unique_name("NarrationItem")

    po_a = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/01/2026", "items": [{"name": item, "narration": "Red", "qty": 5, "price": 5}]}],
        mutation=True,
    )
    po_b = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/01/2026", "items": [{"name": item, "narration": "Blue", "qty": 5, "price": 5}]}],
        mutation=True,
    )
    po_b_num = po_b.get_json()["data"]["poNumber"]
    assert po_a.get_json()["success"] is True

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [vendor, [{"rowIndex": 0, "name": item, "narration": "Blue", "qty": 5, "price": 5}], "02/01/2026"],
    )
    result = resp.get_json()["data"][0]
    assert result["allocations"] == [{"poNumber": po_b_num, "qty": 5}]


def test_suggest_po_allocations_price_mismatch_flags_rate_conflict_but_still_allocates(erp_client):
    vendor = _unique_name("RateConflictVendor")
    item = _unique_name("RateConflictItem")
    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/01/2026", "items": [{"name": item, "qty": 5, "price": 20}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [vendor, [{"rowIndex": 0, "name": item, "qty": 5, "price": 25}], "02/01/2026"],
    )
    result = resp.get_json()["data"][0]
    assert result["allocations"][0]["poNumber"] == po_number
    assert result["allocations"][0]["qty"] == 5
    assert result["allocations"][0]["rateConflict"] == {"poRate": 20, "poUnit": "Pcs", "billRate": 25, "billUnit": "Pcs"}


def test_suggest_po_allocations_shared_candidate_not_double_allocated(erp_client):
    vendor = _unique_name("SharedCandidateVendor")
    item = _unique_name("SharedCandidateItem")
    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/01/2026", "items": [{"name": item, "qty": 5, "price": 5}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [
            vendor,
            [
                {"rowIndex": 0, "name": item, "qty": 3, "price": 5},
                {"rowIndex": 1, "name": item, "qty": 3, "price": 5},
            ],
            "02/01/2026",
        ],
    )
    results = resp.get_json()["data"]
    first_row = next(r for r in results if r["rowIndex"] == 0)
    second_row = next(r for r in results if r["rowIndex"] == 1)
    assert first_row["allocations"] == [{"poNumber": po_number, "qty": 3}]
    assert first_row["unmatchedQty"] == 0
    # Only 2 units left after the first row claimed 3 of the 5 available.
    assert second_row["allocations"] == [{"poNumber": po_number, "qty": 2}]
    assert second_row["unmatchedQty"] == 1


# ── PO/Bill line narration -> Items Master Remarks redirect (GAS 7da086a) ──


def test_po_line_narration_seeds_narration_on_new_item(erp_client):
    """A brand-new item auto-created by a PO line still seeds its
    Narration from the line -- it would otherwise have none at all for
    Production to resolve against.
    """
    vendor = _unique_name("NarrationSeedVendor")
    item = _unique_name("NarrationSeedItem")

    _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/01/2026", "items": [{"name": item, "narration": "Initial desc", "qty": 5, "price": 5}]}],
        mutation=True,
    )

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in listed if i["name"] == item)
    assert match["narration"] == "Initial desc"
    assert match["remarks"] == ""


def test_po_line_narration_overwrites_remarks_not_narration_on_existing_item(erp_client):
    """A later PO line's narration for an item that already exists
    overwrites Items Master REMARKS (so Remarks tracks the latest
    purchase-side description) but leaves NARRATION -- the
    hand-maintained note Production prints and resolves against --
    untouched.
    """
    vendor = _unique_name("NarrationRedirectVendor")
    item = _unique_name("NarrationRedirectItem")

    _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "01/01/2026", "items": [{"name": item, "narration": "First desc", "qty": 5, "price": 5}]}],
        mutation=True,
    )
    original = next(i for i in _rpc(erp_client, "getItemsData").get_json()["data"] if i["name"] == item)
    assert original["narration"] == "First desc"

    _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "poDate": "02/01/2026", "items": [{"name": item, "narration": "Updated vendor desc", "qty": 3, "price": 5}]}],
        mutation=True,
    )

    updated = next(i for i in _rpc(erp_client, "getItemsData").get_json()["data"] if i["name"] == item)
    assert updated["remarks"] == "Updated vendor desc"
    assert updated["narration"] == "First desc", "hand-maintained Narration must survive a later purchase description"


def test_bill_line_narration_also_redirects_to_remarks(erp_client):
    """The redirect applies to Bill lines too -- both PO and Bill share
    the autoExtractFromPoOrBill hook (items_service._auto_extract_item).
    """
    vendor = _unique_name("BillNarrationVendor")
    item = _unique_name("BillNarrationItem")

    _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor, "billNumber": _unique_name("BILL"), "billDate": "01/01/2026", "items": [{"name": item, "narration": "Bill desc", "qty": 2, "price": 5}]}],
        mutation=True,
    )

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in listed if i["name"] == item)
    assert match["narration"] == "Bill desc"
    assert match["remarks"] == ""

    _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor, "billNumber": _unique_name("BILL"), "billDate": "02/01/2026", "items": [{"name": item, "narration": "Revised desc", "qty": 2, "price": 5}]}],
        mutation=True,
    )
    updated = next(i for i in _rpc(erp_client, "getItemsData").get_json()["data"] if i["name"] == item)
    assert updated["remarks"] == "Revised desc"
    assert updated["narration"] == "Bill desc"
