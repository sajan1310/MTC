"""Custom roles -- lets an admin/super_admin define a named role beyond the
four built-in ones (pending_approval/user/admin/super_admin, see
app/models/user.py), each carrying an explicit per-tab access level. A
custom role's `permissions` is a JSON object mapping a sidebar tab id to
one of three levels:
  - "viewer"    -- can call that tab's read-only (non-mutating) methods.
  - "commenter" -- viewer, plus can call updateEntityRemarks for that tab
                   (remarks_service.py) -- nothing else mutating.
  - "editor"    -- full access, same as today's unrestricted behaviour.
A tab absent from the object means no access at all. Assigned to a user
through the existing users.role column (users_service.py's
update_user_role/create_user, relaxed to accept a custom role_key
alongside the built-in ROLES/CREATE_ROLES).

Enforcement lives in two places:
  - app/erp/rpc.py's dispatcher, via TAB_BY_SERVICE_MODULE below (the real
    security boundary -- gates the underlying RPC methods per tab+level).
  - app/erp/pages.py's index() route computes which tabs to even render
    for the sidebar/tab-content (UX only, not enforcement).

Everything here is admin-only (roles=frozenset({"admin"}), which
User.has_role() already treats super_admin as a superset of -- see
app/models/user.py). A custom role can never be granted "usersTab" (User
Management) or any admin-only action -- those stay tied to the literal
"admin"/"super_admin" role strings, so a custom role can never escalate to
admin-equivalent power.
"""

from __future__ import annotations

import re

import psycopg2.extras

import database
from ..envelope import build_response
from ..registry import rpc_method

# (tab_id, display label) -- the sidebar tabs a custom role can be granted.
# dashboardTab is deliberately absent: every role sees it, it's the landing
# page. usersTab is deliberately absent: never assignable to a custom role.
ASSIGNABLE_TABS = [
    ("vendorMaster", "Vendors"),
    ("itemMaster", "Items Master"),
    ("poLedger", "Purchase Orders"),
    ("billLedger", "Bill Ledger"),
    ("returnLedger", "Returns"),
    ("stockTab", "Stock"),
    ("productsTab", "Products & Processes"),
    ("contractorsTab", "Contractors"),
    ("productionTab", "Production"),
    ("clientsTab", "Clients"),
    ("dispatchTab", "Dispatch"),
]
_ASSIGNABLE_TAB_KEYS = frozenset(key for key, _label in ASSIGNABLE_TABS)
_LEVELS = ("viewer", "commenter", "editor")

# Service module (RpcSpec.module, see registry.py) -> the sidebar tab it
# belongs to. A module absent from this dict (units_service, tags_service,
# company_settings_service, system_service, profile_service, dashboard_service,
# ledger_audit_service, remarks_service, ...) is cross-cutting/shared and
# stays accessible to every authenticated non-pending_approval user
# regardless of custom role -- restricting those would break other tabs'
# forms (e.g. Item Master's Base Unit field) for no security benefit, since
# they're header-level shortcuts or per-user/tab-agnostic data, not tied to
# one tab. remarks_service is deliberately absent too: its one method
# (updateEntityRemarks) enforces its own per-tab, per-level check using the
# `tab` argument it receives, since the outer dispatcher can't know which
# tab a generic call targets ahead of time.
TAB_BY_SERVICE_MODULE = {
    "vendors_service": "vendorMaster",
    "items_service": "itemMaster",
    "po_service": "poLedger",
    "bill_service": "billLedger",
    "return_service": "returnLedger",
    "wastage_service": "returnLedger",
    "stock_service": "stockTab",
    "stock_group_service": "stockTab",
    "warehouse_service": "stockTab",
    "bom_service": "productsTab",
    "process_service": "productsTab",
    "contractors_service": "contractorsTab",
    "production_service": "productionTab",
    "issue_service": "productionTab",
    "clients_service": "clientsTab",
    "dispatch_service": "dispatchTab",
    "users_service": "usersTab",
    "roles_service": "usersTab",
}

_BUILTIN_ROLES = frozenset({"pending_approval", "user", "admin", "super_admin"})
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(role_name: str) -> str:
    slug = _SLUG_RE.sub("_", role_name.strip().lower()).strip("_")
    return slug[:50]


def get_role_permissions(role_key: str) -> dict[str, str] | None:
    """Plain helper (not an RPC method) -- {tab: level} for `role_key`, or
    None if it isn't a known custom role. Used by rpc.py's dispatcher and
    pages.py's index() route; a fresh, tiny SELECT each call rather than an
    in-process cache -- this table is expected to stay at most a few dozen
    rows, so the extra query is cheap, and it sidesteps any
    cache-invalidation-on-edit bug entirely.
    """
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute("SELECT permissions FROM custom_roles WHERE role_key = %s", (role_key,))
        row = cur.fetchone()
    if row is None:
        return None
    return dict(row["permissions"] or {})


def is_valid_custom_role(role_key: str) -> bool:
    return get_role_permissions(role_key) is not None


