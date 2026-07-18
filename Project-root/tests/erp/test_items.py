"""Items Master RPC tests, ported behavior from Apps_Script/module_items.js."""

from __future__ import annotations

import uuid


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
