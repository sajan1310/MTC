import os
import psycopg2
from dotenv import load_dotenv

load_dotenv()

def run_sql_file(filepath):
    """Execute SQL migration file."""
    conn = None
    try:
        conn = psycopg2.connect(
            host=os.environ.get('DB_HOST', '127.0.0.1'),
            database=os.environ.get('DB_NAME', 'MTC'),
            user=os.environ.get('DB_USER', 'postgres'),
            password=os.environ.get('DB_PASS')
        )
        cur = conn.cursor()
        
        print(f"Running migration: {filepath}")
        with open(filepath, 'r') as f:
            sql = f.read()
            cur.execute(sql)
        
        conn.commit()
        print("✅ Migration completed successfully!")
        
        # Show created indexes
        cur.execute("""
            SELECT tablename, indexname 
            FROM pg_indexes 
            WHERE schemaname = 'public' 
            ORDER BY tablename, indexname
        """)
        print("\n📊 Database Indexes:")
        for row in cur.fetchall():
            print(f"  - {row[0]}.{row[1]}")
            
    except Exception as e:
        print(f"❌ Migration failed: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

if __name__ == '__main__':
    script_dir = os.path.dirname(os.path.abspath(__file__))
    sql_file = os.path.join(script_dir, 'add_indexes.sql')
    run_sql_file(sql_file)
