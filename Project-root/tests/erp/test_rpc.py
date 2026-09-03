"""RPC dispatcher tests: unknown method, testConnection, auth gate, and
mutation idempotency (X-Mutation-Id replay) via saveUnit -- the first real
mutating method (Phase 0 deferred this test since no mutating method existed
yet to exercise it against).
"""

from __future__ import annotations

import contextlib
import dataclasses
import uuid

import psycopg2.extras
import pytest

import database
from app.erp import mutations


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
        resp = erp_client.post(
            "/api/erp/rpc/getUnitsData", json={"args": ["unexpected_extra_arg"]}
        )

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
        assert (
            "manager" not in body["message"]
        )  # don't leak which role would have worked
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
            cur.execute(
                "UPDATE users SET role = 'manager' WHERE user_id = %s", (erp_test_user,)
            )

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
                cur.execute(
                    "UPDATE users SET role = 'user' WHERE user_id = %s",
                    (erp_test_user,),
                )


def test_mutation_missing_mutation_id_header_is_rejected(erp_client):
    resp = erp_client.post(
        "/api/erp/rpc/saveUnit",
        json={"args": [{"unitName": "x", "family": "Count", "factorToBase": 1}]},
    )
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

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
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
    resp = erp_client.post(
        "/api/erp/rpc/triggerBackup",
        json={"args": []},
        headers={"X-Mutation-Id": str(uuid.uuid4())},
    )
    assert resp.status_code == 403
    assert resp.get_json()["success"] is False


def test_run_scheduled_item_cleanup_is_admin_only(erp_client, erp_admin_client):
    denied = erp_client.post(
        "/api/erp/rpc/runScheduledItemCleanup",
        json={"args": []},
        headers={"X-Mutation-Id": str(uuid.uuid4())},
    )
    assert denied.status_code == 403

    allowed = erp_admin_client.post(
        "/api/erp/rpc/runScheduledItemCleanup",
        json={"args": []},
        headers={"X-Mutation-Id": str(uuid.uuid4())},
    )
    assert allowed.status_code == 200
    assert allowed.get_json()["success"] is True


# ── X-Mutation-Id validation (TEST-001) ──────────────────────────────────


@pytest.mark.parametrize(
    "bad_id",
    [
        "not-a-uuid",
        "12345",
        "'; DROP TABLE erp.rpc_mutations; --",
        "../../etc/passwd",
        "550e8400-e29b-41d4-a716",  # truncated
        "550e8400e29b41d4a716446655440000ff",  # too long
    ],
)
def test_a_non_uuid_mutation_id_is_rejected(erp_client, bad_id):
    """The header is a primary key value that reaches SQL. It is parsed as a
    UUID before anything is done with it, so a malformed one is a 400 rather
    than a stored row keyed by arbitrary client text."""
    resp = erp_client.post(
        "/api/erp/rpc/updateThreshold",
        json={"args": ["NoSuchItem", "", 5]},
        headers={"X-Mutation-Id": bad_id},
    )
    assert resp.status_code == 400
    body = resp.get_json()
    assert body["success"] is False
    assert "UUID" in body["message"]


def test_a_rejected_mutation_id_is_never_stored(erp_client):
    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT COUNT(*) FROM erp.rpc_mutations")
        before = cur.fetchone()[0]

    erp_client.post(
        "/api/erp/rpc/updateThreshold",
        json={"args": ["NoSuchItem", "", 5]},
        headers={"X-Mutation-Id": "not-a-uuid"},
    )

    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT COUNT(*) FROM erp.rpc_mutations")
        assert cur.fetchone()[0] == before


# ── The in-flight duplicate (DATA-003) ───────────────────────────────────


def test_a_duplicate_arriving_while_the_first_is_in_flight_gets_409(erp_client):
    """The double-submit case DATA-003 exists for. The second request must not
    execute the method a second time, and must not be told it succeeded -- 409
    lets the client retry the same id once the first one lands and then collect
    its stored envelope."""
    mutation_id = str(uuid.uuid4())
    # A claim held by "another request in flight": claimed, not completed.
    assert mutations.claim(mutation_id, "updateThreshold") is None

    try:
        resp = erp_client.post(
            "/api/erp/rpc/updateThreshold",
            json={"args": ["NoSuchItem", "", 5]},
            headers={"X-Mutation-Id": mutation_id},
        )
        assert resp.status_code == 409
        body = resp.get_json()
        assert body["success"] is False
        assert "already being processed" in body["message"]

        # The 409 left the first request's claim intact. Releasing it here
        # would let a third request execute concurrently after all, which is
        # the whole thing this mechanism prevents.
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            _conn,
            cur,
        ):
            cur.execute(
                "SELECT status FROM erp.rpc_mutations WHERE mutation_id = %s",
                (mutation_id,),
            )
            assert cur.fetchone()["status"] == "in_progress"
    finally:
        mutations.release(mutation_id)


def test_the_id_becomes_usable_again_once_the_holder_releases_it(erp_client):
    """release() runs when a request dies without storing an envelope. If it
    did not actually free the id, one crashed request would poison it for
    STALE_CLAIM_SECONDS and the user could not retry that action."""
    mutation_id = str(uuid.uuid4())
    mutations.claim(mutation_id, "updateThreshold")
    mutations.release(mutation_id)

    resp = erp_client.post(
        "/api/erp/rpc/updateThreshold",
        json={"args": ["NoSuchItem", "", 5]},
        headers={"X-Mutation-Id": mutation_id},
    )
    assert resp.status_code == 200
    assert "not found in Stock" in resp.get_json()["message"]


