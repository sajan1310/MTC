"""Database snapshot, verification and retention (DATA-001).

Why this module exists
----------------------
``backup_service.export_local_sql_snapshot`` hand-wrote ``INSERT`` statements
by iterating every table and stringifying every value. It produced files that
could not be restored, and said they could:

1. **No schema and no sequences.** The file held ``INSERT INTO ...`` and
   nothing else -- no ``CREATE TABLE``, no index, no constraint, no
   ``setval``. Restoring into an empty database was impossible; restoring into
   an existing one left every ``SERIAL`` at its pre-restore value, so the next
   insert collided on the primary key. ``erp.dispatch_number_seq`` issues
   customer-facing document numbers -- it would have begun re-issuing numbers
   already in use.

2. **``public.users`` and ``public.custom_roles`` were never included.** The
   table list came from ``backup_db_to_sheets.TABLES``, every entry
   ``erp.``-prefixed. A restore lost every account, every password hash and
   every custom role's permission map, while ``updated_by``/``created_by``
   foreign keys throughout ``erp.*`` still pointed at user ids that no longer
   existed.

3. **JSONB was written as Python ``repr``.** psycopg2 hands back a ``list``/
   ``dict``; the serialiser fell through to ``str(val)``, producing
   ``'[{''itemName'': ''Rim 26"''}]'`` -- single-quoted, not JSON. Postgres
   rejects that with ``invalid input syntax for type json``. The column is
   ``erp.production.components_consumed``, one of the five terms in the
   Current Stock formula, so every production row failed to restore.

4. **A failed table was a comment in the file, and the run still said
   SUCCESS.** ``except Exception: f.write("-- Error exporting ...")`` then
   ``local_success = True``. A backup that captured three of fifty tables was
   reported green on the dashboard. That is the worst failure mode a backup
   system can have: it removes the signal that would prompt anyone to look.

The fix is not to write a better serialiser. It is to stop writing one: this
module shells out to ``pg_dump``, which already handles schema, sequences,
constraints, JSONB, arrays, bytea, extensions and encodings correctly, and
whose output ``pg_restore`` is guaranteed to accept.

Contract
--------
``create_snapshot()`` either returns a :class:`Snapshot` describing a file that
``pg_restore`` has confirmed it can read, or raises :class:`BackupError`.
There is no third outcome and no partial success.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlparse

# pg_dump's custom format: compressed, selectively restorable, and the only
# format pg_restore can list without a running server to restore into.
DUMP_FORMAT = "custom"
DUMP_COMPRESSION = "9"

# Generous. A dump that legitimately takes longer than this on a
# single-factory ERP is a signal in itself.
DUMP_TIMEOUT_SECONDS = int(os.getenv("BACKUP_DUMP_TIMEOUT", "1800"))
VERIFY_TIMEOUT_SECONDS = 300

# Schemas a snapshot must be able to restore. NOT passed to pg_dump as
# --schema filters -- see create_snapshot() -- only asserted afterwards by
# REQUIRED_TABLES, which name their schema.
#
# The whole database is dumped instead, for two reasons.
#
# First, correctness of the restore: `--schema=public` makes pg_dump emit
# `CREATE SCHEMA public;`, and every freshly created PostgreSQL database
# already has one. `pg_restore --exit-on-error` therefore aborts the entire
# restore on its first statement. Verified against PostgreSQL 17: a
# schema-filtered dump fails to restore into an empty database; a full dump
# emits `CREATE SCHEMA erp` (which the target genuinely needs) and no
# `CREATE SCHEMA public`, and restores cleanly. A backup that only fails at
# restore time is the failure mode this whole module exists to remove.
#
# Second, a filter list is a thing somebody has to remember to update. The
# original defect was precisely a hardcoded table list that nobody updated
# when `public.users` started mattering. Dumping everything means a schema
# added next year is in the backup without anyone doing anything.
SCHEMAS = ("public", "erp")

# Tables whose absence from a dump means the dump is not a backup, whatever
# else it contains. Checked by name against pg_restore's table of contents.
REQUIRED_TABLES = (
    "public.users",
    "public.custom_roles",
    "erp.items",
    "erp.vendors",
    "erp.clients",
    "erp.stock",
    "erp.bill_headers",
    "erp.bill_lines",
    "erp.po_headers",
    "erp.po_lines",
    "erp.production",
    "erp.dispatch_headers",
    "erp.dispatch_lines",
    "erp.contractor_payments",
)

# Retention. Deliberately generous at the daily end -- these files are small
# relative to the cost of not having one.
RETAIN_DAILY = int(os.getenv("BACKUP_RETAIN_DAILY", "7"))
RETAIN_WEEKLY = int(os.getenv("BACKUP_RETAIN_WEEKLY", "4"))
RETAIN_MONTHLY = int(os.getenv("BACKUP_RETAIN_MONTHLY", "12"))

_SNAPSHOT_RE = re.compile(r"^mtc_(?P<stamp>\d{8}_\d{6})\.dump$")


class BackupError(RuntimeError):
    """A snapshot could not be produced, or could not be verified.

    Always fatal to the caller. Never downgraded to a warning, never written
    into the output file as a comment, never reported as a successful run.
    """


@dataclasses.dataclass(frozen=True)
class Snapshot:
    path: str
    size_bytes: int
    sha256: str
    created_at: str
    table_count: int
    verified: bool

    @property
    def filename(self) -> str:
        return os.path.basename(self.path)


def _require_tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise BackupError(
            f"{name} is not on PATH. Install the PostgreSQL client tools "
            f"(Debian/Ubuntu: apt install postgresql-client). Backups cannot "
            f"run without it."
        )
    return path


def _resolve_config():
    """The configuration of the RUNNING app, falling back to config.Config.

    This matters more than it looks. backup_service did
    ``from config import Config`` and read ``Config.DATABASE_URL`` -- the BASE
    class, which reads os.environ at import time. TestingConfig deliberately
    sets ``DATABASE_URL = None`` so its own DB_* settings (the disposable test
    database) win, and app/__init__.py excludes DATABASE_URL from its
    environment overrides under "testing", precisely because a previous
    incident wrote ~180 test-fixture rows into the production database. None
    of that protection applies to a module that reaches around the app and
    reads the base class: under pytest, with a .env present, ``Config
    .DATABASE_URL`` resolves to the REAL database.

    For a read-only pg_dump that means a test run snapshots production --
    slow, surprising, and a copy of live business data written into the
    repository's backups/ directory. Preferring current_app.config makes the
    existing isolation actually cover this path.
    """
    try:
        from flask import current_app

        if current_app:  # raises/false outside an app context
            return current_app.config
    except Exception:  # noqa: BLE001 -- no app context is a normal case here
        pass
    from config import Config

    return Config


def _cfg_get(config, key, default=None):
    """Config classes use attributes; Flask's config is a dict. Read either."""
    if hasattr(config, "get") and not isinstance(config, type):
        try:
            return config.get(key, default)
        except TypeError:
            pass
    return getattr(config, key, default)


