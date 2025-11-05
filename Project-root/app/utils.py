from __future__ import annotations

from functools import wraps

import database
import psycopg2.extras
from flask import current_app
from flask_login import current_user
from psycopg2 import sql


def role_required(*allowed_roles):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                from flask import jsonify

                return jsonify({"error": "Authentication required"}), 401
            if current_user.role == "super_admin":
                return f(*args, **kwargs)
            if current_user.role not in allowed_roles:
                from flask import jsonify

                return jsonify({"error": "Insufficient permissions"}), 403
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

    email = user_info.get("email")
    name = user_info.get("name")
    picture = user_info.get("picture")
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            conn,
            cur,
        ):
            cur.execute("SELECT * FROM users WHERE email = %s", (email,))
            user_row = cur.fetchone()
            if user_row:
                return User(user_row), False
            cur.execute(
                "INSERT INTO users (name, email, role, profile_picture) VALUES (%s, %s, %s, %s) RETURNING *",
                (name, email, "pending_approval", picture),
            )
            new_user_row = cur.fetchone()
            conn.commit()
            return User(new_user_row), True
    except Exception as e:
        current_app.logger.error(f"Error in get_or_create_user: {e}")
        return None, False


def get_or_create_master_id(cur, value, table_name, id_col, name_col):
    value = str(value).strip()
    if not value:
        value = "--"
    select_query = sql.SQL("SELECT {} FROM {} WHERE {} = %s").format(
        sql.Identifier(id_col), sql.Identifier(table_name), sql.Identifier(name_col)
    )
    cur.execute(select_query, (value,))
    row = cur.fetchone()
    if row:
        return row[0]
    insert_query = sql.SQL("INSERT INTO {} ({}) VALUES (%s) RETURNING {}").format(
        sql.Identifier(table_name), sql.Identifier(name_col), sql.Identifier(id_col)
    )
    cur.execute(insert_query, (value,))
    return cur.fetchone()[0]


def get_or_create_item_master_id(cur, name, model, variation, description):
    model_id = get_or_create_master_id(
        cur, model, "model_master", "model_id", "model_name"
    )
    variation_id = get_or_create_master_id(
        cur, variation, "variation_master", "variation_id", "variation_name"
    )
    cur.execute(
        "SELECT item_id FROM item_master WHERE name=%s AND model_id=%s AND variation_id=%s AND COALESCE(description,'')=%s",
        (name, model_id, variation_id, description or ""),
    )
    row = cur.fetchone()
    if row:
        return row[0]
    cur.execute(
        "INSERT INTO item_master(name, model_id, variation_id, description) VALUES(%s,%s,%s,%s) RETURNING item_id",
        (name, model_id, variation_id, description),
    )
    return cur.fetchone()[0]
