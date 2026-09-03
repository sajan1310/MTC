"""Password-reset token security (SEC-006, SEC-007).

Reset tokens were signed-and-timed only::

    return _reset_serializer().dumps(email, salt=RESET_TOKEN_SALT)

which carries no notion of having been used. A link therefore stayed valid for
the full hour no matter what -- replayable from a mailbox, a browser history
or a proxy log, and still valid *after* the user had already reset their
password with it. Nothing invalidated existing sessions either, so a reset
prompted by a suspected compromise left the attacker signed in.

Separately, the UPDATE had no ``deleted_at`` filter, so a deactivated account
could still have its password changed even though every login path refused it.

Tokens are now bound to a fingerprint of the account's current credential:
using one changes the stored hash, which changes the fingerprint, which
invalidates the token and every session pinned to the old credential.
"""

from __future__ import annotations

import uuid

import psycopg2.extras
import pytest
from werkzeug.security import generate_password_hash

import database
from app.auth.routes import (
    credential_fingerprint,
    generate_reset_token,
    verify_reset_token,
)

OLD_PASSWORD = "0ldP@ssw0rd!2026"
NEW_PASSWORD = "N3wP@ssw0rd!2026"


@pytest.fixture
def account(app):
    """A real user row with a known password, removed afterwards."""
    email = f"reset-test-{uuid.uuid4().hex[:12]}@example.com"
    with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (_c, cur):
        cur.execute(
            "INSERT INTO users (name, email, role, password_hash) "
            "VALUES (%s, %s, 'user', %s) RETURNING user_id",
            ("Reset Test", email, generate_password_hash(OLD_PASSWORD)),
        )
        user_id = cur.fetchone()["user_id"]
    yield {"email": email, "user_id": user_id}
    try:
        with database.get_conn() as (_c, cur):
            cur.execute("DELETE FROM users WHERE user_id = %s", (user_id,))
    except Exception:  # noqa: BLE001 -- best-effort teardown
        pass


def _hash_of(user_id):
    with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (_c, cur):
        cur.execute("SELECT password_hash FROM users WHERE user_id = %s", (user_id,))
        row = cur.fetchone()
    return row["password_hash"] if row else None


def _reset(client, token, password=NEW_PASSWORD):
    return client.post(
        "/auth/api/reset-password",
        json={"token": token, "password": password, "confirm_password": password},
    )


# ── SEC-006: single use ──────────────────────────────────────────────────


def test_a_reset_token_works_once(client, app, account):
    with app.test_request_context():
        token = generate_reset_token(account["email"])
    assert _reset(client, token).status_code == 200


def test_a_reset_token_cannot_be_replayed(client, app, account):
    """THE regression test. The same link, used twice."""
    with app.test_request_context():
        token = generate_reset_token(account["email"])

    assert _reset(client, token).status_code == 200

    second = _reset(client, token, password="Th1rdP@ssw0rd!2026")
    assert second.status_code == 400
    assert "invalid or has expired" in second.get_json()["error"]


def test_replay_does_not_change_the_password(client, app, account):
    """Not just refused -- ineffective."""
    with app.test_request_context():
        token = generate_reset_token(account["email"])
    _reset(client, token)
    after_first = _hash_of(account["user_id"])

    _reset(client, token, password="Th1rdP@ssw0rd!2026")
    assert _hash_of(account["user_id"]) == after_first


def test_an_outstanding_token_is_invalidated_by_any_password_change(
    client, app, account
):
    """Two links requested, one used: the other must die with it. Otherwise a
    link mailed to a compromised inbox outlives the reset it prompted."""
    with app.test_request_context():
        first = generate_reset_token(account["email"])
        second = generate_reset_token(account["email"])

    assert _reset(client, first).status_code == 200
    assert _reset(client, second, password="An0therP@ss!2026").status_code == 400


def test_verify_returns_none_once_the_credential_changes(app, account):
    with app.test_request_context():
        token = generate_reset_token(account["email"])
        assert verify_reset_token(token) == account["email"]

    with database.get_conn() as (_c, cur):
        cur.execute(
            "UPDATE users SET password_hash = %s WHERE user_id = %s",
            (generate_password_hash("SomethingElse!2026"), account["user_id"]),
        )

    with app.test_request_context():
        assert verify_reset_token(token) is None


def test_legacy_bare_email_tokens_are_refused(app, account):
    """Tokens minted before this change were a bare email string and are
    replayable by construction. They expire within the hour anyway, so
    refusing them costs one 'request a new link'."""
    from itsdangerous import URLSafeTimedSerializer

    from app.auth.routes import RESET_TOKEN_SALT

    with app.test_request_context():
        legacy = URLSafeTimedSerializer(app.config["SECRET_KEY"]).dumps(
            account["email"], salt=RESET_TOKEN_SALT
        )
        assert verify_reset_token(legacy) is None


