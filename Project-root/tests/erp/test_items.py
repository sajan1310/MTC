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
    assert body["data"] == {"name": name, "size": "Standard"}

    listed = _rpc(erp_client, "getItemsData").get_json()["data"]
    match = next(i for i in listed if i["name"] == name and i["size"] == "Standard")
    assert match["baseUnit"] == "Pcs"
    assert match["vendors"] == [{"vendor": "Acme Co", "rate": 12.5, "ratePerBaseUnit": 12.5}]


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
    assert body["data"] == {"name": renamed, "size": ""}

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
