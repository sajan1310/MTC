#!/usr/bin/env bash
#
# MTC ERP — one verified snapshot, now.
#
#   sudo /opt/mtc/src/Project-root/deploy/backup.sh
#   sudo .../backup.sh --quiet      # silent unless it fails, for cron
#
# This is the LOCAL snapshot only: pg_dump, verified with pg_restore, with a
# sha256 sidecar beside it. It deliberately does NOT run the Google Sheets
# sync or the GAS mirror that the nightly job also does — those need network
# and credentials, they are the slow half of a nightly run, and neither is
# what anyone means by "take a backup before I touch this".
#
# Why it shells out to db_backup.create_snapshot() rather than running
# pg_dump itself: that function is the only path that VERIFIES the result.
# It dumps to a .partial name, proves pg_restore can read it, writes the
# checksum sidecar, fsyncs both the file and the directory, and only then
# renames it into place. A hand-rolled pg_dump here would produce a file
# that /health reports as unverified and that nobody has confirmed is
# restorable — which is the exact failure class db_backup.py was written to
# end (see its module docstring: the old writer produced unrestorable files
# and reported them as successful backups).
#
# It runs in its own process, which is the safe way to trigger a backup on
# this box: the in-app trigger runs inside gunicorn, and that path is what
# resets the process-global connection pool. Nothing here can reach the
# running workers.
#
# It takes the SAME Postgres advisory lock as the nightly scheduler, so a
# snapshot by hand and the 2am run can never overlap.
set -euo pipefail

APP_USER=mtc
APP_DIR=/opt/mtc
SRC_DIR="$APP_DIR/src"
VENV_DIR="$APP_DIR/venv"
PROJECT_DIR="$SRC_DIR/Project-root"
ENV_FILE=/etc/mtc/mtc.env

QUIET=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --quiet|-q) QUIET=1; shift ;;
        -h|--help)  sed -n '2,7p' "$0" | sed 's/^# \?//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "Run with sudo (the snapshot is written as $APP_USER)."
[[ -f "$ENV_FILE" ]] || fail "$ENV_FILE missing."
[[ -x "$VENV_DIR/bin/python" ]] || fail "$VENV_DIR/bin/python missing. Run deploy.sh first."
[[ -d "$PROJECT_DIR" ]] || fail "$PROJECT_DIR missing."

# Read the values rather than sourcing the file. systemd accepts unquoted
# values containing spaces (RATELIMIT_DEFAULT=200 per day); `. "$ENV_FILE"`
# would try to run the second word as a command. Same reasoning as deploy.sh.
DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | head -1)"
BACKUP_DIR="$(sed -n 's/^BACKUP_DIR=//p' "$ENV_FILE" | head -1)"
[[ -n "$DATABASE_URL" ]] || fail "DATABASE_URL is not set in $ENV_FILE"

# cd first: the imports below resolve only with Project-root as the working
# directory — the same one mtc.service sets.
cd "$PROJECT_DIR"

sudo -u "$APP_USER" env \
    DATABASE_URL="$DATABASE_URL" \
    BACKUP_DIR="$BACKUP_DIR" \
    MTC_BACKUP_QUIET="$QUIET" \
    "$VENV_DIR/bin/python" - <<'PYSNAP'
import os
import sys
import time

QUIET = os.environ.get("MTC_BACKUP_QUIET") == "1"


def say(text=""):
    if not QUIET:
        print(text, flush=True)


# get_backup_dir() rather than a path computed here. The directory has to be
# the one the application and /health read from; a second copy of that
# resolution is how snapshots end up somewhere nobody is looking, with the
# panel reporting the backup as stale while fresh ones pile up elsewhere.
from app.erp.services import backup_service, db_backup  # noqa: E402

backup_dir = backup_service.get_backup_dir()
dsn, password = db_backup.build_dsn()

# The nightly scheduler's own key (backup_service._BACKUP_LOCK_KEY), read
# from it rather than repeated, so the two can never drift apart and start
# running concurrently.
LOCK_KEY = backup_service._BACKUP_LOCK_KEY

import psycopg2  # noqa: E402

conn = psycopg2.connect(dsn, password=password)
conn.autocommit = True
try:
    with conn.cursor() as cur:
        cur.execute("SELECT pg_try_advisory_lock(%s)", (LOCK_KEY,))
        if not cur.fetchone()[0]:
            print(
                "A backup is already running (the nightly job, or the admin "
                "screen). Nothing was done.",
                file=sys.stderr,
            )
            sys.exit(1)

    say(f"Snapshotting into {backup_dir}")
    started = time.perf_counter()
    try:
        snapshot = db_backup.create_snapshot(backup_dir)
    except Exception as exc:
        print(f"FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)

    elapsed = time.perf_counter() - started

    # Retention only after a good snapshot exists, matching perform_full_backup:
    # a run of failures must never be able to delete the last known-good file.
    try:
        pruned = db_backup.prune_snapshots(backup_dir)
    except Exception as exc:  # noqa: BLE001 -- a failed prune is not a failed backup
        pruned = []
        say(f"  (retention skipped: {type(exc).__name__}: {exc})")

    say()
    say(f"  file       {snapshot.filename}")
    say(f"  size       {snapshot.size_bytes / 1024 ** 2:,.1f} MB")
    say(f"  tables     {snapshot.table_count}")
    say(f"  sha256     {snapshot.sha256}")
    say("  verified   yes — pg_restore read it back")
    say(f"  took       {elapsed:,.1f}s")
    if pruned:
        say(f"  pruned     {len(pruned)} old snapshot(s)")
    say()
    say(f"  {os.path.join(backup_dir, snapshot.filename)}")
finally:
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_unlock(%s)", (LOCK_KEY,))
    except Exception:  # noqa: BLE001
        pass
    conn.close()
PYSNAP
