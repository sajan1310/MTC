#!/usr/bin/env python
import os, sys
os.chdir('c:\\Users\\erkar\\OneDrive\\Desktop\\MTC\\Project-root')
sys.path.insert(0, os.getcwd())
from app import create_app; from database import get_conn

app = create_app()
with app.app_context():
    with get_conn() as (conn, cur):
        # Check if table exists
        cur.execute("""
            SELECT EXISTS(
                SELECT 1 FROM information_schema.tables 
                WHERE table_schema='public' AND table_name='production_lot_subprocess_variants'
            )
        """)
        exists = cur.fetchone()[0]
        print(f"production_lot_subprocess_variants exists: {exists}")
        
        if not exists:
            print("\nCreating table...")
            try:
                cur.execute("""
                    CREATE TABLE production_lot_subprocess_variants (
                        id SERIAL PRIMARY KEY,
                        lot_id INTEGER REFERENCES production_lots(id) ON DELETE CASCADE,
                        process_subprocess_id INTEGER REFERENCES process_subprocesses(id) ON DELETE CASCADE,
                        variant_usage_id INTEGER REFERENCES variant_usage(id) ON DELETE CASCADE,
                        quantity_override NUMERIC(12, 4),
                        notes TEXT,
                        created_by INTEGER REFERENCES users(id),
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                conn.commit()
                print("SUCCESS: Table created")
            except Exception as e:
                print(f"ERROR: {e}")
