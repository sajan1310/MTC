"""
Migration: add production_lots.user_id and populate from created_by if present
Date: 2025-11-16

Adds an optional `user_id` INTEGER column to `production_lots` and
populates it from `created_by` when available to restore compatibility
with older queries that expect `user_id`.
"""

import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from dotenv import load_dotenv

load_dotenv()

from config import get_config
from database import init_app, get_conn


def upgrade():
    with get_conn() as (conn, cur):
        print("Ensuring production_lots.user_id exists and populating from created_by...")
        try:
            cur.execute(
                """
                ALTER TABLE production_lots
                ADD COLUMN IF NOT EXISTS user_id INTEGER;
                """
            )

            # If created_by exists, copy values into user_id for compatibility
            try:
                cur.execute(
                    """
                    UPDATE production_lots
                    SET user_id = created_by
                    WHERE user_id IS NULL AND created_by IS NOT NULL;
                    """
                )
            except Exception:
                # If created_by doesn't exist in this schema, ignore
                pass

            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_production_lots_user_id ON production_lots(user_id);"
            )

            conn.commit()
            print("✅ production_lots.user_id ensured and populated when possible.")
        except Exception as e:
            conn.rollback()
            print(f"❌ Error ensuring production_lots.user_id: {e}")
            raise


def downgrade():
    with get_conn() as (conn, cur):
        print("Removing production_lots.user_id if present...")
        try:
            cur.execute("ALTER TABLE production_lots DROP COLUMN IF EXISTS user_id;")
            cur.execute("DROP INDEX IF EXISTS idx_production_lots_user_id;")
            conn.commit()
            print("✅ Downgrade complete.")
        except Exception as e:
            conn.rollback()
            print(f"❌ Error during downgrade: {e}")
            raise


if __name__ == '__main__':
    try:
        cfg_class = get_config()
        class _MockApp:
            def __init__(self, cfg):
                self.config = {k: getattr(cfg, k) for k in dir(cfg) if k.isupper()}
                class _Logger:
                    def info(self, *a, **k): print('INFO:', *a)
                    def warning(self, *a, **k): print('WARN:', *a)
                    def error(self, *a, **k): print('ERROR:', *a)
                    def critical(self, *a, **k): print('CRITICAL:', *a)
                self.logger = _Logger()
        init_app(_MockApp(cfg_class))
    except Exception as e:
        print(f"WARNING: Could not init DB pool: {e}")
    upgrade()
