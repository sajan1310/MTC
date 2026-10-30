"""The Audit report (audit_service): every check finds what it is for, the
ranking is stable, and a run writes nothing but its own two tables."""

from __future__ import annotations

import uuid
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import psycopg2.extras

import database
from app.erp.services import (
    audit_entries,
    audit_service,
    bill_service,
    bom_service,
    contractors_service,
    dashboard_service,
    items_service,
    ledger_audit_service,
    po_service,
    stock_service,
    warehouse_service,
)


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _ok(resp):
    body = resp.get_json()
    assert body["success"] is True, body.get("message")
    return body["data"]


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _process(client, **overrides):
    payload = {
        "processName": _unique("AuditProcess"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique("AuditOutput"),
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
    data = _ok(_rpc(client, "saveProcess", [payload], mutation=True))
    return payload, data["processId"]


def _stage(client, upstream_qty):
    """An upstream process holding pool stock and a downstream one using it."""
    up, up_id = _process(client)
    _ok(
        _rpc(
            client,
            "saveWarehousePoolOpening",
            [{"processId": up_id, "qty": upstream_qty}],
            mutation=True,
        )
    )
    down, down_id = _process(
        client,
        components=[
            {
                "itemName": up["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "",
            }
        ],
    )
    return up["outputItemName"], up_id, down_id


def _lot(client, down_id, up_name, qty):
    _ok(
        _rpc(
            client,
            "saveProduction",
            [
                {
                    "processId": down_id,
                    "assignedTo": "Worker A",
                    "status": "Completed",
                    "qty": qty,
                    "componentsConsumed": [
                        {"itemName": up_name, "qty": qty, "sourceType": "POOL"}
                    ],
                }
            ],
            mutation=True,
        )
    )


def _count(client, name, proc_id, qty, colour=""):
    _ok(
        _rpc(
            client,
            "adjustWarehousePoolManually",
            [name, proc_id, "", colour, qty, "physical recount"],
            mutation=True,
        )
    )


def _findings(check=None, item=None):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute("SET TRANSACTION READ ONLY")
        found, errors = audit_service.compute_findings(cur)
        conn.rollback()
    assert errors == []
    return [
        f
        for f in found
        if (check is None or f["check"] == check)
        and (item is None or f["item"].lower() == item.lower())
    ]


# ── Integrity ──────────────────────────────────────────────────────────────


def test_a_pool_figure_that_disagrees_with_a_fresh_calculation_is_reported(
    erp_admin_client,
):
    up, up_id = _process(erp_admin_client)
    name = up["outputItemName"]
    _ok(
        _rpc(
            erp_admin_client,
            "saveWarehousePoolOpening",
            [{"processId": up_id, "qty": 10}],
            mutation=True,
        )
    )
    assert _findings("pool_cache_stale", name) == []

    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.warehouse_pool SET available_qty = 99 WHERE output_item_name = %s",
            (name,),
        )
    [f] = _findings("pool_cache_stale", name)
    assert f["kind"] == "integrity"
    assert "shows 99, calculates 10" in f["detail"]


def test_the_stock_page_and_the_ledger_replay_must_agree(erp_admin_client, monkeypatch):
    item = _unique("AuditItem")
    _ok(_rpc(erp_admin_client, "saveItem", [{"itemName": item}], mutation=True))
    _ok(
        _rpc(
            erp_admin_client,
            "saveBill",
            [
                {
                    "vendor": _unique("Vendor"),
                    "billNumber": _unique("BILL"),
                    "billDate": "01/01/2026",
                    "items": [{"name": item, "qty": 7, "price": 5}],
                }
            ],
            mutation=True,
        )
    )
    assert _findings("stock_paths_disagree", item) == []

    real = stock_service._get_stock_terms

    def drifted(cur, keys=None):
        terms = real(cur, keys)
        terms.moved[f"{item.lower()}|"] += 5
        return terms

    monkeypatch.setattr(stock_service, "_get_stock_terms", drifted)
    [f] = _findings("stock_paths_disagree", item)
    assert f["kind"] == "integrity"
    assert "Stock page 12, ledger replay 7" in f["detail"]


# ── Entry ──────────────────────────────────────────────────────────────────


def _bucket(name, colour, avail, tag="", process="P"):
    return {
        "outputItemName": name,
        "productTag": tag,
        "color": colour,
        "producedQty": max(avail, 0.0),
        "consumedQty": max(-avail, 0.0),
        "processId": process,
    }


def test_negatives_are_triaged_mixed_bundle_attribution_or_shortfall():
    buckets = {}
    for b in (
        _bucket("Bike", "Red", -5, tag="BK", process="FINAL"),
        _bucket("Bike", "Blue", 8, tag="BK", process="FINAL"),
        _bucket("Frame", "Pink", -2),
        _bucket("Frame", "Green", 10),
        _bucket("Rim", "Black", -3),
    ):
        buckets[
            (b["outputItemName"].lower(), b["productTag"].lower(), b["color"].lower())
        ] = b
    ctx = SimpleNamespace(
        buckets=buckets,
        live_events=[],
        is_final_bucket=lambda key, b: b["processId"] == "FINAL",
    )
    by_item = {
        f["item"]: (f["check"], f["kind"])
        for f in audit_service._check_negative_buckets(ctx)
    }
    assert by_item == {
        "Bike": ("negative_colour_mixed_bundle", "info"),
        "Frame": ("negative_colour_attribution", "entry"),
        "Rim": ("negative_shortfall", "entry"),
    }


def test_a_labor_bill_typed_into_the_pool_by_hand_is_reported(erp_admin_client):
    proc, proc_id = _process(erp_admin_client)
    bill_number = _unique("LABOR")
    _ok(
        _rpc(
            erp_admin_client,
            "saveBill",
            [
                {
                    "billType": "LABOR",
                    "vendor": _unique("Contractor"),
                    "billNumber": bill_number,
                    "billDate": date.today().strftime("%d/%m/%Y"),
                    "items": [
                        {"processName": proc["processName"], "qty": 25, "price": 9}
                    ],
                }
            ],
            mutation=True,
        )
    )
    _count(erp_admin_client, proc["outputItemName"], proc_id, 25)

    [f] = [
        f
        for f in _findings("labor_bill_without_lot")
        if any(bill_number in r for r in f["refs"])
    ]
    assert f["evidence"]["handEdits"] == 1
    assert "typed in rather than made by a lot" in f["detail"]


def test_an_edit_made_to_let_a_lot_through_is_reported(erp_admin_client):
    up_name, up_id, down_id = _stage(erp_admin_client, 500)
    _count(erp_admin_client, up_name, up_id, 12)
    _lot(erp_admin_client, down_id, up_name, 12)

    [f] = _findings("edit_to_let_lot_through", up_name)
    assert f["kind"] == "entry"
    assert "set to 12" in f["title"]


def test_a_zeroed_negative_is_reported_only_while_it_still_governs(erp_admin_client):
    up_name, up_id, down_id = _stage(erp_admin_client, 5)
    _lot(erp_admin_client, down_id, up_name, 12)
    _count(erp_admin_client, up_name, up_id, 0)

    [f] = _findings("negative_set_to_zero", up_name)
    assert "a negative of -7 was set to 0" in f["title"]

    # A later count replaces it, so it no longer shapes today's figure.
    _count(erp_admin_client, up_name, up_id, 4)
    assert _findings("negative_set_to_zero", up_name) == []


def test_a_unit_missing_from_the_units_master_is_reported(erp_admin_client):
    unit = _unique("Crate")
    item = _unique("AuditItem")
    _ok(_rpc(erp_admin_client, "saveItem", [{"itemName": item}], mutation=True))
    _ok(
        _rpc(
            erp_admin_client,
            "saveBill",
            [
                {
                    "vendor": _unique("Vendor"),
                    "billNumber": _unique("BILL"),
                    "billDate": "01/01/2026",
                    "items": [{"name": item, "qty": 3, "price": 5, "unit": unit}],
                }
            ],
            mutation=True,
        )
    )
    titles = [f["title"] for f in _findings("unit_not_in_master")]
    assert f'Unit "{unit.lower()}" is not in the Units master' in titles


# ── Module checks ──────────────────────────────────────────────────────────


def _mentioning(check, text, found=None):
    """Findings of `check` that name `text` anywhere a person would read."""
    if found is None:
        found = _findings(check)
    return [
        f
        for f in found
        if f["check"] == check
        and (
            text in f["title"]
            or text in f["detail"]
            or any(text in r for r in f["refs"])
        )
    ]


def _lot_component(client, qty):
    item = _unique("AuditPart")
    _ok(_rpc(client, "saveItem", [{"itemName": item}], mutation=True))
    return [{"itemName": item, "qty": qty, "sourceType": "ITEM"}]


def _completed_lot(client, proc_id, qty, contractor, status="Completed"):
    _ok(
        _rpc(
            client,
            "saveProduction",
            [
                {
                    "processId": proc_id,
                    "assignedTo": contractor,
                    "status": status,
                    "qty": qty,
                    "componentsConsumed": _lot_component(client, qty),
                }
            ],
            mutation=True,
        )
    )
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT lot_number FROM erp.production WHERE process_id = %s "
            "AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
            (proc_id,),
        )
        return cur.fetchone()[0]


def _rate_card(contractor, process_type, size, rate):
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.contractor_rates (contractor_name, process_type, size, rate_per_unit) "
            "VALUES (%s, %s, %s, %s)",
            (contractor, process_type, size, rate),
        )


