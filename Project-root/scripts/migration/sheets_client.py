"""Google Sheets/Drive API helpers shared by migrate_sheets_to_pg.py and
backup_db_to_sheets.py.

Auth: set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON key path.
The service account must have the target spreadsheet(s) shared with it
(Viewer for migration reads, Editor for backup writes) and the Drive API
enabled if backup_db_to_sheets.py is creating new spreadsheets.
"""

from __future__ import annotations

import datetime
import decimal
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


def to_cell_value(value):
    """Coerce a Postgres row value into something the Sheets API will accept
    JSON-serialize cleanly: None -> '', dates/datetimes -> ISO string,
    dict/list (JSONB) -> JSON string, Decimal -> float, everything else
    passed through as-is. Shared by every script in this directory that
    writes Postgres data into Sheets, so there's one coercion implementation
    instead of several that can quietly drift apart."""
    if value is None:
        return ""
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    if isinstance(value, (dict, list)):
        import json

        return json.dumps(value, default=str)
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (int, float, str, bool)):
        return value
    return str(value)


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


def _reparent_into_folder(drive, spreadsheet_id: str, folder_id: str) -> None:
    with_retry(
        lambda: drive.files()
        .update(fileId=spreadsheet_id, addParents=folder_id, fields="id, parents", supportsAllDrives=True)
        .execute()
    )


def create_spreadsheet(client, drive, title: str, folder_id: str | None) -> str:
    body = {"name": title, "mimeType": "application/vnd.google-apps.spreadsheet"}
    if folder_id:
        body["parents"] = [folder_id]
    try:
        file_res = with_retry(
            lambda: drive.files().create(body=body, fields="id", supportsAllDrives=True).execute()
        )
        return file_res["id"]
    except Exception:
        # Fallback to Sheets API create if Drive API fails
        body_sheets = {"properties": {"title": title}}
        spreadsheet = with_retry(
            lambda: client.spreadsheets().create(body=body_sheets, fields="spreadsheetId").execute()
        )
        spreadsheet_id = spreadsheet["spreadsheetId"]
        if folder_id:
            _reparent_into_folder(drive, spreadsheet_id, folder_id)
        return spreadsheet_id



def add_sheet_tab(client, spreadsheet_id: str, title: str):
    body = {"requests": [{"addSheet": {"properties": {"title": title}}}]}
    with_retry(
        lambda: client.spreadsheets()
        .batchUpdate(spreadsheetId=spreadsheet_id, body=body)
        .execute()
    )


def clear_values(client, spreadsheet_id: str, sheet_name: str):
    """Clear all existing values from a sheet tab so old leftover columns/rows don't linger."""
    with_retry(
        lambda: client.spreadsheets()
        .values()
        .clear(spreadsheetId=spreadsheet_id, range=f"'{sheet_name}'")
        .execute()
    )


def clear_values_from_row(client, spreadsheet_id: str, sheet_name: str, start_row: int):
    """Clear values from `start_row` (1-indexed) to the end of the tab,
    leaving any header rows above it untouched. Unlike `clear_values`
    (which wipes the whole tab, headers included), this is for tabs whose
    header row(s) belong to a destination the caller doesn't own/create --
    e.g. mirroring into a spreadsheet another app's code already reads a
    fixed header layout from."""
    with_retry(
        lambda: client.spreadsheets()
        .values()
        .clear(spreadsheetId=spreadsheet_id, range=f"'{sheet_name}'!A{start_row}:ZZ")
        .execute()
    )


def write_values_from_row(
    client, spreadsheet_id: str, sheet_name: str, rows: list[list], start_row: int, fresh: bool = False
):
    """Like `write_values`, but anchored at `A{start_row}` instead of `A1`,
    and clears only from `start_row` onward (via `clear_values_from_row`)
    instead of the whole tab -- so existing header row(s) above `start_row`
    are preserved untouched."""
    if not rows:
        return

    required_rows = start_row - 1 + len(rows)
    required_cols = max(len(r) for r in rows) if rows else 1
    ensure_grid_size(client, spreadsheet_id, sheet_name, required_rows, required_cols)
    if not fresh:
        clear_values_from_row(client, spreadsheet_id, sheet_name, start_row)

    chunk_size = 5000  # rows per request

    for start in range(0, len(rows), chunk_size):
        chunk = rows[start : start + chunk_size]
        if not chunk:
            continue
        body = {"values": chunk}
        with_retry(
            lambda: client.spreadsheets()
            .values()
            .update(
                spreadsheetId=spreadsheet_id,
                range=f"'{sheet_name}'!A{start_row + start}",
                valueInputOption="RAW",
                body=body,
            )
            .execute()
        )


