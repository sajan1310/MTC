"""Push verified snapshots to Google Drive.

This is the second place a restorable copy lives. Until it existed, the
``.dump`` files never left the server: the Google integration that was
already here uploads a SPREADSHEET (scripts/migration/backup_db_to_sheets.py),
which is table rows in cells -- no schema, no sequences, no constraints, no
foreign-key ordering. You can read it. You cannot restore from it.

Reuses scripts/migration/sheets_client's service-account credentials, which
already carry the full ``auth/drive`` scope, so nothing new has to be granted.

A WARNING ABOUT SERVICE ACCOUNTS AND QUOTA
------------------------------------------
That the spreadsheet upload works proves nothing about this one. Google
Docs/Sheets/Slides files do not count against Drive storage quota; a binary
file does. A service account has NO storage of its own, so an upload into a
folder it owns fails with "Service Accounts do not have storage quota".

The destination folder therefore has to live in a SHARED DRIVE, whose storage
belongs to the organisation, with the service account added as a member.
``supportsAllDrives=True`` below is what lets the API see such a folder at
all. ``_explain_http_error`` turns that failure into those instructions
rather than a stack trace, because it is the one error this module is most
likely to produce on a first run.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import logging
import os
import re
import sys
import time

logger = logging.getLogger(__name__)

# Snapshots and their checksum sidecars, named by db_backup.create_snapshot.
_SNAPSHOT_RE = re.compile(r"^mtc_(?P<stamp>\d{8}_\d{6})\.dump$")

# Drive keeps its own retention, independent of the server's. Deliberately
# shorter than the local grandfather-father-son scheme: this copy exists so a
# dead server disk is survivable, and the likely need is "yesterday", not
# "March".
DRIVE_RETAIN = int(os.getenv("DRIVE_RETAIN", "14"))

# Uploads go up in chunks so a slow or flaky factory link cannot wedge the
# call, and so the emergency path can abandon one between chunks when the UPS
# says the battery is nearly gone.
_CHUNK_BYTES = 4 * 1024 * 1024

UPLOAD_TIMEOUT_SECONDS = int(os.getenv("DRIVE_UPLOAD_TIMEOUT", "900"))


class DriveBackupError(RuntimeError):
    """The snapshot could not be placed in Drive."""


@dataclasses.dataclass(frozen=True)
class DriveUpload:
    file_id: str
    name: str
    size_bytes: int
    url: str


def _sheets_client():
    """The existing service-account helper, imported the way backup_service
    reaches the other scripts/migration modules."""
    migration_dir = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../../scripts/migration")
    )
    if migration_dir not in sys.path:
        sys.path.insert(0, migration_dir)
    import sheets_client  # type: ignore

    return sheets_client


def folder_id(explicit: str | None = None) -> str | None:
    return explicit or os.environ.get("DRIVE_FOLDER_ID") or None


def is_configured(explicit_folder: str | None = None) -> bool:
    """True when both a key file and a destination folder are available.

    Checked before every use rather than at import: an install with no Google
    credentials is a perfectly valid install and must not see errors about a
    feature it has not turned on.
    """
    key = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    return bool(key and os.path.isfile(key) and folder_id(explicit_folder))


def _explain_http_error(exc: Exception) -> str:
    """Turn the two failures that actually happen into instructions."""
    text = str(exc)
    if "storageQuotaExceeded" in text or "do not have storage quota" in text:
        return (
            "Google refused the upload because a service account has no Drive "
            "storage of its own. The DRIVE_FOLDER_ID folder must live in a "
            "Shared Drive with the service account added as a member (Content "
            "manager). A folder in a personal My Drive cannot receive this "
            "file however it is shared. The SPREADSHEET backup keeps working "
            "regardless: Sheets files are exempt from quota, binary files are "
            "not."
        )
    if "notFound" in text or "File not found" in text:
        return (
            "Drive says the destination folder does not exist, which for a "
            "service account usually means it exists but has not been shared "
            "WITH the service account. Add its client_email as a member of "
            "the folder or Shared Drive."
        )
    return text


def upload_snapshot(
    path: str,
    *,
    explicit_folder: str | None = None,
    deadline: float | None = None,
    with_sidecar: bool = True,
) -> DriveUpload:
    """Upload one snapshot (and its .sha256) to the configured Drive folder.

    ``deadline`` is an absolute :func:`time.monotonic` value, checked between
    chunks, so the UPS handler can give a dying machine a bounded upload
    rather than an open-ended one. See scripts/emergency_backup.py.
    """
    if not is_configured(explicit_folder):
        raise DriveBackupError(
            "Drive backup is not configured: set GOOGLE_APPLICATION_CREDENTIALS "
            "to a readable service-account key and DRIVE_FOLDER_ID to the "
            "destination folder."
        )
    if not os.path.isfile(path):
        raise DriveBackupError(f"No such snapshot to upload: {path}")

    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload

    sheets_client = _sheets_client()
    drive = sheets_client.drive_client()
    dest = folder_id(explicit_folder)
    name = os.path.basename(path)
    size = os.path.getsize(path)

    media = MediaFileUpload(
        path,
        mimetype="application/octet-stream",
        chunksize=_CHUNK_BYTES,
        resumable=True,
    )
    request = drive.files().create(
        body={"name": name, "parents": [dest]},
        media_body=media,
        fields="id,name,size",
        # Without this the call cannot see a Shared Drive at all, which is the
        # only place these uploads can legally land. See the module docstring.
        supportsAllDrives=True,
    )

    response = None
    try:
        while response is None:
            if deadline is not None and time.monotonic() > deadline:
                raise DriveBackupError(
                    f"Upload of {name} abandoned at the deadline. The local "
                    f"snapshot is already written and verified; only the "
                    f"off-site copy was lost."
                )
            _status, response = request.next_chunk()
    except HttpError as exc:
        raise DriveBackupError(
            f"Drive rejected {name}: {_explain_http_error(exc)}"
        ) from exc
    finally:
        # MediaFileUpload holds the file open, and on Windows that blocks any
        # retention unlink that follows.
        try:
            media.stream().close()
        except Exception:  # noqa: BLE001 -- best-effort cleanup
            pass

    file_id = response.get("id", "")
    url = f"https://drive.google.com/file/d/{file_id}/view"
    logger.info("[drive_backup] Uploaded %s (%s bytes) -> %s", name, f"{size:,}", url)

    if with_sidecar and os.path.isfile(path + ".sha256"):
        # The checksum travels with the dump, or the Drive copy cannot be
        # verified after download -- which would make it a file rather than a
        # backup. Failing to place it is not worth failing the upload over.
        try:
            side = MediaFileUpload(
                path + ".sha256", mimetype="text/plain", resumable=False
            )
            drive.files().create(
                body={"name": name + ".sha256", "parents": [dest]},
                media_body=side,
                fields="id",
                supportsAllDrives=True,
            ).execute()
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "[drive_backup] Could not upload sidecar for %s: %s", name, exc
            )

    return DriveUpload(file_id=file_id, name=name, size_bytes=size, url=url)


def _all_files(drive, dest: str | None) -> list[dict]:
    resp = (
        drive.files()
        .list(
            q=f"'{dest}' in parents and trashed = false",
            fields="files(id,name)",
            pageSize=400,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        .execute()
    )
    return resp.get("files", [])


def list_drive_snapshots(explicit_folder: str | None = None) -> list[dict]:
    """Snapshot files in the folder, newest first, by the stamp in the name."""
    sheets_client = _sheets_client()
    drive = sheets_client.drive_client()
    dest = folder_id(explicit_folder)

    found: list[dict] = []
    page = None
    while True:
        resp = (
            drive.files()
            .list(
                q=f"'{dest}' in parents and trashed = false",
                fields="nextPageToken, files(id,name,size,createdTime)",
                pageSize=200,
                pageToken=page,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )
        found.extend(resp.get("files", []))
        page = resp.get("nextPageToken")
        if not page:
            break

    dated = []
    for entry in found:
        match = _SNAPSHOT_RE.match(entry.get("name", ""))
        if not match:
            continue
        try:
            when = dt.datetime.strptime(match.group("stamp"), "%Y%m%d_%H%M%S")
        except ValueError:
            continue
        dated.append({**entry, "_when": when})
    return sorted(dated, key=lambda entry: entry["_when"], reverse=True)


def prune_drive_snapshots(
    explicit_folder: str | None = None, keep: int | None = None
) -> list[str]:
    """Keep the newest ``keep`` snapshots in Drive; delete the rest and their
    sidecars. Returns the names removed.

    Drive is not a mirror of the server. It prunes on its own count, so a
    deletion on the server never reaches across and removes the off-site copy
    -- the same reasoning as deploy/offsite-pull.sh.
    """
    limit = DRIVE_RETAIN if keep is None else keep
    if limit < 1:
        raise ValueError("keep must be >= 1")

    sheets_client = _sheets_client()
    drive = sheets_client.drive_client()
    snapshots = list_drive_snapshots(explicit_folder)
    doomed = snapshots[limit:]
    if not doomed:
        return []

    by_name = {f["name"]: f for f in _all_files(drive, folder_id(explicit_folder))}
    removed: list[str] = []
    for entry in doomed:
        for target in (entry["name"], entry["name"] + ".sha256"):
            found = by_name.get(target)
            if not found:
                continue
            try:
                drive.files().delete(
                    fileId=found["id"], supportsAllDrives=True
                ).execute()
            except Exception as exc:  # noqa: BLE001
                logger.warning("[drive_backup] Could not delete %s: %s", target, exc)
                continue
            if target == entry["name"]:
                removed.append(target)
    return removed
