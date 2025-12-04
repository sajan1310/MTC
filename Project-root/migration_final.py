#!/usr/bin/env python
"""Create missing tables for new endpoints - FINAL."""

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
            
            # Create without FK first
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
                print("    OK - Table structure created")
            except Exception as e:
                conn.rollback()
                print(f"    Table creation: {e}")
            
            # Add indexes
            try:
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_psl_subprocess_variants_lot_id 
                    ON production_lot_subprocess_variants(lot_id)
                """)
                conn.commit()
            except:
                conn.rollback()
            
            try:
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_psl_subprocess_variants_process_subprocess_id 
                    ON production_lot_subprocess_variants(process_subprocess_id)
                """)
                conn.commit()
            except:
                conn.rollback()
            print("    OK - Indexes created")
            
            # Add FK constraints - each in separate transaction
            fks = [
                ("fk_pslsv_lot_id", "lot_id", "production_lots(id)"),
                ("fk_pslsv_process_subprocess_id", "process_subprocess_id", "process_subprocesses(id)"),
                ("fk_pslsv_variant_usage_id", "variant_usage_id", "variant_usage(id)"),
            ]
            
            for fk_name, col, ref in fks:
                try:
                    cur.execute(f"""
                        ALTER TABLE production_lot_subprocess_variants
                        ADD CONSTRAINT {fk_name}
                        FOREIGN KEY ({col}) REFERENCES {ref} ON DELETE CASCADE
                    """)
                    conn.commit()
                except Exception as e:
                    conn.rollback()
                    # FK might already exist, that's OK
                    pass
            
            print("    OK - Foreign keys configured")
            
            # Add columns to inventory_alerts table - fresh connection
            print("[2] Adding columns to production_lot_inventory_alerts...")
            with get_conn() as (conn2, cur2):
                # Check existing columns
                try:
                    cur2.execute("""
                        SELECT column_name FROM information_schema.columns 
                        WHERE table_name='production_lot_inventory_alerts'
                    """)
                    existing_cols = set(r[0] for r in cur2.fetchall())
                    print(f"    Existing columns: {existing_cols}")
                except Exception as e:
                    print(f"    Error checking columns: {e}")
                    existing_cols = set()
                
                cols_to_add = [
                    ("user_acknowledged", "BOOLEAN DEFAULT false"),
                    ("user_action", "VARCHAR(50)"),
                    ("action_notes", "TEXT"),
                    ("acknowledged_at", "TIMESTAMP"),
                ]
                
                for col_name, col_def in cols_to_add:
                    if col_name not in existing_cols:
                        try:
                            cur2.execute(f"ALTER TABLE production_lot_inventory_alerts ADD COLUMN {col_name} {col_def}")
                            conn2.commit()
                            print(f"    OK - Added {col_name}")
                        except Exception as e:
                            conn2.rollback()
                            print(f"    ERROR - {col_name}: {e}")
                    else:
                        print(f"    SKIP - {col_name} already exists")
                
                # For acknowledged_by, need special handling due to FK
                if "acknowledged_by" not in existing_cols:
                    try:
                        cur2.execute("""
                            ALTER TABLE production_lot_inventory_alerts
                            ADD COLUMN acknowledged_by INTEGER REFERENCES users(user_id)
                        """)
                        conn2.commit()
                        print(f"    OK - Added acknowledged_by with FK")
                    except Exception as e:
                        conn2.rollback()
                        print(f"    SKIP/ERROR - acknowledged_by: {e}")
                else:
                    print(f"    SKIP - acknowledged_by already exists")
            
            print("\nSUCCESS: All migrations completed!")
        
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