def test_a_lot_payable_that_does_not_match_its_rate_is_a_code_bug(erp_admin_client):
    _proc, proc_id = _process(erp_admin_client)
    lot = _completed_lot(erp_admin_client, proc_id, 10, "Worker A")
    assert _mentioning("lot_payable_formula", lot) == []

    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.production SET contractor_rate = 2, contractor_payable = 50 "
            "WHERE lot_number = %s",
            (lot,),
        )
    [f] = _mentioning("lot_payable_formula", lot)
    assert f["kind"] == "integrity"
    assert "= Rs 20.00, but the lot holds Rs 50.00" in f["detail"]


def test_lots_of_a_rate_card_contractor_that_carry_no_rate_are_reported(
    erp_admin_client,
):
    contractor = _unique("Contractor")
    ptype = _unique("AuditType")
    proc, proc_id = _process(erp_admin_client, processType=ptype)
    # Paid by rate card, but not for this work.
    _rate_card(contractor, "Some Other Work", "General", 3)
    lot = _completed_lot(erp_admin_client, proc_id, 40, contractor)

    [f] = _mentioning("lot_without_rate", contractor)
    assert lot in f["refs"]
    assert f"none for {ptype}" in f["detail"]
    assert f["qty"] == 40

    # A rate card added since: the lot keeps the 0 it was saved with, and
    # the money missing from the contractor's balance is named.
    size = contractors_service._get_size_from_output_item_name(proc["outputItemName"])
    _rate_card(contractor, ptype, size, 2.5)
    [f] = _mentioning("lot_without_rate", contractor)
    assert "about Rs 100.00 is missing" in f["detail"]

    # A contractor with no rate cards at all is paid some other way.
    other = _unique("InHouse")
    _completed_lot(erp_admin_client, proc_id, 5, other)
    assert _mentioning("lot_without_rate", other) == []


def test_the_contractor_ledger_and_each_account_statement_must_agree(
    erp_admin_client, monkeypatch
):
    contractor = _unique("Contractor")
    ptype = _unique("AuditType")
    proc, proc_id = _process(erp_admin_client, processType=ptype)
    size = contractors_service._get_size_from_output_item_name(proc["outputItemName"])
    _rate_card(contractor, ptype, size, 2)
    _completed_lot(erp_admin_client, proc_id, 10, contractor)

    found, errors = audit_service.compute_external_findings()
    assert errors == []
    assert _mentioning("contractor_ledger_paths_disagree", contractor, found) == []

    real = contractors_service.get_contractor_account_ledger

    def drifted(name):
        res = real(name)
        if name.lower() == contractor.lower():
            res["data"]["totalPayable"] += 7
        return res

    monkeypatch.setattr(contractors_service, "get_contractor_account_ledger", drifted)
    found, _errors = audit_service.compute_external_findings()
    [f] = _mentioning("contractor_ledger_paths_disagree", contractor, found)
    assert f["kind"] == "integrity"
    assert "Rs 20.00 earned" in f["detail"] and "Rs 27.00 earned" in f["detail"]


def test_bill_lines_that_miss_their_po_or_charge_above_it_are_reported(
    erp_admin_client,
):
    vendor = _unique("Vendor")
    ordered, other = _unique("AuditItem"), _unique("AuditItem")
    for item in (ordered, other):
        _ok(_rpc(erp_admin_client, "saveItem", [{"itemName": item}], mutation=True))
    po = _ok(
        _rpc(
            erp_admin_client,
            "savePO",
            [
                {
                    "vendor": vendor,
                    "poDate": "01/10/2026",
                    "items": [
                        {"name": ordered, "qty": 100, "unit": "Pcs", "price": 10}
                    ],
                }
            ],
            mutation=True,
        )
    )["poNumber"]
    bill = _unique("BILL")
    _ok(
        _rpc(
            erp_admin_client,
            "saveBill",
            [
                {
                    "vendor": vendor,
                    "billNumber": bill,
                    "billDate": "05/10/2026",
                    "items": [
                        {
                            "name": ordered,
                            "qty": 50,
                            "unit": "Pcs",
                            "price": 12,
                            "po": po,
                        },
                        {"name": other, "qty": 30, "unit": "Pcs", "price": 4, "po": po},
                    ],
                }
            ],
            mutation=True,
        )
    )
    found = _findings()

    [rate] = _mentioning("bill_rate_above_po", f"PO {po}", found)
    assert "Rs 100.00 above PO" in rate["title"]
    assert "Rs 12.00 a Pcs against Rs 10.00 on the PO, x 50" in rate["detail"]

    [miss] = _mentioning("bill_po_line_unmatched", bill, found)
    assert miss["item"] == other
    assert "These 30 base units fulfil no line" in miss["detail"]


def test_a_stored_base_quantity_that_no_longer_converts_the_same_is_reported(
    erp_admin_client,
):
    item = _unique("AuditItem")
    _ok(_rpc(erp_admin_client, "saveItem", [{"itemName": item}], mutation=True))
    bill = _unique("BILL")
    _ok(
        _rpc(
            erp_admin_client,
            "saveBill",
            [
                {
                    "vendor": _unique("Vendor"),
                    "billNumber": bill,
                    "billDate": "01/01/2026",
                    "items": [{"name": item, "qty": 4, "price": 5, "unit": "Pcs"}],
                }
            ],
            mutation=True,
        )
    )
    assert _findings("stored_base_qty_stale", item) == []

    # As if the units were different when it was saved: 4 Pcs held as 400.
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.bill_lines SET base_qty = 400 WHERE item_name = %s", (item,)
        )
    [f] = _findings("stored_base_qty_stale", item)
    assert "saved at 100 Pcs each, today 1" in f["title"]
    assert "Items Stock counts the saved figure: 400 Pcs" in f["detail"]
    assert f["qty"] == 396


def test_an_item_below_zero_in_items_stock_is_reported(erp_admin_client):
    item = _unique("AuditItem")
    _ok(_rpc(erp_admin_client, "saveItem", [{"itemName": item}], mutation=True))
    _ok(
        _rpc(
            erp_admin_client,
            "saveIssueStock",
            [
                {
                    "issuedTo": "Line 1",
                    "date": "02/01/2026",
                    "items": [{"name": item, "qty": 6, "unit": "Pcs"}],
                }
            ],
            mutation=True,
        )
    )
    [f] = _findings("negative_item_stock", item)
    assert f["title"].endswith("is -6 in Items Stock")
    assert f["qty"] == 6


def test_dispatch_amounts_and_their_client_are_checked(erp_admin_client):
    number = _unique("D")
    client = _unique("Client")
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.dispatch_headers (dispatch_number, dispatch_date, client_name) "
            "VALUES (%s, CURRENT_DATE, %s) RETURNING id",
            (number, client),
        )
        header_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO erp.dispatch_lines (header_id, product_id, product_name, qty, rate, amount) "
            "VALUES (%s, 'P1', 'Bike', 5, 100, 450)",
            (header_id,),
        )
    found = _findings()
    [f] = _mentioning("dispatch_amount_formula", number, found)
    assert f["kind"] == "integrity"
    assert "5 x Rs 100.00 held as Rs 450.00" in f["detail"]
    [p] = _mentioning("party_not_in_master", client, found)
    assert "Named on 1 dispatch(s)" in p["detail"]


def test_a_receipt_whose_lines_do_not_add_up_is_a_code_bug(erp_admin_client):
    _proc, proc_id = _process(erp_admin_client)
    lot = _completed_lot(
        erp_admin_client, proc_id, 20, "Worker A", status="In Progress"
    )
    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT id FROM erp.production WHERE lot_number = %s", (lot,))
        lot_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO erp.production_receipts (production_id, receipt_date, qty) "
            "VALUES (%s, CURRENT_DATE, 8) RETURNING id",
            (lot_id,),
        )
        receipt_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO erp.production_receipt_lines (receipt_id, qty) VALUES (%s, 5)",
            (receipt_id,),
        )
    [f] = _mentioning("receipt_total_mismatch", lot)
    assert f["kind"] == "integrity"
    assert "says 8 came back, but its colour lines add up to 5" in f["detail"]


