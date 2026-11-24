"""Every module that moves stock, walked end to end with figures worked out
by hand (asked 2026-11-24: "verify the stock debit credit logic ... match
the interactions and relation between all the modules").

Two ledgers, and what moves each:

  Items Stock (per item and size)
      Current = newest count, or opening stock if never counted
              + bills (Goods lines that affect stock)
              - returns - issues - wastage off Stock
              - what lots used: all of a Completed lot, the received share
                of one still open
              +/- merges
      counting only what took effect after that count.

  Warehouse Pool (per item, product tag and colour)
      Available = newest recount, or nothing
                + opening stock and Labor bills added to the pool
                + what lots made: all of a Completed lot, each receipt of
                  one still open
                - what lots drew from it (POOL lines), on the same terms
                - wastage off the pool - dispatches
      counting only what took effect after that recount.

Pending and In Progress lots move nothing; Cancelled keeps what its receipts
moved. At every step the Stock page, the Item Ledger, the pool, the Pool
Ledger and the Audit's own rebuilds must agree with the hand figure.
"""

from __future__ import annotations

import uuid
from datetime import date

import psycopg2.extras
import pytest

import database
from app import limiter
from app.erp.services import audit_service, bom_service


@pytest.fixture(autouse=True)
def _no_hourly_cap():
    """The app-wide default of 50 requests an hour on one route still applies
    to the test app, and this walk reads every screen after every step."""
    was = limiter.enabled
    limiter.enabled = False
    yield
    limiter.enabled = was


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _ok(resp):
    body = resp.get_json()
    assert body is not None, (resp.status_code, resp.get_data(as_text=True)[:300])
    assert body["success"] is True, body.get("message")
    return body


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _today() -> str:
    return date.today().strftime("%d/%m/%Y")


# ── What each screen says ──────────────────────────────────────────────────


def _stock(client, name, size=""):
    """The Stock page's figure, which the Item Ledger must close on."""
    rows = _ok(_rpc(client, "getStockData"))["data"]
    row = next(r for r in rows if r["name"] == name and (r["size"] or "") == size)
    ledger = _ok(_rpc(client, "getItemLedgerData", [name]))["data"]
    recon = next(r for r in ledger["reconciliation"] if (r.get("size") or "") == size)
    assert abs(recon["currentStock"] - row["currentStock"]) < 1e-6
    assert abs(recon["computedStock"] - row["currentStock"]) < 1e-6
    return round(row["currentStock"], 6)


def _pool(client, name, colour=""):
    """A bucket's Available, which its Pool Ledger must close on."""
    rows = _ok(_rpc(client, "getWarehousePoolData"))["data"]
    bucket = next(
        (
            b
            for b in rows
            if b["outputItemName"] == name
            and (b["color"] or "") == colour
            and not (b["productTag"] or "")
        ),
        None,
    )
    available = bucket["availableQty"] if bucket else 0
    ledger = _ok(_rpc(client, "getWarehousePoolLedger", [name, "", colour]))["data"]
    if ledger:
        assert ledger[0]["balance"] == available  # newest first
    return available


def _integrity(*names):
    """The Audit's integrity findings for these items or buckets: its own
    rebuild of Stock and of the pool against what the screens show."""
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        conn,
        cur,
    ):
        cur.execute(audit_service._SNAPSHOT_SQL)
        found, errors = audit_service.compute_findings(cur)
        conn.rollback()
    assert errors == []
    wanted = {n.lower() for n in names}
    return [
        (f["check"], f["title"])
        for f in found
        if f["kind"] == "integrity" and str(f.get("item") or "").lower() in wanted
    ]


# ── Entries ────────────────────────────────────────────────────────────────


def _item(client, size=""):
    name = _unique("FlowItem")
    _ok(_rpc(client, "saveItem", [{"itemName": name, "itemSize": size}], mutation=True))
    return name


