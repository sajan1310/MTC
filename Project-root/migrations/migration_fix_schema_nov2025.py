"""
Migration: Fix schema mismatches (November 2025)

Purpose:
- Normalize production_lots schema across divergent earlier migrations (created_by vs user_id, cost fields, status constraint).
- Add any missing convenience/business columns referenced by code/tests.
- Add soft delete support where requested (deleted_at on substitute_groups).
- Add category column to item_master (simple text classification) to satisfy code expectations.
- Make changes idempotent (safe to run multiple times in CI).

Key fixes:
1. production_lots:
   - Ensure created_by column exists (legacy code/tests expect either created_by or user_id).
   - Ensure worst_case_estimated_cost column exists (used by costing logic/tests).
   - Replace inconsistent status CHECK with unified, case-insensitive constraint allowing all variants seen in code/tests.
2. item_master:
   - Add category TEXT column if missing.
3. substitute_groups:
   - Add deleted_at TIMESTAMP for soft deletes.
4. General:
   - Preserve existing data; no destructive rewrites.

Status values permitted (case-insensitive):
  planning, ready, in progress, in_progress, active, inactive, draft,
  completed, failed, cancelled, archived

Down migration attempts to revert added columns & constraint only (non-destructive to pre-existing different schema definitions).
\n+Resilience Addendum (2025-11-08):\n+Previously this migration failed when `production_lots` did not yet exist in CI/dev environments, aborting the transaction and preventing later fixes. All ALTER / INDEX / CONSTRAINT operations are now wrapped in DO blocks that first verify the table exists. This makes the migration safe to run before the base UPF tables are applied; it will simply skip missing tables and can be re-run after they are created to apply deferred changes. The companion SQL file `migration_fix_schema_nov2025.sql` was updated similarly.\n+
"""

import os
import psycopg2

# TEST_DB_* takes priority so this migration never touches the production
# database when invoked from the test harness (tests/conftest.py), which
# runs migrations against a dedicated test database.
DB_NAME = os.getenv("TEST_DB_NAME", os.getenv("DB_NAME", os.getenv("POSTGRES_DB", "MTC")))
DB_USER = os.getenv("TEST_DB_USER", os.getenv("DB_USER", os.getenv("POSTGRES_USER", "postgres")))
DB_HOST = os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1"))
DB_PORT = os.getenv("DB_PORT", "5432")
DB_PASSWORD = os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", os.getenv("POSTGRES_PASSWORD", "abcd")))


def get_conn():
    return psycopg2.connect(
        dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD, host=DB_HOST, port=DB_PORT
    )


STATUS_VALUES = [
    "planning",
    "ready",
    "in progress",  # legacy spaced form
    "in_progress",  # snake form
    "active",
    "inactive",
    "draft",
    "completed",
    "failed",
    "cancelled",
    "archived",
]


