"""The per-tab permission gate in the RPC dispatcher (TEST-001).

app/erp/rpc.py's custom-role gate is the real security boundary for every
role outside the four built-in ones: per request, it decides whether the
caller's role may reach the service module behind the method invoked, and
whether it may MUTATE through it. Those lines had no coverage at all --
which was the audit's testing finding in its sharpest form: the code
deciding who may do what was among the least verified code in the app.

Four behaviours are pinned here, because getting any of them backwards is a
silent privilege change rather than a visible bug:

  1. built-in roles skip the gate entirely
  2. a custom role with no grant for the tab is refused
  3. viewer/commenter may read but not mutate; editor may mutate
  4. a module absent from TAB_BY_SERVICE_MODULE is cross-cutting, so allowed

These log in for real (erp_app deliberately does NOT set LOGIN_DISABLED), so
each case exercises the whole path -- session -> load_user -> User.role ->
gate -- rather than a patched-in stand-in that could keep agreeing with a
gate that had stopped working.
"""

from __future__ import annotations

import uuid

import psycopg2.extras
import pytest

import database
from app.erp.registry import RPC_METHODS
from app.erp.services import roles_service


@pytest.fixture
def client_as(erp_app):
    """A logged-in client whose user holds `role`.

    Pass `permissions` to have a matching custom_roles row created first;
    omit it to hold a role name with no row behind it (a built-in role, or a
    role deleted out from under a live session).
    """
    roles_created: list[str] = []
    users_created: list[int] = []

    def _make(role, permissions=None):
        suffix = uuid.uuid4().hex[:8]
        with erp_app.app_context():
            with database.get_conn() as (_conn, cur):
                if permissions is not None:
                    role = roles_service._slugify(f"Gate Role {suffix}")
                    cur.execute(
                        "INSERT INTO custom_roles (role_key, role_name, permissions) "
                        "VALUES (%s, %s, %s)",
                        (role, f"Gate Role {suffix}", psycopg2.extras.Json(permissions)),
                    )
                    roles_created.append(role)
                cur.execute(
                    "INSERT INTO users (name, email, password_hash, role) "
                    "VALUES (%s, %s, %s, %s) RETURNING user_id",
                    (
                        f"Gate User {suffix}",
                        f"gate-{suffix}@example.invalid",
                        "not-a-real-hash",
                        role,
                    ),
                )
                users_created.append(cur.fetchone()[0])

        client = erp_app.test_client()
        with client.session_transaction() as sess:
            sess["_user_id"] = str(users_created[-1])
            sess["_fresh"] = True
        return client

    yield _make

    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            if users_created:
                cur.execute("DELETE FROM users WHERE user_id = ANY(%s)", (users_created,))
            if roles_created:
                cur.execute(
                    "DELETE FROM custom_roles WHERE role_key = ANY(%s)", (roles_created,)
                )


def _read(client):
    """A read on the Stock tab (stock_service -> stockTab)."""
    return client.post("/api/erp/rpc/getStockData", json={"args": []})


def _mutate(client, mutation_id=None):
    """A mutation on the Stock tab."""
    return client.post(
        "/api/erp/rpc/updateThreshold",
        json={"args": ["NoSuchItem", "", 5]},
        headers={"X-Mutation-Id": mutation_id or str(uuid.uuid4())},
    )


def _forbidden(response):
    return (
        response.status_code == 403
        and "Not authorized" in response.get_json()["message"]
    )


# -- The map the gate depends on -----------------------------------------


def test_the_methods_under_test_map_to_the_tab_under_test():
    """If any of this drifts, every assertion below silently tests nothing."""
    assert RPC_METHODS["getStockData"].module == "stock_service"
    assert RPC_METHODS["getStockData"].mutation is False
    assert RPC_METHODS["updateThreshold"].module == "stock_service"
    assert RPC_METHODS["updateThreshold"].mutation is True
    assert RPC_METHODS["updateThreshold"].roles is None
    assert roles_service.TAB_BY_SERVICE_MODULE["stock_service"] == "stockTab"


# -- 1. Built-in roles bypass the gate -----------------------------------


