"""Unit Master RPC tests, ported behavior from Apps_Script/module_units.js."""

from __future__ import annotations

import uuid

import database


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_get_units_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getUnitsData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_unit_creates_and_lists_it(erp_client):
    name = _unique_name("Gross")
    resp = _rpc(
        erp_client,
        "saveUnit",
        [
            {
                "unitName": name,
                "family": "Count",
                "factorToBase": 144,
                "remarks": "12 dozen",
            }
        ],
        mutation=True,
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["unitName"] == name

    listed = _rpc(erp_client, "getUnitsData").get_json()
    names = [u["unitName"] for u in listed["data"]]
    assert name in names


def test_save_unit_rejects_case_insensitive_duplicate(erp_client):
    name = _unique_name("Dozen")
    first = _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": name, "family": "Count", "factorToBase": 12}],
        mutation=True,
    )
    assert first.get_json()["success"] is True

    dupe = _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": name.upper(), "family": "Count", "factorToBase": 12}],
        mutation=True,
    )
    body = dupe.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_save_unit_rename_via_original_unit_name(erp_client):
    original = _unique_name("Box")
    renamed = _unique_name("Carton")

    create = _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": original, "family": "Count", "factorToBase": 50}],
        mutation=True,
    )
    assert create.get_json()["success"] is True

    edit = _rpc(
        erp_client,
        "saveUnit",
        [
            {
                "unitName": renamed,
                "family": "Count",
                "factorToBase": 50,
                "originalUnitName": original,
            }
        ],
        mutation=True,
    )
    body = edit.get_json()
    assert body["success"] is True
    assert body["data"]["unitName"] == renamed

    listed = _rpc(erp_client, "getUnitsData").get_json()["data"]
    names = [u["unitName"] for u in listed]
    assert renamed in names
    assert original not in names


def test_delete_unit_soft_deletes(erp_client):
    name = _unique_name("Pallet")
    _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": name, "family": "Count", "factorToBase": 200}],
        mutation=True,
    )

    deleted = _rpc(erp_client, "deleteUnit", [name], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getUnitsData").get_json()["data"]
    names = [u["unitName"] for u in listed]
    assert name not in names

    missing = _rpc(erp_client, "deleteUnit", [name], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_units_bulk_soft_deletes_multiple(erp_client):
    name_a = _unique_name("Roll")
    name_b = _unique_name("Bundle")
    _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": name_a, "family": "Count", "factorToBase": 1}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": name_b, "family": "Count", "factorToBase": 1}],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteUnitsBulk", [[name_a, name_b]], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "2" in body["message"]

    names = [u["unitName"] for u in _rpc(erp_client, "getUnitsData").get_json()["data"]]
    assert name_a not in names
    assert name_b not in names


def test_delete_units_bulk_no_selection_is_a_success_noop(erp_client):
    resp = _rpc(erp_client, "deleteUnitsBulk", [[]], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "No units selected" in body["message"]


# ── What a unit change must not move ───────────────────────────────────────


def _ok(resp):
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body


def _crate(client, factor=12):
    """A unit of `factor` Pcs. The test database starts with no units, and
    conversion needs Pcs on file to be in the same family."""
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.units (unit_name, family, factor_to_base) "
            "SELECT 'Pcs', 'Count', 1 WHERE NOT EXISTS "
            "(SELECT 1 FROM erp.units WHERE lower(unit_name) = 'pcs' AND deleted_at IS NULL)"
        )
    name = _unique_name("Crate")
    _ok(
        _rpc(
            client,
            "saveUnit",
            [{"unitName": name, "family": "Count", "factorToBase": factor}],
            mutation=True,
        )
    )
    return name


def _item_with_stock(client, stock=100):
    name = _unique_name("UnitItem")
    _ok(
        _rpc(
            client,
            "saveItem",
            [{"itemName": name, "itemBaseUnit": "Pcs", "itemInitialStock": stock}],
            mutation=True,
        )
    )
    return name


def _lot_consuming(client, item, qty, unit):
    process_name = _unique_name("Process")
    process = _ok(
        _rpc(
            client,
            "saveProcess",
            [
                {
                    "processName": process_name,
                    "lotPrefix": uuid.uuid4().hex[:6].upper(),
                    "outputItemName": _unique_name("Output"),
                    "sequence": 1,
                    "isFinalStage": False,
                    "active": True,
                    "remarks": "",
                    "processType": "",
                    "primaryColorAxis": "",
                    "components": [
                        {
                            "itemName": item,
                            "qtyPerUnit": 1,
                            "unit": unit,
                            "sourceType": "ITEM",
                        }
                    ],
                    "colorLinks": [],
                }
            ],
            mutation=True,
        )
    )
    process_id = process["data"]["processId"]
    _ok(
        _rpc(
            client,
            "saveProduction",
            [
                {
                    "processId": process_id,
                    "assignedTo": "Worker A",
                    "status": "Completed",
                    "qty": 1,
                    "componentsConsumed": [
                        {
                            "itemName": item,
                            "qty": qty,
                            "unit": unit,
                            "sourceType": "ITEM",
                        },
                        # POOL components convert in Pass 2, so they rename too.
                        {
                            "itemName": _unique_name("Bucket"),
                            "qty": 1,
                            "unit": unit,
                            "sourceType": "POOL",
                        },
                    ],
                }
            ],
            mutation=True,
        )
    )
    return process_id