def test_a_document_dated_after_today_is_reported(erp_admin_client):
    item = _unique("AuditItem")
    bill = _unique("BILL")
    _ok(_rpc(erp_admin_client, "saveItem", [{"itemName": item}], mutation=True))
    _ok(
        _rpc(
            erp_admin_client,
            "saveBill",
            [
                {
                    "vendor": _unique("Vendor"),
                    "billNumber": bill,
                    "billDate": f"01/01/{date.today().year + 1}",
                    "items": [{"name": item, "qty": 1, "price": 5}],
                }
            ],
            mutation=True,
        )
    )
    [f] = [
        f
        for f in _findings("future_dated")
        if f["area"] == "bills" and any(bill in r for r in f["refs"])
    ]
    assert "Bill(s) dated after today" in f["title"]


def test_the_old_over_consumption_check_is_left_out_and_a_failing_check_is_reported(
    monkeypatch,
):
    monkeypatch.setattr(
        ledger_audit_service,
        "compute_internal_ledger_audit_findings",
        lambda: {
            "findings": [
                {
                    "type": "over_consumed_item",
                    "itemName": "Opening Stock Item",
                    "size": "",
                },
                {
                    "type": "over_billed_po_line",
                    "poNumber": "9",
                    "vendor": "V",
                    "itemName": "Rim",
                    "size": "",
                    "unit": "Pcs",
                    "orderedQty": 1,
                    "billedQty": 3,
                    "overBy": 2,
                },
            ]
        },
    )

    def broken(names=None):
        raise RuntimeError("ledger unreachable")

    monkeypatch.setattr(audit_service, "_contractor_ledger_gaps", broken)
    found, errors = audit_service.compute_external_findings()
    checks = {f["check"] for f in found}
    assert "over_billed_po_line" in checks
    assert "over_consumed_item" not in checks
    assert errors == [
        {"check": "_external_contractor_findings", "error": "ledger unreachable"}
    ]

    summary = audit_service.summarise(audit_service.prioritise(found), errors)
    assert summary["integrityOk"] is False
    by_area = {c["area"]: c for c in summary["coverage"]}
    assert [c["area"] for c in summary["coverage"]] == [
        a for a, _l in audit_service._AREAS
    ]
    assert by_area["contractors"]["failed"] == 1
    assert all(c["checks"] > 0 for c in summary["coverage"])


# ── Stock entries: did each reach Stock, and is it right? ──────────────────


def _item(client, size=""):
    item = _unique("AuditItem")
    _ok(_rpc(client, "saveItem", [{"itemName": item, "itemSize": size}], mutation=True))
    return item


def _bill(client, items, vendor=None, number=None, day="01/01/2026", **form):
    vendor = vendor or _unique("Vendor")
    number = number or _unique("BILL")
    _ok(
        _rpc(
            client,
            "saveBill",
            [
                {
                    "vendor": vendor,
                    "billNumber": number,
                    "billDate": day,
                    "items": items,
                    **form,
                }
            ],
            mutation=True,
        )
    )
    return vendor, number


def _issue(client, item, qty, day, issued_to="Line 1"):
    _ok(
        _rpc(
            client,
            "saveIssueStock",
            [
                {
                    "issuedTo": issued_to,
                    "date": day,
                    "items": [{"name": item, "qty": qty, "unit": "Pcs"}],
                }
            ],
            mutation=True,
        )
    )


def _return(client, vendor, item, qty, price, bill="", day="10/01/2026"):
    _ok(
        _rpc(
            client,
            "saveReturn",
            [
                {
                    "vendor": vendor,
                    "billNumber": bill,
                    "returnDate": day,
                    "items": [{"name": item, "qty": qty, "price": price}],
                }
            ],
            mutation=True,
        )
    )


def _lot_with(client, proc_id, qty, components, status="Completed"):
    _ok(
        _rpc(
            client,
            "saveProduction",
            [
                {
                    "processId": proc_id,
                    "assignedTo": "Worker A",
                    "status": status,
                    "qty": qty,
                    "componentsConsumed": components,
                }
            ],
            mutation=True,
        )
    )
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT lot_number FROM erp.production WHERE process_id = %s "
            "AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
            (proc_id,),
        )
        return cur.fetchone()[0]


def _today() -> str:
    return date.today().strftime("%d/%m/%Y")


def test_every_item_is_rebuilt_from_its_entries_and_must_match_the_stock_page(
    erp_admin_client, monkeypatch
):
    client = erp_admin_client
    item = _item(client)
    _proc, proc_id = _process(client)
    vendor, bill = _bill(
        client, [{"name": item, "qty": 100, "price": 5, "unit": "Pcs"}]
    )
    _issue(client, item, 10, "02/01/2026")
    _ok(
        _rpc(
            client,
            "saveWastage",
            [
                {
                    "date": "03/01/2026",
                    "items": [
                        {"name": item, "qty": 5, "unit": "Pcs", "reason": "Bent"}
                    ],
                }
            ],
            mutation=True,
        )
    )
    _return(client, vendor, item, 3, 5, bill=bill, day="04/01/2026")
    _lot_with(client, proc_id, 7, [{"itemName": item, "qty": 7, "sourceType": "ITEM"}])
    assert _findings("stock_statement_mismatch", item) == []

    # A count resets it: what came before is inside the count, what follows
    # moves it.
    _ok(
        _rpc(
            client,
            "adjustStockManually",
            [item, "", 60, "physical recount"],
            mutation=True,
        )
    )
    _issue(client, item, 4, _today())
    assert _findings("stock_statement_mismatch", item) == []

    real = stock_service._get_stock_terms

    def drifted(cur, keys=None):
        terms = real(cur, keys)
        terms.moved[f"{item.lower()}|"] += 5
        return terms

    monkeypatch.setattr(stock_service, "_get_stock_terms", drifted)
    [f] = _findings("stock_statement_mismatch", item)
    assert f["kind"] == "integrity"
    assert "Stock page 61, rebuilt from its entries 56" in f["title"]
    assert "counted 60" in f["detail"]


def test_a_run_says_what_it_checked(erp_admin_client):
    item = _item(erp_admin_client)
    _bill(erp_admin_client, [{"name": item, "qty": 2, "price": 5, "unit": "Pcs"}])
    stats = {}
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute("SET TRANSACTION READ ONLY")
        audit_service.compute_findings(cur, stats=stats)
        conn.rollback()
    found, errors = audit_service.compute_external_findings(stats)
    summary = audit_service.summarise(audit_service.prioritise(found), errors, stats)

    entries = {e["area"]: e for e in summary["stockEntries"]}
    assert set(entries) == {"production", "bills", "issues", "returns", "wastage"}
    assert entries["bills"]["lines"] >= 1
    assert summary["stockStatement"]["items"] >= 1
    ledgers = {row["label"]: row for row in summary["ledgers"]}
    assert set(ledgers) == {
        "Bill Ledger",
        "Item Ledger",
        "Warehouse Pool",
        "Production lots",
        "Issue Stock",
        "Wastage Ledger",
        "Returns Ledger",
        "PO Ledger",
        "Party ledgers",
        "Dispatch Ledger",
        "Contractor Ledger",
    }
    assert "lines on" in ledgers["Bill Ledger"]["checked"]
    assert ledgers["Warehouse Pool"]["checked"].endswith(" buckets")
    assert all(row["checked"] for row in summary["ledgers"])


