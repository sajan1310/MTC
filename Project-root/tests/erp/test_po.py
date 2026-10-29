"""PO Tracker RPC tests, ported behavior from Apps_Script/module_po.js."""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_get_po_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getPOData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_po_rejects_zero_items(erp_client):
    resp = _rpc(
        erp_client, "savePO", [{"vendor": "Anyone", "items": []}], mutation=True
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "zero items" in body["message"]


def test_save_po_creates_with_sequence_generated_number(erp_client):
    vendor = _unique_name("Hero MotoCorp")
    item = _unique_name("Chain Sprocket")
    resp = _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "contact": "Ludhiana",
                "items": [
                    {"name": item, "size": "Std", "qty": 10, "unit": "Pcs", "price": 5}
                ],
            }
        ],
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
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [{"name": item1, "qty": 5, "price": 2}],
            }
        ],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    edit = _rpc(
        erp_client,
        "savePO",
        [
            {
                "existingPoNumber": po_number,
                "vendor": vendor,
                "items": [{"name": item2, "qty": 3, "price": 4}],
            }
        ],
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
        [
            {
                "existingPoNumber": po_number,
                "vendor": vendor,
                "items": [{"name": item2, "qty": 3, "price": 4}],
            }
        ],
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
    first = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": "A", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    second = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": "B", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    first_num = first.get_json()["data"]["poNumber"]
    second_num = second.get_json()["data"]["poNumber"]

    collide = _rpc(
        erp_client,
        "savePO",
        [
            {
                "existingPoNumber": second_num,
                "poNumber": first_num,
                "vendor": vendor,
                "items": [{"name": "B", "qty": 1, "price": 1}],
            }
        ],
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
        [
            {
                "vendor": vendor,
                "contact": "9999999999",
                "items": [
                    {"name": item, "size": "L", "qty": 2, "unit": "Pcs", "price": 25}
                ],
            }
        ],
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
    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": "X", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    deleted = _rpc(erp_client, "deletePO", [po_number], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    assert po_number not in [po["poNumber"] for po in listed]

    missing = _rpc(erp_client, "deletePO", [po_number], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_pos_bulk(erp_client):
    vendor = _unique_name("BulkVendor")
    a = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": "A", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    b = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": "B", "qty": 1, "price": 1}]}],
        mutation=True,
    )
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

    create = _rpc(
        erp_client,
        "savePO",
        [{"vendor": old_vendor, "items": [{"name": "X", "qty": 1, "price": 1}]}],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    rename = _rpc(
        erp_client,
        "saveVendor",
        [{"vendorName": new_vendor, "originalVendorName": old_vendor}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert match["vendor"] == new_vendor


def test_item_rename_cascades_into_po_lines(erp_client):
    old_item = _unique_name("OldPoItem")
    new_item = _unique_name("NewPoItem")
    _rpc(
        erp_client, "saveItem", [{"itemName": old_item, "itemSize": "M"}], mutation=True
    )

    create = _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": _unique_name("V"),
                "items": [{"name": old_item, "size": "M", "qty": 1, "price": 1}],
            }
        ],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

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
        [
            {
                "vendor": vendor,
                "items": [
                    {"name": item, "size": "", "qty": 10, "unit": "Pcs", "price": 1}
                ],
            }
        ],
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
                "items": [
                    {"name": item, "size": "", "qty": 4, "price": 1, "po": po_number}
                ],
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
                "items": [
                    {"name": item, "size": "", "qty": 6, "price": 1, "po": po_number}
                ],
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
        [
            {
                "vendor": vendor,
                "items": [
                    {"name": item, "size": "", "qty": 5, "unit": "Pcs", "price": 1}
                ],
            }
        ],
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
                "items": [
                    {"name": item, "size": "", "qty": 8, "price": 1, "po": po_number}
                ],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getPOData").get_json()["data"]
    match = next(po for po in listed if po["poNumber"] == po_number)
    assert match["items"][0]["receivedQty"] == 8
    assert match["items"][0]["pendingQty"] == -3


# ─────────────────────────────────────────────────────────────────────────
# closePO / reopenPO -- a status set by hand from the Status dropdown
# ─────────────────────────────────────────────────────────────────────────


def _po_with_receipt(client, ordered=10, received=4):
    """A PO for `ordered` Pcs of one item at Rs 2, `received` of it billed."""
    vendor = _unique_name("CloseVendor")
    item = _unique_name("CloseItem")
    po_number = _rpc(
        client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [
                    {
                        "name": item,
                        "size": "",
                        "qty": ordered,
                        "unit": "Pcs",
                        "price": 2,
                    }
                ],
            }
        ],
        mutation=True,
    ).get_json()["data"]["poNumber"]
    if received:
        body = _rpc(
            client,
            "saveBill",
            [
                {
                    "vendor": vendor,
                    "billNumber": _unique_name("CloseBill"),
                    "billDate": "02/01/2026",
                    "items": [
                        {
                            "name": item,
                            "size": "",
                            "qty": received,
                            "price": 2,
                            "po": po_number,
                        }
                    ],
                }
            ],
            mutation=True,
        ).get_json()
        assert body["success"] is True, body["message"]
    return vendor, item, po_number


