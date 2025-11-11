import sys
sys.path.insert(0, r'c:\Users\erkar\OneDrive\Desktop\MTC\Project-root')

import psycopg2.extras
import database

with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
    cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name='process_subprocesses' ORDER BY ordinal_position")
    columns = [row['column_name'] for row in cur.fetchall()]
    print("process_subprocesses columns:", columns)