def test_a_ledger_only_line_no_count_holds_is_in_no_stock_figure(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    _vendor, bill = _bill(
        client,
        [{"name": item, "qty": 40, "price": 5, "unit": "Pcs"}],
        day=_today(),
        excludeFromStockKeys=[f"{item.lower()}|"],
    )
    [f] = _mentioning("bill_ledger_only_uncounted", bill)
    assert f["qty"] == 40
    assert "in no stock figure" in f["detail"]
    assert f["area"] == "bills"

    _ok(_rpc(client, "adjustStockManually", [item, "", 40, "count"], mutation=True))
    assert _mentioning("bill_ledger_only_uncounted", bill) == []


def test_a_bill_with_no_price_or_far_from_the_usual_one_is_reported(erp_admin_client):
    client = erp_admin_client
    free = _item(client)
    _vendor, bill = _bill(client, [{"name": free, "qty": 4, "price": 0, "unit": "Pcs"}])
    [f] = _mentioning("bill_line_no_price", bill)
    assert free in f["detail"]

    # The wrong price, or the wrong unit: Rs 1 a piece against Rs 40.
    item = _item(client)
    _bill(client, [{"name": item, "qty": 10, "price": 40, "unit": "Pcs"}])
    _bill(client, [{"name": item, "qty": 10, "price": 1, "unit": "Pcs"}])
    [f] = _findings("bill_rate_spread", item)
    assert "differ 40 times over" in f["title"]


def test_the_same_bill_under_two_numbers_is_reported(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    vendor, first = _bill(
        client, [{"name": item, "qty": 9, "price": 5, "unit": "Pcs"}], day="01/02/2026"
    )
    _vendor, second = _bill(
        client,
        [{"name": item, "qty": 9, "price": 5, "unit": "Pcs"}],
        vendor=vendor,
        day="03/02/2026",
    )
    _vendor, other = _bill(
        client,
        [{"name": item, "qty": 8, "price": 5, "unit": "Pcs"}],
        vendor=vendor,
        day="03/02/2026",
    )
    [f] = _mentioning("possible_duplicate_bill", first)
    assert second in f["title"]
    assert other not in f["title"]


def test_a_stored_line_value_that_differs_from_its_base_value_is_a_code_bug(
    erp_admin_client,
):
    item = _item(erp_admin_client)
    _vendor, bill = _bill(
        erp_admin_client, [{"name": item, "qty": 4, "price": 5, "unit": "Pcs"}]
    )
    assert _findings("line_value_mismatch", item) == []
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.bill_lines SET base_rate = 6 WHERE item_name = %s", (item,)
        )
    [f] = _findings("line_value_mismatch", item)
    assert f["kind"] == "integrity"
    assert (
        "Rs 20.00 as entered" in f["detail"] and "Rs 24.00 in base units" in f["detail"]
    )


def test_a_lot_against_its_recipe(erp_admin_client):
    client = erp_admin_client
    nut = _item(client)
    bolt = _item(client, size="14 inch")
    _ok(
        _rpc(
            client,
            "saveItem",
            [{"itemName": bolt, "itemSize": "20 inch"}],
            mutation=True,
        )
    )
    swap = _item(client)
    _proc, proc_id = _process(
        client,
        components=[
            {
                "itemName": nut,
                "size": "",
                "qtyPerUnit": 2,
                "sourceType": "ITEM",
                "colorGroup": "",
            },
            {
                "itemName": bolt,
                "size": "14 inch",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "",
            },
        ],
    )

    def comp(name, qty, size=""):
        return {"itemName": name, "size": size, "qty": qty, "sourceType": "ITEM"}

    as_written = _lot_with(
        client, proc_id, 10, [comp(nut, 20), comp(bolt, 10, "14 inch")]
    )
    short = _lot_with(client, proc_id, 10, [comp(nut, 5), comp(bolt, 10, "14 inch")])
    other_size = _lot_with(
        client, proc_id, 10, [comp(nut, 20), comp(bolt, 10, "20 inch")]
    )
    substituted = _lot_with(client, proc_id, 10, [comp(nut, 20), comp(swap, 10)])

    found = _findings()
    [f] = [x for x in found if x["check"] == "lot_short_of_recipe" and x["item"] == nut]
    assert f["refs"] == [short]
    assert "15 less than the recipe" in f["title"]

    [f] = [
        x for x in found if x["check"] == "lot_used_other_size" and x["item"] == bolt
    ]
    assert f["refs"] == [other_size]
    assert "size 14 inch" in f["detail"] and "20 inch instead" in f["detail"]

    named = " ".join(
        " ".join(x["refs"])
        for x in found
        if x["check"] in ("lot_short_of_recipe", "lot_used_other_size")
    )
    assert as_written not in named and substituted not in named


def test_a_lot_older_than_its_recipe_is_not_judged_by_it(erp_admin_client):
    client = erp_admin_client
    nut = _item(client)
    proc, proc_id = _process(
        client,
        components=[
            {
                "itemName": nut,
                "size": "",
                "qtyPerUnit": 2,
                "sourceType": "ITEM",
                "colorGroup": "",
            }
        ],
    )
    lot = _lot_with(
        client,
        proc_id,
        10,
        [{"itemName": nut, "size": "", "qty": 1, "sourceType": "ITEM"}],
    )
    assert [f["refs"] for f in _findings("lot_short_of_recipe", nut)] == [[lot]]

    # The recipe changed after the lot was entered.
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.process_master SET updated_at = NOW() + interval '1 hour' "
            "WHERE process_id = %s",
            (proc_id,),
        )
    assert _findings("lot_short_of_recipe", nut) == []


def _tampered(check, *drop_types):
    """Run `check` as if the pool's replay had lost those kinds of line."""
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute("SET TRANSACTION READ ONLY")
        ctx = audit_service._Context(cur)
        ctx.all_events = [e for e in ctx.all_events if e["type"] not in drop_types]
        found = check(ctx)
        conn.rollback()
    return found


def test_a_lot_must_land_on_its_pool_buckets(erp_admin_client):
    client = erp_admin_client
    up_name, _up_id, down_id = _stage(client, 50)
    _lot(client, down_id, up_name, 12)
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT lot_number FROM erp.production WHERE process_id = %s", (down_id,)
        )
        lot = cur.fetchone()[0]

    clean = _findings()
    for check in (
        "lot_not_credited",
        "lot_pool_debit_mismatch",
        "lot_credit_misplaced",
    ):
        assert _mentioning(check, lot, clean) == []

    [f] = _mentioning(
        "lot_not_credited",
        lot,
        _tampered(audit_entries._check_lot_entries, "Production Credit"),
    )
    assert f["kind"] == "integrity"
    assert f"{lot} made 12, the Warehouse Pool credited 0" == f["title"]

    [f] = _mentioning(
        "lot_pool_debit_mismatch",
        lot,
        _tampered(
            audit_entries._check_lot_entries,
            "Production Consumption",
            "Colour-agnostic Consumption",
        ),
    )
    assert f"used 12 of {up_name}, the Warehouse Pool took off 0" in f["title"]

    # A credit under another item entirely.
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute("SET TRANSACTION READ ONLY")
        ctx = audit_service._Context(cur)
        for e in ctx.all_events:
            if e["type"] == "Production Credit" and e["ref"] == lot:
                e["bucketKey"] = ("some other item", "", "")
        found = audit_entries._check_lot_entries(ctx)
        conn.rollback()
    [f] = _mentioning("lot_credit_misplaced", lot, found)
    assert "some other item" in f["detail"]


def test_a_non_final_lot_with_its_own_name_still_belongs_on_its_process_output(
    erp_admin_client,
):
    client = erp_admin_client
    item = _item(client)
    proc, proc_id = _process(client)
    _ok(
        _rpc(
            client,
            "saveProduction",
            [
                {
                    "processId": proc_id,
                    "assignedTo": "Worker A",
                    "status": "Completed",
                    "qty": 5,
                    "outputItemName": proc["outputItemName"] + " (Flipkart)",
                    "componentsConsumed": [
                        {"itemName": item, "qty": 5, "sourceType": "ITEM"}
                    ],
                }
            ],
            mutation=True,
        )
    )
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT lot_number FROM erp.production WHERE process_id = %s", (proc_id,)
        )
        lot = cur.fetchone()[0]
    assert _mentioning("lot_credit_misplaced", lot) == []


def test_goods_issued_and_also_used_by_a_lot_are_reported(erp_admin_client):
    client = erp_admin_client
    _proc, proc_id = _process(client)
    same = _item(client)
    lot = _lot_with(
        client, proc_id, 30, [{"itemName": same, "qty": 30, "sourceType": "ITEM"}]
    )
    _issue(client, same, 30, _today(), issued_to="Painter One")
    [f] = _findings("issued_and_used_by_lot", same)
    assert lot in f["refs"]
    assert "used exactly that" in f["detail"]
    assert f["area"] == "issues"

    # Only what matched a lot may be doubled, not all that was issued.
    _issue(client, same, 12, "02/01/2026")
    [f] = _findings("issued_and_used_by_lot", same)
    assert f["title"].endswith(": 30 may have come off Stock twice")

    partly = _item(client)
    _lot_with(
        client, proc_id, 12, [{"itemName": partly, "qty": 12, "sourceType": "ITEM"}]
    )
    _issue(client, partly, 30, _today())
    assert _findings("issued_and_used_by_lot", partly) == []
    [f] = _findings("issued_item_also_used_by_lots", partly)
    assert "1 lot(s)" in f["detail"]


