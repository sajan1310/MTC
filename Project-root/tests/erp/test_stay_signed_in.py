"""Signing in on a phone should last.

Google sign-in called `login_user(user_obj)` with no `remember` and never
set `session.permanent`, so it produced a plain browser-session cookie: no
remember token at all. On a desktop that survives until the browser quits.
On a phone it does not survive the installed PWA being evicted from memory,
which is why the app asked for a sign-in again most times it was opened.

Password sign-in leaves the choice to the operator because the form has a
box to tick. The OAuth flow has no such moment -- the whole interaction
happens on Google's pages -- so the only options are to choose for them or
to sign them out constantly.

The other half is the cookie's own attributes, which were left entirely on
Flask-Login's defaults while the session cookie's were being set with care.
REMEMBER_COOKIE_SECURE is the one that matters: this deployment serves plain
http over a LAN and a tailnet, and a Secure cookie on http is accepted and
then never sent back -- the same undiagnosable logout the session cookie's
own comment describes.
"""

from __future__ import annotations

from datetime import timedelta


def test_remember_cookie_is_not_secure_when_serving_plain_http(erp_app):
    """The trap this deployment actually falls into. A Secure remember
    cookie on http is set, stored, and never sent again.
    """
    assert erp_app.config.get("REMEMBER_COOKIE_SECURE") is False


def test_remember_cookie_tracks_the_session_cookie_rather_than_being_pinned(erp_app):
    """Both follow whether the app is served over https, so a certificate
    turns them both on together and neither is left behind.
    """
    assert erp_app.config.get("REMEMBER_COOKIE_SECURE") == erp_app.config.get(
        "SESSION_COOKIE_SECURE"
    )


def test_remember_cookie_is_http_only(erp_app):
    assert erp_app.config.get("REMEMBER_COOKIE_HTTPONLY") is True


def test_remember_cookie_samesite_matches_the_session_cookie(erp_app):
    """Not pinned Strict: the browser withholds a Strict cookie on Google's
    cross-site redirect back to the callback, which is the trap already
    documented for the session cookie.
    """
    assert erp_app.config.get("REMEMBER_COOKIE_SAMESITE") == erp_app.config.get(
        "SESSION_COOKIE_SAMESITE"
    )


def test_remember_lasts_long_enough_to_be_worth_having(erp_app):
    """Stated rather than inherited from Flask-Login, so it is a decision
    someone can find and change.
    """
    duration = erp_app.config.get("REMEMBER_COOKIE_DURATION")
    assert isinstance(duration, timedelta)
    assert duration >= timedelta(days=30)


def test_oauth_sign_in_asks_to_be_remembered():
    """Read off the source: the OAuth callbacks must pass remember=True and
    mark the session permanent, or a phone is signed out again as soon as
    the app is evicted.

    Asserted on the code because driving a real Google callback here would
    test the mock, not the branch that matters.
    """
    from pathlib import Path

    src = (
        Path(__file__).resolve().parents[2] / "app" / "auth" / "routes.py"
    ).read_text(encoding="utf-8")

    # Every login_user call in the OAuth paths carries remember=True.
    assert src.count("login_user(user_obj, remember=True)") == 2, (
        "both the real and the test OAuth callback must remember the sign-in"
    )
    assert "login_user(user_obj)\n" not in src.replace(
        "login_user(user_obj)\n            session.permanent = False\n", ""
    ), "an OAuth path is still signing in without remember=True"
