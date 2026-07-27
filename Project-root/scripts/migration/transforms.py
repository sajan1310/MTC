"""Cell -> Python value coercion for the Sheets -> Postgres migration.

Kept intentionally dumb: sheet cells are always strings (or missing); each
`type` in mapping.yaml maps to exactly one parser here. Anything that fails
to parse raises ValueError with enough context for the dry-run report to
name the offending row/column rather than a bare traceback.
"""

from __future__ import annotations

import datetime
import json
import re

_TRUE_STRINGS = {"true", "yes", "y", "1", "checked", "✓"}
_FALSE_STRINGS = {"false", "no", "n", "0", "", "unchecked"}

_DATE_FORMATS = (
    "%d/%m/%Y",  # DATE_FORMATS.DISPLAY (dd/mm/yyyy) -- config_maps.py's own convention
    "%Y-%m-%d",  # DATE_FORMATS.ISO
    "%m/%d/%Y",  # Sheets' own locale-dependent serial-to-string rendering, if it slips through
)

_CURRENCY_STRIP_RE = re.compile(r"[₹$,\s]")


def coerce(raw: str | None, type_: str, *, default=None):
    """raw is the exact cell string (or None if the row was shorter than the
    column index). Empty string and None both mean "absent" and fall back to
    `default` (itself None unless the mapping entry declares one)."""
    if raw is None or raw.strip() == "":
        return default

    raw = raw.strip()

    if type_ == "text":
        return raw
    if type_ == "numeric":
        return _to_number(raw)
    if type_ == "integer":
        return int(_to_number(raw))
    if type_ == "boolean":
        return _to_bool(raw)
    if type_ == "date":
        return _to_date(raw)
    if type_ == "json":
        return _to_json(raw)
    raise ValueError(f"Unknown column type {type_!r} in mapping.yaml")


def _to_number(raw: str) -> float:
    cleaned = _CURRENCY_STRIP_RE.sub("", raw)
    try:
        return float(cleaned)
    except ValueError as exc:
        raise ValueError(f"Cannot parse {raw!r} as a number") from exc


def _to_bool(raw: str) -> bool:
    lowered = raw.strip().lower()
    if lowered in _TRUE_STRINGS:
        return True
    if lowered in _FALSE_STRINGS:
        return False
    raise ValueError(f"Cannot parse {raw!r} as a boolean")


def _to_date(raw: str) -> datetime.date:
    for fmt in _DATE_FORMATS:
        try:
            return datetime.datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Cannot parse {raw!r} as a date (tried {_DATE_FORMATS})")


def _to_json(raw: str):
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError(f"Cannot parse {raw!r} as JSON") from exc
