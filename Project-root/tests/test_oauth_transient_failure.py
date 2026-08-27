"""A Google sign-in interrupted mid-exchange must stay recoverable.

The incident these pin, from the 2026-08-27 log:

    14:55:36  GET /auth/google           302
    14:55:45  GET /auth/google/callback  502  ConnectTimeout to oauth2.googleapis.com
    14:56:12  GET /auth/google/callback  400  "Invalid OAuth state"
    14:56:13  GET /auth/google/callback  400  "Invalid OAuth state"
    14:56:17  GET /auth/google/callback  400  "Invalid OAuth state"

The uplink dropped for the three seconds it took to connect to Google's
token endpoint. That alone is a bad minute, not a bug. What made it
unrecoverable is that `expected_state` is consumed with session.pop BEFORE
the exchange is attempted, so the timeout left the session with no
oauth_state at all -- and the operator reloading the callback URL was then
told, three times, that their CSRF state was invalid. One real failure, three
false diagnoses, and no reload could ever have worked.

Two things are asserted here: that a connection which never reached Google is
retried once (so the blip is absorbed), and that when it still fails the state
is put back and the operator is returned to the login page with the actual
reason. The SEC-003 guarantee that motivated the pop is unaffected and is
still pinned by tests/test_oauth_state.py.
"""

from __future__ import annotations

import pytest
from requests.exceptions import ConnectTimeout, HTTPError

from app.auth import routes as auth_routes

CALLBACK = "/auth/google/callback"
STATE = "state-interrupted-flow"

GOOGLE_CFG = {
    "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
    "token_endpoint": "https://oauth2.googleapis.com/token",
    "userinfo_endpoint": "https://openidconnect.googleapis.com/v1/userinfo",
}


@pytest.fixture
def live_oauth(app, monkeypatch):
    """The callback with its TESTING shortcut off, so the real token-exchange
    branch (and its error handling) is the code under test.

    Under TESTING the route skips the exchange entirely and mints a fake
    user -- which is what let the handling of a failed exchange go untested
    for as long as it did.
    """
    monkeypatch.setitem(app.config, "TESTING", False)
    monkeypatch.setattr(auth_routes, "_google_cfg", lambda: GOOGLE_CFG)
    # oauthlib refuses to build a token request against an http:// callback
    # URL; the test server has no TLS, and this is the documented opt-out.
    monkeypatch.setenv("OAUTHLIB_INSECURE_TRANSPORT", "1")
    return app


def _seed_state(client, value: str = STATE) -> None:
    with client.session_transaction() as sess:
        sess["oauth_state"] = value


def _session_state(client):
    with client.session_transaction() as sess:
        return sess.get("oauth_state")


def _fail_exchange_with(monkeypatch, exc):
    def boom(*_args, **_kwargs):
        raise exc

    monkeypatch.setattr(auth_routes._GOOGLE_HTTP, "post", boom)


# ── The connection that never reached Google is retried ──────────────────


def test_connect_failures_are_retried_once():
    retry = auth_routes._GOOGLE_HTTP.get_adapter("https://x").max_retries
    assert retry.connect == 1, "a connect that never left the machine is retryable"
    assert retry.total == 1, "and bounded -- a sync worker is blocked for its duration"


def test_a_request_that_reached_google_is_never_re_sent():
    """The safety half, and the more important assertion of the two.

    A read timeout means the token exchange DID arrive: re-sending it would
    present an authorization code Google has already consumed, turning a
    recoverable timeout into a hard invalid_grant. Same for retrying on a
    response status.
    """
    retry = auth_routes._GOOGLE_HTTP.get_adapter("https://x").max_retries
    assert retry.read == 0
    assert retry.status == 0


# ── When it still fails, the flow stays retryable ────────────────────────


def test_network_failure_keeps_the_state_for_a_retry(live_oauth, client, monkeypatch):
    _seed_state(client)
    _fail_exchange_with(monkeypatch, ConnectTimeout("uplink down"))

    response = client.get(f"{CALLBACK}?code=abc&state={STATE}")

    assert response.status_code == 302
    assert "/auth/login" in response.headers["Location"]
    assert "oauth_error=network" in response.headers["Location"]
    # Was: popped before the exchange and never put back, so the next
    # callback -- and every one after it -- failed the CSRF check instead.
    assert _session_state(client) == STATE


def test_reloading_after_a_network_failure_is_not_called_a_csrf_error(
    live_oauth, client, monkeypatch
):
    _seed_state(client)
    _fail_exchange_with(monkeypatch, ConnectTimeout("uplink down"))

    client.get(f"{CALLBACK}?code=abc&state={STATE}")
    reload_response = client.get(f"{CALLBACK}?code=abc&state={STATE}")

    assert reload_response.status_code != 400
    assert b"Invalid OAuth state" not in reload_response.data


def test_a_rejection_by_google_is_reported_as_one(live_oauth, client, monkeypatch):
    response_stub = type("R", (), {"status_code": 400, "text": "invalid_grant"})()
    _seed_state(client)
    _fail_exchange_with(monkeypatch, HTTPError(response=response_stub))

    response = client.get(f"{CALLBACK}?code=stale&state={STATE}")

    assert response.status_code == 302
    assert "oauth_error=google" in response.headers["Location"]


def test_an_unexpected_error_still_lands_somewhere_usable(
    live_oauth, client, monkeypatch
):
    _seed_state(client)
    _fail_exchange_with(monkeypatch, ValueError("something we did not foresee"))

    response = client.get(f"{CALLBACK}?code=abc&state={STATE}")

    assert response.status_code == 302
    assert "oauth_error=unexpected" in response.headers["Location"]


# ── What the operator is told ────────────────────────────────────────────


def test_the_login_page_names_the_real_failure(client):
    response = client.get("/auth/login?oauth_error=network")

    assert response.status_code == 200
    assert b"Could not reach Google" in response.data


def test_an_unrecognised_code_renders_nothing(client):
    """The code travels in a query string, so it is looked up in a fixed map
    rather than reflected. A message chosen by whoever wrote the URL is a
    phishing lure at best.
    """
    response = client.get("/auth/login?oauth_error=Your+account+was+suspended")

    assert response.status_code == 200
    assert b"Your account was suspended" not in response.data


def test_the_code_is_never_reflected_into_the_page(client):
    payload = "<img src=x onerror=alert(1)>"
    response = client.get("/auth/login", query_string={"oauth_error": payload})

    assert response.status_code == 200
    assert b"onerror=alert(1)" not in response.data