def up():
    conn = get_conn()
    cur = conn.cursor()
    try:
        # 1. Add missing columns (idempotent) -------------------------------
        # Make production_lots changes only if the table exists to avoid aborting the migration.
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'production_lots'
                ) THEN
                    EXECUTE 'ALTER TABLE production_lots ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL';
                    EXECUTE 'ALTER TABLE production_lots ADD COLUMN IF NOT EXISTS worst_case_estimated_cost NUMERIC(12,2)';
                END IF;
            END$$;
            """
        )
        # Guard item_master and substitute_groups as well for resilience in CI
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'item_master'
                ) THEN
                    EXECUTE 'ALTER TABLE item_master ADD COLUMN IF NOT EXISTS category TEXT';
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'substitute_groups'
                ) THEN
                    EXECUTE 'ALTER TABLE substitute_groups ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP';
                END IF;
            END$$;
            """
        )

        # 1b. Note: import_jobs FK handling removed
        # The import_jobs table creation already includes the FK constraint on user_id.
        # No additional FK manipulation needed here to avoid duplicate constraints.

        # 2. Normalize status constraint on production_lots -----------------
        # Drop and recreate status constraint only if production_lots exists
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'production_lots'
                ) THEN
                    IF EXISTS (
                        SELECT 1 FROM pg_constraint c
                        JOIN pg_class t ON c.conrelid = t.oid
                        WHERE t.relname = 'production_lots' AND c.conname = 'production_lots_status_check'
                    ) THEN
                        EXECUTE 'ALTER TABLE production_lots DROP CONSTRAINT production_lots_status_check';
                    END IF;
                    -- Create new robust constraint (case-insensitive)
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint c
                        JOIN pg_class t ON c.conrelid = t.oid
                        WHERE t.relname = 'production_lots' AND c.conname = 'production_lots_status_check'
                    ) THEN
                        EXECUTE $DDL$
                        ALTER TABLE production_lots
                        ADD CONSTRAINT production_lots_status_check
                        CHECK (lower(status) IN (
                            'planning','ready','in progress','in_progress','active','inactive','draft','completed','failed','cancelled','archived'
                        ));
                        $DDL$;
                    END IF;
                END IF;
            END$$;
            """
        )

        # 3. Helpful indexes (only if not exists) --------------------------
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables WHERE table_name='substitute_groups'
                ) THEN
                    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_substitute_groups_deleted_at ON substitute_groups(deleted_at) WHERE deleted_at IS NULL';
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables WHERE table_name='item_master'
                ) THEN
                    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_item_master_category ON item_master(category)';
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables WHERE table_name='production_lots'
                ) THEN
                    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_production_lots_status ON production_lots(status)';
                END IF;
            END$$;
            """
        )

        # 5. Align schema with production (source of truth: live DB schema).
        # Earlier migrations created columns/constraints that production never
        # had, breaking fresh databases built from migrations alone.
        # 5a. cost_items: production uses `amount`; the UPF migration created
        #     `rate_per_unit`. Application code queries ci.amount.
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'cost_items' AND column_name = 'rate_per_unit'
                ) AND NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'cost_items' AND column_name = 'amount'
                ) THEN
                    EXECUTE 'ALTER TABLE cost_items RENAME COLUMN rate_per_unit TO amount';
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'cost_items'
                ) THEN
                    EXECUTE 'ALTER TABLE cost_items ADD COLUMN IF NOT EXISTS unit VARCHAR(20)';
                    EXECUTE 'ALTER TABLE cost_items ALTER COLUMN quantity DROP NOT NULL';
                END IF;
            END$$;
            """
        )

        # 5b. stock_receipts: init_schema.sql created a minimal table, so the
        #     CREATE TABLE IF NOT EXISTS in migration_add_stock_receipts never
        #     added the supplier/billing columns production has.
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'stock_receipts'
                ) THEN
                    EXECUTE 'ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(supplier_id)';
                    EXECUTE 'ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS bill_number VARCHAR(255)';
                    EXECUTE 'ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10,2)';
                    EXECUTE 'ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS tax_percentage NUMERIC(5,2)';
                    EXECUTE 'ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS grand_total NUMERIC(10,2)';
                    EXECUTE 'ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS discount_percentage NUMERIC(10,2) DEFAULT 0';
                    EXECUTE 'ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) DEFAULT 0';
                END IF;
            END$$;
            """
        )

        # 5c. user_id NOT NULL: production's processes/subprocesses/
        #     production_lots use nullable created_by; the application inserts
        #     rows without user_id. Relax the NOT NULL the UPF migration added.
        cur.execute(
            """
            DO $$
            DECLARE
                t TEXT;
            BEGIN
                FOREACH t IN ARRAY ARRAY['processes', 'subprocesses', 'production_lots']
                LOOP
                    IF EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = t AND column_name = 'user_id'
                          AND is_nullable = 'NO'
                    ) THEN
                        EXECUTE format('ALTER TABLE %I ALTER COLUMN user_id DROP NOT NULL', t);
                    END IF;
                END LOOP;
            END$$;
            """
        )

        conn.commit()
        print("✅ migration_fix_schema_nov2025.up completed")
    except Exception as e:
        conn.rollback()
        print(f"❌ migration_fix_schema_nov2025.up failed: {e}")
        raise
    finally:
        cur.close()
        conn.close()


def down():
    conn = get_conn()
    cur = conn.cursor()
    try:
        # Attempt to remove added constraint & columns (safe if present)
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM pg_constraint c JOIN pg_class t ON c.conrelid = t.oid
                    WHERE t.relname='production_lots' AND c.conname='production_lots_status_check'
                ) THEN
                    EXECUTE 'ALTER TABLE production_lots DROP CONSTRAINT production_lots_status_check';
                END IF;
            END$$;
            """
        )
        cur.execute(
            "ALTER TABLE IF EXISTS production_lots DROP COLUMN IF EXISTS worst_case_estimated_cost;"
        )
        cur.execute(
            "ALTER TABLE IF EXISTS production_lots DROP COLUMN IF EXISTS created_by;"
        )
        cur.execute("ALTER TABLE IF EXISTS item_master DROP COLUMN IF EXISTS category;")
        cur.execute(
            "ALTER TABLE IF EXISTS substitute_groups DROP COLUMN IF EXISTS deleted_at;"
        )

        conn.commit()
        print("✅ migration_fix_schema_nov2025.down completed")
    except Exception as e:
        conn.rollback()
        print(f"❌ migration_fix_schema_nov2025.down failed: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "down":
        down()
    else:
        up()


# Compatibility with migrations orchestrator expecting upgrade()/downgrade()
def upgrade():  # noqa: D401
    """Apply schema fixes (delegates to up())."""
    up()


def downgrade():  # noqa: D401
    """Revert schema fixes (delegates to down())."""
    down()
