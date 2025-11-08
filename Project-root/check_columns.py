from app import create_app
from database import get_db_connection

app = create_app()
with app.app_context():
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("""
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='process_subprocesses' 
        ORDER BY ordinal_position
    """)
    cols = cur.fetchall()
    print("Columns in process_subprocesses:")
    for col in cols:
        print(f"  - {col[0]}")
    conn.close()
