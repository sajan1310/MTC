"""Items Master RPC tests, ported behavior from Apps_Script/module_items.js."""

from __future__ import annotations

import uuid

import database


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_get_items_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getItemsData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_item_creates_with_vendors_and_lists_it(erp_client):
    name = _unique_name("BrakePad")
    resp = _rpc(
        erp_client,
        "saveItem",
        [
            {
                "itemName": name,
                "itemSize": "Standard",
                "itemBaseUnit": "Pcs",
                "vendors": [{"vendor": "Acme Co", "rate": 12.5}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["name"] == name
    assert body["data"]["size"] == "Standard"
    # data.item is the freshly-written row, for the client's in-place
    # row-patch instead of a full reload.
    assert body["data"]["item"]["baseUnit"] == "Pcs"
    assert body["data"]["item"]["vendors"] == [{"vendor": "Acme Co", "rate": 12.5, "ratePerBaseUnit": 12.5}]
    # The success toast names the item so it's unambiguous on a page that
    # just patched one row into an already-loaded list of many (reference:
    # module_items.js saveItem, commit e37529e).
    assert body["message"] == f'Item "{name}" (Standard) added successfully.'

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in listed if i["name"] == name and i["size"] == "Standard")
    assert match["baseUnit"] == "Pcs"
    assert match["vendors"] == [{"vendor": "Acme Co", "rate": 12.5, "ratePerBaseUnit": 12.5}]


def test_save_item_update_message_names_item_without_size(erp_client):
    """A sizeless item's toast omits the size parenthetical entirely rather
    than printing an empty "()" -- mirrors the reference's
    `${size ? ` (${size})` : ''}` conditional.
    """
    name = _unique_name("HubBearing")
    create_resp = _rpc(
        erp_client,
        "saveItem",
        [{"itemName": name, "itemSize": "", "itemBaseUnit": "Pcs"}],
        mutation=True,
    )
    assert create_resp.get_json()["message"] == f'Item "{name}" added successfully.'

    update_resp = _rpc(
        erp_client,
        "saveItem",
        [
            {
                "originalName": name,
                "originalSize": "",
                "itemName": name,
                "itemSize": "",
                "itemBaseUnit": "Pcs",
                "itemRemarks": "updated",
            }
        ],
        mutation=True,
    )
    assert update_resp.get_json()["message"] == f'Item "{name}" updated successfully.'


def test_get_items_data_hides_zero_rate_vendors(erp_client):
    """module_items.js's MIN_VENDOR_RATE (0.01) -- a vendor pair with no
    real rate entered (0, or saved as blank and coerced to 0) is stored
    (saveItem's own validation only rejects negative/non-numeric rates,
    matching the source), but must not show up in getItemsData as if it
    were a real quoted price. A real rate for a different vendor on the
    same item is unaffected.
    """
    name = _unique_name("MixedRateItem")
    resp = _rpc(
        erp_client,
        "saveItem",
        [
            {
                "itemName": name,
                "itemSize": "",
                "itemBaseUnit": "Pcs",
                "vendors": [
                    {"vendor": "Empty Slot Vendor", "rate": 0},
                    {"vendor": "Real Vendor", "rate": 8},
                ],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in listed if i["name"] == name and i["size"] == "")
    assert match["vendors"] == [{"vendor": "Real Vendor", "rate": 8, "ratePerBaseUnit": 8}]


def test_save_item_vendor_rate_converted_to_base_unit(erp_client):
    """Purchase Unit 'Gross' (factor 144, Count family) -> Base Unit 'Pcs'
    (factor 1) should divide the rate by 144, exercising the real
    conversion path (not an identity no-op).
    """
    unit_name = _unique_name("Gross")
    _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": unit_name, "family": "Count", "factorToBase": 144}],
        mutation=True,
    )

    item_name = _unique_name("Screw")
    _rpc(
        erp_client,
        "saveItem",
        [
            {
                "itemName": item_name,
                "itemBaseUnit": "Pcs",
                "itemPurchaseUnit": unit_name,
                "vendors": [{"vendor": "Bolt Vendor", "rate": 144}],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in listed if i["name"] == item_name)
    assert match["vendors"][0]["rate"] == 144
    assert match["vendors"][0]["ratePerBaseUnit"] == 1.0


def test_save_item_rejects_duplicate_name_and_size(erp_client):
    name = _unique_name("Duplicate")
    first = _rpc(erp_client, "saveItem", [{"itemName": name, "itemSize": "M"}], mutation=True)
    assert first.get_json()["success"] is True

    dupe = _rpc(erp_client, "saveItem", [{"itemName": name, "itemSize": "M"}], mutation=True)
    body = dupe.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_save_item_rename_moves_paired_stock_row(erp_client):
    original = _unique_name("Original")
    renamed = _unique_name("Renamed")

    _rpc(erp_client, "saveItem", [{"itemName": original, "itemInitialStock": 25}], mutation=True)

    edit = _rpc(
        erp_client,
        "saveItem",
        [{"itemName": renamed, "originalName": original, "originalSize": ""}],
        mutation=True,
    )
    body = edit.get_json()
    assert body["success"] is True
    assert body["data"]["name"] == renamed
    assert body["data"]["size"] == ""

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    names = [i["name"] for i in listed]
    assert renamed in names
    assert original not in names


def test_save_item_rename_collision_offers_merge(erp_client):
    existing = _unique_name("ExistingTarget")
    other = _unique_name("ToBeRenamed")

    _rpc(erp_client, "saveItem", [{"itemName": existing}], mutation=True)
    _rpc(erp_client, "saveItem", [{"itemName": other}], mutation=True)

    collide = _rpc(
        erp_client,
        "saveItem",
        [{"itemName": existing, "originalName": other, "originalSize": ""}],
        mutation=True,
    )
    body = collide.get_json()
    assert body["success"] is False
    assert body["data"]["mergeable"] is True
    assert body["data"]["targetName"] == existing


def test_delete_item_success_and_not_found(erp_client):
    name = _unique_name("Deletable")
    _rpc(erp_client, "saveItem", [{"itemName": name}], mutation=True)

    deleted = _rpc(erp_client, "deleteItem", [name, ""], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    assert name not in [i["name"] for i in listed]

    missing = _rpc(erp_client, "deleteItem", [name, ""], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_items_bulk_deletes_requested_set(erp_client):
    a = _unique_name("BulkA")
    b = _unique_name("BulkB")
    _rpc(erp_client, "saveItem", [{"itemName": a}], mutation=True)
    _rpc(erp_client, "saveItem", [{"itemName": b}], mutation=True)

    resp = _rpc(
        erp_client,
        "deleteItemsBulk",
        [[{"name": a, "size": ""}, {"name": b, "size": ""}]],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert len(body["data"]["deletedItems"]) == 2
    assert body["data"]["skipped"] == []

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    names = [i["name"] for i in listed]
    assert a not in names
    assert b not in names


def test_unit_rename_cascades_into_items_base_and_purchase_unit(erp_client):
    """Confirms Phase 1a's guarded rename cascade actually activates now
    that ITEMS is registered in config_maps.TABLE_NAMES -- not just that it
    doesn't crash (Phase 1a could only prove the latter).
    """
    old_unit = _unique_name("OldUnit")
    new_unit = _unique_name("NewUnit")
    _rpc(erp_client, "saveUnit", [{"unitName": old_unit, "family": "Count", "factorToBase": 1}], mutation=True)

    item_name = _unique_name("UnitCascadeItem")
    _rpc(
        erp_client,
        "saveItem",
        [{"itemName": item_name, "itemBaseUnit": old_unit, "itemPurchaseUnit": old_unit}],
        mutation=True,
    )

    rename = _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": new_unit, "family": "Count", "factorToBase": 1, "originalUnitName": old_unit}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in listed if i["name"] == item_name)
    assert match["baseUnit"] == new_unit
    assert match["purchaseUnit"] == new_unit


def _soft_delete_stock_row(name: str, size: str) -> None:
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.stock SET deleted_at = NOW() WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s)",
            (name, size),
        )


def test_keep_orphan_item_creates_stock_row(erp_client):
    name = _unique_name("OrphanItem")
    _rpc(erp_client, "saveItem", [{"itemName": name, "itemSize": "M"}], mutation=True)
    _soft_delete_stock_row(name, "M")

    stock_before = _rpc(erp_client, "getStockData").get_json()["data"]
    assert not any(s["name"] == name for s in stock_before)

    resp = _rpc(erp_client, "keepOrphanItem", [name, "M", 7], mutation=True)
    assert resp.get_json()["success"] is True

    stock_after = _rpc(erp_client, "getStockData").get_json()["data"]
    match = next(s for s in stock_after if s["name"] == name and s["size"] == "M")
    assert match["initialStock"] == 7


def test_keep_orphan_item_rejects_unknown_item(erp_client):
    resp = _rpc(erp_client, "keepOrphanItem", [_unique_name("NoSuchItem"), "", 1], mutation=True)
    assert resp.get_json()["success"] is False


def test_keep_orphan_items_bulk_creates_stock_rows(erp_client):
    a = _unique_name("BulkOrphanA")
    b = _unique_name("BulkOrphanB")
    _rpc(erp_client, "saveItem", [{"itemName": a}], mutation=True)
    _rpc(erp_client, "saveItem", [{"itemName": b}], mutation=True)
    _soft_delete_stock_row(a, "")
    _soft_delete_stock_row(b, "")

    resp = _rpc(
        erp_client,
        "keepOrphanItemsBulk",
        [[{"name": a, "size": "", "initialStock": 3}, {"name": b, "size": "", "initialStock": 4}]],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["created"] == 2

    stock = _rpc(erp_client, "getStockData").get_json()["data"]
    assert {s["name"]: s["initialStock"] for s in stock if s["name"] in (a, b)} == {a: 3, b: 4}


def test_merge_selected_items_combines_stock_vendors_and_deletes_loser(erp_client):
    keep = _unique_name("KeepItem")
    remove = _unique_name("RemoveItem")
    _rpc(
        erp_client, "saveItem",
        [{"itemName": keep, "itemInitialStock": 10, "vendors": [{"vendor": "Vendor Keep", "rate": 5}]}],
        mutation=True,
    )
    _rpc(
        erp_client, "saveItem",
        [{"itemName": remove, "itemInitialStock": 4, "vendors": [{"vendor": "Vendor Remove", "rate": 8}]}],
        mutation=True,
    )

    resp = _rpc(
        erp_client, "mergeSelectedItems",
        [[{"name": keep, "size": ""}, {"name": remove, "size": ""}]],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"] == {"name": keep, "size": ""}

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    names = [i["name"] for i in listed]
    assert keep in names
    assert remove not in names

    match = next(i for i in listed if i["name"] == keep)
    assert {v["vendor"] for v in match["vendors"]} == {"Vendor Keep", "Vendor Remove"}

    stock = _rpc(erp_client, "getStockData").get_json()["data"]
    stock_match = next(s for s in stock if s["name"] == keep)
    assert stock_match["initialStock"] == 14


def test_merge_selected_items_converts_vendor_rate_across_purchase_units(erp_client):
    """A vendor rate is quoted per the item's own Purchase Unit -- merging an
    item purchased by the Dozen into one purchased by the Pcs must convert
    the rate (120/Dozen -> 10/Pcs), not carry the raw number across.
    """
    dozen = _unique_name("Dozen")
    _rpc(erp_client, "saveUnit", [{"unitName": dozen, "family": "Count", "factorToBase": 12}], mutation=True)

    keep = _unique_name("KeepPcsItem")
    remove = _unique_name("RemoveDozenItem")
    _rpc(
        erp_client, "saveItem",
        [{"itemName": keep, "itemBaseUnit": "Pcs", "itemPurchaseUnit": "Pcs"}],
        mutation=True,
    )
    _rpc(
        erp_client, "saveItem",
        [
            {
                "itemName": remove,
                "itemBaseUnit": "Pcs",
                "itemPurchaseUnit": dozen,
                "vendors": [{"vendor": "Dozen Vendor", "rate": 120}],
            }
        ],
        mutation=True,
    )

    resp = _rpc(
        erp_client, "mergeSelectedItems",
        [[{"name": keep, "size": ""}, {"name": remove, "size": ""}]],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in listed if i["name"] == keep)
    dozen_vendor = next(v for v in match["vendors"] if v["vendor"] == "Dozen Vendor")
    assert dozen_vendor["rate"] == 10


def test_merge_selected_items_converts_stock_across_purchase_units(erp_client):
    """initial_stock is tracked in each item's own Base Unit -- merging an
    item base-tracked in Dozen into one base-tracked in Pcs must convert
    the old row's stock (2 Dozen = 24 Pcs) before summing, not add the raw
    numbers together.
    """
    dozen = _unique_name("StockDozen")
    _rpc(erp_client, "saveUnit", [{"unitName": dozen, "family": "Count", "factorToBase": 12}], mutation=True)

    keep = _unique_name("KeepPcsStockItem")
    remove = _unique_name("RemoveDozenStockItem")
    _rpc(
        erp_client, "saveItem",
        [{"itemName": keep, "itemBaseUnit": "Pcs", "itemInitialStock": 10}],
        mutation=True,
    )
    _rpc(
        erp_client, "saveItem",
        [{"itemName": remove, "itemBaseUnit": dozen, "itemInitialStock": 2}],
        mutation=True,
    )

    resp = _rpc(
        erp_client, "mergeSelectedItems",
        [[{"name": keep, "size": ""}, {"name": remove, "size": ""}]],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    stock = _rpc(erp_client, "getStockData").get_json()["data"]
    stock_match = next(s for s in stock if s["name"] == keep)
    assert stock_match["initialStock"] == 34  # 10 Pcs + (2 Dozen -> 24 Pcs)


def test_merge_selected_items_rejects_wrong_count(erp_client):
    only_one = _unique_name("Solo")
    _rpc(erp_client, "saveItem", [{"itemName": only_one}], mutation=True)
    resp = _rpc(erp_client, "mergeSelectedItems", [[{"name": only_one, "size": ""}]], mutation=True)
    assert resp.get_json()["success"] is False


def test_merge_item_edit_after_duplicate_rejection(erp_client):
    target = _unique_name("MergeTarget")
    original = _unique_name("MergeOriginal")
    _rpc(erp_client, "saveItem", [{"itemName": target, "itemInitialStock": 6}], mutation=True)
    _rpc(erp_client, "saveItem", [{"itemName": original, "itemInitialStock": 2}], mutation=True)

    collide = _rpc(
        erp_client, "saveItem",
        [{"itemName": target, "originalName": original, "originalSize": "", "vendors": [{"vendor": "Edit Vendor", "rate": 9}]}],
        mutation=True,
    )
    body = collide.get_json()
    assert body["success"] is False
    assert body["data"]["mergeable"] is True

    merge = _rpc(
        erp_client, "mergeItemEdit",
        [{"itemName": target, "itemSize": "", "originalName": original, "originalSize": "", "vendors": [{"vendor": "Edit Vendor", "rate": 9}]}],
        mutation=True,
    )
    merge_body = merge.get_json()
    assert merge_body["success"] is True
    assert merge_body["data"] == {"name": target, "size": ""}

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    names = [i["name"] for i in listed]
    assert target in names
    assert original not in names

    match = next(i for i in listed if i["name"] == target)
    assert any(v["vendor"] == "Edit Vendor" for v in match["vendors"])

    stock = _rpc(erp_client, "getStockData").get_json()["data"]
    stock_match = next(s for s in stock if s["name"] == target)
    assert stock_match["initialStock"] == 8


def test_run_scheduled_item_cleanup_merges_exact_duplicates(erp_client):
    """erp.items' own unique index (ux_erp_items_name_size_ci) is on
    lower(item_name)/lower(size) WITHOUT trimming whitespace, so a
    whitespace-padded name bypasses it at the DB level while still being a
    real duplicate once compared the way the app itself does (.strip()
    everywhere) -- a genuine, reachable case for this cleanup phase to
    catch, unlike a byte-identical insert (which the index would reject).
    """
    shared_name = _unique_name("ExactDup")
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.items (item_name, size, remarks) VALUES (%s, %s, %s)",
            (shared_name, "L", "first remark"),
        )
        cur.execute(
            "INSERT INTO erp.items (item_name, size) VALUES (%s, %s)",
            (f" {shared_name} ", "L"),
        )

    resp = _rpc(erp_client, "runScheduledItemCleanup", [], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["merged"] >= 1

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    matches = [i for i in listed if i["name"] == shared_name and i["size"] == "L"]
    assert len(matches) == 1
    assert matches[0]["remarks"] == "first remark"


def test_run_scheduled_item_cleanup_autofixes_unambiguous_truncated_pair(erp_client):
    size = _unique_name("CleanupSize")
    short_name = _unique_name("Trunc")
    long_name = short_name + "Full"
    with database.get_conn() as (_conn, cur):
        cur.execute("INSERT INTO erp.items (item_name, size) VALUES (%s, %s)", (short_name, size))
        cur.execute("INSERT INTO erp.items (item_name, size) VALUES (%s, %s)", (long_name, size))

    resp = _rpc(erp_client, "runScheduledItemCleanup", [], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["autoFixed"] >= 1

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    names_at_size = [i["name"] for i in listed if i["size"] == size]
    assert long_name in names_at_size
    assert short_name not in names_at_size


# ─────────────────────────────────────────────────────────────────────────
# Item identity drift diagnostic ("Check Reference Integrity"), ported
# behavior from module_items.js's getItemIdentityDriftReport /
# fixItemIdentityDriftReference.
# ─────────────────────────────────────────────────────────────────────────


def test_get_item_identity_drift_report_no_drift_on_clean_state(erp_client):
    resp = _rpc(erp_client, "getItemIdentityDriftReport")
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)
    # Not asserting an empty list -- other tests in a full run may leave
    # their own items in place -- just that the RPC itself behaves.
    assert "message" in body


def test_get_item_identity_drift_report_finds_stale_bill_reference(erp_client):
    vendor = _unique_name("DriftVendor")
    bill_number = _unique_name("INV")
    item = _unique_name("DriftBillItem")

    _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": item, "qty": 1, "price": 10}]}],
        mutation=True,
    )
    # Auto-extraction creates the item in Items Master on save -- delete it
    # (not blocked: delete_item's in-use guard only covers BOM/Process
    # Components, not Bill/PO/Return/Wastage/Issue/Production) to
    # manufacture a genuine stale reference.
    delete_resp = _rpc(erp_client, "deleteItem", [item, ""], mutation=True)
    assert delete_resp.get_json()["success"] is True

    drift = _rpc(erp_client, "getItemIdentityDriftReport").get_json()["data"]
    match = next(d for d in drift if d["itemName"] == item)
    assert match["sheet"] == "Bill Ledger"
    assert bill_number in match["context"]


def test_get_item_identity_drift_report_finds_stale_po_reference(erp_client):
    vendor = _unique_name("DriftVendor")
    item = _unique_name("DriftPoItem")

    create = _rpc(
        erp_client, "savePO", [{"vendor": vendor, "items": [{"name": item, "qty": 1, "price": 10}]}], mutation=True
    ).get_json()
    po_number = create["data"]["poNumber"]

    _rpc(erp_client, "deleteItem", [item, ""], mutation=True)

    drift = _rpc(erp_client, "getItemIdentityDriftReport").get_json()["data"]
    match = next(d for d in drift if d["itemName"] == item)
    assert match["sheet"] == "PO Tracker"
    assert po_number in match["context"]


def test_get_item_identity_drift_report_finds_return_wastage_and_issue_references(erp_client):
    """Return/Wastage/Issue never auto-extract into Items Master (a genuine
    behavioral difference from PO/Bill -- see return_service.py's module
    docstring), so an item name that was never registered at all drifts
    immediately, no delete required.
    """
    return_item = _unique_name("DriftReturnItem")
    wastage_item = _unique_name("DriftWastageItem")
    issue_item = _unique_name("DriftIssueItem")

    _rpc(
        erp_client,
        "saveReturn",
        [{"vendor": "V", "returnDate": "01/01/2026", "items": [{"name": return_item, "qty": 1, "price": 1, "reason": "Defective"}]}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveWastage",
        [{"date": "01/01/2026", "items": [{"name": wastage_item, "qty": 1, "unit": "Pcs", "reason": "Damaged"}]}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveIssueStock",
        [{"date": "01/01/2026", "issuedTo": "Contractor A", "items": [{"name": issue_item, "qty": 1, "unit": "Pcs"}]}],
        mutation=True,
    )

    drift = _rpc(erp_client, "getItemIdentityDriftReport").get_json()["data"]
    sheets_by_item = {d["itemName"]: d["sheet"] for d in drift}
    assert sheets_by_item.get(return_item) == "Return Ledger"
    assert sheets_by_item.get(wastage_item) == "Wastage Log"
    assert sheets_by_item.get(issue_item) == "Issued Stock Log"


def test_get_item_identity_drift_report_finds_production_components_consumed_but_skips_pool(erp_client):
    item_drift = _unique_name("DriftProdItem")
    pool_shared_name = _unique_name("DriftPoolOutput")

    process_payload = {
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
    process_resp = _rpc(erp_client, "saveProcess", [process_payload], mutation=True).get_json()
    assert process_resp["success"] is True, process_resp["message"]
    process_id = process_resp["data"]["processId"]

    lot = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 1,
                "componentsConsumed": [
                    {"itemName": item_drift, "qty": 1, "sourceType": "ITEM"},
                    {"itemName": pool_shared_name, "qty": 1, "sourceType": "POOL"},
                ],
            }
        ],
        mutation=True,
    ).get_json()
    assert lot["success"] is True

    drift = _rpc(erp_client, "getItemIdentityDriftReport").get_json()["data"]
    items_flagged = {d["itemName"] for d in drift}
    assert item_drift in items_flagged
    # The POOL row's itemName is an upstream process's Output Item Name
    # (Warehouse Pool identity), not an Items Master reference -- must
    # never be flagged just because it also isn't in Items Master.
    assert pool_shared_name not in items_flagged


def test_fix_item_identity_drift_reference_repoints_bill_ledger_row(erp_client):
    vendor = _unique_name("DriftVendor")
    bill_number = _unique_name("INV")
    stale_item = _unique_name("StaleItem")
    target_item = _unique_name("TargetItem")

    _rpc(
        erp_client,
        "saveBill",
        [{"vendor": vendor, "billNumber": bill_number, "billDate": "01/01/2026", "items": [{"name": stale_item, "qty": 1, "price": 10}]}],
        mutation=True,
    )
    _rpc(erp_client, "deleteItem", [stale_item, ""], mutation=True)
    _rpc(erp_client, "saveItem", [{"itemName": target_item}], mutation=True)

    fix = _rpc(erp_client, "fixItemIdentityDriftReference", [stale_item, "", target_item, ""], mutation=True)
    body = fix.get_json()
    assert body["success"] is True
    assert stale_item in body["message"]
    assert target_item in body["message"]

    bills = _rpc(erp_client, "getBillData").get_json()["data"]
    match = next(b for b in bills if b["billNumber"] == bill_number)
    assert match["items"][0]["name"] == target_item

    drift = _rpc(erp_client, "getItemIdentityDriftReport").get_json()["data"]
    assert not any(d["itemName"] == stale_item for d in drift)


def test_fix_item_identity_drift_reference_rejects_unknown_target(erp_client):
    resp = _rpc(erp_client, "fixItemIdentityDriftReference", ["SomeStaleItem", "", "NoSuchTarget", ""], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "not found in Items Master" in body["message"]


def test_fix_item_identity_drift_reference_requires_stale_name(erp_client):
    resp = _rpc(erp_client, "fixItemIdentityDriftReference", ["", "", "AnyTarget", ""], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "required" in body["message"]
