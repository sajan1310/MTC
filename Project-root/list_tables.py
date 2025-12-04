#!/usr/bin/env python
"""List all tables."""

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
            # Check all tables
            print("All public tables:")
            cur.execute("""
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema='public' 
                ORDER BY table_name
            """)
            for row in cur.fetchall():
                print(f"  - {row[0]}")
        
except Exception as e:
    print(f"✗ Error: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
