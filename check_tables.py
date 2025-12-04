#!/usr/bin/env python
"""Check if required tables exist for new endpoints."""

import sys
sys.path.insert(0, 'c:\\Users\\erkar\\OneDrive\\Desktop\\MTC')

from database import get_conn
from psycopg2.extras import RealDictCursor

try:
    with get_conn(cursor_factory=RealDictCursor) as (conn, cur):
        # Check required tables
        required_tables = [
            'production_lot_subprocesses',
            'production_lot_subprocess_variants',
            'inventory_alerts'
        ]
        
        for table in required_tables:
            cur.execute("""
                SELECT EXISTS(
                    SELECT 1 FROM information_schema.tables 
                    WHERE table_schema='public' AND table_name=%s
                )
            """, (table,))
            exists = cur.fetchone()[0]
            status = "✓ EXISTS" if exists else "✗ MISSING"
            print(f"{table}: {status}")
        
        # Get all tables
        cur.execute("""
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema='public' ORDER BY table_name
        """)
        
        print("\nAll public tables:")
        for row in cur.fetchall():
            print(f"  - {row['table_name']}")

except Exception as e:
    print(f"Error: {e}")
    sys.exit(1)
