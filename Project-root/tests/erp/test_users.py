"""User management RPC tests (app/erp/services/users_service.py) -- the
admin-facing surface for the role/deleted_at columns that already existed on
`users` but had no UI and no RPC methods. Also covers the pending_approval
blanket gate in app/erp/rpc.py and the page-level redirect in
app/erp/pages.py.
"""

from __future__ import annotations

import uuid

import psycopg2.extras
import pytest

import database
from app.erp.services.users_service import BULK_DEACTIVATE_LIMIT


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


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


@pytest.fixture
def custom_role_key(erp_app):
    """A real custom_roles row, removed afterwards. is_valid_custom_role does
    a live SELECT, so a fabricated key would not exercise the same branch."""
    key = f"test_role_{uuid.uuid4().hex[:8]}"
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "INSERT INTO custom_roles (role_key, role_name, permissions) VALUES (%s, %s, %s)",
                (
                    key,
                    f"Test Role {key[-8:]}",
                    psycopg2.extras.Json({"stockTab": "viewer"}),
                ),
            )
    yield key
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute("UPDATE users SET role = 'user' WHERE role = %s", (key,))
            cur.execute("DELETE FROM custom_roles WHERE role_key = %s", (key,))


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
    admin_row = next(
        u for u in body["data"] if u["email"] == "erp-admin-test-user@example.invalid"
    )
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
    target_id = _insert_user(
        erp_app, name="Target One", email=_unique_email("target"), role="user"
    )
    resp = _rpc(
        erp_super_admin_client, "updateUserRole", [target_id, "admin"], mutation=True
    )
    body = resp.get_json()
    assert body["success"] is True
    assert "admin" in body["message"]

    listed = _rpc(erp_super_admin_client, "getUsersData").get_json()["data"]
    match = next(u for u in listed if u["id"] == target_id)
    assert match["role"] == "admin"