def _po(client, po_number):
    listed = _rpc(client, "getPOData").get_json()["data"]
    return next(po for po in listed if po["poNumber"] == po_number)


def test_close_po_completed_turns_the_balance_from_pending_to_short(erp_client):
    _vendor, item, po_number = _po_with_receipt(erp_client)
    assert _po(erp_client, po_number)["status"] == "Partially Received"

    body = _rpc(
        erp_client,
        "closePO",
        [po_number, "Completed", "Vendor will not send the rest"],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    assert f"No longer pending: 6 Pcs {item}." in body["message"]
    # The row the screen patches in place.
    assert body["data"]["po"]["status"] == "Completed"

    po = _po(erp_client, po_number)
    assert po["status"] == "Completed"
    assert po["closedAs"] == "Completed"
    assert po["statusFromBills"] == "Partially Received"
    assert po["closedBy"] == "ERP Test User"
    assert po["closeNote"] == "Vendor will not send the rest"
    assert po["closedAt"]
    line = po["items"][0]
    assert line["receivedQty"] == 4
    assert line["pendingQty"] == 0
    assert line["shortQty"] == 6


def test_close_po_cancels_an_issued_or_a_partial_po(erp_client):
    _vendor, _item, issued = _po_with_receipt(erp_client, received=0)
    body = _rpc(erp_client, "closePO", [issued, "Cancelled"], mutation=True).get_json()
    assert body["success"] is True, body["message"]
    po = _po(erp_client, issued)
    assert po["status"] == "Cancelled"
    assert po["statusFromBills"] == "PO Issued"
    assert po["items"][0]["pendingQty"] == 0
    assert po["items"][0]["shortQty"] == 10

    _vendor, _item, partial = _po_with_receipt(erp_client)
    body = _rpc(erp_client, "closePO", [partial, "cancelled"], mutation=True).get_json()
    assert body["success"] is True, body["message"]
    assert _po(erp_client, partial)["status"] == "Cancelled"


def test_close_po_refuses_what_the_bills_contradict(erp_client):
    _vendor, _item, issued = _po_with_receipt(erp_client, received=0)
    body = _rpc(erp_client, "closePO", [issued, "Completed"], mutation=True).get_json()
    assert body["success"] is False
    assert "Nothing has been received" in body["message"]
    assert _po(erp_client, issued)["status"] == "PO Issued"

    _vendor, _item, full = _po_with_receipt(erp_client, received=10)
    for closed_as in ("Completed", "Cancelled"):
        body = _rpc(erp_client, "closePO", [full, closed_as], mutation=True).get_json()
        assert body["success"] is False
        assert "received in full" in body["message"]

    _vendor, _item, partial = _po_with_receipt(erp_client)
    body = _rpc(
        erp_client, "closePO", [partial, "Partially Received"], mutation=True
    ).get_json()
    assert body["success"] is False

    assert (
        _rpc(erp_client, "closePO", [partial, "Completed"], mutation=True).get_json()[
            "success"
        ]
        is True
    )
    body = _rpc(erp_client, "closePO", [partial, "Cancelled"], mutation=True).get_json()
    assert body["success"] is False
    assert "already Completed" in body["message"]

    body = _rpc(
        erp_client, "closePO", [_unique_name("NoSuchPO"), "Cancelled"], mutation=True
    ).get_json()
    assert body["success"] is False
    assert "not found" in body["message"]


def test_reopen_po_hands_the_status_back_to_the_bills(erp_client):
    _vendor, _item, po_number = _po_with_receipt(erp_client)
    _rpc(erp_client, "closePO", [po_number, "Completed", "short"], mutation=True)

    body = _rpc(erp_client, "reopenPO", [po_number], mutation=True).get_json()
    assert body["success"] is True, body["message"]
    assert "Partially Received again" in body["message"]
    po = _po(erp_client, po_number)
    assert po["status"] == "Partially Received"
    assert (po["closedAs"], po["closedBy"], po["closedAt"], po["closeNote"]) == (
        "",
        "",
        "",
        "",
    )
    assert po["items"][0]["pendingQty"] == 6
    assert po["items"][0]["shortQty"] == 0

    body = _rpc(erp_client, "reopenPO", [po_number], mutation=True).get_json()
    assert body["success"] is False


def test_a_po_closed_by_hand_is_not_suggested_for_new_bills(erp_client):
    vendor, item, po_number = _po_with_receipt(erp_client)
    args = [vendor, [{"rowIndex": 0, "name": item, "qty": 3, "price": 2}], "03/01/2026"]
    before = _rpc(erp_client, "suggestPoAllocations", args).get_json()["data"][0]
    assert [a["poNumber"] for a in before["allocations"]] == [po_number]

    _rpc(erp_client, "closePO", [po_number, "Completed"], mutation=True)
    # The vendor has no open PO left -- the same answer as never having one.
    assert _rpc(erp_client, "suggestPoAllocations", args).get_json()["data"] == []


def test_a_po_closed_by_hand_leaves_the_dashboards_open_pos(erp_client):
    _vendor, _item, po_number = _po_with_receipt(erp_client)

    def kpis():
        return _rpc(erp_client, "getDashboardData").get_json()["data"]["kpis"]

    before = kpis()
    _rpc(erp_client, "closePO", [po_number, "Cancelled"], mutation=True)
    after = kpis()
    assert after["openPoCount"] == before["openPoCount"] - 1
    # 6 Pcs still owed at Rs 2.
    assert after["openPoValue"] == round(before["openPoValue"] - 12, 2)


def test_editing_a_po_keeps_the_status_set_by_hand(erp_client):
    vendor, item, po_number = _po_with_receipt(erp_client)
    _rpc(erp_client, "closePO", [po_number, "Cancelled", "order off"], mutation=True)

    body = _rpc(
        erp_client,
        "savePO",
        [
            {
                "existingPoNumber": po_number,
                "vendor": vendor,
                "items": [
                    {"name": item, "size": "", "qty": 12, "unit": "Pcs", "price": 2}
                ],
            }
        ],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    po = _po(erp_client, po_number)
    assert po["status"] == "Cancelled"
    assert po["closeNote"] == "order off"
    assert po["items"][0]["shortQty"] == 8


# ─────────────────────────────────────────────────────────────────────────
# Identical lines on one PO share their bills (audit 2026-10-29)
# ─────────────────────────────────────────────────────────────────────────


def _twin_line_po(client, received=0):
    """PO 1269's shape: one item and size ordered on two identical lines."""
    vendor = _unique_name("TwinVendor")
    item = _unique_name("TwinItem")
    line = {"name": item, "size": "14 inch", "narration": "Wt 340", "qty": 1000}
    body = _rpc(
        client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [
                    {**line, "unit": "Pcs", "price": 2},
                    {**line, "unit": "Pcs", "price": 2},
                ],
            }
        ],
        mutation=True,
    ).get_json()
    po_number = body["data"]["poNumber"]
    if received:
        bill = {"name": item, "size": "14 inch", "narration": "Wt 340"}
        _rpc(
            client,
            "saveBill",
            [
                {
                    "vendor": vendor,
                    "billNumber": _unique_name("TwinBill"),
                    "billDate": "02/01/2026",
                    "items": [{**bill, "qty": received, "price": 2, "po": po_number}],
                }
            ],
            mutation=True,
        )
    return vendor, item, po_number, body["message"]


