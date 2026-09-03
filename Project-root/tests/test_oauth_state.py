"""OAuth `state` CSRF protection on /auth/google/callback (SEC-003).

The callback used to validate state like this::

    expected_state = session.pop("oauth_state", None)
    if not current_app.config.get("TESTING"):
        if expected_state and returned_state != expected_state:
            return "Invalid OAuth state", 400

Two independent holes:

1. ``if expected_state and ...`` -- when the browser's session carried no
   ``oauth_state`` at all (because that browser never started an OAuth flow)
   the comparison was skipped and the callback proceeded with no CSRF
   protection whatsoever. The absence of state is the attack; the guard
   treated it as the safe case. An attacker starts a Google sign-in with their
   own account, captures the ``code``, and gets the victim to open the
   callback URL -- the victim is then silently logged in AS THE ATTACKER, and
   the work they do lands in the attacker's account.

2. ``if not current_app.config.get("TESTING")`` -- the whole branch was
   skipped under TESTING, so no test could exercise the one check protecting
   this flow. That is a large part of why (1) survived.

Both are closed. These tests fail against the old code.
"""

from __future__ import annotations

import pytest

CALLBACK = "/auth/google/callback"


def _seed_state(client, value: str) -> None:
    """Put an oauth_state in the session, as /auth/google itself would."""
    with client.session_transaction() as sess:
        sess["oauth_state"] = value


# ── The vulnerability itself ─────────────────────────────────────────────


def test_callback_rejected_when_session_has_no_state(client):
    """THE login-CSRF case: victim never started a flow, so their session has
    no oauth_state. This must be refused, not waved through."""
    response = client.get(f"{CALLBACK}?code=attacker_code&state=anything")
    assert response.status_code == 400
    assert b"Invalid OAuth state" in response.data


def test_callback_rejected_when_session_has_no_state_and_none_supplied(client):
    response = client.get(f"{CALLBACK}?code=attacker_code")
    assert response.status_code == 400
    assert b"Invalid OAuth state" in response.data


def test_callback_rejected_on_mismatched_state(client):
    _seed_state(client, "the-real-state")
    response = client.get(f"{CALLBACK}?code=some_code&state=a-different-state")
    assert response.status_code == 400
    assert b"Invalid OAuth state" in response.data


def test_callback_rejected_when_state_param_is_empty(client):
    _seed_state(client, "the-real-state")
    response = client.get(f"{CALLBACK}?code=some_code&state=")
    assert response.status_code == 400
    assert b"Invalid OAuth state" in response.data


def test_callback_rejected_when_state_param_is_absent_but_session_has_one(client):
    _seed_state(client, "the-real-state")
    response = client.get(f"{CALLBACK}?code=some_code")
    assert response.status_code == 400
    assert b"Invalid OAuth state" in response.data


# ── The positive case ────────────────────────────────────────────────────


def test_callback_accepts_matching_state(client, monkeypatch):
    """Without this, every test above would still pass if the callback simply
    rejected everything."""
    import app as app_pkg
    from app.models import User

    monkeypatch.setattr(
        app_pkg,
        "get_or_create_user",
        lambda info: (
            User(
                {
                    "user_id": 1,
                    "name": "Test User",
                    "email": "test@example.com",
                    "role": "user",
                }
            ),
            False,
        ),
    )

    _seed_state(client, "matching-state")
    response = client.get(f"{CALLBACK}?code=test_code&state=matching-state")
    assert response.status_code == 302
    assert b"Invalid OAuth state" not in response.data


# ── Single use ───────────────────────────────────────────────────────────


def test_state_is_consumed_and_cannot_be_replayed(client, monkeypatch):
    """session.pop() removes the state, so a captured callback URL is not
    replayable against the same session."""
    import app as app_pkg
    from app.models import User

    monkeypatch.setattr(
        app_pkg,
        "get_or_create_user",
        lambda info: (
            User(
                {
                    "user_id": 1,
                    "name": "Test User",
                    "email": "test@example.com",
                    "role": "user",
                }
            ),
            False,
        ),
    )

    _seed_state(client, "one-shot-state")
    first = client.get(f"{CALLBACK}?code=test_code&state=one-shot-state")
    assert first.status_code == 302

    replay = client.get(f"{CALLBACK}?code=test_code&state=one-shot-state")
    assert replay.status_code == 400
    assert b"Invalid OAuth state" in replay.data


# ── Ordering / precedence ────────────────────────────────────────────────


def test_google_error_is_reported_before_state_is_considered(client):
    """A user who clicked Deny should see that, not a confusing CSRF error."""
    response = client.get(f"{CALLBACK}?error=access_denied")
    assert response.status_code == 400
    assert b"access_denied" in response.data


@pytest.mark.parametrize(
    "query",
    [
        "code=c&state=THE-REAL-STATE",  # case differs
        "code=c&state=the-real-state ",  # trailing space
        "code=c&state=the-real-stat",  # truncated
        "code=c&state=the-real-statex",  # extended
    ],
)
def test_state_comparison_is_exact(client, query):
    _seed_state(client, "the-real-state")
    response = client.get(f"{CALLBACK}?{query}")
    assert response.status_code == 400


# ── The initiating route still issues a state ────────────────────────────


def test_auth_google_sets_a_state_in_the_session(client, monkeypatch):
    import app.auth.routes as routes

    monkeypatch.setattr(
        routes,
        "_google_cfg",
        lambda: {
            "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth"
        },
    )

    response = client.get("/auth/google")
    assert response.status_code == 302
    with client.session_transaction() as sess:
        state = sess.get("oauth_state")
    assert state, "/auth/google must place an oauth_state in the session"
    # os.urandom(24).hex() -- 48 hex characters of real entropy.
    assert len(state) >= 32
    assert state in response.location
