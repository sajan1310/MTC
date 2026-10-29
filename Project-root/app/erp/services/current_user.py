"""Shared helper for stamping `updated_by` on mutations."""

from __future__ import annotations

from flask_login import current_user


def get_current_user_id() -> int | None:
    try:
        return int(current_user.get_id())
    except Exception:
        return None


def get_current_user_email() -> str:
    try:
        return str(getattr(current_user, "email", "") or "")
    except Exception:
        return ""


def get_current_user_role() -> str:
    try:
        return str(getattr(current_user, "role", "") or "")
    except Exception:
        return ""


def get_current_user_name() -> str:
    """The name to record beside an action, falling back to the email."""
    try:
        name = str(getattr(current_user, "name", "") or "").strip()
    except Exception:
        name = ""
    return name or get_current_user_email()
