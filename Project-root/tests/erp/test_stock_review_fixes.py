"""Units and rates the stock review of 2026-11-04 found going wrong.

Each of these moved a figure while every quantity on screen stayed put:

- "Refresh from Items Master" relabelled a lot component recorded in Gross
  as Pcs and kept its number, so 2 Gross of spokes (288) consumed 2;
- a bill or PO line for an item Items Master did not have yet was
  converted against a stand-in Base Unit of Pcs, then the item was created
  with the line's unit as its Base Unit: 10 Gross stored as 1,440 Gross;
- saving an older bill or PO -- an edit, or a backlog invoice -- put its
  old price back into Items Master as the vendor's current rate;
- two lot lines for the same part in different units were added as bare
  numbers under the first one's unit: 1 Gross + 40 Pcs came to 41 Gross.
"""

from __future__ import annotations

import uuid

import pytest

from app.erp.services import production_service


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _ok(resp):
    body = resp.get_json()
    assert body["success"] is True, body.get("message")
    return body


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _add_unit(client, name, factor, family="Count"):
    _ok(
        _rpc(
            client,
            "saveUnit",
            [{"unitName": name, "family": family, "factorToBase": factor}],
            mutation=True,
        )
    )


def _add_item(client, name, base_unit="Pcs"):
    _ok(
        _rpc(
            client,
            "saveItem",
            [
                {
                    "itemName": name,
                    "itemBaseUnit": base_unit,
                    "itemPurchaseUnit": base_unit,
                }
            ],
            mutation=True,
        )
    )


def _item(client, name):
    listed = _ok(_rpc(client, "getItemsData"))["data"]
    return next(i for i in listed if i["name"] == name)


def _vendor_rate(client, item, vendor):
    return next(v for v in _item(client, item)["vendors"] if v["vendor"] == vendor)[
        "rate"
    ]


def _current(client, name):
    listed = _ok(_rpc(client, "getStockData"))["data"]
    return next(r for r in listed if r["name"] == name and r["size"] == "")[
        "currentStock"
    ]


