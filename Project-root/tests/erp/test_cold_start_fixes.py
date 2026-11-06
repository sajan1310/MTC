"""What made the app slow, and then fail, to start on 2026-11-06.

The server log of that morning (09:23-09:29 IST), and the fix each test pins:

* getMobileDashboard built the whole production history (8 MB) and the
  whole dispatch history for two counters and five activity rows. It took
  66 and 117 s, then failed. It now asks the database for exactly those.
* getProductionData held a transaction open while it turned that history
  into Python. On a cold morning that took over 60 s, Postgres ended the
  idle transaction, and the next query failed with "SSL connection has been
  closed unexpectedly". It now reads in autocommit.
* Every RPC from the phone came back 401: its session had lapsed overnight,
  although its remember-me cookie was still good. /api/erp/csrf-token lets
  the page start the new session and carry on, instead of reloading.
* An idle worker keeps its memory in use (app/erp/keep_warm.py), and
  gunicorn closes each upstream connection after its response
  (gunicorn.conf.py) -- the 502 at 09:28:38.
"""

from __future__ import annotations

import runpy
import uuid
from datetime import date, timedelta
from pathlib import Path

import psycopg2.extensions
import pytest
from flask_login.utils import encode_cookie

from app.erp import keep_warm
from app.erp.services import bom_service, lot_receipts, production_service

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _rpc(client, method, args=None, mutation=False, headers=None):
    headers = dict(headers or {})
    if mutation:
        headers["X-Mutation-Id"] = str(uuid.uuid4())
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _ok(resp):
    body = resp.get_json()
    assert body["success"] is True, body.get("message")
    return body["data"]


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _save_process(client, **overrides):
    payload = {
        "processName": _unique("Process"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique("Output"),
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
    return _ok(_rpc(client, "saveProcess", [payload], mutation=True))["processId"]


def _save_lot(client, process_id, status, lot_date, qty=5, **overrides):
    form = {
        "processId": process_id,
        "assignedTo": "Worker A",
        "qty": qty,
        "status": status,
        "date": lot_date.isoformat(),
        "componentsConsumed": [{"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}],
    }
    form.update(overrides)
    return _ok(_rpc(client, "saveProduction", [form], mutation=True))["row"]


def _bom_product(erp_app, client):
    with erp_app.app_context():
        bom_service.set_bom_password("test-only-bom-password")
    token = _ok(_rpc(client, "verifyBOMAccess", ["test-only-bom-password"]))["token"]
    name = _unique("ColdStartProduct")
    payload = {
        "productName": name,
        "components": [{"itemName": _unique("BomItem"), "qtyPerProduct": 1}],
    }
    product_id = _ok(_rpc(client, "saveBOM", [payload, token], mutation=True))[
        "productId"
    ]
    return name, product_id


def _save_dispatch(client, lines, dispatch_date):
    form = {"lines": lines, "dispatchDate": dispatch_date.isoformat()}
    return _ok(_rpc(client, "saveDispatch", [form], mutation=True))["dispatchNumber"]


def _mobile_dashboard_as_it_was(client) -> dict:
    """getMobileDashboard's figures, worked out the way it did before
    2026-11-06: from the complete getProductionData and getDispatchData
    lists. The rewrite has to give exactly this."""
    lots = _ok(_rpc(client, "getProductionData"))
    lines = _ok(_rpc(client, "getDispatchData"))
    today_key = date.today().isoformat()

    activity = []
    for lot in lots:
        if not lot.get("dateRaw"):
            continue
        activity.append(
            {
                "type": "production",
                "title": lot.get("lotNumber") or lot.get("processId"),
                "subtitle": f"{lot['qty']} unit(s) · {lot['status']}",
                "dateRaw": lot["dateRaw"],
            }
        )
    for d in lines:
        if not d.get("dateRaw"):
            continue
        activity.append(
            {
                "type": "dispatch",
                "title": d["dispatchNumber"],
                "subtitle": f"{d.get('clientName') or 'Direct supply'} · {d['qty']} unit(s)",
                "dateRaw": d["dateRaw"],
            }
        )
    activity.sort(key=lambda a: a["dateRaw"], reverse=True)
    return {
        "pendingProductionCount": sum(
            1 for lot in lots if lot["status"] in ("Pending", "In Progress")
        ),
        "todaysDispatchCount": sum(
            1 for d in lines if d.get("dateRaw") and d["dateRaw"][:10] == today_key
        ),
        "recentActivity": activity[:5],
    }


# ── getMobileDashboard ─────────────────────────────────────────────────────


@pytest.fixture
def activity_seed(erp_app, erp_client):
    """Lots and dispatch lines dated after anything else in the shared test
    database, so the activity list is made of them and every tie-break the
    old merge had is exercised: lots before lines on the same day, lots by
    id, lines by dispatch number and line id.

    In the future (two and three days ahead) so no other test's rows, all
    dated today or earlier, can come between them. Removed afterwards.
    """
    client = erp_client
    newest = date.today() + timedelta(days=3)
    next_newest = date.today() + timedelta(days=2)

    plain = _save_process(client)
    final = _save_process(client, isFinalStage=True)
    name_a, product_a = _bom_product(erp_app, client)
    name_b, product_b = _bom_product(erp_app, client)

    rows = [
        # Ready stock for the dispatches below -- dated today, out of the way.
        _save_lot(
            client, final, "Completed", date.today(), qty=20, productId=product_a
        ),
        _save_lot(
            client, final, "Completed", date.today(), qty=20, productId=product_b
        ),
        # One lot on the newest day: it must come before that day's lines.
        _save_lot(client, plain, "In Progress", newest, qty=2.5),
        # Two on the day before, to be ordered by id.
        _save_lot(client, plain, "Pending", next_newest),
        _save_lot(client, plain, "In Progress", next_newest),
    ]
    dispatches = [
        _save_dispatch(
            client,
            [
                {"productId": product_a, "productName": name_a, "qty": 2},
                {"productId": product_b, "productName": name_b, "qty": 3},
            ],
            newest,
        ),
        _save_dispatch(
            client, [{"productId": product_a, "productName": name_a, "qty": 1}], newest
        ),
        # Today, so the today counter has lines to count: two of them.
        _save_dispatch(
            client,
            [
                {"productId": product_a, "productName": name_a, "qty": 1},
                {"productId": product_b, "productName": name_b, "qty": 1},
            ],
            date.today(),
        ),
    ]
    yield {"rows": rows, "dispatches": dispatches}

    for number in dispatches:
        _rpc(client, "deleteDispatch", [number], mutation=True)
    for row in rows:
        _rpc(client, "deleteProduction", [row["rowIdx"]], mutation=True)


def test_mobile_dashboard_gives_exactly_what_the_full_lists_gave(
    erp_client, activity_seed
):
    expected = _mobile_dashboard_as_it_was(erp_client)
    got = _ok(_rpc(erp_client, "getMobileDashboard"))

    assert got["pendingProductionCount"] == expected["pendingProductionCount"]
    assert got["todaysDispatchCount"] == expected["todaysDispatchCount"]
    assert got["recentActivity"] == expected["recentActivity"]


def test_mobile_dashboard_activity_is_the_seeded_rows_in_merge_order(
    erp_client, activity_seed
):
    got = _ok(_rpc(erp_client, "getMobileDashboard"))["recentActivity"]
    newest_lot = activity_seed["rows"][2]

    # The newest day: its lot first, then its three lines -- the later
    # dispatch number first, and within a dispatch the later line first.
    assert [a["type"] for a in got] == [
        "production",
        "dispatch",
        "dispatch",
        "dispatch",
        "production",
    ]
    assert got[0]["title"] == newest_lot["lotNumber"]
    assert got[0]["subtitle"] == "2.5 unit(s) · In Progress"
    first, second = activity_seed["dispatches"][:2]
    assert [a["title"] for a in got[1:4]] == sorted(
        [first, first, second], reverse=True
    )
    # The day before: the later lot (by id) of its two.
    assert got[4]["title"] == activity_seed["rows"][4]["lotNumber"]


def test_mobile_dashboard_counts_todays_dispatch_lines(erp_client, activity_seed):
    """The phone's "Today's dispatches" tile has always counted lines, not
    dispatches; the rewrite keeps that. The seed's dispatch dated today has
    two lines."""
    expected = _mobile_dashboard_as_it_was(erp_client)["todaysDispatchCount"]
    assert expected >= 2
    assert (
        _ok(_rpc(erp_client, "getMobileDashboard"))["todaysDispatchCount"] == expected
    )


def test_mobile_dashboard_no_longer_reads_the_production_history(
    erp_client, monkeypatch
):
    def refuse():
        raise AssertionError("getMobileDashboard read the whole production history")

    monkeypatch.setattr(production_service, "get_production_data", refuse)
    _ok(_rpc(erp_client, "getMobileDashboard"))


# ── getProductionData: no transaction while the list is built ─────────────


def test_production_list_reads_without_an_open_transaction(erp_app, monkeypatch):
    """Postgres ends a session idle INSIDE a transaction after 60 s. With
    autocommit, the gap between the lots query and the receipts query --
    where fetchall() builds every lot -- is not inside one."""
    seen = []
    real = lot_receipts.load_receipts

    def spy(cur, *args, **kwargs):
        seen.append(cur.connection.get_transaction_status())
        return real(cur, *args, **kwargs)

    monkeypatch.setattr(lot_receipts, "load_receipts", spy)
    with erp_app.app_context():
        production_service.get_production_data()

    assert seen == [psycopg2.extensions.TRANSACTION_STATUS_IDLE]


def test_a_connection_used_in_autocommit_goes_back_to_transactions(erp_app):
    import database

    with erp_app.app_context():
        production_service.get_production_data()
        with database.get_conn() as (conn, cur):
            assert conn.autocommit is False
            cur.execute("SELECT 1")
            assert (
                conn.get_transaction_status()
                == psycopg2.extensions.TRANSACTION_STATUS_INTRANS
            )


# ── A lapsed session, recovered without a reload ───────────────────────────


def test_csrf_token_route_gives_a_signed_in_user_a_token(erp_client):
    resp = erp_client.get("/api/erp/csrf-token")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["csrfToken"]
    assert resp.headers["Cache-Control"] == "no-store"


def test_csrf_token_route_refuses_a_signed_out_page_with_json(erp_app):
    resp = erp_app.test_client().get("/api/erp/csrf-token")
    assert resp.status_code == 401
    assert resp.get_json()["success"] is False


def test_a_remembered_user_recovers_a_lapsed_session(erp_app, erp_test_user):
    """The morning of 2026-11-06, end to end: no session (it lapsed), a
    remember-me cookie, and a page holding the old session's token."""
    erp_app.config["WTF_CSRF_ENABLED"] = True
    client = erp_app.test_client()
    with erp_app.app_context():
        remember = encode_cookie(str(erp_test_user))
    client.set_cookie(
        erp_app.config.get("REMEMBER_COOKIE_NAME", "remember_token"),
        remember,
        domain=erp_app.config["SERVER_NAME"],
    )
    stale = {"X-CSRFToken": "token-of-the-session-that-lapsed"}

    refused = _rpc(client, "getColors", headers=stale)
    assert refused.status_code == 401

    fresh = client.get("/api/erp/csrf-token")
    assert fresh.status_code == 200
    token = fresh.get_json()["data"]["csrfToken"]

    again = _rpc(client, "getColors", headers={"X-CSRFToken": token})
    assert again.status_code == 200
    assert again.get_json()["success"] is True


# ── Keeping an idle worker warm ────────────────────────────────────────────


def test_keep_warm_is_due_only_after_a_full_idle_period(monkeypatch):
    monkeypatch.setattr(keep_warm, "IDLE_SECONDS", 3600)
    monkeypatch.setattr(keep_warm, "_last_use", 1000.0)

    assert not keep_warm._due(now=4000.0, warmed_at=0.0)  # used 50 min ago
    assert keep_warm._due(now=4600.0, warmed_at=0.0)  # idle a full hour
    assert not keep_warm._due(now=4600.0, warmed_at=4000.0)  # warmed 10 min ago
    assert keep_warm._due(now=7700.0, warmed_at=4000.0)  # still idle, an hour on


@pytest.mark.parametrize(
    "path, counts",
    [
        ("/api/erp/rpc/getStockData", True),
        ("/erp/mobile", True),
        ("/health", False),
        ("/metrics", False),
        ("/static/erp/core.js", False),
    ],
)
def test_keep_warm_counts_real_use_only(erp_app, monkeypatch, path, counts):
    monkeypatch.setattr(keep_warm, "_last_use", 0.0)
    with erp_app.test_request_context(path):
        keep_warm.note_request()
    assert (keep_warm._last_use > 0.0) is counts


def test_keep_warm_runs_the_morning_reads(erp_app):
    took = keep_warm.warm(erp_app)
    assert took >= 0.0


def test_keep_warm_stays_off_under_testing(erp_app, monkeypatch):
    started = []
    monkeypatch.setattr(
        keep_warm.threading, "Thread", lambda *a, **k: started.append(k)
    )
    keep_warm.start(erp_app)
    assert started == []


def test_gunicorn_closes_each_upstream_connection(monkeypatch):
    monkeypatch.delenv("GUNICORN_KEEPALIVE", raising=False)
    settings = runpy.run_path(str(PROJECT_ROOT / "gunicorn.conf.py"))
    assert settings["keepalive"] == 0