def build_dsn(config=None) -> tuple[str, str | None]:
    """(dsn_without_password, password) for the database to snapshot.

    The password is returned separately so it can go into ``PGPASSWORD``
    rather than into a command line, where it would be visible to every user
    on the box via ``ps``.
    """
    if config is None:
        config = _resolve_config()

    url = _cfg_get(config, "DATABASE_URL")
    if url:
        parsed = urlparse(url)
        password = parsed.password
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or 5432
        user = parsed.username or "postgres"
        name = (parsed.path or "").lstrip("/")
    else:
        password = _cfg_get(config, "DB_PASS")
        host = _cfg_get(config, "DB_HOST", "127.0.0.1")
        port = int(os.getenv("DB_PORT", "5432"))
        user = _cfg_get(config, "DB_USER", "postgres")
        name = _cfg_get(config, "DB_NAME")

    if not name:
        raise BackupError(
            "No database name resolved -- set DATABASE_URL or DB_NAME before "
            "running a backup."
        )

    # Under TESTING, refuse to touch the production database.
    #
    # _resolve_config() covers the in-app-context path, but a plain
    # unittest.TestCase has no app context, falls back to config.Config, and
    # config.py's load_dotenv() puts the real DATABASE_URL back -- so a test
    # run snapshots production. pg_dump is read-only, so the damage is a slow
    # test and a copy of live business data written into the repository's
    # backups/ directory rather than corruption. It is still the same mistake
    # that once wrote ~180 fixture rows into production, and TestingConfig
    # already carries an assertion of exactly this shape. Mirror it here so
    # the protection does not depend on which entry point is used.
    if _cfg_get(config, "TESTING"):
        production_name = os.getenv("DB_NAME", "MTC")
        if name == production_name and name != "testdb":
            raise BackupError(
                f"Refusing to snapshot database {name!r} while TESTING is set "
                f"-- that is the production database. Point TEST_DB_NAME at a "
                f"disposable database, or pass an explicit config."
            )

    return f"postgresql://{user}@{host}:{port}/{name}", password


