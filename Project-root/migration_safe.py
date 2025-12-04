#!/usr/bin/env python
"""Create missing tables with better error handling."""

import os
import sys

os.chdir('c:\\Users\\erkar\\OneDrive\\Desktop\\MTC\\Project-root')
sys.path.insert(0, os.getcwd())

from app import create_app
from database import get_conn

try:
    app = create_app()
    
    with app.app_context():
        with get_conn() as (conn, cur):
            print("[1] Creating production_lot_subprocess_variants table...")
            try:
                cur.execute("""
                    DROP TABLE IF EXISTS production_lot_subprocess_variants CASCADE;
                """)
                print("    Dropped existing table")
            except:
                pass
            
            cur.execute("""
                CREATE TABLE production_lot_subprocess_variants (
                    id SERIAL PRIMARY KEY,
                    lot_id INTEGER NOT NULL REFERENCES production_lots(id),
                    process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id),
                    variant_usage_id INTEGER NOT NULL REFERENCES variant_usage(id),
                    quantity_override NUMERIC(12, 4),
                    notes TEXT,
                    created_by INTEGER REFERENCES users(id),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            print("    OK - Table created")
            
            print("[2] Creating indexes...")
            cur.execute("""
                CREATE INDEX idx_psl_subprocess_variants_lot_id 
                ON production_lot_subprocess_variants(lot_id)
            """)
            print("    OK - Index on lot_id")
            
            cur.execute("""
                CREATE INDEX idx_psl_subprocess_variants_process_subprocess_id 
                ON production_lot_subprocess_variants(process_subprocess_id)
            """)
            print("    OK - Index on process_subprocess_id")
            
            print("[3] Adding columns to production_lot_inventory_alerts...")
            
            # Check which columns already exist
            cur.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_name='production_lot_inventory_alerts'
            """)
            existing_cols = set(r[0] for r in cur.fetchall())
            print(f"    Existing columns: {existing_cols}")
            
            cols_to_add = [
                ("user_acknowledged", "BOOLEAN DEFAULT false"),
                ("user_action", "VARCHAR(50)"),
                ("action_notes", "TEXT"),
                ("acknowledged_at", "TIMESTAMP"),
                ("acknowledged_by", "INTEGER REFERENCES users(id)")
            ]
            
            for col_name, col_def in cols_to_add:
                if col_name not in existing_cols:
                    cur.execute(f"ALTER TABLE production_lot_inventory_alerts ADD COLUMN {col_name} {col_def}")
                    print(f"    OK - Added {col_name}")
                else:
                    print(f"    SKIP - {col_name} already exists")
            
            conn.commit()
            print("\nSUCCESS: All migrations completed!")
        
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
