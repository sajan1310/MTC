#!/usr/bin/env python
"""Check production_lot_subprocesses structure."""

import os
import sys

os.chdir('c:\\Users\\erkar\\OneDrive\\Desktop\\MTC\\Project-root')
sys.path.insert(0, os.getcwd())

from app import create_app
from database import get_conn

try:
    # Create app context
    app = create_app()
    
    with app.app_context():
        with get_conn() as (conn, cur):
            # Check production_lot_subprocesses structure
            print("production_lot_subprocesses columns:")
            cur.execute("""
                SELECT column_name, data_type, is_nullable
                FROM information_schema.columns 
                WHERE table_name='production_lot_subprocesses' 
                ORDER BY ordinal_position
            """)
            for row in cur.fetchall():
                print(f"  - {row[0]}: {row[1]} (nullable: {row[2]})")
        
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
