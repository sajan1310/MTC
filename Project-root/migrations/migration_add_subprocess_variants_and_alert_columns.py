"""
Migration: Add production_lot_subprocess_variants table and alert acknowledgment columns.

Creates:
  - production_lot_subprocess_variants  (tracks per-subprocess variant selections on a lot)
  - Indexes on that table

Adds columns to production_lot_inventory_alerts:
  - user_acknowledged  BOOLEAN
  - user_action        VARCHAR(50)
  - action_notes       TEXT
  - acknowledged_at    TIMESTAMP
  - acknowledged_by    INTEGER (FK → users)
"""

from __future__ import annotations

MIGRATIONS = [
    (
        """
        CREATE TABLE IF NOT EXISTS production_lot_subprocess_variants (
            id                   SERIAL PRIMARY KEY,
            lot_id               INTEGER NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
            process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
            variant_usage_id     INTEGER NOT NULL REFERENCES variant_usage(id) ON DELETE CASCADE,
            quantity_override    NUMERIC(12, 4),
            notes                TEXT,
            created_by           INTEGER REFERENCES users(id),
            created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        """,
        "Create production_lot_subprocess_variants table",
    ),
    (
        """
        CREATE INDEX IF NOT EXISTS idx_plsv_lot_id
            ON production_lot_subprocess_variants(lot_id);
        """,
        "Index production_lot_subprocess_variants(lot_id)",
    ),
    (
        """
        CREATE INDEX IF NOT EXISTS idx_plsv_process_subprocess_id
            ON production_lot_subprocess_variants(process_subprocess_id);
        """,
        "Index production_lot_subprocess_variants(process_subprocess_id)",
    ),
    (
        """
        ALTER TABLE production_lot_inventory_alerts
            ADD COLUMN IF NOT EXISTS user_acknowledged BOOLEAN DEFAULT false;
        """,
        "Add user_acknowledged to production_lot_inventory_alerts",
    ),
    (
        """
        ALTER TABLE production_lot_inventory_alerts
            ADD COLUMN IF NOT EXISTS user_action VARCHAR(50);
        """,
        "Add user_action to production_lot_inventory_alerts",
    ),
    (
        """
        ALTER TABLE production_lot_inventory_alerts
            ADD COLUMN IF NOT EXISTS action_notes TEXT;
        """,
        "Add action_notes to production_lot_inventory_alerts",
    ),
    (
        """
        ALTER TABLE production_lot_inventory_alerts
            ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP;
        """,
        "Add acknowledged_at to production_lot_inventory_alerts",
    ),
    (
        """
        ALTER TABLE production_lot_inventory_alerts
            ADD COLUMN IF NOT EXISTS acknowledged_by INTEGER REFERENCES users(id);
        """,
        "Add acknowledged_by to production_lot_inventory_alerts",
    ),
]


def run(conn, cur):
    """Execute all migration steps."""
    for sql, description in MIGRATIONS:
        try:
            cur.execute(sql)
            print(f"  [OK]   {description}")
        except Exception as e:
            msg = str(e).lower()
            if "already exists" in msg or "duplicate" in msg:
                print(f"  [SKIP] {description} — already exists")
                conn.rollback()
            else:
                print(f"  [FAIL] {description}: {e}")
                raise
    conn.commit()
    print("Migration complete.")


if __name__ == "__main__":
    import os
    import sys

    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

    from app import create_app
    from database import get_conn

    app = create_app()
    with app.app_context():
        with get_conn() as (conn, cur):
            run(conn, cur)
