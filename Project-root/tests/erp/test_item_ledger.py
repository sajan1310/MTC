"""Item Ledger (getItemLedgerData) tests.

The ledger is computed server-side from the same terms, signs and unit
conversions as the Current Stock formula, so these tests assert the two
AGREE rather than just checking the ledger's own internal shape -- that
agreement is the entire reason the endpoint exists.

It replaced a client-side reconstruction that could not agree by
construction: Production consumption was derived from the BOM recipe keyed
by lot.productId (so every non-final-stage lot contributed nothing, since
only final-stage lots carry a productId), and Wastage and Issue -- two full
terms of the Stock formula -- were missing from the history entirely.
"""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _create_item_with_stock(client, name: str, initial_stock: float = 10):
    resp = _rpc(client, "saveItem", [{"itemName": name, "itemInitialStock": initial_stock}], mutation=True)
    assert resp.get_json()["success"] is True


def _save_non_final_process(client):
    """A NON-final-stage process: its lots carry a blank productId, which is
    exactly the case the old BOM-derived ledger could never show.
    """
    payload = {
        "processName": _unique_name("LedgerProcess"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique_name("LedgerOutput"),
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    resp = _rpc(client, "saveProcess", [payload], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body["data"]["processId"], payload["outputItemName"]


def _ledger(client, name):
    resp = _rpc(client, "getItemLedgerData", [name])
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body["data"]


def test_item_ledger_returns_success_envelope_for_unknown_item(erp_client):
    data = _ledger(erp_client, _unique_name("NoSuchItem"))
    assert data["entries"] == []
    assert data["reconciliation"] == []


def test_item_ledger_shows_production_consumption_for_non_final_stage_lot(erp_client):
    """The regression this endpoint exists for: a non-final-stage lot
    consumed real stock, so the ledger must explain it. Previously Current
    Stock dropped while the ledger showed nothing at all.
    """
    name = _unique_name("LedgerRawMat")
    _create_item_with_stock(erp_client, name, initial_stock=50)
    process_id, _output = _save_non_final_process(erp_client)

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 10,
                "status": "Completed",
                "componentsConsumed": [{"itemName": name, "qty": 6, "sourceType": "ITEM", "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    assert body["data"]["row"]["productId"] == ""  # non-final-stage: no BOM to key off

    data = _ledger(erp_client, name)
    production_rows = [e for e in data["entries"] if e["kind"] == "PRODUCTION"]
    assert len(production_rows) == 1
    assert production_rows[0]["outgoingQty"] == 6
    assert production_rows[0]["ref"] == body["data"]["lotNumber"]
    assert production_rows[0]["countsTowardStock"] is True


def test_item_ledger_ignores_non_completed_lots(erp_client):
    """Only Completed lots move stock -- the ledger must match that, or it
    would show a consumption Current Stock hasn't applied.
    """
    name = _unique_name("LedgerPendingLot")
    _create_item_with_stock(erp_client, name, initial_stock=40)
    process_id, _output = _save_non_final_process(erp_client)

    _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "status": "Pending",
                "componentsConsumed": [{"itemName": name, "qty": 8, "sourceType": "ITEM", "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    assert next(r for r in listed if r["name"] == name)["currentStock"] == 40

    data = _ledger(erp_client, name)
    assert [e for e in data["entries"] if e["kind"] == "PRODUCTION"] == []
    assert data["reconciliation"][0]["balanced"] is True


def test_item_ledger_reconciles_with_current_stock_across_every_term(erp_client):
    """initialStock + incoming - outgoing must equal the Current Stock the
    Stock page shows, with all five terms in play at once.
    """
    name = _unique_name("LedgerAllTerms")
    _create_item_with_stock(erp_client, name, initial_stock=100)

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": _unique_name("LedgerVendor"),
                "billNumber": _unique_name("LINV"),
                "billDate": "01/01/2026",
                "items": [{"name": name, "qty": 20, "price": 5}],
            }
        ],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": _unique_name("LedgerRetVendor"),
                "returnDate": "02/01/2026",
                "items": [{"name": name, "qty": 4, "price": 5}],
            }
        ],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveWastage",
        [{"date": "03/01/2026", "items": [{"name": name, "qty": 5, "unit": "Pcs", "reason": "Damaged"}]}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveIssueStock",
        [{"date": "04/01/2026", "issuedTo": "Contractor A", "items": [{"name": name, "qty": 3, "unit": "Pcs"}]}],
        mutation=True,
    )

    process_id, _output = _save_non_final_process(erp_client)
    _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 10,
                "status": "Completed",
                "componentsConsumed": [{"itemName": name, "qty": 7, "sourceType": "ITEM", "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )

    expected = 100 + 20 - 4 - 5 - 3 - 7
    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    assert next(r for r in listed if r["name"] == name)["currentStock"] == expected

    data = _ledger(erp_client, name)
    kinds = {e["kind"] for e in data["entries"]}
    # Wastage and Issue were entirely absent from the old client-side ledger.
    assert {"BILL", "RETURN", "WASTAGE", "ISSUE", "PRODUCTION"} <= kinds

    assert len(data["reconciliation"]) == 1
    recon = data["reconciliation"][0]
    assert recon["currentStock"] == expected
    assert recon["computedStock"] == expected
    assert recon["balanced"] is True


def test_item_ledger_excludes_ledger_only_bill_from_the_balance(erp_client):
    """A bill line saved as "Ledger only" (affects_stock FALSE) is shown but
    not counted -- matching the Stock formula's own affects_stock filter, so
    the reconciliation still balances.
    """
    name = _unique_name("LedgerOnlyItem")
    _create_item_with_stock(erp_client, name, initial_stock=30)

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": _unique_name("LedgerOnlyVendor"),
                "billNumber": _unique_name("LOINV"),
                "billDate": "01/01/2026",
                "items": [{"name": name, "qty": 12, "price": 3}],
                "excludeFromStockKeys": [f"{name.lower()}|"],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    assert next(r for r in listed if r["name"] == name)["currentStock"] == 30  # bill excluded

    data = _ledger(erp_client, name)
    bill_rows = [e for e in data["entries"] if e["kind"] == "BILL"]
    assert len(bill_rows) == 1
    assert bill_rows[0]["incomingQty"] == 12  # still visible in the ledger
    assert bill_rows[0]["countsTowardStock"] is False
    assert bill_rows[0]["type"] == "Bill (Ledger only)"

    recon = data["reconciliation"][0]
    assert recon["currentStock"] == 30
    assert recon["balanced"] is True


def test_item_ledger_manual_adjustment_is_shown_but_not_double_counted(erp_client):
    """adjust_stock_manually rewrites initial_stock, so an adjustment is
    already absorbed into the initialStock the reconciliation starts from.
    Counting its delta again would double-apply it.
    """
    name = _unique_name("LedgerAdjusted")
    _create_item_with_stock(erp_client, name, initial_stock=20)

    resp = _rpc(erp_client, "adjustStockManually", [name, "", 35, "Physical recount"], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    assert next(r for r in listed if r["name"] == name)["currentStock"] == 35

    data = _ledger(erp_client, name)
    adjustments = [e for e in data["entries"] if e["kind"] == "ADJUSTMENT"]
    assert len(adjustments) == 1
    assert adjustments[0]["incomingQty"] == 15  # 35 - 20, shown for context
    assert adjustments[0]["countsTowardStock"] is False

    recon = data["reconciliation"][0]
    assert recon["initialStock"] == 35  # the adjustment landed here
    assert recon["currentStock"] == 35
    assert recon["balanced"] is True  # not 35 + 15


def test_item_ledger_pool_sourced_component_never_touches_items_stock(erp_client):
    """A POOL-sourced component debits the Warehouse Pool, not Items Stock --
    it must not appear as an Items-Stock movement, mirroring the Stock
    formula's own POOL exclusion.
    """
    name = _unique_name("PoolNotStock")
    _create_item_with_stock(erp_client, name, initial_stock=25)

    upstream_id, upstream_output = _save_non_final_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 40}], mutation=True)

    downstream_id, _output = _save_non_final_process(erp_client)
    _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": downstream_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "status": "Completed",
                "componentsConsumed": [
                    {"itemName": upstream_output, "qty": 9, "sourceType": "POOL"},
                    {"itemName": name, "qty": 2, "sourceType": "ITEM", "unit": "Pcs"},
                ],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    assert next(r for r in listed if r["name"] == name)["currentStock"] == 23  # 25 - 2, POOL untouched

    # The POOL component's own name must not surface as an Items Stock movement.
    pool_ledger = _ledger(erp_client, upstream_output)
    assert [e for e in pool_ledger["entries"] if e["kind"] == "PRODUCTION"] == []

    data = _ledger(erp_client, name)
    production_rows = [e for e in data["entries"] if e["kind"] == "PRODUCTION"]
    assert len(production_rows) == 1
    assert production_rows[0]["outgoingQty"] == 2
    assert data["reconciliation"][0]["balanced"] is True


def test_item_ledger_reports_base_unit_qty_not_as_entered(erp_client):
    """A line entered in a non-base unit must report the BASE-unit quantity,
    the same figure Current Stock moves by -- with the as-entered value
    carried alongside for display.
    """
    name = _unique_name("LedgerDozenItem")
    resp = _rpc(
        erp_client,
        "saveItem",
        [{"itemName": name, "itemInitialStock": 0, "itemBaseUnit": "Pcs", "itemPurchaseUnit": "Dozen"}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": "Dozen", "family": "Count", "factorToBase": 12}],
        mutation=True,
    )

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": _unique_name("DozenVendor"),
                "billNumber": _unique_name("DZINV"),
                "billDate": "01/01/2026",
                "items": [{"name": name, "qty": 2, "unit": "Dozen", "price": 120}],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    current = next(r for r in listed if r["name"] == name)["currentStock"]

    data = _ledger(erp_client, name)
    bill_rows = [e for e in data["entries"] if e["kind"] == "BILL"]
    assert len(bill_rows) == 1
    # Whatever the conversion resolves to, the ledger and Stock must agree.
    assert bill_rows[0]["incomingQty"] == current
    assert bill_rows[0]["enteredQty"] == 2
    assert bill_rows[0]["unit"] == "Dozen"
    assert data["reconciliation"][0]["balanced"] is True
