"""The @role_required decorator (TEST-001).

app/utils.py sat at 38% coverage, and the untested part was lines 13-50 --
role_required itself, an authorization primitive. It is a smaller surface than
the RPC dispatcher's gate, but it is the one a future route will reach for,
and an authorization check nobody has ever exercised is a check nobody knows
the shape of.

Two behaviours here are easy to get wrong and worth pinning explicitly:
super_admin bypasses the allow-list entirely, and an UNAUTHENTICATED caller
gets 401 while an authenticated-but-wrong-role caller gets 403. Collapsing
those two into one response would tell an attacker nothing, but collapsing
them the other way -- 403 for anonymous -- would break the login redirect.
"""

from __future__ import annotations

import pytest
from flask import Flask

from app.utils import role_required


class _FakeUser:
    def __init__(self, role, authenticated=True):
        self.role = role
        self.is_authenticated = authenticated


@pytest.fixture
def guarded_app(monkeypatch):
    """A minimal app with one route behind @role_required("manager")."""
    flask_app = Flask(__name__)
    flask_app.config["TESTING"] = True

    @flask_app.route("/managers-only")
    @role_required("manager")
    def managers_only():
        return {"ok": True}

    def _as(user):
        import app.utils as utils_module

        monkeypatch.setattr(utils_module, "current_user", user)

    flask_app.as_user = _as  # type: ignore[attr-defined]
    return flask_app


def _call(guarded_app, user):
    guarded_app.as_user(user)  # type: ignore[attr-defined]
    return guarded_app.test_client().get("/managers-only")


# ── Authenticated, correct role ──────────────────────────────────────────


def test_the_allowed_role_is_admitted(guarded_app):
    response = _call(guarded_app, _FakeUser("manager"))
    assert response.status_code == 200
    assert response.get_json() == {"ok": True}


def test_super_admin_bypasses_the_allow_list(guarded_app):
    """super_admin is a superset of every role check by design (it matches
    User.has_role's own semantics). Worth pinning: a future refactor that
    dropped this would lock super_admins out of routes they administer."""
    response = _call(guarded_app, _FakeUser("super_admin"))
    assert response.status_code == 200


# ── Authenticated, wrong role ────────────────────────────────────────────


@pytest.mark.parametrize(
    "role", ["user", "pending_approval", "viewer", "store_keeper", ""]
)
def test_a_role_outside_the_allow_list_gets_403(guarded_app, role):
    response = _call(guarded_app, _FakeUser(role))
    assert response.status_code == 403
    body = response.get_json()
    assert body["success"] is False
    assert body["error"] == "forbidden"


def test_plain_admin_is_not_admitted_to_a_manager_only_route(guarded_app):
    """ "admin" is NOT a wildcard here -- only super_admin is. This differs
    from User.has_role(), where admin also matches any check, so the two are
    easy to conflate. Pinned so the difference is deliberate rather than
    discovered."""
    response = _call(guarded_app, _FakeUser("admin"))
    assert response.status_code == 403


# ── Unauthenticated ──────────────────────────────────────────────────────


def test_an_anonymous_caller_gets_401_not_403(guarded_app):
    response = _call(guarded_app, _FakeUser(None, authenticated=False))
    assert response.status_code == 401
    body = response.get_json()
    assert body["success"] is False
    assert body["error"] == "unauthenticated"


def test_authentication_is_checked_before_the_role(guarded_app):
    """An anonymous caller whose (absent) role happens to be in the allow-list
    must still be refused as unauthenticated."""
    response = _call(guarded_app, _FakeUser("manager", authenticated=False))
    assert response.status_code == 401


# ── Multiple allowed roles ───────────────────────────────────────────────


def test_any_listed_role_is_admitted(monkeypatch):
    flask_app = Flask(__name__)
    flask_app.config["TESTING"] = True

    @flask_app.route("/multi")
    @role_required("manager", "supervisor")
    def multi():
        return {"ok": True}

    import app.utils as utils_module

    for role in ("manager", "supervisor"):
        monkeypatch.setattr(utils_module, "current_user", _FakeUser(role))
        assert flask_app.test_client().get("/multi").status_code == 200

    monkeypatch.setattr(utils_module, "current_user", _FakeUser("operator"))
    assert flask_app.test_client().get("/multi").status_code == 403


def test_an_empty_allow_list_admits_only_super_admin(monkeypatch):
    """Guards against a decorator applied with no arguments reading as
    'allow everyone'."""
    flask_app = Flask(__name__)
    flask_app.config["TESTING"] = True

    @flask_app.route("/none")
    @role_required()
    def none_allowed():
        return {"ok": True}

    import app.utils as utils_module

    monkeypatch.setattr(utils_module, "current_user", _FakeUser("admin"))
    assert flask_app.test_client().get("/none").status_code == 403

    monkeypatch.setattr(utils_module, "current_user", _FakeUser("super_admin"))
    assert flask_app.test_client().get("/none").status_code == 200


# ── The wrapper itself ───────────────────────────────────────────────────


def test_the_decorator_preserves_the_view_name():
    """functools.wraps matters here: Flask registers endpoints by function
    name, so losing it would collide every guarded view under 'decorated_function'."""

    @role_required("manager")
    def some_view():
        return "x"

    assert some_view.__name__ == "some_view"
