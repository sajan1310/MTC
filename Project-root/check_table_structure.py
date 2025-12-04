#!/usr/bin/env python
"""Check table structures."""

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
            # Check variant_usage table
            print("variant_usage columns:")
            cur.execute("""
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name='variant_usage' 
                ORDER BY ordinal_position
            """)
            for row in cur.fetchall():
                print(f"  - {row[0]}: {row[1]}")
            
            # Check inventory_alerts table
            print("\ninventory_alerts columns:")
            cur.execute("""
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name='inventory_alerts' 
                ORDER BY ordinal_position
            """)
            for row in cur.fetchall():
                print(f"  - {row[0]}: {row[1]}")
            
            # Check process_subprocesses
            print("\nprocess_subprocesses columns:")
            cur.execute("""
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name='process_subprocesses' 
                ORDER BY ordinal_position
            """)
            for row in cur.fetchall():
                print(f"  - {row[0]}: {row[1]}")
        
except Exception as e:
    print(f"✗ Error: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
