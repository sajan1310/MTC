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

# CONFIRMED against the live sheet by scanning every date column for
# unambiguous evidence (a "13" or higher in one position proves which side
# is the day): PO Tracker, Bill Ledger, Return Ledger, Issued Stock Log,
# Production, and Rate History are ALL m/d/yyyy (zero d/m evidence anywhere
# in any of them) -- this is Apps Script/Sheets' own auto-rendered US-locale
# date string, not config_maps.py's documented DD/MM/YYYY *display*
# convention (that convention is what the app shows humans in the UI, not
# what's literally stored in these particular cells). The one confirmed
# exception is Warehouse Pool Opening's manually-typed plain dates (zero m/d
# evidence there, 35 rows with day>12) -- that sheet gets date_style="dmy"
# explicitly in mapping.yaml. Trying the wrong order first is not just
# "usually fine" -- for any row where both day and month are <=12 it
# silently produces a DIFFERENT VALID DATE with no parse error, which is how
# this went undetected until a live-data cross-check caught it (636 rows
# across Bill/Rate History/Production/Return had day and month transposed
# on the first migration pass). Default is "mdy"; pass date_style="dmy" for
# the one confirmed exception.
_DATE_FORMATS = {
    "mdy": (
        "%m/%d/%Y",
        "%Y-%m-%d",
        "%m/%d/%Y %H:%M:%S",
        "%d/%m/%Y",
        "%d/%m/%Y %H:%M:%S",
    ),
    "dmy": (
        "%d/%m/%Y",
        "%Y-%m-%d",
        "%d/%m/%Y %H:%M:%S",
        "%m/%d/%Y",
        "%m/%d/%Y %H:%M:%S",
    ),
}

_CURRENCY_STRIP_RE = re.compile(r"[₹$,\s]")


def coerce(raw: str | None, type_: str, *, default=None, date_style: str = "mdy"):
    """raw is the exact cell string (or None if the row was shorter than the
    column index). Empty string and None both mean "absent" and fall back to
    `default` (itself None unless the mapping entry declares one).

    date_style only matters for type_="date": "mdy" (default) or "dmy" --
    see the _DATE_FORMATS comment for why the default isn't "dmy" despite
    that being config_maps.py's documented display convention."""
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
        return _to_date(raw, date_style)
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


def _to_date(raw: str, date_style: str) -> datetime.date:
    formats = _DATE_FORMATS[date_style]
    for fmt in formats:
        try:
            return datetime.datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    raise ValueError(
        f"Cannot parse {raw!r} as a date (style={date_style}, tried {formats})"
    )


def _to_json(raw: str):
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError(f"Cannot parse {raw!r} as JSON") from exc
