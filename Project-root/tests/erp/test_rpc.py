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


def test_unexpected_exception_is_logged_and_not_leaked_to_client(erp_client, caplog):
    """A bug (not a domain ValueError/RuntimeError) must not reach the client
    as raw exception text, and must be logged server-side -- see
    app/erp/rpc.py's _DOMAIN_ERROR_TYPES split. getUnitsData takes no
    arguments, so passing one forces a real TypeError from the dispatcher's
    own *args splat -- not a mock, an actual uncaught-bug simulation.
    """
    import logging

    with caplog.at_level(logging.ERROR, logger="app.erp.rpc"):
        resp = erp_client.post("/api/erp/rpc/getUnitsData", json={"args": ["unexpected_extra_arg"]})

    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is False
    # The raw TypeError text ("takes 0 positional arguments but 1 was given")
    # must never reach the client -- only the generic message + reference id.
    assert "positional argument" not in body["message"]
    assert "reference" in body["message"]
    # ... but it MUST be logged server-side, which is the actual bug this fixes:
    # before this change, nothing here would have appeared in any log at all.
    assert any("getUnitsData" in rec.message for rec in caplog.records)


def test_domain_error_message_still_passes_through_verbatim(erp_client):
    """Unchanged behaviour: a real ValueError from a service (bad input) is
    still shown to the user as-is -- only genuinely unexpected exceptions
    are masked.
    """
    resp = erp_client.post(
        "/api/erp/rpc/saveUnit",
        json={"args": [{"unitName": "", "family": "Count", "factorToBase": 1}]},
        headers={"X-Mutation-Id": str(uuid.uuid4())},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is False
    assert body["message"]  # non-empty, service-provided validation message


def test_role_gated_method_denies_user_without_the_role(erp_app, erp_client):
    """Proves the RpcSpec.roles enforcement mechanism actually works, without
    assigning a role requirement to any real production method (that mapping
    is a deferred business decision -- see registry.py's RpcSpec.roles
    docstring). Registers a throwaway method requiring 'manager', calls it as
    the fixture's plain 'user'-role account, and asserts 403 -- then removes
    the throwaway registration so it can't leak into other tests.
    """
    from app.erp.registry import RPC_METHODS, RpcSpec

    RPC_METHODS["__testRoleGatedMethod"] = RpcSpec(
        name="__testRoleGatedMethod",
        func=lambda: {"success": True, "data": "should not be reached", "message": ""},
        roles=frozenset({"manager"}),
    )
    try:
        resp = erp_client.post("/api/erp/rpc/__testRoleGatedMethod", json={"args": []})
        assert resp.status_code == 403
        body = resp.get_json()
        assert body["success"] is False
        assert "manager" not in body["message"]  # don't leak which role would have worked
    finally:
        del RPC_METHODS["__testRoleGatedMethod"]


def test_role_gated_method_allows_matching_role(erp_app, erp_test_user):
    """Same mechanism, opposite outcome: promote the fixture user to
    'manager' and confirm the same gated method now succeeds.
    """
    import database
    from app.erp.registry import RPC_METHODS, RpcSpec

    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute("UPDATE users SET role = 'manager' WHERE user_id = %s", (erp_test_user,))

    client = erp_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = str(erp_test_user)
        sess["_fresh"] = True

    RPC_METHODS["__testRoleGatedMethod"] = RpcSpec(
        name="__testRoleGatedMethod",
        func=lambda: {"success": True, "data": "reached", "message": ""},
        roles=frozenset({"manager"}),
    )
    try:
        resp = client.post("/api/erp/rpc/__testRoleGatedMethod", json={"args": []})
        assert resp.status_code == 200
        assert resp.get_json()["data"] == "reached"
    finally:
        del RPC_METHODS["__testRoleGatedMethod"]
        with erp_app.app_context():
            with database.get_conn() as (_conn, cur):
                cur.execute("UPDATE users SET role = 'user' WHERE user_id = %s", (erp_test_user,))


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


# ── Real methods gated via RpcSpec.roles (first non-synthetic uses of the
# mechanism proven generically above) ────────────────────────────────────

def test_trigger_backup_is_admin_only(erp_client):
    """Asserts only the 403 -- deliberately does not call this as an admin
    here, since a real triggerBackup attempts an actual backup/Sheets
    upload; that path is covered by test_backup.py's mocked tests."""
    resp = erp_client.post("/api/erp/rpc/triggerBackup", json={"args": []}, headers={"X-Mutation-Id": str(uuid.uuid4())})
    assert resp.status_code == 403
    assert resp.get_json()["success"] is False


def test_run_scheduled_item_cleanup_is_admin_only(erp_client, erp_admin_client):
    denied = erp_client.post(
        "/api/erp/rpc/runScheduledItemCleanup", json={"args": []}, headers={"X-Mutation-Id": str(uuid.uuid4())}
    )
    assert denied.status_code == 403

    allowed = erp_admin_client.post(
        "/api/erp/rpc/runScheduledItemCleanup", json={"args": []}, headers={"X-Mutation-Id": str(uuid.uuid4())}
    )
    assert allowed.status_code == 200
    assert allowed.get_json()["success"] is True
