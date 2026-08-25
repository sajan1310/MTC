from __future__ import annotations

from functools import wraps

import database
import psycopg2.extras
from flask import current_app
from flask_login import current_user


def role_required(*allowed_roles):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                from flask import jsonify

                return (
                    jsonify(
                        {
                            "success": False,
                            "data": {},
                            "error": "unauthenticated",
                            "message": "Authentication required",
                        }
                    ),
                    401,
                )
            if current_user.role == "super_admin":
                return f(*args, **kwargs)
            if current_user.role not in allowed_roles:
                from flask import jsonify

                return (
                    jsonify(
                        {
                            "success": False,
                            "data": {},
                            "error": "forbidden",
                            "message": "Insufficient permissions",
                        }
                    ),
                    403,
                )
            return f(*args, **kwargs)

        return decorated_function

    return decorator


def allowed_file(filename: str) -> bool:
    return (
        "." in filename
        and filename.rsplit(".", 1)[1].lower()
        in current_app.config["ALLOWED_EXTENSIONS"]
    )


# Legacy validate_upload removed - now using app.utils.file_validation.validate_upload
# This function is deprecated and should not be used


def get_or_create_user(user_info):
    """Create user on first OAuth login or return existing.
    Returns (User, is_new: bool)
    """
    from .models import User

    # Imported here, not at module scope: app.auth.routes imports from the app
    # package, which imports this module, so a top-level import would be
    # circular. Shared so the Google path and the password path can never
    # again disagree about what role a brand-new account gets (SEC-002).
    from .auth.routes import NEW_ACCOUNT_ROLE

    # Lowercased, like every other write path (api_signup,
    # users_service.create_user). Google returns lowercase for Gmail but makes
    # no such promise for other domains, and a mixed-case row here would be a
    # row nothing else could find -- see AUTH-001 and migration 039.
    email = (user_info.get("email") or "").strip().lower()
    name = user_info.get("name")
    picture = user_info.get("picture")
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            conn,
            cur,
        ):
            # Selected WITHOUT a deleted_at filter, then checked below.
            #
            # Filtering in the WHERE clause looks like the obvious fix for
            # FN-08, but it is wrong here: users.email is UNIQUE, so a
            # soft-deleted row would be invisible to the SELECT and then
            # collide on the INSERT, turning "your account was deactivated"
            # into an IntegrityError and a 500. Fetch the row either way and
            # decide explicitly.
            # lower(email): matches any legacy row stored with capitals as
            # well as the canonical form. Backed by the unique index in
            # migration 039, so this can never match more than one row.
            cur.execute("SELECT * FROM users WHERE lower(email) = %s", (email,))
            user_row = cur.fetchone()
            if user_row:
                if user_row.get("deleted_at") is not None:
                    # Deactivated (users_service.deactivateUser). Previously
                    # this path let login_user() succeed, and then load_user()
                    # -- which DOES filter deleted_at -- returned None on the
                    # very next request and bounced the user back to the login
                    # page, over and over, with nothing anywhere explaining
                    # why. Deactivation now means the same thing on all four
                    # paths: password login, Google login, password reset and
                    # session loading.
                    current_app.logger.info(
                        "[OAuth] Sign-in refused for deactivated account %s", email
                    )
                    return None, False
                return User(user_row), False
            cur.execute(
                "INSERT INTO users (name, email, role, profile_picture) VALUES (%s, %s, %s, %s) RETURNING *",
                (name, email, NEW_ACCOUNT_ROLE, picture),
            )
            new_user_row = cur.fetchone()
            # Note: get_conn() context manager commits on successful exit
            return User(new_user_row), True
    except Exception as e:
        current_app.logger.error(f"Error in get_or_create_user: {e}")
        return None, False
