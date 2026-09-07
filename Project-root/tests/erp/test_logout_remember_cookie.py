"""Logging out must actually log you out, including "remember me".

`logout_user()` does not delete the remember-me cookie itself. It marks the
session with `_remember = "clear"`, and Flask-Login's after_request hook
deletes the cookie when it sees that marker. The logout view then called
`session.clear()`, which wipes the marker before the hook ever runs -- so the
cookie survived logout, and Flask-Login re-authenticated the user from it on
their very next request.

The user sees a login page, believes they are signed out, and is not. On a
shared terminal on a factory floor that is the whole point of the button.

These drive the real cookie rather than asserting on Set-Cookie headers: mint
a genuine Flask-Login remember token, prove it authenticates on its own, log
out, and prove it no longer does.
"""

from __future__ import annotations

import pytest
from flask_login.utils import encode_cookie

DOMAIN = "localhost.localdomain"  # matches erp_app's SERVER_NAME


@pytest.fixture
def remembered_client(erp_app, erp_test_user):
    """A client carrying ONLY a remember-me cookie -- no session."""
    client = erp_app.test_client()
    with erp_app.test_request_context():
        token = encode_cookie(str(erp_test_user))
    client.set_cookie("remember_token", token, domain=DOMAIN)
    return client


def _is_authenticated(client) -> bool:
    """401 is what an unauthenticated API caller now gets (see PR #7)."""
    resp = client.post("/api/erp/rpc/testConnection", json={"args": []})
    return resp.status_code == 200


def test_the_remember_cookie_authenticates_on_its_own(remembered_client):
    """Guards the test above it: if this ever stops holding, the logout test
    below would pass for the wrong reason -- a cookie that never worked
    cannot demonstrate that logout revoked it."""
    assert _is_authenticated(remembered_client)


def test_logout_revokes_the_remember_cookie(remembered_client):
    assert _is_authenticated(remembered_client), "precondition"

    # auth_bp is registered under /auth, and GET renders the confirmation
    # page (logout_confirm.html) -- POST is what actually signs you out.
    resp = remembered_client.post("/auth/logout")
    assert resp.status_code in (301, 302)

    assert not _is_authenticated(remembered_client), (
        "still authenticated after logout -- the remember-me cookie survived, "
        "so the user was silently signed back in on the next request"
    )
