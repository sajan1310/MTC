"""RPC dispatcher tests: unknown method, testConnection, auth gate, and
mutation idempotency (X-Mutation-Id replay) via saveUnit -- the first real
mutating method (Phase 0 deferred this test since no mutating method existed
yet to exercise it against).
"""

from __future__ import annotations

import uuid

import psycopg2.extras

import database


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


def test_mutation_missing_mutation_id_header_is_rejected(erp_client):
    resp = erp_client.post("/api/erp/rpc/saveUnit", json={"args": [{"unitName": "x", "family": "Count", "factorToBase": 1}]})
    assert resp.status_code == 400
    assert resp.get_json()["success"] is False


def test_replayed_mutation_id_does_not_re_execute(erp_client):
    """Same X-Mutation-Id posted twice against saveUnit -> exactly one row,
    and the second response is the stored envelope, not a re-execution
    (which would otherwise fail as a duplicate-name save).
    """
    unit_name = f"Idem-{uuid.uuid4().hex[:8]}"
    mutation_id = str(uuid.uuid4())
    payload = {"args": [{"unitName": unit_name, "family": "Count", "factorToBase": 1}]}
    headers = {"X-Mutation-Id": mutation_id}

    first = erp_client.post("/api/erp/rpc/saveUnit", json=payload, headers=headers)
    second = erp_client.post("/api/erp/rpc/saveUnit", json=payload, headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.get_json() == second.get_json()
    assert first.get_json()["success"] is True

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            "SELECT COUNT(*) AS n FROM erp.units WHERE lower(unit_name) = lower(%s) AND deleted_at IS NULL",
            (unit_name,),
        )
        assert cur.fetchone()["n"] == 1