def _process(client):
    payload = {
        "processName": _unique_name("ReviewProcess"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique_name("ReviewOutput"),
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    return _ok(_rpc(client, "saveProcess", [payload], mutation=True))["data"][
        "processId"
    ]


def _completed_lot(client, components):
    body = _ok(
        _rpc(
            client,
            "saveProduction",
            [
                {
                    "processId": _process(client),
                    "assignedTo": "Worker A",
                    "qty": 1,
                    "status": "Completed",
                    "componentsConsumed": components,
                }
            ],
            mutation=True,
        )
    )
    return body["data"]["row"]


def _lot_components(client, lot_number):
    listed = _ok(_rpc(client, "getProductionData"))["data"]
    return next(r for r in listed if r["lotNumber"] == lot_number)["componentsConsumed"]


def _save_bill(client, vendor, number, bill_date, item, qty, unit, price, **extra):
    return _ok(
        _rpc(
            client,
            "saveBill",
            [
                {
                    "vendor": vendor,
                    "billNumber": number,
                    "billDate": bill_date,
                    "items": [{"name": item, "qty": qty, "unit": unit, "price": price}],
                    **extra,
                }
            ],
            mutation=True,
        )
    )


def _save_po(client, vendor, po_date, item, qty, unit, price, **extra):
    return _ok(
        _rpc(
            client,
            "savePO",
            [
                {
                    "vendor": vendor,
                    "poDate": po_date,
                    "items": [{"name": item, "qty": qty, "unit": unit, "price": price}],
                    **extra,
                }
            ],
            mutation=True,
        )
    )["data"]["poNumber"]


# ─────────────────────────────────────────────────────────────────────────
# Refresh from Items Master keeps a quantity's unit
# ─────────────────────────────────────────────────────────────────────────


def test_refresh_keeps_a_component_recorded_in_another_unit(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    spoke = _unique_name("RimSpoke")
    _add_item(erp_client, spoke, base_unit="Pcs")
    row = _completed_lot(
        erp_client,
        [{"itemName": spoke, "qty": 2, "unit": gross, "sourceType": "ITEM"}],
    )
    assert _current(erp_client, spoke) == pytest.approx(-288)

    body = _ok(
        _rpc(erp_client, "refreshProductionComponentsFromItemsMaster", mutation=True)
    )

    component = _lot_components(erp_client, row["lotNumber"])[0]
    assert component["unit"] == gross
    assert component["qty"] == 2
    assert _current(erp_client, spoke) == pytest.approx(-288)
    assert body["data"]["unitsKept"] >= 1


def test_refresh_still_fills_a_blank_unit_and_fixes_its_casing(erp_client):
    first = _unique_name("Washer")
    second = _unique_name("Nut")
    _add_item(erp_client, first, base_unit="Pcs")
    _add_item(erp_client, second, base_unit="Pcs")
    row = _completed_lot(
        erp_client,
        [
            {"itemName": first, "qty": 3, "unit": "", "sourceType": "ITEM"},
            {"itemName": second, "qty": 4, "unit": "pcs", "sourceType": "ITEM"},
        ],
    )

    _ok(_rpc(erp_client, "refreshProductionComponentsFromItemsMaster", mutation=True))

    units = {
        c["itemName"]: c["unit"] for c in _lot_components(erp_client, row["lotNumber"])
    }
    assert units == {first: "Pcs", second: "Pcs"}
    assert _current(erp_client, first) == pytest.approx(-3)
    assert _current(erp_client, second) == pytest.approx(-4)


# ─────────────────────────────────────────────────────────────────────────
# A line that introduces an item is counted in its own unit
# ─────────────────────────────────────────────────────────────────────────


def test_a_bill_for_a_new_item_in_gross_stores_it_in_gross(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    spoke = _unique_name("NewSpoke")

    body = _save_bill(
        erp_client,
        _unique_name("Vendor"),
        _unique_name("B"),
        "02/09/2026",
        spoke,
        10,
        gross,
        940,
    )

    line = body["data"]["bill"]["items"][0]
    assert _item(erp_client, spoke)["baseUnit"] == gross
    assert line["baseQty"] == pytest.approx(10)
    assert line["baseRate"] == pytest.approx(940)
    assert _current(erp_client, spoke) == pytest.approx(10)


def test_a_bill_for_a_known_item_still_converts_its_gross(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    spoke = _unique_name("KnownSpoke")
    _add_item(erp_client, spoke, base_unit="Pcs")

    body = _save_bill(
        erp_client,
        _unique_name("Vendor"),
        _unique_name("B"),
        "02/09/2026",
        spoke,
        10,
        gross,
        940,
    )

    assert body["data"]["bill"]["items"][0]["baseQty"] == pytest.approx(1440)
    assert _current(erp_client, spoke) == pytest.approx(1440)


def test_a_po_for_a_new_item_in_gross_stores_it_in_gross(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    spoke = _unique_name("NewSpoke")

    po_number = _save_po(
        erp_client, _unique_name("Vendor"), "01/09/2026", spoke, 200, gross, 94
    )

    pos = _ok(_rpc(erp_client, "getPOData"))["data"]
    line = next(p for p in pos if p["poNumber"] == po_number)["items"][0]
    assert _item(erp_client, spoke)["baseUnit"] == gross
    assert line["baseQty"] == pytest.approx(200)
    assert line["baseRate"] == pytest.approx(94)


# ─────────────────────────────────────────────────────────────────────────
# An older bill or PO never puts its price back as the current rate
# ─────────────────────────────────────────────────────────────────────────


def test_editing_an_older_bill_keeps_the_newer_bills_rate(erp_client):
    item = _unique_name("Bolt")
    _add_item(erp_client, item)
    vendor = _unique_name("Vendor")
    july = _unique_name("B")
    _save_bill(erp_client, vendor, july, "01/07/2026", item, 10, "Pcs", 90)
    _save_bill(
        erp_client, vendor, _unique_name("B"), "01/10/2026", item, 10, "Pcs", 100
    )
    assert _vendor_rate(erp_client, item, vendor) == 100

    _save_bill(
        erp_client,
        vendor,
        july,
        "01/07/2026",
        item,
        10,
        "Pcs",
        90,
        remarks="corrected remark",
        existingBillNumber=july,
        existingVendor=vendor,
    )

    assert _vendor_rate(erp_client, item, vendor) == 100


def test_a_backlog_bill_entered_late_keeps_the_newer_rate(erp_client):
    item = _unique_name("Bolt")
    _add_item(erp_client, item)
    vendor = _unique_name("Vendor")
    _save_bill(
        erp_client, vendor, _unique_name("B"), "01/10/2026", item, 10, "Pcs", 100
    )

    _save_bill(erp_client, vendor, _unique_name("B"), "01/07/2026", item, 10, "Pcs", 90)

    assert _vendor_rate(erp_client, item, vendor) == 100


def test_editing_the_newest_bill_still_updates_the_rate(erp_client):
    item = _unique_name("Bolt")
    _add_item(erp_client, item)
    vendor = _unique_name("Vendor")
    _save_bill(erp_client, vendor, _unique_name("B"), "01/07/2026", item, 10, "Pcs", 90)
    october = _unique_name("B")
    _save_bill(erp_client, vendor, october, "01/10/2026", item, 10, "Pcs", 100)

    _save_bill(
        erp_client,
        vendor,
        october,
        "01/10/2026",
        item,
        10,
        "Pcs",
        105,
        existingBillNumber=october,
        existingVendor=vendor,
    )

    assert _vendor_rate(erp_client, item, vendor) == 105


def test_editing_an_older_po_keeps_the_newer_bills_rate(erp_client):
    item = _unique_name("Bolt")
    _add_item(erp_client, item)
    vendor = _unique_name("Vendor")
    po_number = _save_po(erp_client, vendor, "01/07/2026", item, 10, "Pcs", 90)
    _save_bill(
        erp_client, vendor, _unique_name("B"), "01/10/2026", item, 10, "Pcs", 100
    )

    _save_po(
        erp_client,
        vendor,
        "01/07/2026",
        item,
        10,
        "Pcs",
        90,
        existingPoNumber=po_number,
        poNumber=po_number,
        poRemarks="edited",
    )

    assert _vendor_rate(erp_client, item, vendor) == 100


# ─────────────────────────────────────────────────────────────────────────
# Two lot lines for one part are added in one unit
# ─────────────────────────────────────────────────────────────────────────


def test_consolidation_adds_two_units_in_the_base_unit():
    def in_base_unit(component):
        factor = {"gross": 144, "pcs": 1, "": 1}[str(component["unit"]).lower()]
        return component["qty"] * factor, "Pcs"

    merged = production_service._consolidate_duplicate_components(
        [
            {
                "itemName": "Spoke",
                "size": "",
                "sourceType": "ITEM",
                "qty": 1,
                "colorGroup": "COMMON",
                "unit": "Gross",
            },
            {
                "itemName": "Spoke",
                "size": "",
                "sourceType": "ITEM",
                "qty": 40,
                "colorGroup": "COMMON",
                "unit": "Pcs",
            },
        ],
        in_base_unit,
    )

    assert len(merged) == 1
    assert merged[0]["qty"] == 184
    assert merged[0]["unit"] == "Pcs"


def test_a_lot_listing_one_part_in_gross_and_pcs_consumes_both(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    spoke = _unique_name("RimSpoke")
    _add_item(erp_client, spoke, base_unit="Pcs")

    row = _completed_lot(
        erp_client,
        [
            {"itemName": spoke, "qty": 1, "unit": gross, "sourceType": "ITEM"},
            {"itemName": spoke, "qty": 40, "unit": "", "sourceType": "ITEM"},
        ],
    )

    components = _lot_components(erp_client, row["lotNumber"])
    assert [(c["qty"], c["unit"]) for c in components] == [(184, "Pcs")]
    assert _current(erp_client, spoke) == pytest.approx(-184)


def test_a_lot_listing_one_part_in_units_that_cannot_be_added_is_refused(erp_client):
    kg = _unique_name("Kg")
    _add_unit(erp_client, kg, 1000, family="Weight")
    washer = _unique_name("Washer")
    _add_item(erp_client, washer, base_unit="Pcs")

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": _process(erp_client),
                "assignedTo": "Worker A",
                "qty": 1,
                "status": "Completed",
                "componentsConsumed": [
                    {"itemName": washer, "qty": 2, "unit": kg, "sourceType": "ITEM"},
                    {"itemName": washer, "qty": 5, "unit": "Pcs", "sourceType": "ITEM"},
                ],
            }
        ],
        mutation=True,
    )

    body = resp.get_json()
    assert body["success"] is False
    assert "can't be added together" in body["message"]
