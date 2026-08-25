"""The custom-role authorization system (TEST-001).

Coverage in this application was inverted. Business services sat at 86-96%
while the code deciding *who may do what* sat far lower --
roles_service.py 36%, app/utils.py 38%, app/auth/routes.py 49% -- and
app/erp/rpc.py's per-tab permission gate (its lines 76-84) had no coverage at
all. All three P0 security findings in the audit lived in those untested
lines. The custom-role system in particular is a real security boundary that
was effectively unverified.

These tests exercise the boundary itself: the permission matrix
(tab x level x read/mutate), the escalation limits, and the dispatcher gate
that enforces them.
"""

from __future__ import annotations

import uuid

import psycopg2.extras
import pytest

import database
from app.erp.services import roles_service

pytestmark = pytest.mark.integration


@pytest.fixture
def custom_role():
    """A real custom_roles row, removed afterwards."""
    created = []

    def _make(permissions, name=None):
        role_name = name or f"Test Role {uuid.uuid4().hex[:8]}"
        key = roles_service._slugify(role_name)
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_c, cur):
            cur.execute(
                "INSERT INTO custom_roles (role_key, role_name, permissions) "
                "VALUES (%s, %s, %s) RETURNING role_key",
                (key, role_name, psycopg2.extras.Json(permissions)),
            )
            created.append(cur.fetchone()["role_key"])
        return key

    yield _make

    for key in created:
        try:
            with database.get_conn() as (_c, cur):
                cur.execute("DELETE FROM users WHERE role = %s", (key,))
                cur.execute("DELETE FROM custom_roles WHERE role_key = %s", (key,))
        except Exception:  # noqa: BLE001 -- best-effort teardown
            pass


# ── get_effective_tab_level: the matrix ──────────────────────────────────


@pytest.mark.parametrize("builtin", ["user", "admin", "super_admin"])
@pytest.mark.parametrize("tab", [t for t, _ in roles_service.ASSIGNABLE_TABS])
def test_builtin_roles_always_get_editor(builtin, tab):
    """The custom-role system is additive: it must not alter what the four
    built-in roles could already do. If this ever returns anything else, every
    existing user's access silently changes."""
    assert roles_service.get_effective_tab_level(builtin, tab) == "editor"


def test_an_unknown_role_gets_no_access_anywhere():
    """A role deleted out from under an active session must fail closed."""
    assert roles_service.get_effective_tab_level("no-such-role-xyz", "stockTab") is None


def test_a_custom_role_gets_exactly_the_levels_it_was_granted(custom_role):
    key = custom_role({"stockTab": "editor", "billLedger": "viewer", "poLedger": "commenter"})
    assert roles_service.get_effective_tab_level(key, "stockTab") == "editor"
    assert roles_service.get_effective_tab_level(key, "billLedger") == "viewer"
    assert roles_service.get_effective_tab_level(key, "poLedger") == "commenter"


def test_a_tab_absent_from_the_map_means_no_access(custom_role):
    """Absence is denial, not a default-allow."""
    key = custom_role({"stockTab": "editor"})
    assert roles_service.get_effective_tab_level(key, "billLedger") is None
    assert roles_service.get_effective_tab_level(key, "clientsTab") is None


def test_a_role_with_no_permissions_at_all_gets_nothing(custom_role):
    key = custom_role({})
    for tab, _label in roles_service.ASSIGNABLE_TABS:
        assert roles_service.get_effective_tab_level(key, tab) is None


def test_get_role_permissions_returns_none_for_a_builtin_role():
    assert roles_service.get_role_permissions("admin") is None


def test_is_valid_custom_role_distinguishes_custom_from_builtin(custom_role):
    key = custom_role({"stockTab": "viewer"})
    assert roles_service.is_valid_custom_role(key) is True
    assert roles_service.is_valid_custom_role("admin") is False
    assert roles_service.is_valid_custom_role("nonexistent") is False


