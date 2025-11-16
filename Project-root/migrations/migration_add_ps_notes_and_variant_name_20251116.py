"""
Migration: add process_subprocesses.notes and item_variant.name
Date: 2025-11-16

Adds optional `notes` to `process_subprocesses` and `name` to `item_variant`.
Idempotent and safe to run.
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
        print("Adding process_subprocesses.notes and item_variant.name if missing...")
        try:
            cur.execute(
                """
                ALTER TABLE process_subprocesses
                ADD COLUMN IF NOT EXISTS notes TEXT;
                """
            )

            cur.execute(
                """
                ALTER TABLE item_variant
                ADD COLUMN IF NOT EXISTS name VARCHAR(255);
                """
            )

            conn.commit()
            print("✅ Columns ensured.")
        except Exception as e:
            conn.rollback()
            print(f"❌ Error adding columns: {e}")
            raise


def downgrade():
    with get_conn() as (conn, cur):
        print("Removing columns if present...")
        try:
            cur.execute("ALTER TABLE process_subprocesses DROP COLUMN IF EXISTS notes;")
            cur.execute("ALTER TABLE item_variant DROP COLUMN IF EXISTS name;")
            conn.commit()
            print("✅ Downgrade done.")
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
