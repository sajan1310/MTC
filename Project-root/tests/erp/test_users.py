"""User management RPC tests (app/erp/services/users_service.py) -- the
admin-facing surface for the role/deleted_at columns that already existed on
`users` but had no UI and no RPC methods. Also covers the pending_approval
blanket gate in app/erp/rpc.py and the page-level redirect in
app/erp/pages.py.
"""

from __future__ import annotations

import uuid

import database


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}@example.invalid"


def _insert_user(erp_app, *, name, email, role):
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "INSERT INTO users (name, email, password_hash, role) VALUES (%s, %s, 'x', %s) RETURNING user_id",
                (name, email, role),
            )
            return cur.fetchone()[0]


# ── Authorization: only admin may call these ────────────────────────────

def test_get_users_data_denied_for_plain_user(erp_client):
    resp = _rpc(erp_client, "getUsersData")
    assert resp.status_code == 403
    assert resp.get_json()["success"] is False


def test_get_users_data_allowed_for_admin(erp_admin_client):
    resp = _rpc(erp_admin_client, "getUsersData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)
    # Shape check against the admin fixture's own row.
    admin_row = next(u for u in body["data"] if u["email"] == "erp-admin-test-user@example.invalid")
    assert admin_row["role"] == "admin"
    assert admin_row["active"] is True


def test_update_user_role_denied_for_plain_user(erp_app, erp_client, erp_test_user):
    resp = _rpc(erp_client, "updateUserRole", [erp_test_user, "admin"], mutation=True)
    assert resp.status_code == 403


# ── updateUserRole business rules ────────────────────────────────────────

def test_update_user_role_happy_path(erp_app, erp_super_admin_client):
    # Promoting to 'admin' is a Super Admin-only power (see
    # users_service.update_user_role) -- an ordinary admin is covered
    # separately by test_update_user_role_admin_cannot_promote_to_admin.
    target_id = _insert_user(erp_app, name="Target One", email=_unique_email("target"), role="user")
    resp = _rpc(erp_super_admin_client, "updateUserRole", [target_id, "admin"], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "admin" in body["message"]

    listed = _rpc(erp_super_admin_client, "getUsersData").get_json()["data"]
    match = next(u for u in listed if u["id"] == target_id)
    assert match["role"] == "admin"


def test_update_user_role_admin_cannot_promote_to_admin(erp_app, erp_admin_client):
    """An ordinary admin lacks the power to mint peer admins -- only a
    Super Admin can, so nobody remains above every admin to revoke it."""
    target_id = _insert_user(erp_app, name="Target Promo", email=_unique_email("target"), role="user")
    resp = _rpc(erp_admin_client, "updateUserRole", [target_id, "admin"], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Super Admin" in body["message"]

    listed = _rpc(erp_admin_client, "getUsersData").get_json()["data"]
    match = next(u for u in listed if u["id"] == target_id)
    assert match["role"] == "user"


def test_update_user_role_rejects_invalid_role(erp_app, erp_admin_client):
    target_id = _insert_user(erp_app, name="Target Two", email=_unique_email("target"), role="user")
    resp = _rpc(erp_admin_client, "updateUserRole", [target_id, "superuser"], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Invalid role" in body["message"]


def test_update_user_role_can_promote_pending_approval(erp_app, erp_admin_client):
    """The actual bug this feature fixes: an OAuth signup stuck at
    pending_approval forever with no admin surface to move them out of it.
    """
    target_id = _insert_user(erp_app, name="New OAuth User", email=_unique_email("oauth"), role="pending_approval")
    resp = _rpc(erp_admin_client, "updateUserRole", [target_id, "user"], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_admin_client, "getUsersData").get_json()["data"]
    assert next(u for u in listed if u["id"] == target_id)["role"] == "user"


def test_update_user_role_cannot_change_own_role(erp_admin_client, erp_admin_user):
    resp = _rpc(erp_admin_client, "updateUserRole", [erp_admin_user, "user"], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "own role" in body["message"]


def test_update_user_role_rejects_unknown_user(erp_admin_client):
    # role='user', not 'admin' -- the Super Admin promotion gate runs before
    # the user lookup, so 'admin' here would false-pass by tripping THAT
    # check instead of the "not found" one this test means to exercise.
    resp = _rpc(erp_admin_client, "updateUserRole", [999999999, "user"], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "not found" in body["message"].lower()


# ── deactivate / reactivate ──────────────────────────────────────────────

def test_deactivate_and_reactivate_user(erp_app, erp_admin_client):
    target_id = _insert_user(erp_app, name="Deactivate Me", email=_unique_email("deact"), role="user")

    deact = _rpc(erp_admin_client, "deactivateUser", [target_id], mutation=True)
    assert deact.get_json()["success"] is True

    listed = _rpc(erp_admin_client, "getUsersData").get_json()["data"]
    assert next(u for u in listed if u["id"] == target_id)["active"] is False

    react = _rpc(erp_admin_client, "reactivateUser", [target_id], mutation=True)
    assert react.get_json()["success"] is True

    listed = _rpc(erp_admin_client, "getUsersData").get_json()["data"]
    assert next(u for u in listed if u["id"] == target_id)["active"] is True


def test_cannot_deactivate_own_account(erp_admin_client, erp_admin_user):
    resp = _rpc(erp_admin_client, "deactivateUser", [erp_admin_user], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "own account" in body["message"]


def test_deactivated_user_session_is_rejected(erp_app, erp_admin_client):
    """Closes the loop app/__init__.py's load_user now enforces: a
    deactivated user's EXISTING session must stop working immediately, not
    just future logins.
    """
    target_id = _insert_user(erp_app, name="Session Kill Test", email=_unique_email("killme"), role="user")
    _rpc(erp_admin_client, "deactivateUser", [target_id], mutation=True)

    client = erp_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = str(target_id)
        sess["_fresh"] = True

    resp = client.post("/api/erp/rpc/testConnection", json={"args": []})
    # load_user's WHERE deleted_at IS NULL now returns None for this user_id
    # -> flask-login treats the session as unauthenticated.
    assert resp.status_code in (302, 401)


# ── pending_approval blanket RPC gate ────────────────────────────────────

def test_pending_approval_user_is_blocked_from_every_rpc_method(erp_app):
    pending_id = _insert_user(erp_app, name="Pending Person", email=_unique_email("pending"), role="pending_approval")
    client = erp_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = str(pending_id)
        sess["_fresh"] = True

    # testConnection is otherwise open to any authenticated user -- proves
    # the block is unconditional, not just on admin-gated methods.
    resp = client.post("/api/erp/rpc/testConnection", json={"args": []})
    body = resp.get_json()
    assert resp.status_code == 403
    assert body["success"] is False
    assert "approval" in body["message"].lower()