def test_identical_po_lines_fill_in_order_from_one_bill(erp_client):
    _vendor, _item, po_number, _msg = _twin_line_po(erp_client, received=1000)

    po = _po(erp_client, po_number)
    # One 1000-piece bill used to mark BOTH lines received -- Completed,
    # with 1000 still to come.
    assert po["status"] == "Partially Received"
    first, second = po["items"]
    assert (first["receivedQty"], first["pendingQty"]) == (1000, 0)
    assert (second["receivedQty"], second["pendingQty"]) == (0, 1000)


def test_the_last_identical_line_carries_an_overage(erp_client):
    _vendor, _item, po_number, _msg = _twin_line_po(erp_client, received=2500)

    po = _po(erp_client, po_number)
    assert po["status"] == "Completed"
    first, second = po["items"]
    assert (first["receivedQty"], first["pendingQty"]) == (1000, 0)
    assert (second["receivedQty"], second["pendingQty"]) == (1500, -500)


def test_identical_lines_still_open_are_suggested_and_counted(erp_client):
    vendor, item, po_number, _msg = _twin_line_po(erp_client, received=1000)

    suggestion = _rpc(
        erp_client,
        "suggestPoAllocations",
        [
            vendor,
            [{"rowIndex": 0, "name": item, "size": "14 inch", "qty": 300, "price": 2}],
            "03/01/2026",
        ],
    ).get_json()["data"][0]
    assert [(a["poNumber"], a["qty"]) for a in suggestion["allocations"]] == [
        (po_number, 300)
    ]

    def kpis():
        return _rpc(erp_client, "getDashboardData").get_json()["data"]["kpis"]

    before = kpis()
    _rpc(erp_client, "closePO", [po_number, "Completed"], mutation=True)
    after = kpis()
    # The open twin was counted: 1000 Pcs at Rs 2 leave the dashboard.
    assert after["openPoCount"] == before["openPoCount"] - 1
    assert after["openPoValue"] == round(before["openPoValue"] - 2000, 2)


