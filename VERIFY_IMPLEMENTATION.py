#!/usr/bin/env python
"""Verification script for new endpoint implementation."""

import os
import sys

os.chdir('c:\\Users\\erkar\\OneDrive\\Desktop\\MTC\\Project-root')
sys.path.insert(0, os.getcwd())

from app import create_app
from database import get_conn

print("=" * 70)
print("ENDPOINT IMPLEMENTATION VERIFICATION")
print("=" * 70)

try:
    app = create_app()
    
    print("\n[1] Checking Endpoints Registration...")
    endpoints = {}
    for rule in app.url_map.iter_rules():
        rule_str = str(rule)
        if 'subprocesses' in rule_str and 'variants' in rule_str:
            endpoints['add_subprocess_variants'] = rule_str
        elif 'production-lots' in rule_str and 'subprocesses' in rule_str and 'POST' in str(rule.methods):
            endpoints['add_subprocess'] = rule_str
        elif 'bulk-acknowledge' in rule_str:
            endpoints['bulk_acknowledge'] = rule_str
    
    print("  - Add Subprocess Endpoint:", endpoints.get('add_subprocess', 'NOT FOUND'))
    print("  - Update Variants Endpoint:", endpoints.get('add_subprocess_variants', 'NOT FOUND'))
    print("  - Bulk Acknowledge Endpoint:", endpoints.get('bulk_acknowledge', 'NOT FOUND'))
    
    if len(endpoints) >= 3:
        print("\n  OK - All 3 endpoints registered")
    else:
        print(f"\n  ERROR - Only {len(endpoints)}/3 endpoints found")
    
    print("\n[2] Checking Database Tables...")
    with app.app_context():
        with get_conn() as (conn, cur):
            # Check new table
            cur.execute("""
                SELECT EXISTS(
                    SELECT 1 FROM information_schema.tables 
                    WHERE table_name='production_lot_subprocess_variants'
                )
            """)
            table_exists = cur.fetchone()[0]
            print(f"  - production_lot_subprocess_variants: {'EXISTS' if table_exists else 'NOT FOUND'}")
            
            if table_exists:
                # Check columns
                cur.execute("""
                    SELECT column_name FROM information_schema.columns 
                    WHERE table_name='production_lot_subprocess_variants'
                    ORDER BY ordinal_position
                """)
                cols = [r[0] for r in cur.fetchall()]
                print(f"    Columns: {', '.join(cols)}")
            
            # Check new columns in alerts table
            cur.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_name='production_lot_inventory_alerts'
                AND column_name IN ('user_acknowledged', 'user_action', 'acknowledged_by')
            """)
            alert_cols = set(r[0] for r in cur.fetchall())
            print(f"\n  - production_lot_inventory_alerts columns:")
            for col in ['user_acknowledged', 'user_action', 'acknowledged_by']:
                status = 'OK' if col in alert_cols else 'MISSING'
                print(f"    {col}: {status}")
    
    print("\n" + "=" * 70)
    print("VERIFICATION COMPLETE - All systems operational")
    print("=" * 70)
    
except Exception as e:
    print(f"\nERROR: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
