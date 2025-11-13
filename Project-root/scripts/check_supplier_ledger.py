import os
import sys
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from migrations.migrations import MockApp
from database import init_app, get_conn

app = MockApp()
init_app(app)
init_app(app)

with get_conn() as (conn, cur):
    cur.execute("SELECT to_regclass('public.supplier_ledger');")
    res = cur.fetchone()
    print('supplier_ledger regclass:', res)

with get_conn() as (conn, cur):
    try:
        cur.execute('SELECT * FROM supplier_ledger LIMIT 5;')
        rows = cur.fetchall()
        print('sample rows (up to 5):')
        for r in rows:
            print(r)
    except Exception as e:
        print('Could not select from supplier_ledger (this may be expected if view not present):', e)

with get_conn() as (conn, cur):
    cur.execute("SELECT table_schema, table_name FROM information_schema.views WHERE table_name = 'supplier_ledger';")
    print('information_schema.views entries:', cur.fetchall())
