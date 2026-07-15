"""Idempotent runner for migrations/erp/*.sql, tracked in erp.migrations_applied.

Self-contained on purpose: connects directly via psycopg2 (same
DATABASE_URL / DB_* env var resolution as database.py) instead of going
through the Flask app, so it can run before gunicorn starts (Docker
entrypoint) or against a throwaway test database (tests/erp/conftest.py),
and it tracks its own state in erp.migrations_applied -- separate from the
app's two existing, mutually-inconsistent trackers
(migrations/migration_tracker.py's migrations_applied table and
tests/conftest.py's schema_migrations table, both in the public schema).

Usage:
    python migrations/erp/runner.py            # apply all pending migrations
    python migrations/erp/runner.py --status    # show applied/pending
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

import psycopg2


def _connect(
    *,
    database_url: str | None = None,
    host: str | None = None,
    dbname: str | None = None,
    user: str | None = None,
    password: str | None = None,
):
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
    """
    conn = _connect(**connect_kwargs)
    conn.autocommit = False
    applied_now: list[str] = []
    try:
        with conn.cursor() as cur:
            _bootstrap(cur)
        conn.commit()

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