def _stock_of(client, name):
    listed = _rpc(client, "getStockData").get_json()["data"]
    return next(r for r in listed if r["name"] == name)["currentStock"]


def _units_saved_on(process_id):
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT pc.unit FROM erp.process_components pc "
            "JOIN erp.process_master pm ON pm.id = pc.master_id "
            "WHERE pm.process_id = %s",
            (process_id,),
        )
        recipe = [r[0] for r in cur.fetchall()]
        cur.execute(
            "SELECT components_consumed FROM erp.production WHERE process_id = %s",
            (process_id,),
        )
        lot = [c["unit"] for c in cur.fetchone()[0]]
    return recipe, lot


def test_renaming_a_unit_leaves_stock_where_it_was(erp_client):
    crate = _crate(erp_client)
    item = _item_with_stock(erp_client)
    process_id = _lot_consuming(erp_client, item, 2, crate)
    assert _stock_of(erp_client, item) == 76  # 100 - 2 x 12

    renamed = _unique_name("Carton")
    _ok(
        _rpc(
            erp_client,
            "saveUnit",
            [
                {
                    "unitName": renamed,
                    "family": "Count",
                    "factorToBase": 12,
                    "originalUnitName": crate,
                }
            ],
            mutation=True,
        )
    )

    assert _stock_of(erp_client, item) == 76
    assert _units_saved_on(process_id) == ([renamed], [renamed, renamed])


def test_a_unit_in_use_keeps_its_factor(erp_client):
    crate = _crate(erp_client)
    item = _item_with_stock(erp_client, stock=0)
    number = _unique_name("BILL")
    _ok(
        _rpc(
            erp_client,
            "saveBill",
            [
                {
                    "vendor": _unique_name("Vendor"),
                    "billNumber": number,
                    "billDate": "01/01/2026",
                    "items": [{"name": item, "qty": 8, "price": 5, "unit": crate}],
                }
            ],
            mutation=True,
        )
    )
    assert _stock_of(erp_client, item) == 96

    refused = _rpc(
        erp_client,
        "saveUnit",
        [
            {
                "unitName": crate,
                "family": "Count",
                "factorToBase": 9,
                "originalUnitName": crate,
            }
        ],
        mutation=True,
    ).get_json()

    assert refused["success"] is False
    assert "1 bill line" in refused["message"]
    assert "Add a new unit" in refused["message"]
    listed = _rpc(erp_client, "getUnitsData").get_json()["data"]
    assert next(u for u in listed if u["unitName"] == crate)["factorToBase"] == 12
    assert _stock_of(erp_client, item) == 96


def test_a_unit_in_use_keeps_its_family(erp_client):
    crate = _crate(erp_client)
    _lot_consuming(erp_client, _item_with_stock(erp_client), 1, crate)

    refused = _rpc(
        erp_client,
        "saveUnit",
        [
            {
                "unitName": crate,
                "family": "Weight",
                "factorToBase": 12,
                "originalUnitName": crate,
            }
        ],
        mutation=True,
    ).get_json()

    assert refused["success"] is False
    assert "process component" in refused["message"]


def test_a_unit_only_an_items_base_unit_names_keeps_its_factor(erp_client):
    """Lines in other units convert through the item's Base Unit factor, so
    naming it as a Base Unit is reason enough."""
    crate = _crate(erp_client)
    _ok(
        _rpc(
            erp_client,
            "saveItem",
            [{"itemName": _unique_name("UnitItem"), "itemBaseUnit": crate}],
            mutation=True,
        )
    )

    refused = _rpc(
        erp_client,
        "saveUnit",
        [
            {
                "unitName": crate,
                "family": "Count",
                "factorToBase": 9,
                "originalUnitName": crate,
            }
        ],
        mutation=True,
    ).get_json()

    assert refused["success"] is False
    assert "1 item" in refused["message"]


def test_a_unit_nothing_uses_can_take_a_new_factor(erp_client):
    crate = _crate(erp_client)

    _ok(
        _rpc(
            erp_client,
            "saveUnit",
            [
                {
                    "unitName": crate,
                    "family": "Count",
                    "factorToBase": 9,
                    "originalUnitName": crate,
                }
            ],
            mutation=True,
        )
    )

    listed = _rpc(erp_client, "getUnitsData").get_json()["data"]
    assert next(u for u in listed if u["unitName"] == crate)["factorToBase"] == 9


def test_a_unit_in_use_can_still_change_its_remarks(erp_client):
    crate = _crate(erp_client)
    _lot_consuming(erp_client, _item_with_stock(erp_client), 1, crate)

    _ok(
        _rpc(
            erp_client,
            "saveUnit",
            [
                {
                    "unitName": crate,
                    "family": "Count",
                    "factorToBase": 12,
                    "originalUnitName": crate,
                    "remarks": "twelve to a crate",
                }
            ],
            mutation=True,
        )
    )
