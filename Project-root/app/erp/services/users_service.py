"""User management -- the admin-facing surface for the `role`/`deleted_at`
columns on `users` (created by migrations/erp/000_public_core.sql) that had
no UI and no RPC methods reading or writing them. Every method here is
role-gated via RpcSpec.roles (registry.py) rather than left open like the
rest of the RPC surface -- this is deliberately the first (and, for now,
only) consumer of that mechanism; see rpc.py's enforcement.

Role model: kept to the three values already used elsewhere rather than
introducing a taxonomy nothing else in the codebase expects yet --
"user" (default for password signup), "admin" (superuser, User.has_role()),
and "pending_approval" (app/utils.py's get_or_create_user default for a
brand-new Google OAuth signup). That third one existed before this file did
but was never enforced anywhere and had no admin surface to move a user out
of it -- see rpc.py's blanket pending_approval gate and this module's
update_user_role, which together are what actually close that gap.

A fourth value, "super_admin", exists above these three (assigned directly
in the database, not through this file's ROLES/CREATE_ROLES -- see
User.has_role()/is_admin in app/models/user.py) and is a strict superset of
admin everywhere EXCEPT one place: only a super_admin can hand out the
"admin" role itself (both here in create_user and in update_user_role),
so an ordinary admin can't mint unlimited peer admins with nothing above
them to revoke it.

A fifth kind of value -- an admin/super_admin-defined custom role (see
roles_service.py, is_valid_custom_role) -- is also accepted here alongside
the fixed ROLES/CREATE_ROLES tuples. Unlike admin/super_admin, a custom
role is never a superuser wildcard: it only grants whatever specific
per-tab access level its own permissions map says (enforced in
app/erp/rpc.py, not here), and can never be usersTab/admin-equivalent.
"""

from __future__ import annotations

import re

import psycopg2.extras

import database
from .current_user import get_current_user_id, get_current_user_role
from .roles_service import is_valid_custom_role
from ..envelope import build_response
from ..registry import rpc_method

ROLES = ("pending_approval", "user", "admin")

# Roles createUser can hand out directly (no pending_approval -- that state
# is for an organic self-signup awaiting review; a user an admin/super_admin
# proactively created is already vetted by virtue of who created them).
CREATE_ROLES = ("user", "admin")

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def _row_to_user_record(row) -> dict:
    return {
        "id": row["user_id"],
        "name": row["name"] or "",
        "email": row["email"] or "",
        "role": row["role"] or "user",
        "company": row["company"] or "",
        "mobile": row["mobile"] or "",
        "active": row["deleted_at"] is None,
        "createdAt": row["created_at"].isoformat() if row["created_at"] else None,
    }