def _env_with_password(password: str | None) -> dict:
    env = dict(os.environ)
    if password:
        env["PGPASSWORD"] = password
    # Deterministic, parseable tool output regardless of the operator's locale.
    env["LC_ALL"] = "C"
    return env


def _run(cmd: list[str], *, env: dict, timeout: int, what: str) -> str:
    try:
        completed = subprocess.run(
            cmd,
            env=env,
            timeout=timeout,
            capture_output=True,
            text=True,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise BackupError(f"{what} timed out after {timeout}s") from exc
    except OSError as exc:
        raise BackupError(f"{what} could not be started: {exc}") from exc

    if completed.returncode != 0:
        # stderr can quote the DSN, which carries host and user. It never
        # carries the password (that goes via PGPASSWORD), but trim it anyway
        # -- this string reaches logs and the dashboard.
        detail = (completed.stderr or "").strip().splitlines()
        tail = " | ".join(detail[-3:]) if detail else f"exit {completed.returncode}"
        raise BackupError(f"{what} failed: {tail}")
    return completed.stdout


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_snapshot(path: str, password: str | None = None) -> int:
    """Prove ``pg_restore`` can read the file and that it contains the tables
    a restore actually needs. Returns the number of tables found.

    This is the step whose absence made the old system dangerous: a file
    existed, so the run was called a success, and nobody discovered otherwise
    until they needed it.
    """
    pg_restore = _require_tool("pg_restore")
    listing = _run(
        [pg_restore, "--list", path],
        env=_env_with_password(password),
        timeout=VERIFY_TIMEOUT_SECONDS,
        what="pg_restore --list (backup verification)",
    )

    tables = set()
    for line in listing.splitlines():
        # Definition lines look like
        #     324; 1259 1299467 TABLE erp app_settings postgres
        # and each is accompanied by a
        #     6216; 0 1299467 TABLE DATA erp app_settings postgres
        # line. The negative lookahead keeps the second kind out, so
        # table_count is a count of tables and not double it.
        match = re.search(r"\bTABLE\s+(?!DATA\b)(\S+)\s+(\S+)", line)
        if match:
            tables.add(f"{match.group(1)}.{match.group(2)}")

    missing = [t for t in REQUIRED_TABLES if t not in tables]
    if missing:
        raise BackupError(
            "Snapshot is missing tables a restore cannot do without: "
            + ", ".join(missing)
            + f" (found {len(tables)} tables). Refusing to record this as a "
            "successful backup."
        )
    return len(tables)


def create_snapshot(backup_dir: str, *, config=None, now: dt.datetime | None = None) -> Snapshot:
    """Produce and verify one snapshot. Raises BackupError on any failure.

    The file is written to a ``.partial`` name and only renamed into place
    once pg_dump has exited 0 AND pg_restore has confirmed it is readable, so
    a directory listing can never show a truncated or unverified file that a
    later restore would trust.
    """
    pg_dump = _require_tool("pg_dump")
    dsn, password = build_dsn(config)

    os.makedirs(backup_dir, exist_ok=True)
    stamp = (now or dt.datetime.now()).strftime("%Y%m%d_%H%M%S")
    final_path = os.path.join(backup_dir, f"mtc_{stamp}.dump")
    partial_path = final_path + ".partial"

    cmd = [
        pg_dump,
        f"--format={DUMP_FORMAT}",
        f"--compress={DUMP_COMPRESSION}",
        # Ownership and grants are a property of the target cluster, not of
        # the data. Including them makes a restore onto a differently-named
        # role fail for no good reason.
        "--no-owner",
        "--no-privileges",
        # A single consistent snapshot across all tables.
        "--serializable-deferrable",
        "--file",
        partial_path,
        # No --schema filters: the whole database. See the SCHEMAS comment.
        dsn,
    ]

    try:
        _run(
            cmd,
            env=_env_with_password(password),
            timeout=DUMP_TIMEOUT_SECONDS,
            what="pg_dump",
        )
        if not os.path.exists(partial_path) or os.path.getsize(partial_path) == 0:
            raise BackupError("pg_dump exited 0 but produced no output file")

        table_count = verify_snapshot(partial_path, password)
        checksum = _sha256(partial_path)
        size = os.path.getsize(partial_path)

        os.replace(partial_path, final_path)
        with open(final_path + ".sha256", "w", encoding="utf-8") as handle:
            handle.write(f"{checksum}  {os.path.basename(final_path)}\n")
    except BaseException:
        # Never leave an unverified file where a human might reach for it.
        try:
            if os.path.exists(partial_path):
                os.unlink(partial_path)
        except OSError:
            pass
        raise

    return Snapshot(
        path=final_path,
        size_bytes=size,
        sha256=checksum,
        created_at=(now or dt.datetime.now()).isoformat(timespec="seconds"),
        table_count=table_count,
        verified=True,
    )


def _snapshot_files(backup_dir: str) -> list[tuple[dt.datetime, Path]]:
    out = []
    for entry in Path(backup_dir).glob("mtc_*.dump"):
        match = _SNAPSHOT_RE.match(entry.name)
        if not match:
            continue
        try:
            when = dt.datetime.strptime(match.group("stamp"), "%Y%m%d_%H%M%S")
        except ValueError:
            continue
        out.append((when, entry))
    return sorted(out, key=lambda pair: pair[0], reverse=True)


def prune_snapshots(backup_dir: str) -> list[str]:
    """Grandfather-father-son retention. Returns the filenames removed.

    Nothing pruned the old backups/ directory at all, so it grew without
    bound -- on a machine whose disk filling up is itself a way to lose the
    database.
    """
    snapshots = _snapshot_files(backup_dir)
    keep: set[Path] = set()

    for when, path in snapshots[:RETAIN_DAILY]:
        keep.add(path)

    seen_weeks: set[tuple[int, int]] = set()
    for when, path in snapshots:
        key = when.isocalendar()[:2]
        if key not in seen_weeks and len(seen_weeks) < RETAIN_WEEKLY:
            seen_weeks.add(key)
            keep.add(path)

    seen_months: set[tuple[int, int]] = set()
    for when, path in snapshots:
        key = (when.year, when.month)
        if key not in seen_months and len(seen_months) < RETAIN_MONTHLY:
            seen_months.add(key)
            keep.add(path)

    removed = []
    for _when, path in snapshots:
        if path in keep:
            continue
        try:
            path.unlink()
            removed.append(path.name)
            sidecar = path.with_name(path.name + ".sha256")
            if sidecar.exists():
                sidecar.unlink()
        except OSError:
            # A file we cannot delete is not a reason to fail a backup that
            # already succeeded.
            continue
    return removed


def latest_snapshot(backup_dir: str) -> Snapshot | None:
    """The newest verified snapshot on disk, or None. Used by the health
    surface so 'when did a backup last actually work' is answerable without
    trusting an in-process variable that a worker restart would have reset."""
    snapshots = _snapshot_files(backup_dir)
    if not snapshots:
        return None
    when, path = snapshots[0]
    sidecar = path.with_name(path.name + ".sha256")
    checksum = ""
    if sidecar.exists():
        checksum = sidecar.read_text(encoding="utf-8").split()[0]
    return Snapshot(
        path=str(path),
        size_bytes=path.stat().st_size,
        sha256=checksum,
        created_at=when.isoformat(timespec="seconds"),
        table_count=0,
        verified=bool(checksum),
    )
