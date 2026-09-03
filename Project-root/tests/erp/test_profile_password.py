"""changeMyPassword + the offline-password prompt it is supposed to silence.

The prompt (App.OfflinePassword in static/erp/core.js) is driven entirely by
the `current-user-has-password` meta that templates/erp/index.html renders
from User.has_password. Nothing covered that chain end to end, so "I already
set a password and the banner is still there" had no test that could tell a
real regression from a user who never actually saved the form.

These tests walk the whole loop against a user seeded the way
get_or_create_user() (app/utils.py) seeds a Google sign-in: name/email/role
only, password_hash NULL.
"""

from __future__ import annotations

import re
import uuid

import pytest

import database

_META = re.compile(r'name="current-user-has-password"\s*content="([^"]+)"')

STRONG_PASSWORD = "Str0ng!Passw0rd"


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _has_password_meta(client):
    """The single bit core.js reads. 'no' unhides the banner, anything else
    (including a missing tag) leaves it hidden."""
    html = client.get("/erp").get_data(as_text=True)
    match = _META.search(html)
    return match.group(1) if match else None


@pytest.fixture
def google_user(erp_app):
    """A user with password_hash NULL -- what Google sign-in creates.

    ON CONFLICT resets password_hash back to NULL so the fixture is the same
    starting point on a re-run against a database an earlier run already
    gave a password to.
    """
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                """
                INSERT INTO users (name, email, role)
                VALUES (%s, %s, 'user')
                ON CONFLICT (email) DO UPDATE SET password_hash = NULL
                RETURNING user_id
                """,
                ("Google Only User", "erp-google-only@example.invalid"),
            )
            return cur.fetchone()[0]


@pytest.fixture
def google_client(erp_app, google_user):
    client = erp_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = str(google_user)
        sess["_fresh"] = True
    return client


def test_prompt_shows_then_stops_showing_once_a_password_is_set(
    erp_app, google_user, google_client
):
    """The whole point of the banner: it must appear for a Google-only
    account, and must be gone on the next load once that account has a
    password -- no dismissal, no stale meta."""
    assert _has_password_meta(google_client) == "no"

    # Empty current password: this account never had one, and
    # change_my_password skips the check when password_hash IS NULL.
    resp = _rpc(
        google_client,
        "changeMyPassword",
        ["", STRONG_PASSWORD, STRONG_PASSWORD],
        mutation=True,
    )
    assert resp.status_code == 200
    assert resp.get_json()["success"] is True

    assert _has_password_meta(google_client) == "yes"

    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "SELECT password_hash FROM users WHERE user_id = %s", (google_user,)
            )
            assert cur.fetchone()[0] is not None


def test_prompt_stays_hidden_for_an_account_that_already_has_one(erp_client):
    """erp_test_user is seeded with a password_hash, so the banner must
    never have been unhidden in the first place."""
    assert _has_password_meta(erp_client) == "yes"


def test_a_rejected_password_leaves_the_prompt_up(google_client):
    """A weak password fails validate_password, so nothing is saved and the
    warning must survive -- hiding it here would strand the account with no
    password and no further warning."""
    resp = _rpc(google_client, "changeMyPassword", ["", "weak", "weak"], mutation=True)
    assert resp.get_json()["success"] is False

    assert _has_password_meta(google_client) == "no"


def test_the_user_id_meta_is_emitted_for_a_non_admin(erp_client):
    """App.OfflinePassword keys its per-user dismissal on current-user-id, so
    that tag has to reach every user, not just the admins users.js was
    originally written for -- otherwise two users sharing a shop-floor
    terminal would share one dismissal."""
    html = erp_client.get("/erp").get_data(as_text=True)
    assert 'name="current-user-id"' in html
    # ...while the role tag stays admin-only, as it always was.
    assert 'name="current-user-role"' not in html


def test_an_existing_password_still_requires_the_current_one(google_client):
    """The NULL-hash exemption must close behind the first password: once
    set, a wrong current password is rejected like anyone else's."""
    ok = _rpc(
        google_client,
        "changeMyPassword",
        ["", STRONG_PASSWORD, STRONG_PASSWORD],
        mutation=True,
    )
    assert ok.get_json()["success"] is True

    resp = _rpc(
        google_client,
        "changeMyPassword",
        ["wrong", "An0ther!Passw0rd", "An0ther!Passw0rd"],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "current password" in body["message"].lower()
