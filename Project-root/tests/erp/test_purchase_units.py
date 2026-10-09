"""A line's unit and rate across POs and bills -- the Gross spokes.

Rim-assembly spokes are counted in pieces and bought by the Gross: a PO or
bill line in Gross converts (144 pieces each, the rate divided by 144), and
nothing else does. Pinned here:

- a unit anything still uses can't be deleted. It would silently stop
  converting: "Gross" was deleted on 2026-09-08, and three POs raised before
  it was added back stored 200 Gross as 200 pieces;
- Items Master keeps a vendor's rate in the unit it was quoted in, beside
  that unit as the Purchase Unit -- saves used to file the per-piece rate
  there, so a spoke bought at Rs 100 a Gross read as Rs 0.69 a Gross;
- rates offered to a new line are read against today's units, not the base
  rate stored with an old line.
"""

from __future__ import annotations

import uuid

import pytest


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _add_unit(client, name, factor):
    resp = _rpc(
        client,
        "saveUnit",
        [{"unitName": name, "family": "Count", "factorToBase": factor}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True


def _add_item(client, name, purchase_unit="Pcs"):
    resp = _rpc(
        client,
        "saveItem",
        [{"itemName": name, "itemBaseUnit": "Pcs", "itemPurchaseUnit": purchase_unit}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True


def _save_po(client, vendor, item, qty, unit, price):
    resp = _rpc(
        client,
        "savePO",
        [
            {
                "vendor": vendor,
                "poDate": "01/09/2026",
                "items": [{"name": item, "qty": qty, "unit": unit, "price": price}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body
    return body["data"]["poNumber"]


def _item(client, name):
    listed = _rpc(client, "getItemsData").get_json()["data"]
    return next(i for i in listed if i["name"] == name)


def _unit_names(client):
    return [u["unitName"] for u in _rpc(client, "getUnitsData").get_json()["data"]]


def _po_line(client, po_number):
    pos = _rpc(client, "getPOData").get_json()["data"]
    return next(p for p in pos if p["poNumber"] == po_number)["items"][0]


# ─────────────────────────────────────────────────────────────────────────
# A unit in use can't be deleted
# ─────────────────────────────────────────────────────────────────────────


def test_delete_unit_refuses_a_unit_an_item_is_bought_in(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    _add_item(erp_client, _unique_name("Spoke"), purchase_unit=gross)

    body = _rpc(erp_client, "deleteUnit", [gross], mutation=True).get_json()

    assert body["success"] is False
    assert "still used by 1 item" in body["message"]
    assert gross in _unit_names(erp_client)


def test_delete_unit_refuses_a_unit_a_po_line_is_in(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    _save_po(erp_client, _unique_name("Vendor"), _unique_name("Spoke"), 2, gross, 100)

    body = _rpc(erp_client, "deleteUnit", [gross], mutation=True).get_json()

    assert body["success"] is False
    assert "1 PO line" in body["message"]
    assert gross in _unit_names(erp_client)


def test_delete_units_bulk_deletes_the_unused_and_keeps_the_used(erp_client):
    used = _unique_name("Gross")
    free = _unique_name("Bundle")
    _add_unit(erp_client, used, 144)
    _add_unit(erp_client, free, 10)
    _add_item(erp_client, _unique_name("Spoke"), purchase_unit=used)

    body = _rpc(erp_client, "deleteUnitsBulk", [[used, free]], mutation=True).get_json()

    assert body["success"] is True
    assert body["message"] == f"Deleted 1 unit(s). Kept {used}: still in use."
    names = _unit_names(erp_client)
    assert used in names
    assert free not in names


# ─────────────────────────────────────────────────────────────────────────
# Items Master keeps a vendor's rate in the unit it was quoted in
# ─────────────────────────────────────────────────────────────────────────


def test_a_po_files_the_vendor_rate_in_the_unit_it_was_quoted_in(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    item = _unique_name("Spoke")
    _add_item(erp_client, item)
    vendor = _unique_name("WeBest")

    _save_po(erp_client, vendor, item, 200, gross, 100)

    record = _item(erp_client, item)
    assert record["purchaseUnit"] == gross
    rate = next(v for v in record["vendors"] if v["vendor"] == vendor)
    assert rate["rate"] == 100
    assert rate["ratePerBaseUnit"] == pytest.approx(100 / 144)


def test_a_bill_files_the_vendor_rate_in_the_unit_it_was_charged_in(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    item = _unique_name("Spoke")
    _add_item(erp_client, item)
    vendor = _unique_name("Mahadev")

    resp = _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("Bill"),
                "billDate": "02/09/2026",
                "items": [{"name": item, "qty": 10, "unit": gross, "price": 102}],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    record = _item(erp_client, item)
    assert record["purchaseUnit"] == gross
    rate = next(v for v in record["vendors"] if v["vendor"] == vendor)
    assert rate["rate"] == 102
    assert rate["ratePerBaseUnit"] == pytest.approx(102 / 144)


def test_syncing_vendors_from_po_history_keeps_the_quoted_unit(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    item = _unique_name("Spoke")
    _add_item(erp_client, item)
    vendor = _unique_name("Tushar")
    _save_po(erp_client, vendor, item, 200, gross, 85)

    resp = _rpc(erp_client, "syncVendorsFromPOHistory", [], mutation=True)
    assert resp.get_json()["success"] is True

    rate = next(v for v in _item(erp_client, item)["vendors"] if v["vendor"] == vendor)
    assert rate["rate"] == 85


# ─────────────────────────────────────────────────────────────────────────
# Rates offered to a new line are read against today's units
# ─────────────────────────────────────────────────────────────────────────


def test_po_and_bill_lines_carry_their_rate_per_base_unit(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    item = _unique_name("Spoke")
    _add_item(erp_client, item)
    vendor = _unique_name("WeBest")
    po_number = _save_po(erp_client, vendor, item, 200, gross, 100)
    bill_number = _unique_name("Bill")
    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": bill_number,
                "billDate": "02/09/2026",
                "items": [{"name": item, "qty": 30, "unit": gross, "price": 99}],
            }
        ],
        mutation=True,
    )

    assert _po_line(erp_client, po_number)["ratePerBaseUnit"] == pytest.approx(
        100 / 144
    )
    bills = _rpc(erp_client, "getBillData").get_json()["data"]
    line = next(b for b in bills if b["billNumber"] == bill_number)["items"][0]
    assert line["ratePerBaseUnit"] == pytest.approx(99 / 144)


def test_a_po_raised_while_its_unit_was_missing_is_matched_on_todays_units(erp_client):
    # The unit doesn't exist yet: the PO stores 200 x Rs 100 unconverted, as
    # POs 1233-1235 did on 2026-09-09.
    gross = _unique_name("Gross")
    item = _unique_name("Spoke")
    _add_item(erp_client, item)
    vendor = _unique_name("Tushar")
    po_number = _save_po(erp_client, vendor, item, 200, gross, 100)
    _add_unit(erp_client, gross, 144)

    assert _po_line(erp_client, po_number)["ratePerBaseUnit"] == pytest.approx(
        100 / 144
    )

    # A bill at the PO's own rate, in the PO's own unit, agrees with it.
    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [
            vendor,
            [{"rowIndex": "r1", "name": item, "qty": 1, "unit": gross, "price": 100}],
            None,
        ],
    )
    (row,) = resp.get_json()["data"]
    (allocation,) = row["allocations"]
    assert allocation["poNumber"] == po_number
    assert "rateConflict" not in allocation


def test_a_rate_conflict_offers_the_po_rate_in_the_bill_lines_unit(erp_client):
    gross = _unique_name("Gross")
    _add_unit(erp_client, gross, 144)
    item = _unique_name("Spoke")
    _add_item(erp_client, item)
    vendor = _unique_name("WeBest")
    _save_po(erp_client, vendor, item, 200, gross, 100)

    resp = _rpc(
        erp_client,
        "suggestPoAllocations",
        [
            vendor,
            [
                {
                    "rowIndex": "r1",
                    "name": item,
                    "qty": 1440,
                    "unit": "Pcs",
                    "price": 0.75,
                }
            ],
            None,
        ],
    )
    (row,) = resp.get_json()["data"]
    conflict = row["allocations"][0]["rateConflict"]
    assert conflict["poRate"] == 100
    assert conflict["poUnit"] == gross
    assert conflict["poRateInBillUnit"] == pytest.approx(0.6944)
    assert conflict["billUnit"] == "Pcs"