def test_save_po_says_when_a_line_is_repeated(erp_client):
    _vendor, item, _po_number, message = _twin_line_po(erp_client)
    assert f'Note: "{item} [14 inch]" is on this PO more than once' in message


def test_over_receipt_warning_names_the_open_po_it_may_belong_to(erp_client):
    vendor = _unique_name("MislinkVendor")
    item = _unique_name("MislinkItem")

    def po(date):
        return _rpc(
            erp_client,
            "savePO",
            [
                {
                    "vendor": vendor,
                    "poDate": date,
                    "items": [
                        {"name": item, "size": "", "qty": 10, "unit": "Pcs", "price": 1}
                    ],
                }
            ],
            mutation=True,
        ).get_json()["data"]["poNumber"]

    older, newer = po("01/01/2026"), po("05/01/2026")
    body = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("MislinkBill"),
                "billDate": "06/01/2026",
                "items": [
                    {"name": item, "size": "", "qty": 15, "price": 1, "po": older}
                ],
            }
        ],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    assert (
        f"on PO {older} has now received 15 Pcs against 10 ordered (5 over). "
        f"PO {newer} still has 10 Pcs of it pending -- was this meant for it?"
    ) in body["message"]


def test_editing_a_bill_matches_it_to_the_po_it_already_fills(erp_client):
    """Bill 288 (2026-09-30): saved against PO 1187 for 500 cartons, edited
    on the phone to 498. The match counted the bill's own 500 as already
    received, found the PO full, and the line was saved Direct -- PO 1187
    then showed 500 cartons pending that had arrived."""
    vendor, item, po_number = _po_with_receipt(erp_client, ordered=500, received=0)
    bill_number = _unique_name("EditBill")
    line = {"name": item, "size": "", "qty": 500, "price": 2, "po": po_number}
    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": bill_number,
                "billDate": "02/01/2026",
                "items": [line],
            }
        ],
        mutation=True,
    )
    asked = [
        vendor,
        [{"rowIndex": 0, "name": item, "qty": 498, "price": 2}],
        "02/01/2026",
    ]

    # As anyone else sees it, the PO is full.
    others = _rpc(erp_client, "suggestPoAllocations", asked).get_json()["data"]
    assert others[0]["allocations"] == []
    # The bill being edited still fills it.
    editing = {"vendor": vendor.upper(), "billNumber": bill_number}
    result = _rpc(erp_client, "suggestPoAllocations", [*asked, editing]).get_json()
    assert [(a["poNumber"], a["qty"]) for a in result["data"][0]["allocations"]] == [
        (po_number, 498)
    ]


