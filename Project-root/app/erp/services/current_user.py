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