def _col_letter(n: int) -> str:
    """1-indexed column number -> A1-style letters (1 -> 'A', 27 -> 'AA')."""
    letters = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def write_date_columns_user_entered(
    client, spreadsheet_id: str, sheet_name: str, rows: list[list], start_row: int, date_cols: list[int]
):
    """Re-writes just `date_cols` (1-indexed column numbers already present
    in `rows`, holding to_cell_value()'s ISO 'YYYY-MM-DD' strings) using
    valueInputOption=USER_ENTERED, so Sheets parses each one into a real
    date-typed cell instead of leaving literal text behind.

    Why this needs a second, separate write: the bulk row write
    (write_values_from_row) uses RAW so that ordinary text/number columns
    -- item codes, phone numbers, anything that happens to look numeric --
    are stored exactly as given, with no auto-parsing that could mangle
    them (e.g. a leading zero silently dropped). USER_ENTERED gives that
    same auto-parsing to every cell in a request, not just date ones, so it
    can't be used for the whole row -- only for the columns that actually
    need it.

    ISO 'YYYY-MM-DD' is the one string format safe to hand to
    USER_ENTERED here: it's unambiguous regardless of the spreadsheet's
    locale, so it can't trigger the day/month swap utils.js's own
    _parseDateParts (in the GAS app) guards against for its own DD/MM/YYYY
    display strings.
    """
    if not rows or not date_cols:
        return

    chunk_size = 5000  # rows per request, matching write_values_from_row

    for chunk_start in range(0, len(rows), chunk_size):
        chunk = rows[chunk_start : chunk_start + chunk_size]
        row0 = start_row + chunk_start
        value_ranges = []
        for col in date_cols:
            idx = col - 1
            col_values = [[row[idx] if idx < len(row) else ""] for row in chunk]
            letter = _col_letter(col)
            value_ranges.append({
                "range": f"'{sheet_name}'!{letter}{row0}:{letter}{row0 + len(chunk) - 1}",
                "values": col_values,
            })
        body = {"valueInputOption": "USER_ENTERED", "data": value_ranges}
        with_retry(
            lambda body=body: client.spreadsheets().values().batchUpdate(spreadsheetId=spreadsheet_id, body=body).execute()
        )


def write_values(client, spreadsheet_id: str, sheet_name: str, rows: list[list], fresh: bool = False):
    """Overwrite `sheet_name!A1` onward with `rows`. Chunked to stay under the
    Sheets API's per-request cell-count limits for very large tables.

    `fresh=True` skips clearing the tab first -- a newly-created tab is
    already empty, so it saves an API round-trip with no behavior change.
    """
    if not rows:
        return

    required_rows = len(rows)
    required_cols = max(len(r) for r in rows) if rows else 1
    ensure_grid_size(client, spreadsheet_id, sheet_name, required_rows, required_cols)
    if not fresh:
        clear_values(client, spreadsheet_id, sheet_name)

    chunk_size = 5000  # rows per request

    for start in range(0, len(rows), chunk_size):
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


def ensure_grid_size(client, spreadsheet_id: str, sheet_name: str, required_rows: int, required_cols: int):
    meta = with_retry(
        lambda: client.spreadsheets().get(spreadsheetId=spreadsheet_id, fields="sheets.properties").execute()
    )
    for sheet in meta.get("sheets", []):
        props = sheet.get("properties", {})
        if props.get("title") == sheet_name:
            sheet_id = props.get("sheetId")
            grid_props = props.get("gridProperties", {})
            current_rows = grid_props.get("rowCount", 1000)
            current_cols = grid_props.get("columnCount", 26)

            reqs = []
            if required_rows > current_rows:
                reqs.append({
                    "updateSheetProperties": {
                        "properties": {
                            "sheetId": sheet_id,
                            "gridProperties": {"rowCount": required_rows + 500}
                        },
                        "fields": "gridProperties.rowCount"
                    }
                })
            if required_cols > current_cols:
                reqs.append({
                    "updateSheetProperties": {
                        "properties": {
                            "sheetId": sheet_id,
                            "gridProperties": {"columnCount": required_cols + 5}
                        },
                        "fields": "gridProperties.columnCount"
                    }
                })
            if reqs:
                with_retry(
                    lambda: client.spreadsheets().batchUpdate(
                        spreadsheetId=spreadsheet_id,
                        body={"requests": reqs}
                    ).execute()
                )
            break