def _save_po(client, vendor, date, lines):
    return _rpc(
        client,
        "savePO",
        [{"vendor": vendor, "poDate": date, "items": lines}],
        mutation=True,
    ).get_json()["data"]["poNumber"]


def test_a_bill_beyond_the_preferred_po_fills_the_vendors_other_open_po(erp_client):
    """Bill 522 (2026-10-17): 2000 pairs, narration and rate matching only
    PO 1271, which had 1000 left. The other 1000 went Direct while PO 1205,
    older, at another rate and narration, still had 2000 pending."""
    vendor, item = _unique_name("SpillVendor"), _unique_name("PEDAL")
    older = _save_po(
        erp_client,
        vendor,
        "19/08/2026",
        [
            {
                "name": item,
                "narration": "Big Head",
                "qty": 2000,
                "unit": "Pair",
                "price": 19,
            }
        ],
    )
    newer = _save_po(
        erp_client,
        vendor,
        "02/10/2026",
        [
            {
                "name": item,
                "narration": "Big Head, y2k",
                "qty": 1000,
                "unit": "Pair",
                "price": 20.5,
            }
        ],
    )
    row = {
        "rowIndex": 0,
        "name": item,
        "narration": "Big Head, y2k",
        "qty": 2000,
        "unit": "Pair",
        "price": 20.5,
    }
    result = _rpc(
        erp_client, "suggestPoAllocations", [vendor, [row], "17/10/2026"]
    ).get_json()["data"][0]

    # The matching PO first, then the older one -- nothing left for Direct.
    assert [(a["poNumber"], a["qty"]) for a in result["allocations"]] == [
        (newer, 1000),
        (older, 1000),
    ]
    assert result["unmatchedQty"] == 0
    # The older PO's different rate is flagged, not hidden.
    assert result["allocations"][1]["rateConflict"]["poRate"] == 19


def test_a_line_narration_tells_apart_is_never_filled_with_the_others_goods(
    erp_client,
):
    """PO 1289 orders FREE-WHEEL twice, 16T and 18T. An 18T bill fills the
    18T line, and what is left of it goes to another PO or Direct -- never
    onto the 16T line."""
    vendor, item = _unique_name("TwinNarrVendor"), _unique_name("FREEWHEEL")
    po = _save_po(
        erp_client,
        vendor,
        "01/10/2026",
        [
            {"name": item, "narration": "16T", "qty": 100, "price": 50},
            {"name": item, "narration": "18T", "qty": 100, "price": 50},
        ],
    )
    other = _save_po(
        erp_client,
        vendor,
        "05/10/2026",
        [{"name": item, "narration": "", "qty": 30, "price": 50}],
    )
    row = {"rowIndex": 0, "name": item, "narration": "18T", "qty": 150, "price": 50}
    result = _rpc(
        erp_client, "suggestPoAllocations", [vendor, [row], "10/10/2026"]
    ).get_json()["data"][0]

    assert [(a["poNumber"], a["qty"]) for a in result["allocations"]] == [
        (po, 100),
        (other, 30),
    ]
    assert result["unmatchedQty"] == 20


def test_format_qty_never_writes_exponents():
    from app.erp.services.units_service import format_qty

    assert format_qty(1500000) == "1500000"
    assert format_qty(97.92) == "97.92"
    assert format_qty(50100.004799999995) == "50100.0048"
    assert format_qty(10) == "10"
    assert format_qty(-0.00001) == "0"
    assert format_qty(None) == "0"


# ─────────────────────────────────────────────────────────────────────────
# suggestPoAllocations (Phase 2e)
# ─────────────────────────────────────────────────────────────────────────


def test_suggest_po_allocations_no_vendor_or_items_returns_empty(erp_client):
    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        ["", [{"name": "X", "qty": 1}], "01/01/2026"],
    )
    assert resp.get_json()["data"] == []

    resp2 = _rpc(
        erp_client, "suggestPoAllocations", [_unique_name("V"), [], "01/01/2026"]
    )
    assert resp2.get_json()["data"] == []


