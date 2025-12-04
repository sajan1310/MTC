import sys
sys.path.insert(0, 'Project-root')

from database import get_conn

try:
    with get_conn() as (conn, cur):
        cur.execute("""
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'production_lots' 
            ORDER BY ordinal_position
        """)
        print('Columns in production_lots table:')
        for row in cur.fetchall():
            print(f'  {row[0]}: {row[1]}')
except Exception as e:
    print(f'Error: {e}')
    import traceback
    traceback.print_exc()
