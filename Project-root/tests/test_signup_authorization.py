"""Self-service signup must not mint privileged accounts (SEC-002).

Two account-creation paths existed and they disagreed about the role:

    app/utils.py       (Google)   -> "pending_approval"
    app/auth/routes.py (password) -> "user"      <-- the defect

app/erp/rpc.py blocks exactly one role, "pending_approval", and RpcSpec.roles
is None for the large majority of the ~166 registered methods. So an
unauthenticated, CSRF-exempt, 5-per-hour POST to /auth/api/signup produced an
account with immediate unrestricted access to stock, bills, purchase orders,
returns, production, dispatch, clients, contractors and vendor ledgers -- and
logged straight in.

Both paths now route through auth.routes.NEW_ACCOUNT_ROLE, the database
default is 'pending_approval' too (migrations/erp/036), and signup can be
switched off entirely with ALLOW_SELF_SIGNUP=false.
"""

from __future__ import annotations

import uuid

import psycopg2.extras
import pytest

import database
from app.auth.routes import NEW_ACCOUNT_ROLE

STRONG_PASSWORD = "Str0ng!Passw0rd#2026"


@pytest.fixture
def fresh_email():
    """A never-before-seen address, cleaned up afterwards."""
    email = f"signup-test-{uuid.uuid4().hex[:12]}@example.com"
    yield email
    try:
        with database.get_conn() as (_conn, cur):
            cur.execute("DELETE FROM users WHERE email = %s", (email,))
    except Exception:  # noqa: BLE001 -- best-effort teardown
        pass


def _signup(client, email, password=STRONG_PASSWORD, name="Signup Test"):
    return client.post(
        "/auth/api/signup",
        json={
            "name": name,
            "email": email,
            "password": password,
            "confirm_password": password,
        },
    )


def _role_of(email):
    with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (_conn, cur):
        cur.execute("SELECT role FROM users WHERE email = %s", (email,))
        row = cur.fetchone()
    return row["role"] if row else None


# ── The vulnerability itself ─────────────────────────────────────────────


def test_signup_creates_a_pending_account_not_a_privileged_one(client, fresh_email):
    """THE regression test. This asserted role would have been 'user'."""
    response = _signup(client, fresh_email)
    assert response.status_code == 201
    assert _role_of(fresh_email) == "pending_approval"


def test_signup_never_creates_a_user_role_account(client, fresh_email):
    _signup(client, fresh_email)
    assert _role_of(fresh_email) != "user"


def test_new_account_role_constant_is_the_inert_role(client):
    """rpc.py blocks this exact string; if the constant drifts, the gate stops
    matching and every new account is unrestricted again."""
    assert NEW_ACCOUNT_ROLE == "pending_approval"


def test_signup_response_tells_the_user_they_are_pending(client, fresh_email):
    response = _signup(client, fresh_email)
    body = response.get_json()
    assert body.get("pending_approval") is True
    assert "pending-approval" in body.get("redirect_url", "")


def test_signup_session_cannot_call_rpc_methods(client, fresh_email):
    """The session is real, but the role grants nothing. This is the property
    that actually matters -- the role string is only a proxy for it."""
    assert _signup(client, fresh_email).status_code == 201

    response = client.post(
        "/api/erp/rpc/getStockData",
        json={"args": []},
        headers={"X-CSRFToken": "test"},
    )
    assert response.status_code == 403
    assert "awaiting admin approval" in (response.get_json() or {}).get("message", "")


def test_signup_session_cannot_call_a_mutating_rpc_method(client, fresh_email):
    assert _signup(client, fresh_email).status_code == 201

    response = client.post(
        "/api/erp/rpc/saveUnit",
        json={"args": [{"unitName": "Hacked", "family": "Count", "factorToBase": 1}]},
        headers={"X-CSRFToken": "test", "X-Mutation-Id": str(uuid.uuid4())},
    )
    assert response.status_code == 403


def test_signup_session_is_redirected_to_the_holding_page(client, fresh_email):
    assert _signup(client, fresh_email).status_code == 201
    response = client.get("/erp", follow_redirects=False)
    assert response.status_code == 302
    assert "pending-approval" in response.location


# ── Both creation paths agree ────────────────────────────────────────────


def test_google_signup_also_lands_in_pending_approval(app, fresh_email):
    """The Google path was already correct; this pins the two together so they
    cannot drift apart again."""
    from app.utils import get_or_create_user

    with app.app_context():
        user, is_new = get_or_create_user(
            {"email": fresh_email, "name": "OAuth User", "picture": None}
        )
    assert is_new is True
    assert user.role == NEW_ACCOUNT_ROLE


# ── Input handling still works ───────────────────────────────────────────


def test_duplicate_signup_is_rejected(client, fresh_email):
    assert _signup(client, fresh_email).status_code == 201
    assert _signup(client, fresh_email).status_code == 409


def test_weak_password_is_rejected_before_any_account_exists(client, fresh_email):
    response = _signup(client, fresh_email, password="weak")
    assert response.status_code == 400
    assert _role_of(fresh_email) is None


def test_mismatched_confirmation_is_rejected(client, fresh_email):
    response = client.post(
        "/auth/api/signup",
        json={
            "name": "Test",
            "email": fresh_email,
            "password": STRONG_PASSWORD,
            "confirm_password": STRONG_PASSWORD + "x",
        },
    )
    assert response.status_code == 400
    assert _role_of(fresh_email) is None


# ── The kill switch ──────────────────────────────────────────────────────


def test_signup_can_be_disabled_entirely(client, app, fresh_email):
    app.config["ALLOW_SELF_SIGNUP"] = False
    try:
        response = _signup(client, fresh_email)
        assert response.status_code == 403
        assert _role_of(fresh_email) is None
    finally:
        app.config["ALLOW_SELF_SIGNUP"] = True


@pytest.mark.parametrize("falsey", ["false", "False", "0", "no", "off"])
def test_signup_switch_accepts_string_falsey_values(client, app, fresh_email, falsey):
    """The value arrives from the environment, so it is a string, not a bool."""
    app.config["ALLOW_SELF_SIGNUP"] = falsey
    try:
        assert _signup(client, fresh_email).status_code == 403
    finally:
        app.config["ALLOW_SELF_SIGNUP"] = True
