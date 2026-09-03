"""Self-service account management -- lets ANY authenticated user view/edit
their OWN name, email, and password. Unlike users_service.py (the admin-
facing surface for OTHER users' role/deleted_at, role-gated via
RpcSpec.roles), nothing here is role-gated: every method operates strictly
on get_current_user_id()'s own row and never accepts a target user_id from
the client, so there's no privilege boundary to enforce beyond "must be
logged in" (already covered by @login_required in rpc.py).
"""

from __future__ import annotations

import re

import database
from .current_user import get_current_user_id
from ..envelope import build_response
from ..registry import rpc_method

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


@rpc_method("updateMyProfile", mutation=True)
@database.transactional
def update_my_profile(conn, cur, name, email):
    user_id = get_current_user_id()
    if user_id is None:
        raise ValueError("Not authenticated.")

    name = str(name or "").strip()
    email = str(email or "").strip().lower()
    if not name or not email:
        raise ValueError("Name and email are required.")
    if not _EMAIL_RE.match(email):
        raise ValueError("Please enter a valid email address.")

    # lower(email) (AUTH-001): identity is case-insensitive.
    cur.execute(
        "SELECT user_id FROM users WHERE lower(email) = %s AND user_id != %s",
        (email, user_id),
    )
    if cur.fetchone():
        raise ValueError("An account with this email already exists.")

    cur.execute(
        "UPDATE users SET name = %s, email = %s, updated_at = NOW() WHERE user_id = %s "
        "RETURNING user_id, name, email, role",
        (name, email, user_id),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("User not found.")
    return build_response(
        True,
        {
            "id": row["user_id"],
            "name": row["name"],
            "email": row["email"],
            "role": row["role"],
        },
        "Profile updated.",
    )


@rpc_method("changeMyPassword", mutation=True)
@database.transactional
def change_my_password(conn, cur, current_password, new_password, confirm_password):
    user_id = get_current_user_id()
    if user_id is None:
        raise ValueError("Not authenticated.")

    current_password = str(current_password or "")
    new_password = str(new_password or "")
    confirm_password = str(confirm_password or "")

    if new_password != confirm_password:
        raise ValueError("New passwords do not match.")

    from ... import validate_password

    ok, msg = validate_password(new_password)
    if not ok:
        raise ValueError(msg)

    cur.execute("SELECT password_hash FROM users WHERE user_id = %s", (user_id,))
    row = cur.fetchone()
    if row is None:
        raise ValueError("User not found.")

    from werkzeug.security import check_password_hash, generate_password_hash

    # A Google OAuth-only account has no password_hash yet -- let them set
    # one for the first time without proving a "current" password that was
    # never set. Anyone who already has one must prove it first.
    existing_hash = row["password_hash"]
    if existing_hash:
        if not current_password:
            raise ValueError("Enter your current password.")
        if not check_password_hash(existing_hash, current_password):
            raise ValueError("Current password is incorrect.")

    cur.execute(
        "UPDATE users SET password_hash = %s, updated_at = NOW() WHERE user_id = %s",
        (generate_password_hash(new_password), user_id),
    )
    return build_response(True, None, "Password updated.")
