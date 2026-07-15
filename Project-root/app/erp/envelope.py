"""Response envelope, ported from Apps_Script/utils.js's buildResponse().

Kept byte-compatible with the Apps Script contract so the ported frontend
JS (Script_ApiCore.html's _apiCall and everything built on it) needs no
changes to how it reads {success, data, message}.
"""

from __future__ import annotations

from typing import Any


def build_response(success: bool, data: Any = None, message: str = "") -> dict:
    """{success: bool, data: data-or-None, message: str} -- mirrors buildResponse(true/false, data, message)."""
    return {
        "success": bool(success),
        "data": data if success else None,
        "message": str(message or "").strip(),
    }
