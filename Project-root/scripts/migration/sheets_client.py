"""Google Sheets/Drive API helpers for migrate_sheets_to_pg.py (the one-time
import from the old Apps Script spreadsheets) and app/erp/services/
drive_backup.py.

The nightly export of every table into a spreadsheet, and the mirror into the
Apps Script app's sheets, used the write helpers that lived here too; both
were retired on 2026-11-24, and their helpers with them.

Auth: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON key path.
The service account must have the source spreadsheet shared with it (Viewer).
"""

from __future__ import annotations

import os
import time

READ_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"]


def _credentials(scopes: list[str]):
    from google.oauth2 import service_account

    key_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not key_path:
        raise RuntimeError(
            "GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a service "
            "account JSON key with access to the target spreadsheet(s)."
        )
    return service_account.Credentials.from_service_account_file(
        key_path, scopes=scopes
    )


# The resources a client is asked for on every call, in the order they nest:
# sheets.spreadsheets().values() and drive.files().
_REUSED_RESOURCES = ("spreadsheets", "values", "files")


def reuse_resources(service):
    """Make `service.spreadsheets()`, its `.values()` and `service.files()`
    hand back one object each, built once, instead of a new one per call.

    google-api-python-client builds a resource from the discovery document
    every time it is asked for one: every method of it, each with its
    documentation pretty-printed from the request and response schemas.
    For Sheets that is 19 MB a time (measured, 2.126.0), held together by
    reference cycles, so only the cycle collector can free it.

    Python 3.14's incremental collector paces itself by object count, and
    this garbage is a few hundred objects holding megabytes of text: on the
    server (3.14.4) it freed none of it, so each nightly Sheets export left
    about 3 GB in the gunicorn worker that ran it (2026-11-08 to 2026-11-14:
    every afternoon of 20-60 s replies). That export is gone, but anything
    that still calls Google from inside the app would do the same.

    A resource is only a factory for requests and carries no state between
    them, so sharing it changes nothing a caller can see. Built once, a call
    costs 0.06 MB.
    """

    def _pin(owner, name):
        make = getattr(owner, name, None)
        if not callable(make):
            return None
        resource = make()
        setattr(owner, name, lambda: resource)
        return resource

    for name in _REUSED_RESOURCES:
        resource = _pin(service, name)
        if resource is not None:
            for child in _REUSED_RESOURCES:
                _pin(resource, child)
    return service


def sheets_read_client():
    from googleapiclient.discovery import build

    return reuse_resources(
        build(
            "sheets", "v4", credentials=_credentials(READ_SCOPES), cache_discovery=False
        )
    )


def drive_client():
    from googleapiclient.discovery import build

    return reuse_resources(
        build(
            "drive", "v3", credentials=_credentials(DRIVE_SCOPES), cache_discovery=False
        )
    )


def with_retry(fn, *, attempts=6, base_delay=1.5):
    """Retry a Sheets/Drive API call with exponential backoff on quota errors
    AND on transient network failures (read timeouts, connection resets) --
    the underlying httplib2/socket layer raises plain TimeoutError/OSError
    for those, not HttpError, and a flaky connection on a Windows dev
    machine hits this path in practice, not just in theory."""
    import socket

    from googleapiclient.errors import HttpError

    last_exc = None
    for attempt in range(attempts):
        try:
            return fn()
        except HttpError as exc:
            last_exc = exc
            # 502 and 504 are Google's front end failing to reach the Sheets
            # backend -- "try again in 30 seconds", in its own words. They
            # were missing from this list, so on 2026-09-30 a single 502 on
            # the ninth of 46 tabs failed a whole export at once.
            if exc.resp.status not in (429, 500, 502, 503, 504):
                raise
        except (TimeoutError, ConnectionError, socket.timeout, OSError) as exc:
            last_exc = exc
        # No sleep after the final attempt -- there is nothing left to wait
        # for. With attempts=6 and base_delay=1.5 the last backoff is 48s.
        if attempt == attempts - 1:
            break
        time.sleep(base_delay * (2**attempt))
    assert last_exc is not None
    raise last_exc


def fetch_sheet_values(client, spreadsheet_id: str, sheet_name: str) -> list[list[str]]:
    """Fetch every populated cell of `sheet_name`. Returns raw rows (list of
    list of str), 1-indexed row N is result[N-1]. Short rows are NOT padded --
    callers must index defensively."""

    def _call():
        return (
            client.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=f"'{sheet_name}'!A:ZZ")
            .execute()
        )

    result = with_retry(_call)
    return result.get("values", [])
