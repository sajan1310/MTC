import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'Project-root'))

from app.database import get_conn
import psycopg2.extras
import json

conn, cur = get_conn(cursor_factory=psycopg2.extras.RealDictCursor)
cur.execute("""
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name='production_lots' 
    ORDER BY ordinal_position
""")
columns = [dict(r) for r in cur.fetchall()]
print(json.dumps(columns, indent=2))
cur.close()
conn.close()