def test_a_failed_release_is_logged_and_never_masks_the_real_error(
    erp_client, caplog, monkeypatch
):
    """The cleanup branch in the dispatcher's `finally`.

    An unexpected exception inside the method is already caught and converted
    to an envelope, so the release path is only reached when storing that
    envelope ITSELF fails -- a dead connection, say. If the subsequent release
    also raised, its exception would replace the one that actually mattered
    and the real cause would never be logged. It is caught and logged instead.
    """
    import app.erp.rpc as rpc_module

    def _complete_boom(_mutation_id, _result):
        raise RuntimeError("could not store the envelope")

    def _release_boom(_mutation_id):
        raise RuntimeError("release failed too")

    monkeypatch.setattr(rpc_module.mutations, "complete", _complete_boom)
    monkeypatch.setattr(rpc_module.mutations, "release", _release_boom)

    mutation_id = str(uuid.uuid4())
    with caplog.at_level("WARNING"):
        # The ORIGINAL error is what escapes -- not the release failure.
        with pytest.raises(RuntimeError, match="could not store the envelope"):
            erp_client.post(
                "/api/erp/rpc/updateThreshold",
                json={"args": ["NoSuchItem", "", 5]},
                headers={"X-Mutation-Id": mutation_id},
            )

    assert any(
        "Failed to release mutation claim" in r.getMessage() for r in caplog.records
    ), [r.getMessage() for r in caplog.records]

    with database.get_conn() as (_conn, cur):
        cur.execute(
            "DELETE FROM erp.rpc_mutations WHERE mutation_id = %s", (mutation_id,)
        )


# ── mutations.claim: the row-vanishes-underneath-it retry ────────────────


class _PruningCursor:
    """Wraps a real cursor and deletes `mutation_id` from a SEPARATE
    connection just before claim()'s follow-up SELECT runs -- reproducing a
    concurrent release() or prune landing in the window between claim()'s
    INSERT and that SELECT.

    Deleting from another connection is both faithful (that is where a real
    concurrent release comes from) and necessary: issuing it on the same
    cursor would discard the INSERT ... RETURNING result set that claim()
    has not fetched yet.
    """

    def __init__(self, cur, mutation_id, state, delete_conn_factory):
        self._cur = cur
        self._mutation_id = mutation_id
        self._state = state
        self._delete_conn_factory = delete_conn_factory

    def execute(self, sql, params=None):
        if (
            not self._state["done"]
            and "FROM erp.rpc_mutations" in sql
            and "SELECT" in sql
        ):
            self._state["done"] = True  # one-shot, or the retry recurses forever
            # Deliberately nested, so PERF-003's guard has to be opted out of
            # explicitly -- that is what allow_nested_connections() is for, and
            # needing it here is the guard working, not a problem with it.
            with database.allow_nested_connections():
                with self._delete_conn_factory() as (_conn, other):
                    other.execute(
                        "DELETE FROM erp.rpc_mutations WHERE mutation_id = %s",
                        (self._mutation_id,),
                    )
        return self._cur.execute(sql, params)

    def __getattr__(self, name):
        return getattr(self._cur, name)


def test_claim_retries_when_its_row_vanishes_between_insert_and_select(monkeypatch):
    """claim() INSERTs, and on conflict SELECTs the existing row to decide
    what to tell the caller. If that row is gone by the SELECT -- a concurrent
    release(), or the pruner -- there is nothing to report, and the honest
    answer is to run the claim again rather than report an in-flight duplicate
    that no longer exists. Without the retry, a user would be told their action
    was already being processed when nothing was."""
    mutation_id = str(uuid.uuid4())
    state = {"done": False}
    real_get_conn = database.get_conn

    @contextlib.contextmanager
    def _pruning_get_conn(*args, **kwargs):
        with real_get_conn(*args, **kwargs) as (conn, cur):
            yield conn, _PruningCursor(cur, mutation_id, state, real_get_conn)

    # Somebody else holds the id first, so the second claim below takes the
    # ON CONFLICT branch and reaches the SELECT at all.
    assert mutations.claim(mutation_id, "updateThreshold") is None

    monkeypatch.setattr(mutations.database, "get_conn", _pruning_get_conn)
    try:
        # The row disappears after the INSERT; the retry then wins the id
        # outright, so this returns None (we own it) rather than raising.
        assert mutations.claim(mutation_id, "updateThreshold") is None
        assert state["done"], "the prune never fired -- the test proved nothing"
    finally:
        monkeypatch.setattr(mutations.database, "get_conn", real_get_conn)
        mutations.release(mutation_id)


def test_a_completed_envelope_is_replayed_rather_than_re_executed(erp_client):
    """The other side of claim(): a COMPLETED row returns its stored envelope.
    A rejected save must replay as the same rejection, not get a second
    attempt at running."""
    mutation_id = str(uuid.uuid4())
    stored = {"success": False, "data": None, "message": "the original answer"}
    mutations.claim(mutation_id, "updateThreshold")
    mutations.complete(mutation_id, stored)

    resp = erp_client.post(
        "/api/erp/rpc/updateThreshold",
        json={"args": ["NoSuchItem", "", 5]},
        headers={"X-Mutation-Id": mutation_id},
    )
    assert resp.status_code == 200
    assert resp.get_json() == stored


def test_the_registry_spec_is_frozen():
    """RpcSpec is a frozen dataclass, so the allowlist cannot be mutated at
    runtime by anything that gets hold of a spec."""
    from app.erp.registry import RPC_METHODS

    spec = RPC_METHODS["updateThreshold"]
    assert dataclasses.is_dataclass(spec)
    with pytest.raises(dataclasses.FrozenInstanceError):
        spec.mutation = False
