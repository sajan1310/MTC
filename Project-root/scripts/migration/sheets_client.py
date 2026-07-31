"""Google Sheets/Drive API helpers shared by migrate_sheets_to_pg.py and
backup_db_to_sheets.py.

Auth: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON key path.
The service account must have the target spreadsheet(s) shared with it
(Viewer for migration reads, Editor for backup writes) and the Drive API
enabled if backup_db_to_sheets.py is creating new spreadsheets.
"""

from __future__ import annotations

import os
import time

READ_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
WRITE_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def _credentials(scopes: list[str]):
    from google.oauth2 import service_account

    key_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not key_path:
        raise RuntimeError(
            "GOOGLE_APPLICATION_CREDENTIALS is not set. Point it at a service "
            "account JSON key with access to the target spreadsheet(s)."
        )
    return service_account.Credentials.from_service_account_file(key_path, scopes=scopes)


def sheets_read_client():
    from googleapiclient.discovery import build

    return build("sheets", "v4", credentials=_credentials(READ_SCOPES), cache_discovery=False)


def sheets_write_client():
    from googleapiclient.discovery import build

    return build("sheets", "v4", credentials=_credentials(WRITE_SCOPES), cache_discovery=False)


def drive_client():
    from googleapiclient.discovery import build

    return build("drive", "v3", credentials=_credentials(WRITE_SCOPES), cache_discovery=False)


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
            if exc.resp.status not in (429, 500, 503):
                raise
        except (TimeoutError, ConnectionError, socket.timeout, OSError) as exc:
            last_exc = exc
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


def create_spreadsheet(client, drive, title: str, folder_id: str | None) -> str:
    body = {"properties": {"title": title}}
    spreadsheet = with_retry(
        lambda: client.spreadsheets().create(body=body, fields="spreadsheetId").execute()
    )
    spreadsheet_id = spreadsheet["spreadsheetId"]
    if folder_id:
        with_retry(
            lambda: drive.files()
            .update(fileId=spreadsheet_id, addParents=folder_id, fields="id, parents")
            .execute()
        )
    return spreadsheet_id


def add_sheet_tab(client, spreadsheet_id: str, title: str):
    body = {"requests": [{"addSheet": {"properties": {"title": title}}}]}
    with_retry(
        lambda: client.spreadsheets()
        .batchUpdate(spreadsheetId=spreadsheet_id, body=body)
        .execute()
    )


def write_values(client, spreadsheet_id: str, sheet_name: str, rows: list[list]):
    """Overwrite `sheet_name!A1` onward with `rows`. Chunked to stay under the
    Sheets API's per-request cell-count limits for very large tables."""
    chunk_size = 5000  # rows per request
    for start in range(0, len(rows), chunk_size) or [0]:
        chunk = rows[start : start + chunk_size]
        if not chunk:
            continue
        body = {"values": chunk}
        with_retry(
            lambda: client.spreadsheets()
            .values()
            .update(
                spreadsheetId=spreadsheet_id,
                range=f"'{sheet_name}'!A{start + 1}",
                valueInputOption="RAW",
                body=body,
            )
            .execute()
        )
