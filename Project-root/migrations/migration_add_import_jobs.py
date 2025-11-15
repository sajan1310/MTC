"""
Migration: Add import_jobs table for background import processing
Created: 2024-11-01
Purpose: Create table to track background import jobs for large import operations

This migration:
1. Creates import_jobs table with status tracking
2. Adds indexes for efficient job queries
3. Supports queuing, processing, and completion states
"""

from database import get_conn


def upgrade():
    """
    Creates import_jobs table for tracking background import operations.
    """
    with get_conn() as (conn, cur):
        print("Creating import_jobs table...")

        # Create import_jobs table
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS import_jobs (
                id SERIAL PRIMARY KEY,
                import_id UUID UNIQUE NOT NULL,
                user_id INTEGER NOT NULL,
                table_name VARCHAR(100) NOT NULL,
                total_rows INTEGER NOT NULL DEFAULT 0,
                processed_rows INTEGER NOT NULL DEFAULT 0,
                failed_rows INTEGER NOT NULL DEFAULT 0,
                status VARCHAR(50) NOT NULL DEFAULT 'pending',
                error_message TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                updated_at TIMESTAMP DEFAULT NOW(),
                CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT chk_status CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'))
            );
        """
        )
        print("✅ Created import_jobs table")

        # Create indexes for efficient queries
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_import_jobs_import_id
            ON import_jobs(import_id);
        """
        )
        print("✅ Created index on import_jobs(import_id)")

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_import_jobs_user_id
            ON import_jobs(user_id);
        """
        )
        print("✅ Created index on import_jobs(user_id)")

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_import_jobs_status
            ON import_jobs(status)
            WHERE status IN ('pending', 'processing');
        """
        )
        print("✅ Created index on import_jobs(status)")

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_import_jobs_created_at
            ON import_jobs(created_at DESC);
        """
        )
        print("✅ Created index on import_jobs(created_at)")

        # Create import_results table to store detailed results
        # Create import_results table. The foreign key to import_jobs(import_id) is added
        # conditionally below to avoid failing when an existing import_jobs table has
        # a mismatched column type (e.g., varchar vs uuid) in legacy schemas.
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS import_results (
                id SERIAL PRIMARY KEY,
                import_id UUID UNIQUE NOT NULL,
                processed INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0,
                skipped INTEGER NOT NULL DEFAULT 0,
                success_rate DECIMAL(5, 2),
                duration_seconds DECIMAL(10, 2),
                failed_rows JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            );
        """
        )
        print("✅ Created import_results table (FK added conditionally)")

        # Conditionally add FK constraint only if import_jobs.import_id exists and is of type uuid
        cur.execute(
            """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name = 'import_jobs' AND column_name = 'import_id'
                       AND data_type = 'uuid') THEN
                BEGIN
                    ALTER TABLE import_results
                      ADD CONSTRAINT fk_import FOREIGN KEY (import_id) REFERENCES import_jobs(import_id) ON DELETE CASCADE;
                EXCEPTION WHEN duplicate_object THEN
                    -- constraint already exists; ignore
                    NULL;
                END;
            END IF;
        END
        $$;
        """
        )

        # Create index on import_results
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_import_results_import_id
            ON import_results(import_id);
        """
        )
        print("✅ Created index on import_results(import_id)")

        # Create trigger to update updated_at timestamp
        cur.execute(
            """
            CREATE OR REPLACE FUNCTION update_import_jobs_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        """
        )

        cur.execute(
            """
            DROP TRIGGER IF EXISTS trigger_update_import_jobs_updated_at ON import_jobs;
        """
        )

        cur.execute(
            """
            CREATE TRIGGER trigger_update_import_jobs_updated_at
            BEFORE UPDATE ON import_jobs
            FOR EACH ROW
            EXECUTE FUNCTION update_import_jobs_updated_at();
        """
        )
        print("✅ Created trigger for updated_at timestamp")

        conn.commit()
        print("\n✅ Migration completed successfully!")
        print("   import_jobs table created for background import processing")


def downgrade():
    """
    Removes the import_jobs and import_results tables.
    """
    with get_conn() as (conn, cur):
        print("Removing import_jobs infrastructure...")

        # Drop trigger
        cur.execute(
            "DROP TRIGGER IF EXISTS trigger_update_import_jobs_updated_at ON import_jobs;"
        )
        cur.execute("DROP FUNCTION IF EXISTS update_import_jobs_updated_at();")
        print("✅ Dropped trigger and function")

        # Drop tables (import_results first due to foreign key)
        cur.execute("DROP TABLE IF EXISTS import_results CASCADE;")
        print("✅ Dropped import_results table")

        cur.execute("DROP TABLE IF EXISTS import_jobs CASCADE;")
        print("✅ Dropped import_jobs table")

        conn.commit()
        print("\n✅ Downgrade completed: import_jobs infrastructure removed")


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