@rpc_method("getUsersData", roles=frozenset({"admin"}))
def get_users_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT user_id, name, email, role, company, mobile, created_at, deleted_at
            FROM users
            ORDER BY deleted_at IS NOT NULL, lower(name)
            """
        )
        rows = cur.fetchall()
    return build_response(True, [_row_to_user_record(r) for r in rows])


# Mirrors auth/routes.py's api_signup validation (name/email/password/confirm,
# email uniqueness, password strength, werkzeug hash) -- this is the same
# account-creation shape, just admin/super_admin-initiated instead of a
# self-signup, and without the login_user/session step since the new
# account isn't the caller's own.
@rpc_method("createUser", mutation=True, roles=frozenset({"admin"}))
@database.transactional
def create_user(conn, cur, name, email, password, confirm_password, role):
    name = str(name or "").strip()
    email = str(email or "").strip().lower()
    password = str(password or "")
    confirm_password = str(confirm_password or "")
    role = str(role or "").strip().lower()

    if not name or not email or not password or not confirm_password:
        raise ValueError("Name, email, password, and confirm password are all required.")
    if not _EMAIL_RE.match(email):
        raise ValueError("Please enter a valid email address.")
    if password != confirm_password:
        raise ValueError("Passwords do not match.")

    from ... import validate_password

    ok, msg = validate_password(password)
    if not ok:
        raise ValueError(msg)

    if role not in CREATE_ROLES and not is_valid_custom_role(role, cur):
        raise ValueError(f"Invalid role \"{role}\". Must be one of: {', '.join(CREATE_ROLES)}, or a custom role.")
    # Same rule as update_user_role: only a Super Admin can hand out Admin.
    if role == "admin" and get_current_user_role() != "super_admin":
        raise ValueError("Only a Super Admin can create a user with the Admin role.")

    # lower(email) (AUTH-001): identity is case-insensitive.
    cur.execute("SELECT user_id FROM users WHERE lower(email) = %s", (email,))
    if cur.fetchone():
        raise ValueError("An account with this email already exists.")

    from werkzeug.security import generate_password_hash

    password_hash = generate_password_hash(password)
    cur.execute(
        "INSERT INTO users (name, email, role, password_hash) VALUES (%s, %s, %s, %s) "
        "RETURNING user_id, name, email, role, company, mobile, created_at, deleted_at",
        (name, email, role, password_hash),
    )
    row = cur.fetchone()
    return build_response(True, _row_to_user_record(row), f'"{name}" created as {role}.')


@rpc_method("updateUserRole", mutation=True, roles=frozenset({"admin"}))
@database.transactional
def update_user_role(conn, cur, user_id, role):
    user_id = int(user_id)
    role = str(role or "").strip().lower()
    if role not in ROLES and not is_valid_custom_role(role, cur):
        raise ValueError(f"Invalid role \"{role}\". Must be one of: {', '.join(ROLES)}, or a custom role.")

    # Creating new admins is a Super Admin-only power -- an ordinary admin
    # could otherwise mint an unlimited number of peer admins with no one
    # above them to revoke it. This is the promotion-direction half of that
    # rule; the symmetric demotion-direction half (touching an EXISTING
    # admin's role at all) needs the target's current role, so it's checked
    # below once that's fetched -- an ordinary admin could otherwise strip
    # every other admin's access unchecked, which is just the same "no one
    # above them" problem from the other direction.
    if role == "admin" and get_current_user_role() != "super_admin":
        raise ValueError("Only a Super Admin can promote a user to Admin.")

    if user_id == get_current_user_id():
        # A lone admin demoting themselves would leave nobody able to manage
        # users at all (nothing here re-promotes from outside the app) --
        # simplest safe rule is to just disallow changing your own role,
        # not just the admin -> non-admin direction.
        raise ValueError("You cannot change your own role. Ask another admin.")

    cur.execute("SELECT user_id, name, role FROM users WHERE user_id = %s AND deleted_at IS NULL", (user_id,))
    row = cur.fetchone()
    if row is None:
        raise ValueError("User not found or already deactivated.")

    if row["role"] in ("admin", "super_admin") and get_current_user_role() != "super_admin":
        raise ValueError("Only a Super Admin can change another Admin's role.")

    cur.execute("UPDATE users SET role = %s, updated_at = NOW() WHERE user_id = %s", (role, user_id))
    return build_response(True, None, f'"{row["name"]}" is now {role}.')


@rpc_method("deactivateUser", mutation=True, roles=frozenset({"admin"}))
@database.transactional
def deactivate_user(conn, cur, user_id):
    user_id = int(user_id)
    if user_id == get_current_user_id():
        raise ValueError("You cannot deactivate your own account.")

    cur.execute(
        "SELECT user_id, name FROM users WHERE user_id = %s AND deleted_at IS NULL",
        (user_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("User not found or already deactivated.")

    # Soft delete, same convention as every other entity in this app
    # (erp.*'s deleted_at) -- the row and its history (updated_by
    # references on items/POs/etc.) stay intact.
    cur.execute("UPDATE users SET deleted_at = NOW(), updated_at = NOW() WHERE user_id = %s", (user_id,))
    return build_response(True, None, f'"{row["name"]}" deactivated. They can no longer sign in.')


@rpc_method("reactivateUser", mutation=True, roles=frozenset({"admin"}))
@database.transactional
def reactivate_user(conn, cur, user_id):
    user_id = int(user_id)
    cur.execute(
        "SELECT user_id, name FROM users WHERE user_id = %s AND deleted_at IS NOT NULL",
        (user_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("User not found or already active.")

    cur.execute("UPDATE users SET deleted_at = NULL, updated_at = NOW() WHERE user_id = %s", (user_id,))
    return build_response(True, None, f'"{row["name"]}" reactivated.')
