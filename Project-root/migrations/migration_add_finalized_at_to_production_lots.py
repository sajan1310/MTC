"""
Migration: add finalized_at column to production_lots
Date: 2025-11-14

Adds an optional `finalized_at` TIMESTAMP column to `production_lots`.
This migration is idempotent and safe to run on existing schemas.
"""

import os
import sys

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from dotenv import load_dotenv

load_dotenv()

from config import get_config
from database import init_app, get_conn


def upgrade():
    with get_conn() as (conn, cur):
        print("Adding finalized_at column to production_lots (if not exists)...")
        try:
            # Safe, idempotent add column
            cur.execute(
                """
                ALTER TABLE production_lots
                ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMP;
                """
            )

            # Optional: add index to speed queries filtering by finalized_at
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_production_lots_finalized_at ON production_lots(finalized_at);"
            )

            conn.commit()
            print("✅ finalized_at column added (or already present).")
        except Exception as e:
            conn.rollback()
            print(f"❌ Error adding finalized_at column: {e}")
            raise


def downgrade():
    with get_conn() as (conn, cur):
        print("Removing finalized_at column from production_lots (if exists)...")
        try:
            cur.execute(
                """
                ALTER TABLE production_lots
                DROP COLUMN IF EXISTS finalized_at;
                """
            )
            cur.execute("DROP INDEX IF EXISTS idx_production_lots_finalized_at;")
            conn.commit()
            print("✅ finalized_at column removed (if it existed).")
        except Exception as e:
            conn.rollback()
            print(f"❌ Error removing finalized_at column: {e}")
            raise


if __name__ == "__main__":
    # Initialize DB pool using project config so get_conn() works
    try:
        cfg_class = get_config()

        # Build a minimal app-like object expected by database.init_app
        class _MockApp:
            def __init__(self, cfg):
                # expose a mapping-like config with .get
                self.config = {k: getattr(cfg, k) for k in dir(cfg) if k.isupper()}

                # simple logger
                class _Logger:
                    def info(self, *a, **k):
                        print("INFO:", *a)

                    def warning(self, *a, **k):
                        print("WARN:", *a)

                    def error(self, *a, **k):
                        print("ERROR:", *a)

                    def critical(self, *a, **k):
                        print("CRITICAL:", *a)

                self.logger = _Logger()

        app = _MockApp(cfg_class)
        # Allow Config.apply_database_url side-effects to populate DB_* fields
        # (get_config already applied apply_database_url on the class)
        init_app(app)
    except Exception as e:
        print(f"WARNING: Could not initialize DB pool before running migration: {e}")
        # Proceeding may still work if DB pool is not strictly required in TESTING mode

    upgrade()
