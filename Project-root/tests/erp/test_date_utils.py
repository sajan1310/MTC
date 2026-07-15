"""Date parsing tests, ported behavior from Apps_Script/utils.js's
_parseDateParts/_validDateParts/toSafeDateObject.
"""

from __future__ import annotations

from datetime import date, datetime

from app.erp.date_utils import parse_date_parts, to_safe_date


def test_parses_iso_format():
    assert parse_date_parts("2026-07-15") == (2026, 7, 15)


def test_parses_display_slash_format():
    assert parse_date_parts("15/07/2026") == (2026, 7, 15)


def test_parses_display_dash_format():
    assert parse_date_parts("15-07-2026") == (2026, 7, 15)


def test_parses_display_dot_format():
    assert parse_date_parts("15.07.2026") == (2026, 7, 15)


def test_rejects_invalid_calendar_date():
    assert parse_date_parts("30/02/2026") is None  # Feb 30 doesn't exist


def test_rejects_garbage_string():
    assert parse_date_parts("not a date") is None


def test_rejects_none_and_empty():
    assert parse_date_parts(None) is None
    assert parse_date_parts("") is None


def test_date_object_passthrough():
    assert parse_date_parts(date(2026, 7, 15)) == (2026, 7, 15)


def test_datetime_object_passthrough():
    assert parse_date_parts(datetime(2026, 7, 15, 10, 30)) == (2026, 7, 15)


def test_to_safe_date_returns_date_object():
    assert to_safe_date("15/07/2026") == date(2026, 7, 15)


def test_to_safe_date_returns_none_for_invalid():
    assert to_safe_date("garbage") is None