def test_suggest_po_allocations_no_open_pos_for_vendor_returns_empty(erp_client):
    vendor = _unique_name("NoPoVendor")
    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [vendor, [{"name": "X", "qty": 1, "price": 1}], None],
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"] == []


def test_suggest_po_allocations_excludes_po_dated_after_bill_date(erp_client):
    vendor = _unique_name("FutureVendor")
    item = _unique_name("FutureItem")
    create = _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/06/2026",
                "items": [{"name": item, "qty": 10, "price": 5}],
            }
        ],
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
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [{"name": item, "qty": 10, "unit": "Pcs", "price": 5}],
            }
        ],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [
            vendor,
            [{"rowIndex": 0, "name": item, "qty": 10, "unit": "Pcs", "price": 5}],
            "02/01/2026",
        ],
    )
    result = resp.get_json()["data"][0]
    assert result["allocations"] == [
        {
            "poNumber": po_number,
            "qty": 10,
            "poRate": 5,
            "poUnit": "Pcs",
            "poRateInBillUnit": 5,
        }
    ]
    assert result["unmatchedQty"] == 0


def test_suggest_po_allocations_splits_across_two_pos_oldest_first(erp_client):
    vendor = _unique_name("SplitVendor")
    item = _unique_name("SplitItem")

    first = _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [{"name": item, "qty": 4, "price": 5}],
            }
        ],
        mutation=True,
    )
    second = _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "05/01/2026",
                "items": [{"name": item, "qty": 10, "price": 5}],
            }
        ],
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
    rate = {"poRate": 5, "poUnit": "Pcs", "poRateInBillUnit": 5}
    assert result["allocations"] == [
        {"poNumber": first_num, "qty": 4, **rate},
        {"poNumber": second_num, "qty": 5, **rate},
    ]
    assert result["unmatchedQty"] == 0


def test_suggest_po_allocations_excludes_fully_billed_po_lines(erp_client):
    vendor = _unique_name("FullyBilledVendor")
    item = _unique_name("FullyBilledItem")
    create = _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [{"name": item, "qty": 5, "price": 5}],
            }
        ],
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
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [{"name": item, "narration": "Red", "qty": 5, "price": 5}],
            }
        ],
        mutation=True,
    )
    po_b = _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [{"name": item, "narration": "Blue", "qty": 5, "price": 5}],
            }
        ],
        mutation=True,
    )
    po_b_num = po_b.get_json()["data"]["poNumber"]
    assert po_a.get_json()["success"] is True

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [
            vendor,
            [{"rowIndex": 0, "name": item, "narration": "Blue", "qty": 5, "price": 5}],
            "02/01/2026",
        ],
    )
    result = resp.get_json()["data"][0]
    assert [(a["poNumber"], a["qty"]) for a in result["allocations"]] == [(po_b_num, 5)]


def test_suggest_po_allocations_price_mismatch_flags_rate_conflict_but_still_allocates(
    erp_client,
):
    vendor = _unique_name("RateConflictVendor")
    item = _unique_name("RateConflictItem")
    create = _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [{"name": item, "qty": 5, "price": 20}],
            }
        ],
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
    assert result["allocations"][0]["rateConflict"] == {
        "poRate": 20,
        "poUnit": "Pcs",
        "poRateInBillUnit": 20,
        "billRate": 25,
        "billUnit": "Pcs",
    }


def test_suggest_po_allocations_carries_po_rate_for_a_line_with_no_price(erp_client):
    """A bill line typed with no price yet is filled from the PO it draws
    down -- so the PO's rate has to arrive even when there is nothing for it
    to conflict with."""
    vendor = _unique_name("BlankRateVendor")
    item = _unique_name("BlankRateItem")
    create = _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [{"name": item, "qty": 5, "unit": "Pcs", "price": 42.5}],
            }
        ],
        mutation=True,
    )
    po_number = create.get_json()["data"]["poNumber"]

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [
            vendor,
            [{"rowIndex": 0, "name": item, "qty": 3, "unit": "Pcs"}],
            "02/01/2026",
        ],
    )
    (allocation,) = resp.get_json()["data"][0]["allocations"]
    assert allocation["poNumber"] == po_number
    assert allocation["poRate"] == 42.5
    assert allocation["poRateInBillUnit"] == 42.5
    assert "rateConflict" not in allocation