@pytest.mark.parametrize("role", ["user", "admin", "super_admin"])
def test_builtin_roles_are_never_gated(client_as, role):
    """The custom-role system is additive. If the gate ever fired for these,
    every existing user's access would change silently."""
    assert _read(client_as(role)).status_code == 200


# -- 2. No grant for the tab ---------------------------------------------


def test_a_custom_role_without_the_tab_is_refused_a_read(client_as):
    client = client_as(None, {"billLedger": "editor"})   # a DIFFERENT tab
    assert _forbidden(_read(client))


def test_a_custom_role_with_no_grants_at_all_is_refused(client_as):
    assert _forbidden(_read(client_as(None, {})))


def test_a_role_deleted_out_from_under_a_session_fails_closed(client_as):
    """get_effective_tab_level returns None for an unknown role. Failing OPEN
    here would turn a deleted role into unrestricted access."""
    assert _forbidden(_read(client_as("role-that-no-longer-exists")))


# -- 3. Read vs mutate ---------------------------------------------------


def test_viewer_may_read(client_as):
    assert _read(client_as(None, {"stockTab": "viewer"})).status_code == 200


def test_viewer_may_not_mutate(client_as):
    """THE line that had no coverage: `if spec.mutation and level != "editor"`."""
    assert _forbidden(_mutate(client_as(None, {"stockTab": "viewer"})))


def test_commenter_may_read_but_not_mutate(client_as):
    client = client_as(None, {"stockTab": "commenter"})
    assert _read(client).status_code == 200
    assert _forbidden(_mutate(client))


def test_editor_may_mutate(client_as):
    """Reaches the service, which then rejects the made-up item on its own
    terms -- a 200 domain failure, NOT a 403. That distinction is the point:
    the gate let it through."""
    response = _mutate(client_as(None, {"stockTab": "editor"}))
    assert response.status_code == 200
    body = response.get_json()
    assert body["success"] is False
    assert "not found in Stock" in body["message"]


def test_a_refused_mutation_never_claims_its_mutation_id(client_as):
    """403 lands before the claim, so the id is still usable afterwards.
    Otherwise a permission error would burn the id, and the client's retry --
    once actually granted access -- would replay a stored envelope for a call
    that never ran."""
    client = client_as(None, {"stockTab": "viewer"})
    mutation_id = str(uuid.uuid4())
    assert _mutate(client, mutation_id).status_code == 403
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT 1 FROM erp.rpc_mutations WHERE mutation_id = %s", (mutation_id,)
        )
        assert cur.fetchone() is None, "a refused call claimed a mutation id"


# -- 4. Cross-cutting modules --------------------------------------------


def test_a_module_outside_the_tab_map_stays_reachable(client_as):
    """units_service is deliberately absent from TAB_BY_SERVICE_MODULE -- it
    backs the Base Unit field on other tabs' forms, so gating it would break
    those forms for no security benefit."""
    assert "units_service" not in roles_service.TAB_BY_SERVICE_MODULE
    client = client_as(None, {"stockTab": "viewer"})
    assert client.post("/api/erp/rpc/getUnitsData", json={"args": []}).status_code == 200


# -- Ordering against the other two gates --------------------------------


def test_pending_approval_is_blocked_before_the_tab_gate(client_as):
    """pending_approval is refused unconditionally and earlier, with its own
    message -- it must never depend on a tab grant."""
    response = _read(client_as("pending_approval"))
    assert response.status_code == 403
    assert "awaiting admin approval" in response.get_json()["message"]


def test_a_custom_role_cannot_reach_an_admin_only_method(client_as):
    """RpcSpec.roles is checked BEFORE the tab gate. usersTab is not grantable
    to a custom role, but this pins the other half of that promise: even a
    role holding every tab it could possibly hold is still refused an
    admin-only method."""
    assert RPC_METHODS["getCustomRoles"].roles == frozenset({"admin"})
    client = client_as(None, {"stockTab": "editor", "usersTab": "editor"})
    assert _forbidden(client.post("/api/erp/rpc/getCustomRoles", json={"args": []}))
