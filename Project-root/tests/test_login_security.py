"""Login identity and throttling (AUTH-001, SEC-009).

Two findings, both in `api_login`.

**AUTH-001 — an account you could create but never sign in to.**
`api_signup` and `users_service.create_user` both store
`email.strip().lower()`. `api_login` looked the address up with `.strip()`
only, against a case-sensitive `WHERE email = %s`. So anyone who typed a
capital letter when signing up got an account whose address the login form
could not find: correct password, existing row, `401 Invalid credentials`,
every time, with nothing to indicate why. A password reset did not help --
that path lowercases, so it "worked" while login went on failing.

Nothing lowercases on the client (`type="email"` does not), so this needed no
unusual behaviour to hit. It was reproduced end to end before the fix:
signup 201, login with the typed spelling 401, login with the lowercased form
200.

**SEC-009 — the throttle protected the server, not the account.**
`10 per minute` keyed on the client IP means an attacker spreading attempts
across addresses had unlimited guesses at one password, while an office
behind one NAT shared a single 10/minute budget. The new per-account limit is
keyed on the submitted address and only counts failures.
"""

from __future__ import annotations

import uuid

import pytest

import database

PASSWORD = "Str0ng!Pass"


@pytest.fixture
def account(app):
    """A real, approved account created through the signup endpoint."""
    created = []

    def _make(typed_email=None):
        typed = typed_email or f"login-{uuid.uuid4().hex[:8]}@example.invalid"
        client = app.test_client()
        response = client.post(
            "/auth/api/signup",
            json={
                "name": "Login Probe",
                "email": typed,
                "password": PASSWORD,
                "confirm_password": PASSWORD,
            },
        )
        assert response.status_code == 201, response.get_json()
        # Signup lands in pending_approval; promote so login is the only
        # thing under test here.
        with app.app_context():
            with database.get_conn() as (_conn, cur):
                cur.execute(
                    "UPDATE users SET role = 'user' WHERE lower(email) = %s",
                    (typed.lower(),),
                )
        created.append(typed.lower())
        return typed

    yield _make

    with app.app_context():
        with database.get_conn() as (_conn, cur):
            for email in created:
                cur.execute("DELETE FROM users WHERE lower(email) = %s", (email,))


def _login(client, email, password=PASSWORD):
    return client.post("/auth/api/login", json={"email": email, "password": password})


# ── AUTH-001: case-insensitive identity ──────────────────────────────────


def test_signing_in_with_the_spelling_you_signed_up_with_works(app, account):
    """THE regression test. Against the old code this is a 401."""
    typed = account("MixedCase.User@Example.COM")
    assert _login(app.test_client(), typed).status_code == 200


@pytest.mark.parametrize(
    "transform",
    [
        str.lower,
        str.upper,
        lambda e: e.capitalize(),
        lambda e: e.replace("@", "@").swapcase(),
        lambda e: f"  {e}  ",  # leading/trailing whitespace
    ],
)
def test_any_casing_of_the_same_address_signs_in(app, account, transform):
    """An email address is one identity however it is typed."""
    typed = account("Casing.Probe@Example.com")
    assert _login(app.test_client(), transform(typed)).status_code == 200


def test_the_address_is_stored_in_one_canonical_form(app, account):
    typed = account("Canonical.Form@Example.COM")
    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "SELECT email FROM users WHERE lower(email) = %s", (typed.lower(),)
            )
            stored = cur.fetchone()[0]
    assert stored == typed.lower()


def test_a_wrong_password_is_still_refused_whatever_the_casing(app, account):
    """The fix widens which addresses resolve, and must not widen anything
    else."""
    typed = account("Still.Checked@Example.com")
    assert _login(app.test_client(), typed.upper(), "wrong-password").status_code == 401


def test_an_unknown_address_is_still_refused(app):
    assert _login(app.test_client(), "nobody-at-all@example.invalid").status_code == 401


def test_a_duplicate_signup_is_caught_across_casings(app, account):
    """Because the uniqueness check compares lower(email) too. Otherwise the
    check passes and the INSERT then violates the unique index -- a 500 where
    a clear message belongs."""
    typed = account("Dup.Probe@Example.com")
    response = app.test_client().post(
        "/auth/api/signup",
        json={
            "name": "Dup Two",
            "email": typed.upper(),
            "password": PASSWORD,
            "confirm_password": PASSWORD,
        },
    )
    # 409, not 400: this is a conflict with existing state, and the route
    # already says so. Asserting the code as well as the message keeps the
    # test honest about which branch it reached.
    assert response.status_code == 409
    assert "already exists" in response.get_json()["error"]


