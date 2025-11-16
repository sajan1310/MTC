"""
Migration: ensure variant-related and finalized_at columns exist
Date: 2025-11-16

Adds optional columns that some environments are missing which the
production lot APIs expect. This migration is idempotent and safe to run
on existing schemas. It will add columns only if they do not exist.
"""

import sys
import os
from datetime import datetime

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from dotenv import load_dotenv

load_dotenv()

from config import get_config
from database import init_app, get_conn


def upgrade():
    with get_conn() as (conn, cur):
        print("Ensuring variant-related and finalized columns exist...")
        try:
            # production_lots.finalized_at
            cur.execute(
                """
                ALTER TABLE production_lots
                ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMP;
                """
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_production_lots_finalized_at ON production_lots(finalized_at);"
            )

            # variant_usage.item_id (legacy schema sometimes stored item_id on usage)
            cur.execute(
                """
                ALTER TABLE variant_usage
                ADD COLUMN IF NOT EXISTS item_id INTEGER;
                """
            )

            # item_variant compatibility columns used by some queries
            cur.execute(
                """
                ALTER TABLE item_variant
                ADD COLUMN IF NOT EXISTS item_number VARCHAR(128);
                """
            )
            cur.execute(
                """
                ALTER TABLE item_variant
                ADD COLUMN IF NOT EXISTS description TEXT;
                """
            )
            cur.execute(
                """
                ALTER TABLE item_variant
                ADD COLUMN IF NOT EXISTS unit_price NUMERIC(14,4);
                """
            )

            # Opening stock sometimes stored as numeric; ensure column exists (no-op if present)
            cur.execute(
                """
                ALTER TABLE item_variant
                ADD COLUMN IF NOT EXISTS opening_stock NUMERIC(14,4) DEFAULT 0;
                """
            )

            conn.commit()
            print("✅ Ensured columns added (or already present).")
        except Exception as e:
            conn.rollback()
            print(f"❌ Error ensuring columns: {e}")
            raise


def downgrade():
    with get_conn() as (conn, cur):
        print("Rolling back ensured columns (if they exist)...")
        try:
            cur.execute("ALTER TABLE production_lots DROP COLUMN IF EXISTS finalized_at;")
            cur.execute("DROP INDEX IF EXISTS idx_production_lots_finalized_at;")

            cur.execute("ALTER TABLE variant_usage DROP COLUMN IF EXISTS item_id;")

            cur.execute("ALTER TABLE item_variant DROP COLUMN IF EXISTS item_number;")
            cur.execute("ALTER TABLE item_variant DROP COLUMN IF EXISTS description;")
            cur.execute("ALTER TABLE item_variant DROP COLUMN IF EXISTS unit_price;")
            cur.execute("ALTER TABLE item_variant DROP COLUMN IF EXISTS opening_stock;")

            conn.commit()
            print("✅ Downgrade completed (columns removed if present).")
        except Exception as e:
            conn.rollback()
            print(f"❌ Error during downgrade: {e}")
            raise


if __name__ == "__main__":
    try:
        cfg_class = get_config()

        class _MockApp:
            def __init__(self, cfg):
                self.config = {k: getattr(cfg, k) for k in dir(cfg) if k.isupper()}

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
        init_app(app)
    except Exception as e:
        print(f"WARNING: Could not initialize DB pool before running migration: {e}")

    upgrade()