def _process(client, output, components=(), **extra):
    payload = {
        "processName": _unique("FlowProcess"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": output,
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": list(components),
        "colorLinks": [],
        **extra,
    }
    return _ok(_rpc(client, "saveProcess", [payload], mutation=True))["data"][
        "processId"
    ]


def _bill(client, name, qty, **line):
    vendor, number = _unique("FlowVendor"), _unique("FLOWBILL")
    _ok(
        _rpc(
            client,
            "saveBill",
            [
                {
                    "vendor": vendor,
                    "billNumber": number,
                    "billDate": _today(),
                    "items": [
                        {"name": name, "qty": qty, "price": 5, "unit": "Pcs", **line}
                    ],
                }
            ],
            mutation=True,
        )
    )
    return vendor, number


def _lot(client, process_id, qty, components, status, **form):
    body = _ok(
        _rpc(
            client,
            "saveProduction",
            [
                {
                    "processId": process_id,
                    "assignedTo": "Flow Worker",
                    "status": status,
                    "qty": qty,
                    "componentsConsumed": components,
                    **form,
                }
            ],
            mutation=True,
        )
    )
    return body["data"]["row"]["rowIdx"], body["data"]["lotNumber"]


def _status(client, row_idx, qty, status):
    _ok(_rpc(client, "updateProductionStatus", [row_idx, qty, status], mutation=True))


def _bom_product(erp_app, client):
    with erp_app.app_context():
        bom_service.set_bom_password("test-only-bom-password")
    token = _ok(_rpc(client, "verifyBOMAccess", ["test-only-bom-password"]))["data"][
        "token"
    ]
    name = _unique("FlowCycle")
    body = _ok(
        _rpc(
            client,
            "saveBOM",
            [
                {
                    "productName": name,
                    "components": [
                        {"itemName": _unique("BomItem"), "qtyPerProduct": 1}
                    ],
                },
                token,
            ],
            mutation=True,
        )
    )
    return name, body["data"]["productId"]


# ── The walk ───────────────────────────────────────────────────────────────


def test_goods_through_every_module_land_exactly_where_the_formulae_say(
    erp_app, erp_admin_client
):
    client = erp_admin_client
    raw = _item(client)
    sticker = _item(client)
    frame = _unique("Painted Frame")
    cycle_out = _unique("Packed Cycle")
    product_name, product_id = _bom_product(erp_app, client)

    paint = _process(client, frame)
    pack = _process(
        client,
        cycle_out,
        components=[
            {"itemName": frame, "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": ""}
        ],
        isFinalStage=True,
        sequence=2,
    )

    # Received bills add to Stock; a Ledger only line does not.
    _bill(client, raw, 100)
    vendor, number = _bill(client, sticker, 40)
    assert _stock(client, raw) == 100
    assert _stock(client, sticker) == 40

    # Issue, wastage off Stock and a vendor return each take from it.
    _ok(
        _rpc(
            client,
            "saveIssueStock",
            [
                {
                    "issuedTo": "Flow Line",
                    "date": _today(),
                    "items": [{"name": raw, "qty": 10, "unit": "Pcs"}],
                }
            ],
            mutation=True,
        )
    )
    _ok(
        _rpc(
            client,
            "saveWastage",
            [
                {
                    "date": date.today().isoformat(),
                    "items": [{"name": raw, "qty": 5, "unit": "Pcs", "reason": "Bent"}],
                }
            ],
            mutation=True,
        )
    )
    _ok(
        _rpc(
            client,
            "saveReturn",
            [
                {
                    "vendor": vendor,
                    "billNumber": number,
                    "returnDate": _today(),
                    "items": [{"name": sticker, "qty": 4, "price": 5}],
                }
            ],
            mutation=True,
        )
    )
    assert _stock(client, raw) == 85  # 100 - 10 - 5
    assert _stock(client, sticker) == 36  # 40 - 4

    # A painting lot moves nothing while it is Pending or In Progress.
    paint_lot, _ = _lot(
        client,
        paint,
        20,
        [
            {"itemName": raw, "qty": 20, "sourceType": "ITEM"},
            {"itemName": sticker, "qty": 20, "sourceType": "ITEM"},
        ],
        "Pending",
    )
    _status(client, paint_lot, 20, "In Progress")
    assert _stock(client, raw) == 85
    assert _pool(client, frame) == 0

    # Half received: the pool gets 10 frames, Stock gives up half the parts.
    _ok(
        _rpc(
            client,
            "saveProductionReceipt",
            [
                {
                    "rowIdx": paint_lot,
                    "date": _today(),
                    "lines": [{"color": "", "qty": 10}],
                }
            ],
            mutation=True,
        )
    )
    assert _pool(client, frame) == 10
    assert _stock(client, raw) == 75
    assert _stock(client, sticker) == 26

    # Completed: the balance is counted as received now.
    _status(client, paint_lot, 20, "Completed")
    assert _pool(client, frame) == 20
    assert _stock(client, raw) == 65
    assert _stock(client, sticker) == 16

    # The final stage draws frames from the pool, not from Stock.
    pack_lot, _ = _lot(
        client,
        pack,
        12,
        [{"itemName": frame, "qty": 12, "sourceType": "POOL"}],
        "Completed",
        productId=product_id,
        productName=product_name,
    )
    assert _pool(client, frame) == 8
    assert _stock(client, raw) == 65  # untouched by a POOL line
    ready = next(
        r
        for r in _ok(_rpc(client, "getReadyToDispatchData"))["data"]
        if r["productId"] == product_id
    )
    assert ready["readyQty"] == 12

    # Wastage off the pool and a dispatch both take from their buckets.
    _ok(
        _rpc(
            client,
            "saveWastage",
            [
                {
                    "date": date.today().isoformat(),
                    "items": [
                        {
                            "sourceType": "POOL",
                            "name": frame,
                            "color": "",
                            "productTag": "",
                            "qty": 3,
                            "reason": "Chipped",
                        }
                    ],
                }
            ],
            mutation=True,
        )
    )
    assert _pool(client, frame) == 5
    _ok(
        _rpc(
            client,
            "saveDispatch",
            [
                {
                    "lines": [
                        {"productId": product_id, "productName": product_name, "qty": 7}
                    ]
                }
            ],
            mutation=True,
        )
    )
    ready = next(
        r
        for r in _ok(_rpc(client, "getReadyToDispatchData"))["data"]
        if r["productId"] == product_id
    )
    assert ready["readyQty"] == 5  # 12 made - 7 dispatched

    # Counts are anchors: what came before is inside them.
    _ok(
        _rpc(
            client,
            "adjustStockManually",
            [raw, "", 60, "physical recount"],
            mutation=True,
        )
    )
    assert _stock(client, raw) == 60
    _ok(
        _rpc(
            client,
            "adjustWarehousePoolManually",
            [frame, paint, "", "", 4, "physical recount"],
            mutation=True,
        )
    )
    assert _pool(client, frame) == 4

    # Reopening the painting lot gives its parts back and takes its frames
    # out -- but both sit inside today's counts, which already saw them.
    _status(client, paint_lot, 20, "In Progress")
    assert _stock(client, raw) == 60
    assert _pool(client, frame) == 4
    # The sticker was never counted: the receipt's half stays used, the
    # balance that completing counted as received comes back.
    assert _stock(client, sticker) == 26

    # Completed again, it keeps its first Completed moment -- switching a
    # lot back and forth never makes it new stock -- so it is still inside
    # the count, and only the uncounted sticker moves.
    _status(client, paint_lot, 20, "Completed")
    assert _stock(client, raw) == 60
    assert _stock(client, sticker) == 16

    assert _integrity(raw, sticker, frame, cycle_out) == []

    # Deleting the packing lot puts its frames back and its cycles out.
    pack_row = _ok(_rpc(client, "getProductionData"))["data"]
    pack_rec = next(r for r in pack_row if r["rowIdx"] == pack_lot)
    _ok(
        _rpc(
            client,
            "deleteProduction",
            [pack_lot, pack_rec.get("productId"), pack_rec.get("qty")],
            mutation=True,
        )
    )
    assert _pool(client, frame) == 4  # the recount already holds it
    assert _integrity(raw, sticker, frame, cycle_out) == []


def test_a_lot_line_naming_an_item_in_a_size_items_master_lacks_is_refused(
    erp_admin_client,
):
    """The desktop lot form saved a swapped item with the old item's size
    until 2026-11-24 ("PEDAL-BLACK---STEEL BALL-20"" as GENERAL): such a line
    takes its parts off no Stock row at all."""
    client = erp_admin_client
    pedal = _item(client, "20 inch")
    _bill(client, pedal, 50, size="20 inch")
    process = _process(client, _unique("Packed"))

    refused = _rpc(
        client,
        "saveProduction",
        [
            {
                "processId": process,
                "assignedTo": "Flow Worker",
                "status": "Completed",
                "qty": 10,
                "componentsConsumed": [
                    {
                        "itemName": pedal,
                        "size": "GENERAL",
                        "qty": 10,
                        "sourceType": "ITEM",
                    }
                ],
            }
        ],
        mutation=True,
    ).get_json()
    assert refused["success"] is False
    assert refused["message"] == (
        f'{pedal} is not in Items Master in size "GENERAL" (it has 20 inch). '
        "Change the size on that line to the one the lot used, then save again."
    )
    assert _stock(client, pedal, "20 inch") == 50

    # The size it has: the parts come off it.
    _lot(
        client,
        process,
        10,
        [{"itemName": pedal, "size": "20 inch", "qty": 10, "sourceType": "ITEM"}],
        "Completed",
    )
    assert _stock(client, pedal, "20 inch") == 40

    # A name Items Master does not know at all saves as it always did.
    stranger = _unique("Loose part")
    _lot(
        client,
        process,
        1,
        [{"itemName": stranger, "size": "GENERAL", "qty": 1, "sourceType": "ITEM"}],
        "Completed",
    )
