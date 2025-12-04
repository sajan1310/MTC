#!/usr/bin/env python
import os, sys
os.chdir('c:\\Users\\erkar\\OneDrive\\Desktop\\MTC\\Project-root')
sys.path.insert(0, os.getcwd())
from app import create_app; from database import get_conn

app = create_app()
with app.app_context():
    with get_conn() as (conn, cur):
        # Check constraints on variant_usage
        print("variant_usage PRIMARY KEY:")
        cur.execute("""
            SELECT constraint_name, constraint_type
            FROM information_schema.table_constraints
            WHERE table_name = 'variant_usage'
        """)
        for row in cur.fetchall():
            print(f"  {row}")
        
        # Try to create the table without FK constraints first
        print("\nAttempting to create table without FKs...")
        try:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS production_lot_subprocess_variants (
                    id SERIAL PRIMARY KEY,
                    lot_id INTEGER,
                    process_subprocess_id INTEGER,
                    variant_usage_id INTEGER,
                    quantity_override NUMERIC(12, 4),
                    notes TEXT,
                    created_by INTEGER,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()
            print("SUCCESS: Table created without FKs")
            
            # Now add FKs one by one
            print("\nAdding FK constraints...")
            fks = [
                ("lot_id", "production_lots", "id"),
                ("process_subprocess_id", "process_subprocesses", "id"),
                ("variant_usage_id", "variant_usage", "id"),
                ("created_by", "users", "id"),
            ]
            
            for col, ref_table, ref_col in fks:
                try:
                    cur.execute(f"""
                        ALTER TABLE production_lot_subprocess_variants
                        ADD CONSTRAINT fk_pslsv_{col}
                        FOREIGN KEY ({col}) REFERENCES {ref_table}({ref_col}) ON DELETE CASCADE
                    """)
                    conn.commit()
                    print(f"  OK - FK on {col} to {ref_table}({ref_col})")
                except Exception as e:
                    print(f"  FAIL - FK on {col}: {e}")
                    conn.rollback()
        except Exception as e:
            print(f"ERROR: {e}")
            conn.rollback()
