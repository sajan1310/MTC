"""DD/MM/YYYY-tolerant date parsing, ported from
Apps_Script/utils.js's _parseDateParts/_validDateParts/toSafeDateObject.

Every date-bearing module (Bill, PO, Return, Wastage, Issue, Production,
Client Orders, Dispatch) needs this, so it's ported once here rather than
per-module.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone

_ISO_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})")
_DISPLAY_RE = re.compile(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$")


def parse_date_parts(date_val) -> tuple[int, int, int] | None:
    """Returns (year, month, day) or None. Accepts date/datetime, a numeric
    epoch timestamp (seconds, or milliseconds if > 1e12), an ISO 'YYYY-MM-DD'
    string, or this app's DD/MM/YYYY | DD-MM-YYYY | DD.MM.YYYY display format.
    """
    if date_val is None or date_val == "":
        return None

    if isinstance(date_val, datetime):
        return (date_val.year, date_val.month, date_val.day)
    if isinstance(date_val, date):
        return (date_val.year, date_val.month, date_val.day)

    if isinstance(date_val, (int, float)):
        seconds = date_val / 1000 if date_val > 1_000_000_000_000 else date_val
        try:
            dt = datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (ValueError, OSError, OverflowError):
            return None
        return (dt.year, dt.month, dt.day)

    if not isinstance(date_val, str):
        return None
    s = date_val.strip()

    m = _ISO_RE.match(s)
    if m:
        return _valid_date_parts(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    m = _DISPLAY_RE.match(s)
    if m:
        return _valid_date_parts(int(m.group(3)), int(m.group(2)), int(m.group(1)))

    return None


def _valid_date_parts(year: int, month: int, day: int) -> tuple[int, int, int] | None:
    if not (1 <= month <= 12) or not (1 <= day <= 31):
        return None
    try:
        date(year, month, day)
    except ValueError:
        return None
    return (year, month, day)


def to_safe_date(date_val) -> date | None:
    parts = parse_date_parts(date_val)
    if not parts:
        return None
    return date(*parts)


def to_iso_string(date_val) -> str | None:
    """'YYYY-MM-DD' or None, ports _toSafeDateString."""
    parts = parse_date_parts(date_val)
    if not parts:
        return None
    year, month, day = parts
    return f"{year:04d}-{month:02d}-{day:02d}"


def to_display_string(date_val) -> str | None:
    """'DD/MM/YYYY' or None, ports _toDisplayDate."""
    parts = parse_date_parts(date_val)
    if not parts:
        return None
    year, month, day = parts
    return f"{day:02d}/{month:02d}/{year:04d}"