def test_the_database_refuses_two_addresses_differing_only_in_case(app, account):
    """Migration 039's unique index on lower(email). The application checks
    for this, but the application is not the only thing that writes to this
    table -- a fixture, an admin script or a psql session would otherwise
    create the ambiguity, and then a login lookup matches two rows and picks
    one arbitrarily."""
    import psycopg2

    typed = account("Index.Probe@Example.com")
    with app.app_context():
        with pytest.raises(psycopg2.errors.UniqueViolation):
            with database.get_conn() as (_conn, cur):
                cur.execute(
                    "INSERT INTO users (name, email, password_hash, role) "
                    "VALUES (%s, %s, %s, 'user')",
                    ("Sneaky", typed.upper(), "x"),
                )


# ── SEC-009: per-account throttle ────────────────────────────────────────


def test_repeated_failures_on_one_account_are_throttled(app, account):
    """The finding: with a per-IP limit only, an attacker rotating source
    addresses had unlimited guesses at a single password."""
    typed = account()
    # Each request from a different address, so the per-IP limit cannot be
    # what stops it -- this is the per-account limit or nothing.
    statuses = []
    for attempt in range(14):
        client = app.test_client()
        response = client.post(
            "/auth/api/login",
            json={"email": typed, "password": f"wrong-{attempt}"},
            environ_overrides={"REMOTE_ADDR": f"203.0.113.{attempt + 1}"},
        )
        statuses.append(response.status_code)

    assert 429 in statuses, f"never throttled: {statuses}"
    # The configured budget is 10 failures; the 11th onwards should be locked.
    assert statuses[:10] == [401] * 10, statuses
    assert statuses[10] == 429, statuses


def test_a_correct_password_does_not_consume_the_budget(app, account):
    """deduct_when: only a 401 counts. Otherwise someone signing in correctly
    all morning -- several tabs, several devices -- would lock themselves out
    of their own account."""
    typed = account()
    for attempt in range(12):
        client = app.test_client()
        response = client.post(
            "/auth/api/login",
            json={"email": typed, "password": PASSWORD},
            environ_overrides={"REMOTE_ADDR": f"198.51.100.{attempt + 1}"},
        )
        assert response.status_code == 200, (attempt, response.get_json())


def test_throttling_one_account_does_not_affect_another(app, account):
    """Otherwise the throttle is a denial-of-service tool: guess wrongly at a
    colleague's address often enough and they cannot get in."""
    victim = account()
    bystander = account()

    for attempt in range(13):
        app.test_client().post(
            "/auth/api/login",
            json={"email": victim, "password": f"wrong-{attempt}"},
            environ_overrides={"REMOTE_ADDR": f"192.0.2.{attempt + 1}"},
        )

    response = app.test_client().post(
        "/auth/api/login",
        json={"email": bystander, "password": PASSWORD},
        environ_overrides={"REMOTE_ADDR": "192.0.2.200"},
    )
    assert response.status_code == 200, response.get_json()


def test_the_throttle_key_does_not_contain_the_address(app):
    """The limiter's storage is Redis, whose keys appear in `KEYS *`, the slow
    log and any dump of that instance. A throttle needs to know that two
    attempts are for the same account, not who the account belongs to."""
    from app.auth.routes import _login_account_key

    email = "Someone.Identifiable@example.com"
    with app.test_request_context("/auth/api/login", json={"email": email}):
        key = _login_account_key()

    assert email not in key
    assert email.lower() not in key
    assert "someone" not in key.lower()
    assert key.startswith("acct:")


def test_the_throttle_key_is_the_same_however_the_address_is_typed(app):
    """Otherwise changing the capitalisation resets the counter, and the
    throttle is trivially defeated."""
    from app.auth.routes import _login_account_key

    keys = set()
    for spelling in ("user@example.com", "USER@EXAMPLE.COM", "  User@Example.Com  "):
        with app.test_request_context("/auth/api/login", json={"email": spelling}):
            keys.add(_login_account_key())
    assert len(keys) == 1, keys


def test_a_request_with_no_address_falls_back_to_the_client_ip(app):
    """Rather than every malformed request sharing one unbounded bucket."""
    from app.auth.routes import _login_account_key

    with app.test_request_context("/auth/api/login", json={}):
        key = _login_account_key()
    assert key.startswith("noaddr:")