def test_an_issue_must_land_in_its_vendors_ledger(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    stem = uuid.uuid4().hex[:8]
    vendor = f"A.M. Coat {stem}"
    _bill(client, [{"name": item, "qty": 50, "price": 5, "unit": "Pcs"}], vendor=vendor)

    _issue(client, item, 1, _today(), issued_to=vendor)
    assert _mentioning("issue_not_in_vendor_ledger", vendor) == []

    _issue(client, item, 2, _today(), issued_to=f"AM COAT {stem}".upper())
    [f] = _mentioning("issue_not_in_vendor_ledger", vendor)
    assert f"{vendor}'s Vendor Ledger" in f["title"]
    [f] = _mentioning("issued_to_variants", vendor.split()[-1].upper())
    assert f["area"] == "issues"


def test_returns_are_checked_against_their_bill(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    vendor, bill = _bill(
        client,
        [{"name": item, "qty": 10, "price": 50, "unit": "Pcs"}],
        day="05/01/2026",
    )
    _return(client, vendor, item, 15, 50, bill=bill)
    [f] = _findings("return_exceeds_bill", item)
    assert f["qty"] == 5
    assert f["area"] == "returns"

    _return(client, vendor, item, 1, 0, bill=bill)
    [f] = [x for x in _findings("return_without_value") if vendor in x["title"]]
    assert "about Rs 50.00" in f["detail"]

    _return(client, vendor, item, 1, 20, bill=bill)
    [f] = [x for x in _findings("return_rate_differs") if vendor in x["title"]]
    assert "Rs 20.00 a base unit against Rs 50.00 on the bill" in f["detail"]

    _return(client, vendor, item, 1, 50, bill=bill, day="02/01/2026")
    assert [x for x in _findings("return_before_bill") if bill in x["title"]]

    stranger = _unique("Vendor")
    _return(client, stranger, item, 1, 50)
    [f] = [x for x in _findings("return_item_never_billed") if stranger in x["title"]]
    assert item in f["detail"]


def test_wastage_must_land_where_it_was_written_off(erp_admin_client):
    client = erp_admin_client
    proc, proc_id = _process(client)
    output = proc["outputItemName"]
    _ok(
        _rpc(
            client,
            "saveWastage",
            [
                {
                    "date": "03/01/2026",
                    "items": [
                        {"name": output, "qty": 2, "unit": "Pcs", "reason": "Bent"}
                    ],
                }
            ],
            mutation=True,
        )
    )
    [f] = [x for x in _findings("wastage_wrong_source") if output in x["detail"]]
    assert f["area"] == "wastage"

    _ok(
        _rpc(
            client,
            "saveWarehousePoolOpening",
            [{"processId": proc_id, "qty": 10}],
            mutation=True,
        )
    )
    _ok(
        _rpc(
            client,
            "saveWastage",
            [
                {
                    "date": _today(),
                    "items": [
                        {
                            "sourceType": "POOL",
                            "name": output,
                            "qty": 3,
                            "reason": "Dropped",
                        }
                    ],
                }
            ],
            mutation=True,
        )
    )
    assert _mentioning("wastage_not_in_pool", output) == []
    [f] = _mentioning(
        "wastage_not_in_pool",
        output,
        _tampered(audit_entries._check_wastage_entries, "Wastage"),
    )
    assert f["kind"] == "integrity"


def test_a_lot_number_typed_into_a_wastage_vendor_is_not_a_party(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    _proc, proc_id = _process(client)
    lot = _lot_with(
        client, proc_id, 5, [{"itemName": item, "qty": 5, "sourceType": "ITEM"}]
    )
    typed = lot.removeprefix("LOT-")
    stranger = _unique("Odd Vendor")
    for vendor in (typed, stranger):
        _ok(
            _rpc(
                client,
                "saveWastage",
                [
                    {
                        "date": "03/01/2026",
                        "vendor": vendor,
                        "items": [
                            {"name": item, "qty": 1, "unit": "Pcs", "reason": "Bent"}
                        ],
                    }
                ],
                mutation=True,
            )
        )
    found = _findings()
    assert _mentioning("party_not_in_master", typed, found) == []
    assert _mentioning("party_not_in_master", stranger, found)
    [f] = _mentioning("wastage_lot_in_vendor", typed, found)
    assert f["area"] == "wastage"


def test_the_same_entry_saved_twice_is_reported(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    _issue(client, item, 7, "05/02/2026", issued_to="Twice Party")
    _issue(client, item, 7, "05/02/2026", issued_to="Twice Party")
    [f] = [
        x
        for x in _findings("possible_duplicate_entry")
        if "Twice Party" in x["detail"] and x["area"] == "issues"
    ]
    assert "same date (05/02/2026)" in f["detail"]


# ── Landing: bills, POs, ids, ledgers ──────────────────────────────────────


def test_bills_on_a_full_po_while_another_waits_are_reported(erp_admin_client):
    client = erp_admin_client
    vendor = _unique("Vendor")
    item = _item(client)

    def po():
        return _ok(
            _rpc(
                client,
                "savePO",
                [
                    {
                        "vendor": vendor,
                        "poDate": "01/10/2026",
                        "items": [
                            {"name": item, "qty": 100, "unit": "Pcs", "price": 10}
                        ],
                    }
                ],
                mutation=True,
            )
        )["poNumber"]

    full, waiting = po(), po()
    _bill(
        client,
        [{"name": item, "qty": 150, "unit": "Pcs", "price": 10, "po": full}],
        vendor=vendor,
        day="05/10/2026",
    )
    found, errors = audit_service.compute_external_findings()
    assert errors == []
    found += _findings()
    [f] = _mentioning("bill_on_wrong_po", f"PO {full}", found)
    assert f"PO {waiting} still waits for it" in f["title"]
    assert f["area"] == "pos"
    assert _mentioning("over_billed_po_line", f"PO {full}", found)

    # One problem, not two: only the finding that says where it belongs stays.
    ranked = audit_service.prioritise(found)
    assert _mentioning("over_billed_po_line", f"PO {full}", ranked) == []
    assert _mentioning("bill_on_wrong_po", f"PO {full}", ranked)


def test_a_bill_dated_before_its_po_is_reported(erp_admin_client):
    client = erp_admin_client
    vendor = _unique("Vendor")
    item = _item(client)
    number = _ok(
        _rpc(
            client,
            "savePO",
            [
                {
                    "vendor": vendor,
                    "poDate": "10/10/2026",
                    "items": [{"name": item, "qty": 100, "unit": "Pcs", "price": 10}],
                }
            ],
            mutation=True,
        )
    )["poNumber"]
    _vendor, bill = _bill(
        client,
        [{"name": item, "qty": 5, "unit": "Pcs", "price": 10, "po": number}],
        vendor=vendor,
        day="05/10/2026",
    )
    [f] = _mentioning("bill_before_po", bill)
    assert f"PO {number}" in f["title"]


def test_a_stored_id_must_point_at_what_the_entry_names(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    other = _item(client)
    _vendor, bill = _bill(client, [{"name": item, "qty": 1, "price": 5, "unit": "Pcs"}])
    assert _mentioning("entry_points_at_other_record", bill) == []

    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.bill_lines SET item_id = "
            "(SELECT id FROM erp.items WHERE item_name = %s) WHERE item_name = %s",
            (other, item),
        )
    [f] = _mentioning("entry_points_at_other_record", bill)
    assert f["kind"] == "integrity"
    assert other in f["title"]

    # Merged away: the name was moved on and nothing reads the id, so no
    # figure is affected.
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.items SET deleted_at = NOW() WHERE item_name = %s", (other,)
        )
    assert _mentioning("entry_points_at_other_record", bill) == []
    [f] = _mentioning("entry_points_at_merged_record", bill)
    assert f["kind"] == "info"


def test_every_ledger_must_show_every_entry_exactly_once(erp_admin_client, monkeypatch):
    item = _item(erp_admin_client)
    _bill(erp_admin_client, [{"name": item, "qty": 3, "price": 5, "unit": "Pcs"}])
    assert audit_service._external_ledger_readers({}) == []

    def lost_a_line():
        res = bill_service.get_bill_data()
        res["data"][0]["items"].pop()
        return res

    readers = [
        (r[0], r[1], lost_a_line, *r[3:]) if r[0] == "bills" else r
        for r in audit_service._LEDGER_READERS
    ]
    monkeypatch.setattr(audit_service, "_LEDGER_READERS", tuple(readers))
    [f] = audit_service._external_ledger_readers({})
    assert f["kind"] == "integrity"
    assert f["title"] == "Bill Ledger does not show every entry exactly once"


def test_the_dashboard_must_match_the_ledgers(erp_admin_client, monkeypatch):
    assert audit_service._external_dashboard_findings() == []
    real = dashboard_service.get_dashboard_data

    def off():
        res = real()
        res["data"]["kpis"]["wastageThisMonthCount"] += 1
        return res

    monkeypatch.setattr(dashboard_service, "get_dashboard_data", off)
    [f] = audit_service._external_dashboard_findings()
    assert f["kind"] == "integrity"
    assert f["area"] == "dashboard"
    assert "Wastage" in f["title"]


def test_a_po_status_must_agree_with_its_pending_figures(erp_admin_client, monkeypatch):
    real = po_service._load_po_list

    def off(cur, billed):
        pos = real(cur, billed)
        pos.append(
            {
                "poNumber": "PO-X",
                "vendor": "V",
                "status": "Completed",
                "closedAs": "",
                "items": [
                    {
                        "name": "Rim",
                        "size": "",
                        "qty": 8,
                        "pendingQty": 7,
                        "receivedQty": 1,
                    }
                ],
            }
        )
        return pos

    monkeypatch.setattr(po_service, "_load_po_list", off)
    [f] = _findings("po_status_disagrees")
    assert f["title"] == "PO PO-X says Completed but has 1 line(s) pending"


def test_every_item_ledger_is_read_and_must_close_on_the_stock_page(
    erp_admin_client, monkeypatch
):
    item = _item(erp_admin_client)
    _bill(erp_admin_client, [{"name": item, "qty": 9, "price": 5, "unit": "Pcs"}])
    _issue(erp_admin_client, item, 2, "02/02/2026")
    stats = {}
    assert (
        _mentioning(
            "item_ledger_disagrees", item, audit_service._external_item_ledgers(stats)
        )
        == []
    )
    assert stats["itemLedgers"] >= 1

    real = items_service.build_item_ledger

    def off(name, production=None, terms=None):
        res = real(name, production, terms)
        if name == item:
            res["data"]["reconciliation"][0]["balanced"] = False
            res["data"]["reconciliation"][0]["computedStock"] = 99
        return res

    monkeypatch.setattr(items_service, "build_item_ledger", off)
    found, _errors = audit_service.compute_external_findings()
    [f] = _mentioning("item_ledger_disagrees", item, found)
    assert f["kind"] == "integrity"
    assert "its rows add up to 99; the Stock page shows 7" in f["detail"]


def test_an_item_ledger_top_balance_that_is_not_the_stock_is_reported(
    erp_admin_client, monkeypatch
):
    item = _item(erp_admin_client)
    _bill(erp_admin_client, [{"name": item, "qty": 9, "price": 5, "unit": "Pcs"}])
    real = items_service.build_item_ledger

    def off(name, production=None, terms=None):
        res = real(name, production, terms)
        if name == item:
            res["data"]["entries"][0]["balance"] = 4
        return res

    monkeypatch.setattr(items_service, "build_item_ledger", off)
    [f] = _mentioning(
        "item_ledger_disagrees", item, audit_service._external_item_ledgers({})
    )
    assert "its top balance is 4; the Stock page shows 9" in f["detail"]


def test_the_item_ledger_reads_the_same_from_shared_data(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    _proc, proc_id = _process(client)
    _bill(client, [{"name": item, "qty": 40, "price": 5, "unit": "Pcs"}])
    _lot_with(client, proc_id, 6, [{"itemName": item, "qty": 6, "sourceType": "ITEM"}])
    _issue(client, item, 2, "02/02/2026")
    _ok(_rpc(client, "adjustStockManually", [item, "", 30, "count"], mutation=True))

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        production = {}
        for comp in stock_service._iter_completed_production_components(cur):
            production.setdefault(comp["itemName"].strip().lower(), []).append(comp)
        terms = stock_service._get_stock_terms(cur)

    shared = items_service.build_item_ledger(item, production, terms)["data"]
    assert shared == items_service.get_item_ledger_data(item)["data"]
    assert shared["reconciliation"][0]["balanced"] is True


def test_every_pool_ledger_is_read_and_must_close_on_its_balance(
    erp_admin_client, monkeypatch
):
    up, up_id = _process(erp_admin_client)
    name = up["outputItemName"]
    _ok(
        _rpc(
            erp_admin_client,
            "saveWarehousePoolOpening",
            [{"processId": up_id, "qty": 10}],
            mutation=True,
        )
    )
    assert _findings("pool_ledger_screen_disagrees", name) == []

    real = warehouse_service.pool_ledger_lines

    def off(want, anchor, events, absorbed):
        lines = real(want, anchor, events, absorbed)
        if want[0] == name.lower():
            lines[0]["balance"] = 3
        return lines

    monkeypatch.setattr(warehouse_service, "pool_ledger_lines", off)
    [f] = _findings("pool_ledger_screen_disagrees", name)
    assert f["kind"] == "integrity"
    assert "closes on 3; Available Qty is 10" in f["detail"]


def test_a_ledger_total_must_match_its_lines(erp_admin_client, monkeypatch):
    item = _item(erp_admin_client)
    _bill(erp_admin_client, [{"name": item, "qty": 3, "price": 5, "unit": "Pcs"}])

    def inflated():
        res = bill_service.get_bill_data()
        res["data"][0]["totalAmount"] += 100
        return res

    readers = [
        (r[0], r[1], inflated, *r[3:]) if r[0] == "bills" else r
        for r in audit_service._LEDGER_READERS
    ]
    monkeypatch.setattr(audit_service, "_LEDGER_READERS", tuple(readers))
    [f] = audit_service._external_ledger_readers({})
    assert f["title"] == "Bill Ledger does not show every entry exactly once"
    assert "value Rs" in f["detail"]


def test_ready_to_dispatch_must_add_up_to_the_pool(erp_admin_client):
    proc, proc_id = _process(erp_admin_client, isFinalStage=True)
    _ok(
        _rpc(
            erp_admin_client,
            "saveWarehousePoolOpening",
            [{"processId": proc_id, "qty": 10}],
            mutation=True,
        )
    )
    name = proc["outputItemName"]
    assert _mentioning("ready_vs_pool", name) == []
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.warehouse_pool SET available_qty = 3 WHERE output_item_name = %s",
            (name,),
        )
    [f] = _mentioning("ready_vs_pool", name)
    assert f["kind"] == "integrity"
    assert "shows 10" in f["title"] and "holds 3" in f["title"]


def test_an_older_lot_is_judged_by_the_lots_around_it(erp_admin_client):
    client = erp_admin_client
    part = _item(client)
    other = _item(client)
    _proc, proc_id = _process(client)

    def lot(*parts):
        return _lot_with(
            client,
            proc_id,
            10,
            [
                {
                    "itemName": name,
                    "qty": 10,
                    "sourceType": "ITEM",
                    "colorGroup": "COMMON",
                }
                for name in parts
            ],
        )

    for _n in range(5):
        lot(part, other)
    odd = lot(other)
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.process_master SET updated_at = NOW() + interval '1 hour' "
            "WHERE process_id = %s",
            (proc_id,),
        )
    [f] = _findings("lot_unlike_its_neighbours", part)
    assert f["refs"] == [odd]
    assert "used 0 a unit where lots of the same output around it used 1" in f["detail"]
    assert _findings("lot_unlike_its_neighbours", other) == []


def test_an_extra_charge_with_no_amount_is_reported(erp_admin_client):
    item = _item(erp_admin_client)
    _proc, proc_id = _process(erp_admin_client)
    contractor = _unique("Contractor")
    lot = _completed_lot(erp_admin_client, proc_id, 5, contractor)
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.production SET extra_charge_type = 'Polish' WHERE lot_number = %s",
            (lot,),
        )
    [f] = _mentioning("lot_extra_charge_missing", lot)
    assert contractor in f["title"] and item not in f["title"]


def test_a_logistics_contractor_with_no_rate_is_reported(erp_admin_client):
    contractor = _unique("Transporter")
    number = _unique("D")
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.dispatch_headers (dispatch_number, dispatch_date, client_name, "
            "logistics_contractor) VALUES (%s, CURRENT_DATE, 'Someone', %s) RETURNING id",
            (number, contractor),
        )
        cur.execute(
            "INSERT INTO erp.dispatch_lines (header_id, product_id, product_name, qty, rate, "
            "amount) VALUES (%s, 'P9', 'Bike', 5, 0, 0)",
            (cur.fetchone()[0],),
        )
    [f] = _mentioning("dispatch_no_logistics_rate", contractor)
    assert number in f["detail"]
    assert f["area"] == "contractors"


def test_a_pool_entry_whose_process_is_gone_is_reported(erp_admin_client):
    proc, proc_id = _process(erp_admin_client)
    _ok(
        _rpc(
            erp_admin_client,
            "saveWarehousePoolOpening",
            [{"processId": proc_id, "qty": 10}],
            mutation=True,
        )
    )
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.process_master SET deleted_at = NOW() WHERE process_id = %s",
            (proc_id,),
        )
    [f] = _findings("pool_opening_process_missing", proc["outputItemName"])
    assert proc_id in f["title"]