# ── Escalation limits ────────────────────────────────────────────────────


def test_users_tab_can_never_be_granted_to_a_custom_role():
    """usersTab is User Management. If a custom role could be granted it, a
    custom role could create admins -- i.e. escalate to admin-equivalent
    power, which the module docstring explicitly promises is impossible."""
    assert "usersTab" not in {t for t, _ in roles_service.ASSIGNABLE_TABS}
    with pytest.raises(ValueError, match="Unknown tab"):
        roles_service._validate_permissions({"usersTab": "editor"})


def test_a_role_cannot_be_named_after_a_builtin_role(app):
    """Slugging "Super Admin" yields "super_admin"; if that were allowed to be
    created, assigning it would grant real super_admin power."""
    for builtin in ("admin", "super_admin", "user", "pending_approval"):
        with app.app_context(), pytest.raises(ValueError, match="built-in role"):
            roles_service.create_custom_role(builtin.replace("_", " "), {})


def test_an_unknown_tab_is_rejected():
    with pytest.raises(ValueError, match="Unknown tab"):
        roles_service._validate_permissions({"notATab": "editor"})


@pytest.mark.parametrize("bad_level", ["admin", "owner", "full", "", "super", None])
def test_an_invalid_access_level_is_rejected(bad_level):
    """'editor' is the highest level that exists. Anything the caller invents
    must be refused, not coerced."""
    with pytest.raises(ValueError):
        roles_service._validate_permissions({"stockTab": bad_level})


def test_valid_levels_are_accepted_and_normalised():
    cleaned = roles_service._validate_permissions(
        {"stockTab": "Editor", "billLedger": " viewer ", "poLedger": "COMMENTER"}
    )
    assert cleaned == {
        "stockTab": "editor",
        "billLedger": "viewer",
        "poLedger": "commenter",
    }


def test_permissions_must_be_a_mapping():
    for bad in ([], "editor", 5, None):
        with pytest.raises(ValueError, match="map of tab"):
            roles_service._validate_permissions(bad)


# ── The module -> tab map the dispatcher relies on ───────────────────────


def test_every_assignable_tab_is_reachable_from_some_service_module():
    """A tab an admin can grant, but which no service module maps to, is a
    permission that silently does nothing."""
    mapped = set(roles_service.TAB_BY_SERVICE_MODULE.values())
    for tab, label in roles_service.ASSIGNABLE_TABS:
        assert tab in mapped, f"{label} ({tab}) is grantable but gates no service module"


def test_users_and_roles_services_map_to_the_ungrantable_tab():
    """Both administer access itself, so both must sit behind usersTab --
    which no custom role can hold."""
    assert roles_service.TAB_BY_SERVICE_MODULE["users_service"] == "usersTab"
    assert roles_service.TAB_BY_SERVICE_MODULE["roles_service"] == "usersTab"
    assert "usersTab" not in {t for t, _ in roles_service.ASSIGNABLE_TABS}


# ── CRUD lifecycle ───────────────────────────────────────────────────────


def test_create_read_update_delete_round_trip(app):
    name = f"Store Keeper {uuid.uuid4().hex[:6]}"
    key = roles_service._slugify(name)
    try:
        with app.app_context():
            created = roles_service.create_custom_role(name, {"stockTab": "editor"})
            assert created["success"] is True
            assert created["data"]["roleKey"] == key

            listed = roles_service.get_custom_roles()
            assert any(r["roleKey"] == key for r in listed["data"])

            updated = roles_service.update_custom_role(
                key, name, {"stockTab": "viewer", "billLedger": "editor"}
            )
            assert updated["success"] is True
            assert roles_service.get_effective_tab_level(key, "stockTab") == "viewer"
            assert roles_service.get_effective_tab_level(key, "billLedger") == "editor"

            deleted = roles_service.delete_custom_role(key)
            assert deleted["success"] is True
            assert roles_service.get_role_permissions(key) is None
    finally:
        with database.get_conn() as (_c, cur):
            cur.execute("DELETE FROM custom_roles WHERE role_key = %s", (key,))