def test_suggest_po_allocations_quotes_po_rate_in_the_bills_unit(erp_client):
    """Ordered by the dozen, received by the piece: the rate that fills the
    bill is the PO's rate per PIECE, not the price of a dozen."""
    dozen = _unique_name("Dz")
    unit = _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": dozen, "family": "Count", "factorToBase": 12}],
        mutation=True,
    )
    assert unit.get_json()["success"] is True

    vendor = _unique_name("DozenVendor")
    item = _unique_name("DozenItem")
    _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [{"name": item, "qty": 2, "unit": dozen, "price": 120}],
            }
        ],
        mutation=True,
    )

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [
            vendor,
            [{"rowIndex": 0, "name": item, "qty": 24, "unit": "Pcs"}],
            "02/01/2026",
        ],
    )
    (allocation,) = resp.get_json()["data"][0]["allocations"]
    assert allocation["qty"] == 24
    assert allocation["poRate"] == 120
    assert allocation["poUnit"] == dozen
    assert allocation["poRateInBillUnit"] == 10


def _claimed(row):
    """(PO, qty) per allocation -- what these tests are about, without the
    rate fields every allocation also carries."""
    return [(a["poNumber"], a["qty"]) for a in row["allocations"]]


def test_suggest_po_allocations_shared_candidate_not_double_allocated(erp_client):
    vendor = _unique_name("SharedCandidateVendor")
    item = _unique_name("SharedCandidateItem")
    create = _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [{"name": item, "qty": 5, "price": 5}],
            }
        ],
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
    assert _claimed(first_row) == [(po_number, 3)]
    assert first_row["unmatchedQty"] == 0
    # Only 2 units left after the first row claimed 3 of the 5 available.
    assert _claimed(second_row) == [(po_number, 2)]
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
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [
                    {"name": item, "narration": "Initial desc", "qty": 5, "price": 5}
                ],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in listed if i["name"] == item)
    assert match["narration"] == "Initial desc"
    assert match["remarks"] == ""


def test_po_line_narration_overwrites_remarks_not_narration_on_existing_item(
    erp_client,
):
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
        [
            {
                "vendor": vendor,
                "poDate": "01/01/2026",
                "items": [
                    {"name": item, "narration": "First desc", "qty": 5, "price": 5}
                ],
            }
        ],
        mutation=True,
    )
    original = next(
        i
        for i in _rpc(erp_client, "getItemsData").get_json()["data"]
        if i["name"] == item
    )
    assert original["narration"] == "First desc"

    _rpc(
        erp_client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "02/01/2026",
                "items": [
                    {
                        "name": item,
                        "narration": "Updated vendor desc",
                        "qty": 3,
                        "price": 5,
                    }
                ],
            }
        ],
        mutation=True,
    )

    updated = next(
        i
        for i in _rpc(erp_client, "getItemsData").get_json()["data"]
        if i["name"] == item
    )
    assert updated["remarks"] == "Updated vendor desc"
    assert updated["narration"] == "First desc", (
        "hand-maintained Narration must survive a later purchase description"
    )


def test_bill_line_narration_also_redirects_to_remarks(erp_client):
    """The redirect applies to Bill lines too -- both PO and Bill share
    the autoExtractFromPoOrBill hook (items_service._auto_extract_item).
    """
    vendor = _unique_name("BillNarrationVendor")
    item = _unique_name("BillNarrationItem")

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("BILL"),
                "billDate": "01/01/2026",
                "items": [
                    {"name": item, "narration": "Bill desc", "qty": 2, "price": 5}
                ],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in listed if i["name"] == item)
    assert match["narration"] == "Bill desc"
    assert match["remarks"] == ""

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("BILL"),
                "billDate": "02/01/2026",
                "items": [
                    {"name": item, "narration": "Revised desc", "qty": 2, "price": 5}
                ],
            }
        ],
        mutation=True,
    )
    updated = next(
        i
        for i in _rpc(erp_client, "getItemsData").get_json()["data"]
        if i["name"] == item
    )
    assert updated["remarks"] == "Revised desc"
    assert updated["narration"] == "Bill desc"
