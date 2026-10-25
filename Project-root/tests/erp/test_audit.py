"""The Audit report (audit_service): every check finds what it is for, the
ranking is stable, and a run writes nothing but its own two tables."""

from __future__ import annotations

import uuid
from datetime import date
from types import SimpleNamespace

import psycopg2.extras

import database
from app.erp.services import audit_service, stock_service


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