def get_effective_tab_level(role: str, tab: str) -> str | None:
    """The access level `role` has for `tab`: "viewer"/"commenter"/"editor",
    or None for no access at all. Built-in roles (user/admin/super_admin)
    always get "editor" -- this whole system is additive, their existing
    unrestricted behaviour is untouched. pending_approval is handled
    entirely by rpc.py's separate, unconditional blanket gate before this
    is ever consulted.
    """
    if role in ("user", "admin", "super_admin"):
        return "editor"
    perms = get_role_permissions(role)
    if perms is None:
        return None
    return perms.get(tab)


def _validate_permissions(permissions) -> dict[str, str]:
    if not isinstance(permissions, dict):
        raise ValueError("Permissions must be a map of tab -> access level.")
    cleaned: dict[str, str] = {}
    for tab, level in permissions.items():
        tab = str(tab)
        level = str(level or "").strip().lower()
        if tab not in _ASSIGNABLE_TAB_KEYS:
            raise ValueError(f'Unknown tab "{tab}".')
        if level not in _LEVELS:
            raise ValueError(f'Invalid access level "{level}" for {tab}. Must be one of: {", ".join(_LEVELS)}.')
        cleaned[tab] = level
    return cleaned


@rpc_method("getCustomRoles", roles=frozenset({"admin"}))
def get_custom_roles():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT r.role_key, r.role_name, r.permissions,
                   COUNT(u.user_id) FILTER (WHERE u.deleted_at IS NULL) AS user_count
            FROM custom_roles r
            LEFT JOIN users u ON u.role = r.role_key
            GROUP BY r.role_key, r.role_name, r.permissions
            ORDER BY lower(r.role_name)
            """
        )
        rows = cur.fetchall()
    return build_response(True, [
        {
            "roleKey": r["role_key"],
            "roleName": r["role_name"],
            "permissions": dict(r["permissions"] or {}),
            "userCount": r["user_count"],
        }
        for r in rows
    ])


@rpc_method("createCustomRole", mutation=True, roles=frozenset({"admin"}))
@database.transactional
def create_custom_role(conn, cur, role_name, permissions):
    role_name = str(role_name or "").strip()
    if not role_name:
        raise ValueError("Role name is required.")
    role_key = _slugify(role_name)
    if not role_key:
        raise ValueError("Role name must contain at least one letter or number.")
    if role_key in _BUILTIN_ROLES:
        raise ValueError(f'"{role_name}" collides with a built-in role. Choose a different name.')

    cleaned_permissions = _validate_permissions(permissions)

    cur.execute("SELECT 1 FROM custom_roles WHERE role_key = %s", (role_key,))
    if cur.fetchone():
        raise ValueError(f'A role named "{role_name}" already exists.')

    cur.execute(
        "INSERT INTO custom_roles (role_key, role_name, permissions) VALUES (%s, %s, %s) "
        "RETURNING role_key, role_name, permissions",
        (role_key, role_name, psycopg2.extras.Json(cleaned_permissions)),
    )
    row = cur.fetchone()
    return build_response(
        True,
        {"roleKey": row["role_key"], "roleName": row["role_name"], "permissions": dict(row["permissions"] or {})},
        f'Role "{role_name}" created.',
    )


@rpc_method("updateCustomRole", mutation=True, roles=frozenset({"admin"}))
@database.transactional
def update_custom_role(conn, cur, role_key, role_name, permissions):
    role_key = str(role_key or "").strip()
    role_name = str(role_name or "").strip()
    if not role_key or not role_name:
        raise ValueError("Role key and role name are required.")

    cleaned_permissions = _validate_permissions(permissions)

    cur.execute("SELECT role_key FROM custom_roles WHERE role_key = %s", (role_key,))
    if cur.fetchone() is None:
        raise ValueError("Role not found.")

    cur.execute(
        "UPDATE custom_roles SET role_name = %s, permissions = %s, updated_at = NOW() WHERE role_key = %s",
        (role_name, psycopg2.extras.Json(cleaned_permissions), role_key),
    )
    return build_response(True, None, f'Role "{role_name}" updated.')


@rpc_method("deleteCustomRole", mutation=True, roles=frozenset({"admin"}))
@database.transactional
def delete_custom_role(conn, cur, role_key):
    role_key = str(role_key or "").strip()

    cur.execute("SELECT role_name FROM custom_roles WHERE role_key = %s", (role_key,))
    row = cur.fetchone()
    if row is None:
        raise ValueError("Role not found.")

    cur.execute("SELECT COUNT(*) AS n FROM users WHERE role = %s AND deleted_at IS NULL", (role_key,))
    in_use = cur.fetchone()["n"]
    if in_use > 0:
        raise ValueError(
            f'"{row["role_name"]}" is still assigned to {in_use} user(s). '
            "Reassign them to a different role first."
        )

    cur.execute("DELETE FROM custom_roles WHERE role_key = %s", (role_key,))
    return build_response(True, None, f'Role "{row["role_name"]}" deleted.')
