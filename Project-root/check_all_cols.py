#!/usr/bin/env python
import os, sys
os.chdir('c:\\Users\\erkar\\OneDrive\\Desktop\\MTC\\Project-root')
sys.path.insert(0, os.getcwd())
from app import create_app; from database import get_conn

app = create_app()
with app.app_context():
    with get_conn() as (conn, cur):
        for table in ['variant_usage', 'process_subprocesses', 'production_lots']:
            cur.execute(f"SELECT column_name, data_type FROM information_schema.columns WHERE table_name='{table}' ORDER BY ordinal_position")
            print(f"\n{table}:")
            for r in cur.fetchall():
                print(f"  {r[0]}: {r[1]}")
