"""
Migration 001: Create Migration Tracking Table

This is the first migration and sets up the migrations_applied table
that tracks which migrations have been applied.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure project root is on path
sys.path.insert(0, str(Path(__file__).parent.parent))

import database


def upgrade() -> None:
    """Create migrations_applied table for tracking applied migrations."""
    with database.get_conn() as (conn, cur):
        # Create the migrations tracking table
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS migrations_applied (
                id SERIAL PRIMARY KEY,
                migration_name VARCHAR(255) NOT NULL UNIQUE,
                applied_at TIMESTAMP DEFAULT NOW(),
                status VARCHAR(50) DEFAULT 'completed',
                error_message TEXT
            );
            
            CREATE INDEX IF NOT EXISTS idx_migrations_applied_status 
            ON migrations_applied(status);
            """
        )
        conn.commit()
        print("[OK] Created migrations_applied table")


if __name__ == "__main__":
    upgrade()