def test_update_user_role_admin_cannot_promote_to_admin(erp_app, erp_admin_client):
    """An ordinary admin lacks the power to mint peer admins -- only a
    Super Admin can, so nobody remains above every admin to revoke it."""
    target_id = _insert_user(
        erp_app, name="Target Promo", email=_unique_email("target"), role="user"
    )
    resp = _rpc(erp_admin_client, "updateUserRole", [target_id, "admin"], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Super Admin" in body["message"]

    listed = _rpc(erp_admin_client, "getUsersData").get_json()["data"]
    match = next(u for u in listed if u["id"] == target_id)
    assert match["role"] == "user"


def test_update_user_role_rejects_invalid_role(erp_app, erp_admin_client):
    target_id = _insert_user(
        erp_app, name="Target Two", email=_unique_email("target"), role="user"
    )
    resp = _rpc(
        erp_admin_client, "updateUserRole", [target_id, "superuser"], mutation=True
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "Invalid role" in body["message"]


def test_update_user_role_can_promote_pending_approval(erp_app, erp_admin_client):
    """The actual bug this feature fixes: an OAuth signup stuck at
    pending_approval forever with no admin surface to move them out of it.
    """
    target_id = _insert_user(
        erp_app,
        name="New OAuth User",
        email=_unique_email("oauth"),
        role="pending_approval",
    )
    resp = _rpc(erp_admin_client, "updateUserRole", [target_id, "user"], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_admin_client, "getUsersData").get_json()["data"]
    assert next(u for u in listed if u["id"] == target_id)["role"] == "user"


def test_update_user_role_cannot_change_own_role(erp_admin_client, erp_admin_user):
    resp = _rpc(
        erp_admin_client, "updateUserRole", [erp_admin_user, "user"], mutation=True
    )
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
    target_id = _insert_user(
        erp_app, name="Deactivate Me", email=_unique_email("deact"), role="user"
    )

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
    target_id = _insert_user(
        erp_app, name="Session Kill Test", email=_unique_email("killme"), role="user"
    )
    _rpc(erp_admin_client, "deactivateUser", [target_id], mutation=True)

    client = erp_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = str(target_id)
        sess["_fresh"] = True

    resp = client.post("/api/erp/rpc/testConnection", json={"args": []})
    # load_user's WHERE deleted_at IS NULL now returns None for this user_id
    # -> flask-login treats the session as unauthenticated.
    assert resp.status_code in (302, 401)


# ── bulkDeactivateUsers (Super Admin only) ───────────────────────────────


def _active(client, user_id):
    listed = _rpc(client, "getUsersData").get_json()["data"]
    return next(u for u in listed if u["id"] == user_id)["active"]


def test_bulk_deactivate_denied_for_plain_user(erp_client, erp_test_user):
    resp = _rpc(erp_client, "bulkDeactivateUsers", [[erp_test_user]], mutation=True)
    assert resp.status_code == 403


def test_bulk_deactivate_denied_for_ordinary_admin(erp_app, erp_admin_client):
    """The decorator's roles=frozenset({"admin"}) CANNOT express this.

    rpc.py checks it with User.has_role, which returns True for any role
    check at all when the caller is admin or super_admin -- so the gate that
    actually keeps an ordinary admin out is the explicit role comparison in
    the method body. If that comparison is ever dropped in favour of a
    roles= declaration, this is the test that fails.
    """
    target_id = _insert_user(
        erp_app, name="Bulk Denied", email=_unique_email("bulkdenied"), role="user"
    )

    resp = _rpc(erp_admin_client, "bulkDeactivateUsers", [[target_id]], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Super Admin" in body["message"]
    assert _active(erp_admin_client, target_id) is True


def test_bulk_deactivate_happy_path(erp_app, erp_super_admin_client):
    ids = [
        _insert_user(
            erp_app,
            name=f"Bulk Target {n}",
            email=_unique_email(f"bulk{n}"),
            role="user",
        )
        for n in range(3)
    ]

    body = _rpc(
        erp_super_admin_client, "bulkDeactivateUsers", [ids], mutation=True
    ).get_json()
    assert body["success"] is True, body["message"]
    assert body["data"]["deactivated"] == 3

    for user_id in ids:
        assert _active(erp_super_admin_client, user_id) is False


def test_bulk_deactivate_skips_the_caller_and_deactivates_the_rest(
    erp_app, erp_super_admin_client, erp_super_admin_user
):
    """A "select all" that swept up the caller must not fail wholesale."""
    target_id = _insert_user(
        erp_app, name="Bulk With Self", email=_unique_email("bulkself"), role="user"
    )

    body = _rpc(
        erp_super_admin_client,
        "bulkDeactivateUsers",
        [[target_id, erp_super_admin_user]],
        mutation=True,
    ).get_json()

    assert body["success"] is True, body["message"]
    assert body["data"]["deactivated"] == 1
    assert body["data"]["skippedSelf"] is True
    assert "your own account was skipped" in body["message"]
    assert _active(erp_super_admin_client, target_id) is False
    assert _active(erp_super_admin_client, erp_super_admin_user) is True


def test_bulk_deactivate_skips_other_super_admins(erp_app, erp_super_admin_client):
    """super_admin is assigned directly in the database, so deactivating
    every super_admin is not recoverable from inside the app. Single
    deactivation has no such rule -- bulk is where one click could do it."""
    peer_id = _insert_user(
        erp_app, name="Peer Super", email=_unique_email("peersuper"), role="super_admin"
    )
    target_id = _insert_user(
        erp_app, name="Ordinary", email=_unique_email("ordinary"), role="user"
    )

    body = _rpc(
        erp_super_admin_client,
        "bulkDeactivateUsers",
        [[peer_id, target_id]],
        mutation=True,
    ).get_json()

    assert body["success"] is True, body["message"]
    assert body["data"]["deactivated"] == 1
    assert body["data"]["skippedSuperAdmins"] == 1
    assert _active(erp_super_admin_client, peer_id) is True
    assert _active(erp_super_admin_client, target_id) is False


def test_bulk_deactivate_counts_already_inactive_ids(erp_app, erp_super_admin_client):
    already = _insert_user(
        erp_app, name="Already Off", email=_unique_email("alreadyoff"), role="user"
    )
    _rpc(erp_super_admin_client, "deactivateUser", [already], mutation=True)
    target_id = _insert_user(
        erp_app, name="Still On", email=_unique_email("stillon"), role="user"
    )

    body = _rpc(
        erp_super_admin_client,
        "bulkDeactivateUsers",
        [[already, target_id]],
        mutation=True,
    ).get_json()

    assert body["success"] is True, body["message"]
    assert body["data"]["deactivated"] == 1
    assert body["data"]["alreadyInactive"] == 1
    assert "already inactive or not found" in body["message"]


def test_bulk_deactivate_errors_when_nothing_survives_the_filters(
    erp_super_admin_client, erp_super_admin_user
):
    """Selecting only your own account deactivates nothing. A success
    envelope reading "0 deactivated" would render as a green toast for an
    action that did nothing."""
    body = _rpc(
        erp_super_admin_client,
        "bulkDeactivateUsers",
        [[erp_super_admin_user]],
        mutation=True,
    ).get_json()

    assert body["success"] is False
    assert "No users were deactivated" in body["message"]
    assert "your own account was skipped" in body["message"]


def test_bulk_deactivate_rejects_an_empty_selection(erp_super_admin_client):
    body = _rpc(
        erp_super_admin_client, "bulkDeactivateUsers", [[]], mutation=True
    ).get_json()
    assert body["success"] is False
    assert "at least one user" in body["message"]


def test_bulk_deactivate_caps_the_batch_size(erp_super_admin_client):
    """A blast-radius limit, not a performance one."""
    too_many = list(range(1, BULK_DEACTIVATE_LIMIT + 2))
    body = _rpc(
        erp_super_admin_client, "bulkDeactivateUsers", [too_many], mutation=True
    ).get_json()
    assert body["success"] is False
    assert f"at most {BULK_DEACTIVATE_LIMIT}" in body["message"]


def test_bulk_deactivate_is_atomic_across_the_batch(erp_app, erp_super_admin_client):
    """One UPDATE, one transaction: a partial batch would leave half a team
    signed out with no record of where it stopped."""
    ids = [
        _insert_user(
            erp_app, name=f"Atomic {n}", email=_unique_email(f"atomic{n}"), role="user"
        )
        for n in range(4)
    ]
    _rpc(erp_super_admin_client, "bulkDeactivateUsers", [ids], mutation=True)

    listed = _rpc(erp_super_admin_client, "getUsersData").get_json()["data"]
    states = {u["id"]: u["active"] for u in listed if u["id"] in ids}
    assert set(states.values()) == {False}


def test_bulk_deactivated_user_cannot_sign_in(erp_app, erp_super_admin_client):
    """Same closing of the loop as the single-deactivation case: an EXISTING
    session must stop working, not just future logins."""
    target_id = _insert_user(
        erp_app, name="Bulk Session Kill", email=_unique_email("bulkkill"), role="user"
    )
    _rpc(erp_super_admin_client, "bulkDeactivateUsers", [[target_id]], mutation=True)

    client = erp_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = str(target_id)
        sess["_fresh"] = True

    resp = client.post("/api/erp/rpc/testConnection", json={"args": []})
    assert resp.status_code in (302, 401)


# ── pending_approval blanket RPC gate ────────────────────────────────────


def test_pending_approval_user_is_blocked_from_every_rpc_method(erp_app):
    pending_id = _insert_user(
        erp_app,
        name="Pending Person",
        email=_unique_email("pending"),
        role="pending_approval",
    )
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


# ── createUser (TEST-001) ────────────────────────────────────────────────
#
# This whole method was untested: it hands out roles AND writes a password
# hash, so both halves of "who can become what" ran unverified. The
# privilege rule below (only a Super Admin creates an Admin) is the same
# rule updateUserRole enforces, implemented separately in each -- so it
# needs its own test in each, or the two can drift apart silently.


def _find_user(erp_app, email):
    with erp_app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            _conn,
            cur,
        ):
            cur.execute("SELECT * FROM users WHERE email = %s", (email,))
            return cur.fetchone()


def test_create_user_denied_for_plain_user(erp_client):
    resp = _rpc(
        erp_client,
        "createUser",
        ["Nope", _unique_email("nope"), "Str0ng!Pass", "Str0ng!Pass", "user"],
        mutation=True,
    )
    assert resp.status_code == 403


def test_admin_can_create_a_plain_user(erp_app, erp_admin_client):
    email = _unique_email("created")
    resp = _rpc(
        erp_admin_client,
        "createUser",
        ["Created Person", email, "Str0ng!Pass", "Str0ng!Pass", "user"],
        mutation=True,
    )
    body = resp.get_json()
    assert resp.status_code == 200 and body["success"] is True, body
    assert body["data"]["email"] == email
    assert body["data"]["role"] == "user"
    assert body["data"]["active"] is True

    row = _find_user(erp_app, email)
    assert row is not None
    assert row["role"] == "user"
    assert row["deleted_at"] is None


def test_the_created_account_can_actually_sign_in(erp_app, erp_admin_client):
    """The point of createUser is a working account. Storing an unusable or
    plaintext credential would still return success:true -- so assert on the
    hash itself, not on the envelope."""
    from werkzeug.security import check_password_hash

    email = _unique_email("loginable")
    _rpc(
        erp_admin_client,
        "createUser",
        ["Loginable Person", email, "Str0ng!Pass", "Str0ng!Pass", "user"],
        mutation=True,
    )

    row = _find_user(erp_app, email)
    assert row["password_hash"] != "Str0ng!Pass", "password stored in plaintext"
    assert check_password_hash(row["password_hash"], "Str0ng!Pass")
    assert not check_password_hash(row["password_hash"], "wrong-password")


def test_the_email_is_normalised_to_lowercase(erp_app, erp_admin_client):
    """Stored lowercase, matching api_signup -- so the uniqueness check and
    the login lookup both see one canonical form."""
    email = _unique_email("MixedCase").upper()
    resp = _rpc(
        erp_admin_client,
        "createUser",
        ["Mixed Case", email, "Str0ng!Pass", "Str0ng!Pass", "user"],
        mutation=True,
    )
    assert resp.get_json()["success"] is True
    assert _find_user(erp_app, email.lower()) is not None


# ── createUser: the Admin-minting rule ───────────────────────────────────


def test_an_ordinary_admin_cannot_create_an_admin(erp_app, erp_admin_client):
    """The rule that stops an admin minting unlimited peer admins with
    nobody above them to revoke it. updateUserRole enforces the same rule
    separately; both need pinning."""
    email = _unique_email("minted-admin")
    resp = _rpc(
        erp_admin_client,
        "createUser",
        ["Minted Admin", email, "Str0ng!Pass", "Str0ng!Pass", "admin"],
        mutation=True,
    )
    body = resp.get_json()
    assert resp.status_code == 200 and body["success"] is False
    assert "Super Admin" in body["message"]
    assert _find_user(erp_app, email) is None, "refused create still wrote a row"


def test_a_super_admin_can_create_an_admin(erp_app, erp_super_admin_client):
    email = _unique_email("real-admin")
    resp = _rpc(
        erp_super_admin_client,
        "createUser",
        ["Real Admin", email, "Str0ng!Pass", "Str0ng!Pass", "admin"],
        mutation=True,
    )
    assert resp.get_json()["success"] is True, resp.get_json()
    assert _find_user(erp_app, email)["role"] == "admin"


def test_nobody_can_create_a_super_admin(erp_app, erp_super_admin_client):
    """super_admin is deliberately outside CREATE_ROLES -- it is assigned in
    the database, never handed out through the app, so there is no in-app
    path to a second super_admin."""
    email = _unique_email("second-super")
    resp = _rpc(
        erp_super_admin_client,
        "createUser",
        ["Second Super", email, "Str0ng!Pass", "Str0ng!Pass", "super_admin"],
        mutation=True,
    )
    assert resp.get_json()["success"] is False
    assert _find_user(erp_app, email) is None


def test_create_user_cannot_hand_out_pending_approval(erp_app, erp_admin_client):
    """pending_approval IS in ROLES (updateUserRole may set it) but is not in
    CREATE_ROLES: a user an admin created proactively is already vetted, so
    creating one straight into the awaiting-review state would just be an
    account nobody can use. The two tuples differing is deliberate."""
    from app.erp.services.users_service import CREATE_ROLES, ROLES

    assert "pending_approval" in ROLES and "pending_approval" not in CREATE_ROLES

    email = _unique_email("born-pending")
    resp = _rpc(
        erp_admin_client,
        "createUser",
        ["Born Pending", email, "Str0ng!Pass", "Str0ng!Pass", "pending_approval"],
        mutation=True,
    )
    assert resp.get_json()["success"] is False
    assert _find_user(erp_app, email) is None


def test_create_user_accepts_a_custom_role(erp_app, erp_admin_client, custom_role_key):
    """A custom role is not a superuser wildcard, so an ordinary admin may
    hand one out -- unlike "admin"."""
    email = _unique_email("custom-role-user")
    resp = _rpc(
        erp_admin_client,
        "createUser",
        ["Custom Role Person", email, "Str0ng!Pass", "Str0ng!Pass", custom_role_key],
        mutation=True,
    )
    assert resp.get_json()["success"] is True, resp.get_json()
    assert _find_user(erp_app, email)["role"] == custom_role_key


# ── createUser: input validation ─────────────────────────────────────────


def test_create_user_rejects_an_unknown_role(erp_app, erp_admin_client):
    email = _unique_email("bad-role")
    resp = _rpc(
        erp_admin_client,
        "createUser",
        ["Bad Role", email, "Str0ng!Pass", "Str0ng!Pass", "wizard"],
        mutation=True,
    )
    assert resp.get_json()["success"] is False
    assert _find_user(erp_app, email) is None


def test_create_user_rejects_a_duplicate_email(erp_app, erp_admin_client):
    """users.email is UNIQUE, so without this check the insert would raise a
    raw IntegrityError instead of a message the admin can act on."""
    email = _unique_email("dupe")
    first = _rpc(
        erp_admin_client,
        "createUser",
        ["First Person", email, "Str0ng!Pass", "Str0ng!Pass", "user"],
        mutation=True,
    )
    assert first.get_json()["success"] is True

    second = _rpc(
        erp_admin_client,
        "createUser",
        ["Second Person", email, "Str0ng!Pass", "Str0ng!Pass", "user"],
        mutation=True,
    )
    body = second.get_json()
    assert second.status_code == 200 and body["success"] is False
    assert "already exists" in body["message"]


def test_a_duplicate_is_caught_regardless_of_the_typed_casing(
    erp_app, erp_admin_client
):
    """Because the email is lowercased before the uniqueness check, not
    after -- otherwise the same person could be created twice under two
    spellings and then neither row would be reachable by login."""
    email = _unique_email("case-dupe")
    assert (
        _rpc(
            erp_admin_client,
            "createUser",
            ["Case One", email, "Str0ng!Pass", "Str0ng!Pass", "user"],
            mutation=True,
        ).get_json()["success"]
        is True
    )

    resp = _rpc(
        erp_admin_client,
        "createUser",
        ["Case Two", email.upper(), "Str0ng!Pass", "Str0ng!Pass", "user"],
        mutation=True,
    )
    assert resp.get_json()["success"] is False
    assert "already exists" in resp.get_json()["message"]


@pytest.mark.parametrize(
    "args, expected",
    [
        (["", "x@example.invalid", "Str0ng!Pass", "Str0ng!Pass", "user"], "required"),
        (["N", "", "Str0ng!Pass", "Str0ng!Pass", "user"], "required"),
        (["N", "x@example.invalid", "", "", "user"], "required"),
        (["N", "not-an-email", "Str0ng!Pass", "Str0ng!Pass", "user"], "valid email"),
        (
            ["N", "x@example.invalid", "Str0ng!Pass", "Different!1", "user"],
            "do not match",
        ),
        (["N", "x@example.invalid", "short", "short", "user"], "8 characters"),
        (["N", "x@example.invalid", "alllower1!", "alllower1!", "user"], "uppercase"),
        (["N", "x@example.invalid", "ALLUPPER1!", "ALLUPPER1!", "user"], "lowercase"),
        (["N", "x@example.invalid", "NoDigits!!", "NoDigits!!", "user"], "number"),
        (["N", "x@example.invalid", "NoSpecial1", "NoSpecial1", "user"], "special"),
    ],
)
def test_create_user_rejects_bad_input(erp_admin_client, args, expected):
    """Password strength is delegated to the same validate_password the
    self-signup path uses -- an admin-created account must not be allowed a
    weaker credential than a user could set for themselves."""
    resp = _rpc(erp_admin_client, "createUser", args, mutation=True)
    body = resp.get_json()
    assert resp.status_code == 200 and body["success"] is False
    assert expected in body["message"], body["message"]


# ── updateUserRole: the demotion-direction half of the Admin rule ────────
#
# The promotion direction (admin cannot promote TO admin) was already
# covered. This direction -- an ordinary admin touching an EXISTING
# admin's role -- was not, and it is the same "nobody above them" problem
# mirrored: without it, one admin could strip every other admin's access.


def test_an_ordinary_admin_cannot_demote_another_admin(erp_app, erp_admin_client):
    target_id = _insert_user(
        erp_app, name="Peer Admin", email=_unique_email("peer-admin"), role="admin"
    )
    resp = _rpc(erp_admin_client, "updateUserRole", [target_id, "user"], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Super Admin" in body["message"]

    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute("SELECT role FROM users WHERE user_id = %s", (target_id,))
            assert cur.fetchone()[0] == "admin", "role changed despite the refusal"


def test_an_ordinary_admin_cannot_demote_a_super_admin(erp_app, erp_admin_client):
    target_id = _insert_user(
        erp_app,
        name="Peer Super",
        email=_unique_email("peer-super"),
        role="super_admin",
    )
    resp = _rpc(erp_admin_client, "updateUserRole", [target_id, "user"], mutation=True)
    assert resp.get_json()["success"] is False

    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute("SELECT role FROM users WHERE user_id = %s", (target_id,))
            assert cur.fetchone()[0] == "super_admin"


def test_a_super_admin_can_demote_an_admin(erp_app, erp_super_admin_client):
    """The rule is 'only a Super Admin', not 'never' -- an admin whose access
    should be revoked has to be revocable by someone."""
    target_id = _insert_user(
        erp_app, name="Demotable", email=_unique_email("demotable"), role="admin"
    )
    resp = _rpc(
        erp_super_admin_client, "updateUserRole", [target_id, "user"], mutation=True
    )
    assert resp.get_json()["success"] is True, resp.get_json()

    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute("SELECT role FROM users WHERE user_id = %s", (target_id,))
            assert cur.fetchone()[0] == "user"


def test_update_user_role_accepts_a_custom_role(
    erp_app, erp_admin_client, custom_role_key
):
    target_id = _insert_user(
        erp_app, name="To Custom", email=_unique_email("to-custom"), role="user"
    )
    resp = _rpc(
        erp_admin_client, "updateUserRole", [target_id, custom_role_key], mutation=True
    )
    assert resp.get_json()["success"] is True, resp.get_json()

    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute("SELECT role FROM users WHERE user_id = %s", (target_id,))
            assert cur.fetchone()[0] == custom_role_key


# ── deactivate/reactivate: the already-in-that-state branches ────────────


def test_deactivating_an_already_deactivated_user_is_refused(erp_app, erp_admin_client):
    target_id = _insert_user(
        erp_app, name="Twice Off", email=_unique_email("twice-off"), role="user"
    )
    assert (
        _rpc(erp_admin_client, "deactivateUser", [target_id], mutation=True).get_json()[
            "success"
        ]
        is True
    )

    resp = _rpc(erp_admin_client, "deactivateUser", [target_id], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "already deactivated" in body["message"]


def test_reactivating_an_active_user_is_refused(erp_app, erp_admin_client):
    target_id = _insert_user(
        erp_app, name="Already On", email=_unique_email("already-on"), role="user"
    )
    resp = _rpc(erp_admin_client, "reactivateUser", [target_id], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "already active" in body["message"]
