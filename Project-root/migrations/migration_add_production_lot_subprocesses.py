"""
Database Migration: Add Production Lot Subprocess Tracking

This migration adds proper tracking of subprocesses selected for each production lot,
enabling the subprocess-to-production-lot linkage workflow.

NEW TABLE: production_lot_subprocesses
- Links production lots to the specific subprocesses they need to execute
- Supports status tracking for each subprocess in the lot
- Enables workflow management (Planning -> Ready -> In Progress -> Completed)

CONTEXT:
Previously, the system only tracked which variants were selected from substitute groups.
This migration adds explicit tracking of which subprocesses must be executed for each lot.

This is critical for:
1. Validating that all required subprocesses are addressed before lot execution
2. Supporting parallel subprocess execution tracking
3. Supporting per-subprocess status transitions
4. Enabling proper data aggregation and reporting
"""


def upgrade():
    """Create production_lot_subprocesses table and related supporting structures."""
    import database
    import psycopg2.extras

    with database.get_conn() as (conn, cur):
        # Create the new table for subprocess tracking
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS production_lot_subprocesses (
                id SERIAL PRIMARY KEY,
                production_lot_id INTEGER NOT NULL,
                process_subprocess_id INTEGER NOT NULL,
                status VARCHAR(50) DEFAULT 'Planning',
                started_at TIMESTAMP,
                completed_at TIMESTAMP,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                
                FOREIGN KEY (production_lot_id) REFERENCES production_lots(id) ON DELETE CASCADE,
                FOREIGN KEY (process_subprocess_id) REFERENCES process_subprocesses(id),
                UNIQUE(production_lot_id, process_subprocess_id)
            )
            """
        )

        # Create index for faster queries
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_prod_lot_subprocess_lot
            ON production_lot_subprocesses(production_lot_id)
            """
        )

        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_prod_lot_subprocess_status
            ON production_lot_subprocesses(status)
            """
        )

        conn.commit()

        print("✓ Created production_lot_subprocesses table")


def downgrade():
    """Drop the production_lot_subprocesses table."""
    import database

    with database.get_conn() as (conn, cur):
        cur.execute("DROP TABLE IF EXISTS production_lot_subprocesses CASCADE")
        conn.commit()

        print("✓ Dropped production_lot_subprocesses table")


# Script to run migration manually
if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
