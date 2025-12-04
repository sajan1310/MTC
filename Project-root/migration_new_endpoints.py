#!/usr/bin/env python
"""Create missing tables for new endpoints."""

import os
import sys

os.chdir('c:\\Users\\erkar\\OneDrive\\Desktop\\MTC\\Project-root')
sys.path.insert(0, os.getcwd())

from app import create_app
from database import get_conn

migrations = [
    # First: Create the new table
    ("""
    CREATE TABLE IF NOT EXISTS production_lot_subprocess_variants (
        id SERIAL PRIMARY KEY,
        lot_id INTEGER NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
        process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
        variant_usage_id INTEGER NOT NULL REFERENCES variant_usage(id) ON DELETE CASCADE,
        quantity_override NUMERIC(12, 4),
        notes TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """, "Create production_lot_subprocess_variants table"),
    
    # Create indexes
    ("""CREATE INDEX IF NOT EXISTS idx_production_lot_subprocess_variants_lot_id 
        ON production_lot_subprocess_variants(lot_id);""", "Index on lot_id"),
    
    ("""CREATE INDEX IF NOT EXISTS idx_production_lot_subprocess_variants_process_subprocess_id 
        ON production_lot_subprocess_variants(process_subprocess_id);""", "Index on process_subprocess_id"),
    
    # Add columns to alerts table
    ("""ALTER TABLE production_lot_inventory_alerts 
        ADD COLUMN IF NOT EXISTS user_acknowledged BOOLEAN DEFAULT false;""", "Add user_acknowledged column"),
        
    ("""ALTER TABLE production_lot_inventory_alerts
        ADD COLUMN IF NOT EXISTS user_action VARCHAR(50);""", "Add user_action column"),
        
    ("""ALTER TABLE production_lot_inventory_alerts
        ADD COLUMN IF NOT EXISTS action_notes TEXT;""", "Add action_notes column"),
        
    ("""ALTER TABLE production_lot_inventory_alerts
        ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMP;""", "Add acknowledged_at column"),
        
    ("""ALTER TABLE production_lot_inventory_alerts
        ADD COLUMN IF NOT EXISTS acknowledged_by INTEGER REFERENCES users(id);""", "Add acknowledged_by column"),
]

try:
    # Create app context
    app = create_app()
    
    with app.app_context():
        with get_conn() as (conn, cur):
            # Execute each migration step
            for migration_sql, description in migrations:
                try:
                    cur.execute(migration_sql)
                    print(f"[OK] {description}")
                except Exception as step_e:
                    # If column already exists, it's OK
                    if "already exists" in str(step_e) or "duplicate key" in str(step_e):
                        print(f"[SKIP] {description} - already exists")
                    else:
                        raise
                        
            conn.commit()
            print("\nSUCCESS: Migration completed")
        
except Exception as e:
    print(f"ERROR: Migration failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
