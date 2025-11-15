"""
Schema Verification Helper

Purpose: Quickly assert that the November 2025 schema fixes are present.
Run this after applying migrations.

Usage:
  python scripts/verify_schema_post_migration.py

Env (optional): DB_HOST, DB_NAME, DB_USER, DB_PASS, DB_PORT
"""

import os
import sys
from typing import List, Tuple

import psycopg2
import psycopg2.extras

DB_NAME = os.getenv("DB_NAME", os.getenv("POSTGRES_DB", "MTC"))
DB_USER = os.getenv("DB_USER", os.getenv("POSTGRES_USER", "postgres"))
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_PASSWORD = os.getenv("DB_PASS", os.getenv("POSTGRES_PASSWORD", "abcd"))

EXPECTED_COLUMNS = [
    ("production_lots", "created_by"),
    ("production_lots", "worst_case_estimated_cost"),
    ("item_master", "category"),
    ("substitute_groups", "deleted_at"),
]

EXPECTED_INDEXES = [
    ("substitute_groups", "idx_substitute_groups_deleted_at"),
    ("item_master", "idx_item_master_category"),
    ("production_lots", "idx_production_lots_status"),
]

EXPECTED_CONSTRAINTS = [
    ("production_lots", "production_lots_status_check"),
]

EXPECTED_FKS = [
    ("import_jobs", "fk_user"),
]

STATUS_ALLOWED = set(
    s.lower()
    for s in [
        "planning",
        "ready",
        "in progress",
        "in_progress",
        "active",
        "inactive",
        "draft",
        "completed",
        "failed",
        "cancelled",
        "archived",
    ]
)


def get_conn():
    return psycopg2.connect(
        dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD, host=DB_HOST, port=DB_PORT
    )


def check_columns(cur, items: List[Tuple[str, str]]):
    missing = []
    for table, col in items:
        cur.execute(
            """
            SELECT 1 FROM information_schema.columns
            WHERE table_name=%s AND column_name=%s
            """,
            (table, col),
        )
        if cur.fetchone() is None:
            missing.append((table, col))
    return missing


def check_indexes(cur, items: List[Tuple[str, str]]):
    missing = []
    for table, index in items:
        cur.execute(
            """
            SELECT 1 FROM pg_indexes
            WHERE schemaname='public' AND indexname=%s AND tablename=%s
            """,
            (index, table),
        )
        if cur.fetchone() is None:
            missing.append((table, index))
    return missing


def check_constraints(cur, items: List[Tuple[str, str]]):
    missing = []
    for table, con in items:
        cur.execute(
            """
            SELECT 1 FROM pg_constraint c
            JOIN pg_class t ON c.conrelid = t.oid
            WHERE t.relname=%s AND c.conname=%s
            """,
            (table, con),
        )
        if cur.fetchone() is None:
            missing.append((table, con))
    return missing


essential_queries = {
    "status_constraint": "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='production_lots_status_check'",
    "fk_import_jobs": "SELECT constraint_name FROM information_schema.table_constraints WHERE table_name='import_jobs' AND constraint_type='FOREIGN KEY' AND constraint_name='fk_user'",
}


def main():
    ok = True
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            missing_columns = check_columns(cur, EXPECTED_COLUMNS)
            missing_indexes = check_indexes(cur, EXPECTED_INDEXES)
            missing_constraints = check_constraints(cur, EXPECTED_CONSTRAINTS)

            print("\nSchema verification results:")
            if missing_columns:
                ok = False
                print("  ❌ Missing columns:")
                for t, c in missing_columns:
                    print(f"    - {t}.{c}")
            else:
                print("  ✅ All expected columns present")

            if missing_indexes:
                ok = False
                print("  ❌ Missing indexes:")
                for t, i in missing_indexes:
                    print(f"    - {t}:{i}")
            else:
                print("  ✅ All expected indexes present")

            if missing_constraints:
                ok = False
                print("  ❌ Missing constraints:")
                for t, con in missing_constraints:
                    print(f"    - {t}:{con}")
            else:
                print("  ✅ All expected constraints present")

            # Show details for critical items
            print("\nDetails:")
            for name, q in essential_queries.items():
                cur.execute(q)
                rows = cur.fetchall()
                print(f"  - {name}: {rows}")

            # Sanity: if table exists, probe one permissible status
            try:
                cur.execute("SELECT lower(status) FROM production_lots LIMIT 1;")
                # If there are rows, ensure sample value is allowed (advisory)
                r = cur.fetchone()
                if r and r[0] not in STATUS_ALLOWED:
                    ok = False
                    print(
                        f"  ❌ Found disallowed status value in production_lots: {r[0]}"
                    )
            except Exception as e:
                # Table might not exist or permission issues; non-fatal
                print(f"  ℹ️ Skipped sample status check: {e}")

    if not ok:
        print("\n❌ Schema verification FAILED. See above for details.")
        sys.exit(1)
    print("\n✅ Schema verification PASSED.")


if __name__ == "__main__":
    main()
