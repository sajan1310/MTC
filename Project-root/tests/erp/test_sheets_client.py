"""Tests for scripts/migration/sheets_client.py, the Google API helpers the
one-time Sheets import and the Drive upload still use.

Moved here from test_gas_sheet_mirror.py when the nightly Sheets export and the
Apps Script mirror were retired (2026-11-24). No network: a client is built
from the discovery document the library ships, and nothing is executed.
"""

import os
import sys
from unittest.mock import MagicMock

import pytest

_MIGRATION_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../scripts/migration")
)
if _MIGRATION_DIR not in sys.path:
    sys.path.insert(0, _MIGRATION_DIR)

import sheets_client  # noqa: E402


# ─────────────────────────────────────────────────────────────────────────
# Which answers from Google are worth asking again
# ─────────────────────────────────────────────────────────────────────────


def _answers_then_succeeds(status):
    """A Sheets call that gets `status` back from Google once, then works."""
    from googleapiclient.errors import HttpError

    calls = []

    def call():
        calls.append(status)
        if len(calls) == 1:
            raise HttpError(MagicMock(status=status, reason="from Google"), b"")
        return "written"

    return call, calls


def test_a_bad_gateway_from_google_is_retried(monkeypatch):
    """2026-09-30: one 502 on the ninth of 46 tabs failed a whole export.
    Google's own page for it says to try again in 30 seconds; the retry list
    said 429, 500 and 503, and with_retry gave up on the spot."""
    monkeypatch.setattr(sheets_client.time, "sleep", lambda _seconds: None)

    for status in (502, 504):
        call, calls = _answers_then_succeeds(status)

        assert sheets_client.with_retry(call) == "written"
        assert len(calls) == 2


def test_a_request_google_refuses_is_not_retried(monkeypatch):
    """The other edge. A 403 is as wrong the sixth time as the first, and
    retrying it turns an immediate answer into a minute and a half of
    waiting for the same one."""
    from googleapiclient.errors import HttpError

    monkeypatch.setattr(sheets_client.time, "sleep", lambda _seconds: None)
    call, calls = _answers_then_succeeds(403)

    with pytest.raises(HttpError):
        sheets_client.with_retry(call)

    assert len(calls) == 1


# ─────────────────────────────────────────────────────────────────────────
# One resource per client, not one per call
# ─────────────────────────────────────────────────────────────────────────


def _offline_client(api, version):
    from google.auth.credentials import AnonymousCredentials
    from googleapiclient.discovery import build

    return build(
        api, version, credentials=AnonymousCredentials(), cache_discovery=False
    )


def _a_read(client):
    """The request fetch_sheet_values builds, never sent."""
    return (
        client.spreadsheets()
        .values()
        .get(spreadsheetId="sheet-id", range="'Items'!A:ZZ")
    )


def test_a_client_hands_back_the_same_resource_every_time():
    sheets = sheets_client.reuse_resources(_offline_client("sheets", "v4"))
    drive = sheets_client.reuse_resources(_offline_client("drive", "v3"))

    assert sheets.spreadsheets() is sheets.spreadsheets()
    assert sheets.spreadsheets().values() is sheets.spreadsheets().values()
    assert drive.files() is drive.files()


def test_a_reused_resource_builds_the_same_request():
    """Sharing the resource must change nothing Google is sent."""
    plain = _a_read(_offline_client("sheets", "v4"))
    reused = _a_read(sheets_client.reuse_resources(_offline_client("sheets", "v4")))

    assert reused.uri == plain.uri
    assert reused.method == plain.method == "GET"


def test_a_call_leaves_no_garbage_for_the_collector():
    """2026-11-08 to 2026-11-14: every Sheets export left about 3 GB in the
    web worker that ran it. Each `client.spreadsheets()` builds the whole
    resource again -- 19 MB held in reference cycles, some 300 objects -- and
    Python 3.14's collector freed none of it.

    Counted with the collector off, so the answer does not depend on which
    collector the interpreter has: what is left for it is what would pile up.
    """
    import gc

    client = sheets_client.reuse_resources(_offline_client("sheets", "v4"))
    _a_read(client)
    gc.collect()
    was_enabled = gc.isenabled()
    gc.disable()
    try:
        for _ in range(40):
            _a_read(client)
        left_for_the_collector = gc.collect()
    finally:
        if was_enabled:
            gc.enable()

    # Unshared, the same 40 calls leave about 12,000 objects.
    assert left_for_the_collector < 400


def test_a_stand_in_client_is_left_as_it_is():
    """Tests pass their own stand-ins; anything without these resources is
    handed back untouched."""

    class Bare:
        pass

    bare = Bare()
    assert sheets_client.reuse_resources(bare) is bare
    assert not hasattr(bare, "spreadsheets")