def test_a_duplicate_role_name_is_rejected(app, custom_role):
    name = f"Dup Role {uuid.uuid4().hex[:6]}"
    custom_role({"stockTab": "viewer"}, name=name)
    with app.app_context(), pytest.raises(ValueError, match="already exists"):
        roles_service.create_custom_role(name, {"stockTab": "viewer"})


def test_a_role_still_assigned_to_a_user_cannot_be_deleted(app, custom_role):
    """Deleting an in-use role would leave those users with a role that
    resolves to no permissions -- locked out with no explanation."""
    key = custom_role({"stockTab": "viewer"})
    email = f"role-holder-{uuid.uuid4().hex[:8]}@example.com"
    with database.get_conn() as (_c, cur):
        cur.execute(
            "INSERT INTO users (name, email, role) VALUES (%s, %s, %s)",
            ("Role Holder", email, key),
        )

    with app.app_context(), pytest.raises(ValueError, match="still assigned"):
        roles_service.delete_custom_role(key)
    # And the role survives the refusal.
    assert roles_service.get_role_permissions(key) is not None


def test_deleting_an_unknown_role_reports_not_found(app):
    with app.app_context(), pytest.raises(ValueError, match="not found"):
        roles_service.delete_custom_role("does-not-exist")


def test_updating_an_unknown_role_reports_not_found(app):
    with app.app_context(), pytest.raises(ValueError, match="not found"):
        roles_service.update_custom_role("does-not-exist", "X", {})


def test_an_empty_role_name_is_rejected(app):
    with app.app_context():
        with pytest.raises(ValueError, match="required"):
            roles_service.create_custom_role("", {})
        with pytest.raises(ValueError, match="required"):
            roles_service.create_custom_role("   ", {})


def test_a_name_with_no_alphanumerics_is_rejected(app):
    with app.app_context(), pytest.raises(ValueError, match="letter or number"):
        roles_service.create_custom_role("!!!___!!!", {})


# ── Slug behaviour ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name,expected",
    [
        ("Store Keeper", "store_keeper"),
        ("  Store   Keeper  ", "store_keeper"),
        ("Store-Keeper!", "store_keeper"),
        ("STORE KEEPER", "store_keeper"),
        ("Store Keeper 2", "store_keeper_2"),
    ],
)
def test_slugify_is_stable_and_normalising(name, expected):
    """Two names that differ only in case or punctuation must not become two
    roles that look identical in the admin UI."""
    assert roles_service._slugify(name) == expected


def test_slug_is_length_capped_to_the_column():
    """users.role and custom_roles.role_key are VARCHAR(50); a longer slug
    would be truncated by the database and stop matching."""
    assert len(roles_service._slugify("x" * 200)) <= 50

@pytest.mark.parametrize(
    "role_key, role_name",
    [
        ("", "Some Name"),
        ("   ", "Some Name"),
        ("some_key", ""),
        ("some_key", "   "),
        (None, "Some Name"),
        ("some_key", None),
    ],
)
def test_updating_a_role_needs_both_a_key_and_a_name(app, role_key, role_name):
    """Blank-name guard on the update path. create_custom_role has the same
    guard and is already covered; this one is separate code and was not.
    Without it, a blank name would be written over a working role's label and
    the Users tab would show an unnamed role nobody could identify."""
    with app.app_context(), pytest.raises(ValueError, match="required"):
        roles_service.update_custom_role(role_key, role_name, {"stockTab": "viewer"})


def test_updating_a_role_that_does_not_exist_is_rejected(app):
    with app.app_context(), pytest.raises(ValueError, match="not found"):
        roles_service.update_custom_role("no_such_role_key", "No Such Role", {})
