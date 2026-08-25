"""The migration runner. Applies migrations/erp/*.sql, tracked in
erp.migrations_applied.

This is the only migration path there is (MIG-001) -- the deploy scripts, the
Docker entrypoint and the test suite all call exactly this. It builds a
complete database from empty, public core tables included, because
000_public_core.sql sorts first.

Self-contained on purpose: connects directly via psycopg2 (same DATABASE_URL
/ DB_* env var resolution as database.py) rather than going through the Flask
app, so it can run before gunicorn starts and against a throwaway test
database.

It used to be one of three trackers. The other two -- public.migrations_applied
and public.schema_migrations -- described a schema production had already
dropped; the scripts behind them now live in migrations/legacy/ and nothing
executes them. That directory's README has the evidence.

Usage:
    python migrations/erp/runner.py            # apply all pending migrations
    python migrations/erp/runner.py --status    # show applied/pending
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

import psycopg2

# Advisory-lock key for migration execution (MIG-001). An arbitrary but fixed
# 64-bit constant; it only has to differ from the other advisory locks this
# codebase takes (backup_service's _BACKUP_LOCK_KEY = 918_273_646 and
# ledger_audit_service's own key).
MIGRATION_LOCK_KEY = 771_204_915


def _connect(
    *,
    database_url: str | None = None,
    host: str | None = None,
    dbname: str | None = None,
    user: str | None = None,
    password: str | None = None,
):
    # Explicit connection kwargs (as tests/erp/conftest.py always passes)
    # must win over DATABASE_URL -- previously DATABASE_URL was checked
    # first regardless, so a caller explicitly asking for dbname="testdb"
    # would silently connect to whatever DATABASE_URL happened to resolve
    # to instead (e.g. via config.py's load_dotenv() repopulating it from
    # .env the moment `app`/`config` gets imported, even if the caller's own
    # shell had it unset). Confirmed live: this sent a test run's migration
    # replay at the real MTC database instead of the disposable test DB.
    explicit_kwargs_given = any((host, dbname, user, password))
    if not explicit_kwargs_given:
        database_url = database_url or os.getenv("DATABASE_URL")
    if database_url:
        parsed = urlparse(database_url)
        return psycopg2.connect(
            host=parsed.hostname,
            port=parsed.port or 5432,
            dbname=(parsed.path or "").lstrip("/"),
            user=parsed.username,
            password=parsed.password,
        )
    return psycopg2.connect(
        host=host or os.getenv("DB_HOST", "127.0.0.1"),
        dbname=dbname or os.getenv("DB_NAME", "MTC"),
        user=user or os.getenv("DB_USER", "postgres"),
        password=password or os.getenv("DB_PASS", ""),
    )


def _bootstrap(cur) -> None:
    """Create the erp schema + its migration-tracking table if absent.

    Idempotent, and safe to run even though 001_init_erp_schema.sql also
    creates these -- that file re-applies the same CREATE ... IF NOT EXISTS
    statements harmlessly the first time it actually runs.
    """
    cur.execute("CREATE SCHEMA IF NOT EXISTS erp")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS erp.migrations_applied (
            id SERIAL PRIMARY KEY,
            migration_name VARCHAR(255) NOT NULL UNIQUE,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )


def _applied(cur) -> set[str]:
    cur.execute("SELECT migration_name FROM erp.migrations_applied")
    return {row[0] for row in cur.fetchall()}


def _pending(cur) -> list[tuple[str, Path]]:
    migrations_dir = Path(__file__).parent
    applied = _applied(cur)
    result = []
    for sql_file in sorted(migrations_dir.glob("*.sql")):
        if sql_file.stem not in applied:
            result.append((sql_file.stem, sql_file))
    return result


def run_pending_migrations(**connect_kwargs) -> list[str]:
    """Apply every not-yet-recorded migrations/erp/*.sql file, in filename order.

    Returns the names of migrations applied during this call (empty if
    everything was already applied).

    Serialised across processes by a Postgres advisory lock (MIG-001).
    deploy/mtc.service runs this from ExecStartPre on EVERY start, with
    Restart=always -- so a restart loop, a rolling deploy or `docker-compose
    scale` can easily have two instances computing the same pending set and
    executing it simultaneously. `CREATE TABLE IF NOT EXISTS` survives that;
    `ALTER TABLE ... ADD COLUMN` and data migrations do not. 032_recalc_
    contractor_payable_per_unit_extra_charge.sql is exactly the dangerous
    kind: a recalculation applied twice produces wrong money.

    The UNIQUE on migration_name meant one side rolled back and today that
    happens to save you -- but only because every statement here is
    transactional. The first `CREATE INDEX CONCURRENTLY` anyone adds breaks
    that accident silently. A lock is the thing that actually holds.

    pg_advisory_lock BLOCKS rather than skipping: the second instance waits
    and then finds nothing pending, which is the correct outcome. Skipping
    would let it start serving requests against a half-migrated schema.
    """
    conn = _connect(**connect_kwargs)
    conn.autocommit = False
    applied_now: list[str] = []
    lock_held = False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_lock(%s)", (MIGRATION_LOCK_KEY,))
            lock_held = True
        conn.commit()

        with conn.cursor() as cur:
            _bootstrap(cur)
        conn.commit()

        # Read the pending list only AFTER the lock is held. Computed before,
        # it could reflect a state another instance has since changed.
        with conn.cursor() as cur:
            pending = _pending(cur)

        for name, sql_file in pending:
            with conn.cursor() as cur:
                cur.execute(sql_file.read_text(encoding="utf-8"))
                cur.execute(
                    "INSERT INTO erp.migrations_applied (migration_name) VALUES (%s)",
                    (name,),
                )
            conn.commit()
            applied_now.append(name)
            print(f"[OK] Applied {name}")
    except Exception:
        conn.rollback()
        raise
    finally:
        # Session-level lock, so it must be released explicitly. Closing the
        # connection would release it too, but being explicit keeps the
        # intent legible and survives someone later reusing the connection.
        if lock_held:
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT pg_advisory_unlock(%s)", (MIGRATION_LOCK_KEY,))
                conn.commit()
            except Exception:  # noqa: BLE001 -- teardown must not mask the real error
                pass
        conn.close()
    return applied_now


def show_status(**connect_kwargs) -> None:
    conn = _connect(**connect_kwargs)
    try:
        with conn.cursor() as cur:
            _bootstrap(cur)
            conn.commit()
            applied = sorted(_applied(cur))
            pending = [name for name, _ in _pending(cur)]
        print(f"Applied ({len(applied)}): {applied}")
        print(f"Pending ({len(pending)}): {pending}")
    finally:
        conn.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run pending ERP database migrations")
    parser.add_argument(
        "--status", action="store_true", help="Show migration status instead of running"
    )
    args = parser.parse_args()

    if args.status:
        show_status()
    else:
        applied = run_pending_migrations()
        if applied:
            print(f"[OK] Applied {len(applied)} migration(s): {applied}")
        else:
            print("[OK] No pending ERP migrations")
