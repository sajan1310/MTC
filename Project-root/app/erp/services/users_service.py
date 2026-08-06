"""User management -- the admin-facing surface for the `role`/`deleted_at`
columns that already existed on `users` (migrations/init_schema.sql) but had
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
"""

from __future__ import annotations

import psycopg2.extras

import database
from .current_user import get_current_user_id
from ..envelope import build_response
from ..registry import rpc_method

ROLES = ("pending_approval", "user", "admin")


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


@rpc_method("updateUserRole", mutation=True, roles=frozenset({"admin"}))
@database.transactional
def update_user_role(conn, cur, user_id, role):
    user_id = int(user_id)
    role = str(role or "").strip().lower()
    if role not in ROLES:
        raise ValueError(f"Invalid role \"{role}\". Must be one of: {', '.join(ROLES)}.")

    if user_id == get_current_user_id():
        # A lone admin demoting themselves would leave nobody able to manage
        # users at all (nothing here re-promotes from outside the app) --
        # simplest safe rule is to just disallow changing your own role,
        # not just the admin -> non-admin direction.
        raise ValueError("You cannot change your own role. Ask another admin.")

    cur.execute("SELECT user_id, name FROM users WHERE user_id = %s AND deleted_at IS NULL", (user_id,))
    row = cur.fetchone()
    if row is None:
        raise ValueError("User not found or already deactivated.")

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