def test_a_vendor_with_two_gst_rates_is_listed_once(erp_admin_client):
    item = _item(erp_admin_client)
    vendor = _unique("Vendor")
    for gst in (0, 18):
        _bill(
            erp_admin_client,
            [{"name": item, "qty": 1, "price": 5, "unit": "Pcs", "gst": gst}],
            vendor=vendor,
        )
    [f] = _mentioning("vendor_mixed_gst", f"Vendor {vendor}")
    assert f["kind"] == "entry"


def test_a_payment_entered_twice_is_reported(erp_admin_client):
    name = _unique("Contractor")
    _ok(
        _rpc(
            erp_admin_client,
            "saveContractor",
            [{"contractorName": name}],
            mutation=True,
        )
    )
    for _n in (1, 2):
        _ok(
            _rpc(
                erp_admin_client,
                "recordContractorPayment",
                [{"contractorName": name, "amount": 750, "date": "05/01/2026"}],
                mutation=True,
            )
        )
    [f] = [
        x
        for x in _findings("possible_duplicate_entry")
        if name in x["detail"] and x["area"] == "contractors"
    ]
    assert "same date (05/01/2026)" in f["detail"]


def test_a_bom_that_disagrees_with_its_recipe_is_reported(monkeypatch):
    monkeypatch.setattr(
        bom_service,
        "get_bom_process_components_drift",
        lambda: {
            "data": [
                {
                    "productId": "P1",
                    "productName": "Bike",
                    "itemName": "Rim",
                    "size": "",
                    "bomQtyPerProduct": 2,
                    "recipeQtyPerUnit": 3,
                }
            ]
        },
    )
    found, _errors = audit_service.compute_external_findings()
    [f] = [x for x in found if x["check"] == "bom_recipe_drift"]
    assert f["area"] == "processes"
    assert "Rim: 2 in the BOM, 3 in the recipe" in f["detail"]