def test_a_tampered_token_is_refused(app, account):
    with app.test_request_context():
        token = generate_reset_token(account["email"])
        assert verify_reset_token(token[:-4] + "AAAA") is None


# ── SEC-007: deactivated accounts ────────────────────────────────────────


def test_a_deactivated_account_cannot_reset_its_password(client, app, account):
    with app.test_request_context():
        token = generate_reset_token(account["email"])

    with database.get_conn() as (_c, cur):
        cur.execute(
            "UPDATE users SET deleted_at = NOW() WHERE user_id = %s",
            (account["user_id"],),
        )

    before = _hash_of(account["user_id"])
    response = _reset(client, token)
    assert response.status_code == 400
    assert _hash_of(account["user_id"]) == before


def test_no_token_is_issued_for_a_deactivated_account(app, account):
    with database.get_conn() as (_c, cur):
        cur.execute(
            "UPDATE users SET deleted_at = NOW() WHERE user_id = %s",
            (account["user_id"],),
        )
    with app.test_request_context():
        assert verify_reset_token(generate_reset_token(account["email"])) is None


# ── Session invalidation ─────────────────────────────────────────────────


# These assert on load_user directly rather than on a @login_required route.
# The shared `app` fixture sets LOGIN_DISABLED=True, which makes
# @login_required a no-op, so a route's status code cannot witness session
# invalidation at all -- it would return 200 whatever the session held. Since
# load_user IS the mechanism (a session whose pinned credential fingerprint no
# longer matches resolves to no user), asserting on it directly is both the
# real property and immune to that fixture setting. Flipping LOGIN_DISABLED
# off here instead would have meant weakening a fixture ~40 other test
# modules depend on.


def _load_user_with_session(app, user_id, cred_fp):
    """Run the Flask-Login user_loader with `cred_fp` pinned in the session."""
    with app.test_request_context():
        from flask import session

        if cred_fp is not None:
            session["cred_fp"] = cred_fp
        return app.login_manager._user_callback(str(user_id))


def test_session_pinned_to_the_old_credential_no_longer_resolves(app, account):
    """The property that matters when a reset follows a compromise: a session
    established before the reset must stop working, wherever it lives."""
    stale = credential_fingerprint(_hash_of(account["user_id"]))

    # Still valid before the reset.
    assert _load_user_with_session(app, account["user_id"], stale) is not None

    with database.get_conn() as (_c, cur):
        cur.execute(
            "UPDATE users SET password_hash = %s WHERE user_id = %s",
            (generate_password_hash(NEW_PASSWORD), account["user_id"]),
        )

    assert _load_user_with_session(app, account["user_id"], stale) is None


def test_a_session_pinned_to_the_current_credential_still_resolves(app, account):
    """Without this, the test above would pass if load_user simply rejected
    every session."""
    current = credential_fingerprint(_hash_of(account["user_id"]))
    assert _load_user_with_session(app, account["user_id"], current) is not None


def test_sessions_without_a_fingerprint_keep_working(app, account):
    """Sessions created before this shipped, and Google sign-ins for accounts
    with no password at all, carry no fingerprint. Absence is tolerated;
    only a mismatch is rejected."""
    assert _load_user_with_session(app, account["user_id"], None) is not None


def test_reset_clears_the_session_that_performed_it(client, app, account):
    assert (
        client.post(
            "/auth/api/login",
            json={"email": account["email"], "password": OLD_PASSWORD},
        ).status_code
        == 200
    )
    with client.session_transaction() as sess:
        assert sess.get("_user_id") is not None

    with app.test_request_context():
        token = generate_reset_token(account["email"])
    assert _reset(client, token).status_code == 200

    with client.session_transaction() as sess:
        assert sess.get("_user_id") is None
        assert sess.get("cred_fp") is None


def test_login_pins_the_session_to_the_current_credential(client, app, account):
    assert (
        client.post(
            "/auth/api/login",
            json={"email": account["email"], "password": OLD_PASSWORD},
        ).status_code
        == 200
    )
    with client.session_transaction() as sess:
        assert sess.get("cred_fp") == credential_fingerprint(
            _hash_of(account["user_id"])
        )


# ── The fingerprint itself ───────────────────────────────────────────────


def test_fingerprint_changes_when_the_hash_changes(app):
    a = credential_fingerprint(generate_password_hash("same-password"))
    b = credential_fingerprint(generate_password_hash("same-password"))
    # Werkzeug salts, so even the same plaintext yields a different hash --
    # which is why resetting to the same password still invalidates tokens.
    assert a != b


def test_fingerprint_is_stable_for_one_hash(app):
    hashed = generate_password_hash("x")
    assert credential_fingerprint(hashed) == credential_fingerprint(hashed)


def test_fingerprint_handles_accounts_with_no_password(app):
    """Google-created accounts have password_hash NULL."""
    assert credential_fingerprint(None) == credential_fingerprint(None)
    assert credential_fingerprint(None) != credential_fingerprint(
        generate_password_hash("x")
    )
