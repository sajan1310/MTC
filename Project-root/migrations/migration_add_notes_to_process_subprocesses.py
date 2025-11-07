"""
Migration: Add notes column to process_subprocesses
Ensures the process_subprocesses table has a notes TEXT column used by the API.
This migration is intentionally independent of the application's DB pool so
it can run in test environments that call upgrade() directly.
"""
import os
import psycopg2
from contextlib import contextmanager


def _get_conn_kwargs():
    # Prefer DATABASE_URL if provided
    url = os.getenv("DATABASE_URL")
    if url:
        # psycopg2 can accept a connection string directly
        return {"dsn": url}
    # Fallback to discrete vars (as used by tests)
    return {
        "host": os.getenv("DB_HOST", "127.0.0.1"),
        "database": os.getenv("DB_NAME", "testuser"),
        "user": os.getenv("DB_USER", "postgres"),
        "password": os.getenv("DB_PASS", "abcd"),
    }


@contextmanager
def _conn_cursor():
    kwargs = _get_conn_kwargs()
    if "dsn" in kwargs:
        conn = psycopg2.connect(kwargs["dsn"])
    else:
        conn = psycopg2.connect(**kwargs)
    try:
        conn.autocommit = True
        cur = conn.cursor()
        yield conn, cur
    finally:
        try:
            cur.close()
        except Exception:
            pass
        conn.close()


def upgrade():
    """Add notes column if missing."""
    with _conn_cursor() as (conn, cur):
        cur.execute(
            """
            ALTER TABLE IF EXISTS process_subprocesses
            ADD COLUMN IF NOT EXISTS notes TEXT;
            """
        )
        print("Upgrade complete: ensured process_subprocesses.notes exists.")


def downgrade():
    """Remove notes column (safe to run)."""
    with _conn_cursor() as (conn, cur):
        cur.execute(
            """
            ALTER TABLE IF EXISTS process_subprocesses
            DROP COLUMN IF EXISTS notes;
            """
        )
        print("Downgrade complete: removed process_subprocesses.notes if present.")


if __name__ == "__main__":
    upgrade()