# ── The modules around them ────────────────────────────────────────────────


def test_a_recipe_that_cannot_work_is_reported(erp_admin_client):
    client = erp_admin_client
    nothing = _unique("Nothing makes this")
    proc, proc_id = _process(
        client,
        components=[
            {
                "itemName": nothing,
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "",
            }
        ],
    )
    [f] = [x for x in _findings("process_component_unmade") if nothing in x["detail"]]
    assert f["area"] == "processes"

    # Two processes each consuming the other's output.
    other, other_id = _process(
        client,
        components=[
            {
                "itemName": proc["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "",
            }
        ],
    )
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.process_components SET item_name = %s WHERE item_name = %s",
            (other["outputItemName"], nothing),
        )
    [f] = [x for x in _findings("process_cycle") if proc["processName"] in x["detail"]]
    assert other["processName"] in f["detail"]


def test_inspections_are_checked_against_their_lots(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    _proc, proc_id = _process(client)
    lot = _lot_with(
        client, proc_id, 5, [{"itemName": item, "qty": 5, "sourceType": "ITEM"}]
    )
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.lot_inspections (production_id, status) "
            "SELECT id, 'in_progress' FROM erp.production WHERE lot_number = %s",
            (lot,),
        )
    [f] = _mentioning("inspection_open_on_completed_lot", lot)
    assert f["area"] == "inspection"

    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.lot_inspections SET status = 'cleared', cleared_at = NOW(), "
            "cleared_sheet = '[]'::jsonb WHERE production_id = "
            "(SELECT id FROM erp.production WHERE lot_number = %s)",
            (lot,),
        )
    assert _mentioning("inspection_open_on_completed_lot", lot) == []
    assert _mentioning("inspection_changed_after_clearing", lot)


def test_the_dispatch_plan_and_pushed_orders_are_checked(erp_admin_client):
    client = _unique("PlanClient")
    number = _unique("D")
    order = _unique("PI")
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.dispatch_plan_lines (plan_date, client_name, product_id, "
            "product_name, qty) VALUES (CURRENT_DATE - 30, %s, 'P1', 'Bike', 4)",
            (client,),
        )
        cur.execute(
            "INSERT INTO erp.dispatch_plan_lines (plan_date, client_name, product_id, "
            "product_name, qty, fulfilled_dispatch_number) "
            "VALUES (CURRENT_DATE, %s, 'P1', 'Bike', 4, %s)",
            (client, number),
        )
        cur.execute(
            "INSERT INTO erp.client_orders_headers (order_number, order_date, client_name, "
            "status) VALUES (%s, CURRENT_DATE, %s, 'Order Confirmed') RETURNING id",
            (order, client),
        )
        header = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO erp.client_orders_lines (header_id, product_id, product_name, qty, "
            "production_pushed) VALUES (%s, 'P1', 'Bike', 4, 'yes')",
            (header,),
        )
    found = _findings()
    assert _mentioning("plan_line_overdue", client, found)
    assert _mentioning("plan_line_dispatch_missing", number, found)
    assert _mentioning("order_pushed_lot_missing", order, found)


def test_a_dispatch_must_come_off_the_pool(erp_admin_client):
    number = _unique("D")
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.dispatch_headers (dispatch_number, dispatch_date, client_name) "
            "VALUES (%s, CURRENT_DATE, 'Someone') RETURNING id",
            (number,),
        )
        cur.execute(
            "INSERT INTO erp.dispatch_lines (header_id, product_id, product_name, qty, rate, "
            "amount) VALUES (%s, %s, 'Bike', 5, 100, 500)",
            (cur.fetchone()[0], _unique("NoSuchProduct")),
        )
    [f] = _mentioning(
        "dispatch_not_in_pool",
        number,
        _tampered(audit_service._check_dispatch, "Dispatch"),
    )
    assert f["kind"] == "integrity"
    assert "5 sent, the Warehouse Pool took off 0" in f["title"]


def test_a_date_far_from_the_day_it_was_entered_is_reported(erp_admin_client):
    item = _item(erp_admin_client)
    _vendor, bill = _bill(
        erp_admin_client,
        [{"name": item, "qty": 1, "price": 5, "unit": "Pcs"}],
        day=_today(),
    )
    assert _mentioning("dated_far_from_entry", bill) == []
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.bill_headers SET bill_date = bill_date - 400 WHERE bill_number = %s",
            (bill,),
        )
    assert _mentioning("dated_far_from_entry", bill)


def test_a_unit_deleted_from_the_master_is_named_with_the_factor_it_had(
    erp_admin_client,
):
    client = erp_admin_client
    unit = _unique("Crate")
    _ok(
        _rpc(
            client,
            "saveUnit",
            [{"unitName": unit, "family": "Count", "factorToBase": 12}],
            mutation=True,
        )
    )
    item = _item(client)
    _bill(client, [{"name": item, "qty": 3, "price": 5, "unit": unit}])
    assert _findings("deleted_unit_lines", item) == []

    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.units SET deleted_at = NOW() WHERE unit_name = %s", (unit,)
        )

    found = _findings()
    [f] = [x for x in found if x["check"] == "deleted_unit_lines" and x["item"] == item]
    assert "Saved at 12 Pcs per" in f["detail"]
    assert "Items Stock counts 36 Pcs" in f["detail"]
    assert "would convert at 1 and give 3" in f["detail"]
    assert f["qty"] == 33
    assert not [
        x for x in found if x["check"] == "stored_base_qty_stale" and x["item"] == item
    ]
    [u] = [
        x
        for x in found
        if x["title"] == f'Unit "{unit.lower()}" is not in the Units master'
    ]
    assert "when 1" in u["detail"] and "was 12" in u["detail"]


def test_a_lot_whose_colours_do_not_add_up_is_reported(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    _proc, proc_id = _process(client)
    lot = _lot_with(
        client, proc_id, 20, [{"itemName": item, "qty": 20, "sourceType": "ITEM"}]
    )
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.production SET color_breakdown = %s::jsonb WHERE lot_number = %s",
            ('[{"color": "Red", "qty": 30}, {"color": "Blue", "qty": 10}]', lot),
        )
    [f] = _mentioning("lot_colours_disagree", lot)
    assert "add up to 40, the lot says 20" in f["title"]


def test_a_lot_left_in_progress_for_weeks_is_reported(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    _proc, proc_id = _process(client)
    lot = _lot_with(
        client,
        proc_id,
        6,
        [{"itemName": item, "qty": 6, "sourceType": "ITEM"}],
        status="In Progress",
    )
    assert _mentioning("lot_stuck_in_progress", lot) == []
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.production SET production_date = CURRENT_DATE - 40 "
            "WHERE lot_number = %s",
            (lot,),
        )
    [f] = _mentioning("lot_stuck_in_progress", lot)
    assert "In Progress for 40 days" in f["title"]


def test_a_receipt_beyond_its_lot_is_a_code_bug(erp_admin_client):
    client = erp_admin_client
    item = _item(client)
    _proc, proc_id = _process(client)
    lot = _lot_with(
        client,
        proc_id,
        20,
        [{"itemName": item, "qty": 20, "sourceType": "ITEM"}],
        status="In Progress",
    )
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.production_receipts (production_id, receipt_date, qty) "
            "SELECT id, CURRENT_DATE, 25 FROM erp.production WHERE lot_number = %s "
            "RETURNING id",
            (lot,),
        )
        cur.execute(
            "INSERT INTO erp.production_receipt_lines (receipt_id, qty) VALUES (%s, 25)",
            (cur.fetchone()[0],),
        )
    [f] = _mentioning("receipt_beyond_lot", lot)
    assert f["kind"] == "integrity"
    assert "25 received of 20" in f["detail"]


def test_a_contractor_paid_more_than_earned_is_reported(erp_admin_client):
    name = _unique("Contractor")
    _ok(
        _rpc(
            erp_admin_client,
            "saveContractor",
            [{"contractorName": name}],
            mutation=True,
        )
    )
    _ok(
        _rpc(
            erp_admin_client,
            "recordContractorPayment",
            [{"contractorName": name, "amount": 500, "date": "01/01/2026"}],
            mutation=True,
        )
    )
    found, _errors = audit_service.compute_external_findings()
    [f] = _mentioning("contractor_overpaid", name, found)
    assert "Rs 500.00 more than earned" in f["title"]


