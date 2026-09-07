"""A missing connection pool must report itself, not a fake logout.

On 2026-09-07 a live worker served requests with `database.db_pool = None`.
Every RPC failed, but not visibly as a database fault: get_conn() raised,
load_user() caught it and returned None, Flask-Login read that as "not signed
in", @login_required redirected to the login page, fetch() followed the
redirect, and the browser reported

    SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON

in every module at once. The one thing the failure never said was
"database". It was diagnosed as a session bug, then a Select2 bug, then a
search bug, before anyone looked at the pool.

These pin the fix: a missing pool is a 503 that says so, and -- the boundary
that matters -- a genuinely unauthenticated caller still gets 401, because
turning real auth failures into 503s would be its own kind of lie.
"""

from __future__ import annotations

import database


def test_missing_pool_is_a_json_503_for_rpc(erp_client, monkeypatch):
    monkeypatch.setattr(database, "db_pool", None)

    resp = erp_client.post("/api/erp/rpc/testConnection", json={"args": []})

    assert resp.status_code == 503
    assert resp.mimetype == "application/json"
    body = resp.get_json()
    assert body["success"] is False
    assert "database" in body["message"].lower()
    # The user must not be told to sign in again -- that was the whole defect.
    assert "signed out" in body["message"].lower()


def test_missing_pool_does_not_redirect_an_rpc_to_the_login_page(
    erp_client, monkeypatch
):
    """The specific shape of the original bug: a 302 that fetch() follows,
    turning the login page into an HTTP 200 the client tries to parse."""
    monkeypatch.setattr(database, "db_pool", None)

    resp = erp_client.post("/api/erp/rpc/getUnitsData", json={"args": []})

    assert resp.status_code != 302
    assert "login" not in resp.headers.get("Location", "")
    assert not resp.get_data(as_text=True).lstrip().startswith("<!DOCTYPE")


def test_missing_pool_on_a_page_is_503_not_a_login_redirect(erp_client, monkeypatch):
    """Also pins load_user's re-entry guard, which is not optional.

    The 503 handler renders a template, and Flask-Login installs a template
    context processor that resolves current_user -- so rendering the error
    page calls the loader a SECOND time. Without the guard that second call
    aborts again, inside the error handler, where Flask cannot handle it, and
    the ServiceUnavailable escapes as a bare unhandled exception. This test
    fails outright (not as an assertion, as an escaped exception) if the
    guard is removed.
    """
    monkeypatch.setattr(database, "db_pool", None)

    resp = erp_client.get("/erp", headers={"Accept": "text/html"})

    assert resp.status_code == 503


def test_a_real_signed_out_caller_still_gets_401(erp_app, monkeypatch):
    """The boundary. With the pool healthy and no session, this is an
    authentication failure and must stay one -- the 503 path is only for a
    pool that is genuinely gone."""
    client = erp_app.test_client()  # no session

    resp = client.post("/api/erp/rpc/testConnection", json={"args": []})

    assert resp.status_code == 401
    assert resp.get_json()["success"] is False


def test_a_healthy_pool_is_unaffected(erp_client):
    resp = erp_client.post("/api/erp/rpc/testConnection", json={"args": []})

    assert resp.status_code == 200
    assert resp.get_json()["success"] is True
