"""Phase 0 RPC dispatcher tests: unknown method, testConnection, auth gate.

Mutation idempotency (X-Mutation-Id replay) is deferred to Phase 1 -- no
mutating RPC methods exist yet to exercise it against.
"""

from __future__ import annotations


def test_unknown_method_returns_404_envelope(erp_client):
    resp = erp_client.post("/api/erp/rpc/notARealMethod", json={"args": []})
    assert resp.status_code == 404
    body = resp.get_json()
    assert body["success"] is False
    assert "notARealMethod" in body["message"]


def test_test_connection_returns_success_envelope(erp_client):
    resp = erp_client.post("/api/erp/rpc/testConnection", json={"args": []})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["appTitle"] == "Maharaja Bikes ERP"
    assert body["data"]["dbAvailable"] is True


def test_rpc_requires_login(erp_app):
    client = erp_app.test_client()  # no session set up -- not logged in
    resp = client.post("/api/erp/rpc/testConnection", json={"args": []})
    # Flask-Login's default unauthorized handler either redirects to the
    # login view or aborts 401 depending on the request's Accept header.
    assert resp.status_code in (302, 401)
