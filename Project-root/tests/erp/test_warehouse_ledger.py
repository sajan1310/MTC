"""getWarehousePoolLedger -- the per-bucket transaction history.

The ledger used to be assembled in the browser (App.Stock.buildPoolLedgerRows)
from getProductionData + getWarehousePoolOpeningData +
getWarehousePoolAdjustmentHistory, i.e. as a SECOND implementation of the
pool's arithmetic. It had drifted from the real one in five separate ways: a
per-lot Output Item Name hid a lot from its own bucket, neither the credit nor
the debit leg could match a COMPOSITE bucket colour, a lot was credited to its
composite bucket AND its bare-colour one, and every manual correction was
counted twice because adjustWarehousePoolManually records it in two tables.

It is now sourced from an event sink threaded through
_build_warehouse_pool_buckets itself, so the ledger IS the pool's arithmetic.
The invariant every test here leans on is the one that catches any future
drift by construction: THE CLOSING BALANCE EQUALS THE BUCKET'S AVAILABLE QTY.
"""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _save_process(client, **overrides):
    payload = {
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
    }
    payload.update(overrides)
    resp = _rpc(client, "saveProcess", [payload], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return payload, body["data"]["processId"]


def _bucket(client, output_item_name, color=""):
    rows = _rpc(client, "getWarehousePoolData").get_json()["data"]
    return next(
        b for b in rows
        if b["outputItemName"] == output_item_name and (b["color"] or "") == color
    )


def _ledger(client, output_item_name, color=""):
    resp = _rpc(client, "getWarehousePoolLedger", [output_item_name, "", color])
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body["data"]


def _closing(rows):
    # Rows come back newest-first, so the running balance closes on row 0.
    return rows[0]["balance"] if rows else 0


def test_ledger_closes_on_the_buckets_available_qty(erp_client):
    payload, process_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening",
         [{"processId": process_id, "qty": 25, "remarks": "Initial seed"}], mutation=True)

    rows = _ledger(erp_client, payload["outputItemName"])
    assert _closing(rows) == _bucket(erp_client, payload["outputItemName"])["availableQty"] == 25
    assert [r["type"] for r in rows] == ["Opening Stock"]
    assert rows[0]["remarks"] == "Initial seed"


def test_a_manual_correction_is_counted_once_not_twice(erp_client):
    """adjustWarehousePoolManually writes the delta to
    erp.warehouse_pool_opening AND an audit row to
    erp.warehouse_pool_adjustments. Reading both is what used to apply every
    correction twice and drift the running balance by the correction total.
    """
    payload, process_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": 20}], mutation=True)
    _rpc(erp_client, "adjustWarehousePoolManually",
         [payload["outputItemName"], process_id, "", "", 12, "Physical recount"], mutation=True)

    rows = _ledger(erp_client, payload["outputItemName"])
    corrections = [r for r in rows if r["type"] == "Manual Correction"]
    assert len(corrections) == 1
    # -8 to get from 20 to 12, shown as an Out rather than a negative In.
    assert corrections[0]["outQty"] == 8
    assert corrections[0]["inQty"] == 0
    assert corrections[0]["remarks"] == "Physical recount"

    assert _closing(rows) == _bucket(erp_client, payload["outputItemName"])["availableQty"] == 12


def test_a_lot_with_its_own_output_item_name_still_appears(erp_client):
    """The original report: LOT-FTD028-0009 was logged under its own name
    ("... IBC T/Tube 2.40") on a WIP process whose output is "... IBC Steel
    Rim". Pass 1 normalises a non-final-stage lot onto its PROCESS's name, so
    the lot really is in that bucket -- but the browser compared the stored
    name and showed nothing.
    """
    payload, process_id = _save_process(erp_client)
    saved = _rpc(
        erp_client,
        "saveProduction",
        [{
            "processId": process_id,
            "assignedTo": "Worker A",
            "qty": 15,
            "status": "Completed",
            "outputItemName": _unique_name("A-Different-Name"),
            # saveProduction requires at least one component; an ITEM one
            # keeps this fixture about the OUTPUT name and nothing else.
            "componentsConsumed": [{"itemName": "Bolt", "qty": 15, "sourceType": "ITEM"}],
        }],
        mutation=True,
    )
    body = saved.get_json()
    assert body["success"] is True, body["message"]
    lot_number = body["data"]["row"]["lotNumber"]

    rows = _ledger(erp_client, payload["outputItemName"])
    credits = [r for r in rows if r["type"] == "Production Credit"]
    assert [r["ref"] for r in credits] == [lot_number]
    assert credits[0]["inQty"] == 15
    assert _closing(rows) == _bucket(erp_client, payload["outputItemName"])["availableQty"] == 15


def test_consumption_shows_as_an_out_and_the_balance_still_closes(erp_client):
    upstream, upstream_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening",
         [{"processId": upstream_id, "qty": 30}], mutation=True)

    downstream, downstream_id = _save_process(erp_client, sequence=2)
    saved = _rpc(
        erp_client,
        "saveProduction",
        [{
            "processId": downstream_id,
            "assignedTo": "Worker B",
            "qty": 10,
            "status": "Completed",
            "componentsConsumed": [
                {"itemName": upstream["outputItemName"], "qty": 10, "sourceType": "POOL"}
            ],
        }],
        mutation=True,
    )
    assert saved.get_json()["success"] is True, saved.get_json()["message"]

    rows = _ledger(erp_client, upstream["outputItemName"])
    outs = [r for r in rows if r["outQty"]]
    assert outs, "the draw should appear as an Out"
    assert sum(r["outQty"] for r in outs) == 10
    assert _closing(rows) == _bucket(erp_client, upstream["outputItemName"])["availableQty"] == 20


def test_unknown_bucket_returns_an_empty_ledger_not_an_error(erp_client):
    body = _rpc(erp_client, "getWarehousePoolLedger", ["No Such Item", "", ""]).get_json()
    assert body["success"] is True
    assert body["data"] == []


def test_output_item_name_is_required(erp_client):
    body = _rpc(erp_client, "getWarehousePoolLedger", ["", "", ""]).get_json()
    assert body["success"] is False