def test_one_party_spelled_two_ways_is_reported(erp_admin_client):
    stem = uuid.uuid4().hex[:8]
    with database.get_conn() as (_conn, cur):
        for name in (f"R.K. Traders {stem}", f"RK TRADERS {stem}"):
            cur.execute("INSERT INTO erp.vendors (vendor_name) VALUES (%s)", (name,))
    [f] = _mentioning("master_name_variants", f"R.K. Traders {stem}")
    assert f"RK TRADERS {stem}" in f["title"]


def test_a_bill_naming_a_po_that_is_not_there_is_reported(erp_admin_client):
    item = _item(erp_admin_client)
    vendor, _bill_number = _bill(
        erp_admin_client, [{"name": item, "qty": 1, "price": 5, "unit": "Pcs"}]
    )
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.bill_lines SET po_number = 'NO-SUCH-PO' WHERE item_name = %s",
            (item,),
        )
    [f] = _mentioning("bill_names_missing_po", vendor)
    assert "PO NO-SUCH-PO (never existed)" in f["detail"]


def test_a_completed_lot_with_no_completion_time_is_a_code_bug(erp_admin_client):
    item = _item(erp_admin_client)
    _proc, proc_id = _process(erp_admin_client)
    lot = _lot_with(
        erp_admin_client,
        proc_id,
        5,
        [{"itemName": item, "qty": 5, "sourceType": "ITEM"}],
    )
    assert _mentioning("lot_completed_at_missing", lot) == []
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.migrations_applied (migration_name, applied_at) "
            "SELECT '051_lot_completed_at', NOW() - interval '1 day' WHERE NOT EXISTS "
            "(SELECT 1 FROM erp.migrations_applied WHERE migration_name = '051_lot_completed_at')"
        )
        cur.execute(
            "UPDATE erp.production SET completed_at = NULL WHERE lot_number = %s",
            (lot,),
        )
    [f] = _mentioning("lot_completed_at_missing", lot)
    assert f["kind"] == "integrity"


# ── What is missing ────────────────────────────────────────────────────────


def test_each_discrepancy_says_what_calculation_or_logic_is_missing():
    f = audit_service._finding
    ranked = audit_service.prioritise(
        [
            f("lot_without_rate", "entry", "contractors", "no rate", "a"),
            f("lot_without_rate", "entry", "contractors", "no rate two", "b"),
            f("bill_rate_above_po", "entry", "bills", "over", "c"),
            f("pool_cache_stale", "integrity", "pool", "stale", "d"),
        ],
        today=date(2026, 10, 15),
    )
    by_check = {x["check"]: x for x in ranked}
    assert by_check["lot_without_rate"]["missing"]["type"] == "calculation"
    assert by_check["bill_rate_above_po"]["missing"]["type"] == "logic"
    assert by_check["pool_cache_stale"]["missing"] is None

    missing = audit_service.summarise(ranked, [])["missing"]
    assert [m["type"] for m in missing] == ["calculation", "logic"]
    assert missing[0]["findings"] == 2
    assert missing[0]["checks"] == ["lot_without_rate"]

    brief = audit_service.build_brief(
        {"runId": 1, "startedAt": "2026-10-15T10:00"}, ranked
    )
    assert "- Missing calculation: No payable is worked out" in brief


def test_every_missing_entry_belongs_to_a_real_check():
    sources = "".join(
        Path(m.__file__).read_text(encoding="utf-8")
        for m in (audit_service, audit_entries, ledger_audit_service)
    )
    for check in audit_service._MISSING:
        assert sources.count(f'"{check}"') >= 2, check
    assert set(audit_service._MISSING) <= {
        *audit_service._LANDING_CHECKS,
        *audit_service._MISSING,
    }


def test_two_findings_never_share_a_fingerprint():
    f = audit_service._finding
    ranked = audit_service.prioritise(
        [
            f(
                "lot_without_rate",
                "entry",
                "contractors",
                "Paint",
                "a",
                refs=["Amarjeet"],
            ),
            f(
                "lot_without_rate",
                "entry",
                "contractors",
                "Powder",
                "b",
                refs=["Amarjeet"],
            ),
            f(
                "lot_without_rate",
                "entry",
                "contractors",
                "Fitting",
                "c",
                refs=["Mohan"],
            ),
        ],
        today=date(2026, 10, 15),
    )
    assert len({x["fingerprint"] for x in ranked}) == 3
    # One that stood alone keeps the fingerprint its review was saved under.
    alone = f(
        "lot_without_rate", "entry", "contractors", "Fitting", "c", refs=["Mohan"]
    )
    assert alone["fingerprint"] in {x["fingerprint"] for x in ranked}


# ── Priority ───────────────────────────────────────────────────────────────


def test_priority_puts_code_bugs_first_and_caps_review_only_checks():
    f = audit_service._finding
    ranked = audit_service.prioritise(
        [
            f("large_count_variance", "entry", "stock", "big count", "a", qty=9000),
            f("negative_shortfall", "entry", "pool", "short", "b", qty=40),
            f("pool_cache_stale", "integrity", "pool", "stale", "c", qty=1),
            f("negative_colour_mixed_bundle", "info", "pool", "mixed", "d", qty=500),
        ],
        today=date(2026, 10, 15),
    )
    # Integrity first; a capped check keeps its score, so within P3 it still
    # ranks by size.
    assert [(x["check"], x["priority"]) for x in ranked] == [
        ("pool_cache_stale", "P1"),
        ("large_count_variance", "P3"),
        ("negative_shortfall", "P3"),
        ("negative_colour_mixed_bundle", "P3"),
    ]


# ── Runs, reviews, hand-off ────────────────────────────────────────────────

_TABLES = (
    "erp.production",
    "erp.warehouse_pool",
    "erp.warehouse_pool_opening",
    "erp.warehouse_pool_adjustments",
    "erp.stock_adjustments",
    "erp.bill_lines",
    "erp.items",
)


def _fingerprint():
    out = {}
    with database.get_conn() as (_conn, cur):
        for t in _TABLES:
            cur.execute(
                f"SELECT md5(string_agg(x::text, '' ORDER BY x::text)) FROM {t} x"
            )
            out[t] = cur.fetchone()[0]
    return out


def test_an_audit_run_writes_nothing_but_its_own_tables(erp_admin_client):
    up_name, up_id, down_id = _stage(erp_admin_client, 5)
    _lot(erp_admin_client, down_id, up_name, 12)
    before = _fingerprint()
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.audit_runs (trigger) VALUES ('button') RETURNING id"
        )
        run_id = cur.fetchone()[0]

    audit_service._execute_run(run_id)

    assert _fingerprint() == before
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT status, jsonb_array_length(findings) FROM erp.audit_runs WHERE id = %s",
            (run_id,),
        )
        status, n = cur.fetchone()
    assert status == "DONE"
    assert n > 0


def test_review_dismiss_holds_until_the_numbers_change_and_the_brief_has_the_refs(
    erp_admin_client, monkeypatch
):
    monkeypatch.setattr(audit_service, "_spawn", lambda target, *args: target(*args))
    up, up_id = _process(erp_admin_client)
    name = up["outputItemName"]
    _ok(
        _rpc(
            erp_admin_client,
            "saveWarehousePoolOpening",
            [{"processId": up_id, "qty": 10}],
            mutation=True,
        )
    )
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.warehouse_pool SET available_qty = 99 WHERE output_item_name = %s",
            (name,),
        )

    def run_and_find():
        run_id = _ok(_rpc(erp_admin_client, "runAudit", mutation=True))["runId"]
        assert (
            _ok(_rpc(erp_admin_client, "getAuditStatus", [run_id]))["status"] == "DONE"
        )
        report = _ok(_rpc(erp_admin_client, "getAuditReport", [run_id]))
        [mine] = [
            x
            for x in report["findings"]
            if x["check"] == "pool_cache_stale" and x["item"] == name
        ]
        return run_id, mine

    run_id, mine = run_and_find()
    assert mine["review"] == "open"
    _ok(
        _rpc(
            erp_admin_client,
            "setAuditFindingStatus",
            [
                [{"fingerprint": mine["fingerprint"], "valueSig": mine["valueSig"]}],
                "dismissed",
            ],
            mutation=True,
        )
    )
    assert run_and_find()[1]["review"] == "dismissed"

    brief = _ok(
        _rpc(erp_admin_client, "getAuditBrief", [run_id, [mine["fingerprint"]]])
    )["markdown"]
    assert name in brief and "pool_cache_stale" in brief and f"run #{run_id}" in brief

    # New numbers, new decision needed.
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.warehouse_pool SET available_qty = 77 WHERE output_item_name = %s",
            (name,),
        )
    assert run_and_find()[1]["review"] == "open"


def test_only_an_admin_can_run_the_audit(erp_client):
    resp = _rpc(erp_client, "runAudit", mutation=True)
    assert resp.status_code == 403 or resp.get_json()["success"] is False
