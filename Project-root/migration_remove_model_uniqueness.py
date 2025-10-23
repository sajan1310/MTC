import os
import psycopg2
from psycopg2 import pool
from dotenv import load_dotenv

# Load environment variables from a .env file
load_dotenv()

# --- Database Setup ---
try:
    db_pool = pool.SimpleConnectionPool(
        1, 2,
        host=os.environ.get('DB_HOST', '127.0.0.1'),
        database=os.environ.get('DB_NAME', 'MTC'),
        user=os.environ.get('DB_USER', 'postgres'),
        password=os.environ.get('DB_PASS')
    )
except psycopg2.OperationalError as e:
    print(f"FATAL: Could not connect to the database: {e}")
    db_pool = None

def get_constraint_name(cur, table_name, column_name):
    """Helper function to find the name of a unique constraint."""
    cur.execute("""
        SELECT constraint_name
        FROM information_schema.table_constraints
        WHERE table_name = %s
          AND constraint_type = 'UNIQUE'
          AND table_schema = 'public'
    """, (table_name,))
    constraints = cur.fetchall()

    for constraint in constraints:
        cur.execute("""
            SELECT column_name
            FROM information_schema.constraint_column_usage
            WHERE table_name = %s
              AND constraint_name = %s
              AND table_schema = 'public'
        """, (table_name, constraint[0]))
        columns = [row[0] for row in cur.fetchall()]
        if column_name in columns:
            return constraint[0]
    return None

def run_migration():
    if not db_pool:
        return

    conn = None
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()

        # Find and drop the unique constraint on model_master(model_name)
        model_constraint_name = get_constraint_name(cur, 'model_master', 'model_name')
        if model_constraint_name:
            print(f"Found unique constraint on model_master: {model_constraint_name}. Dropping it...")
            cur.execute(f"ALTER TABLE model_master DROP CONSTRAINT {model_constraint_name};")
            print("Constraint dropped successfully.")
        else:
            print("No unique constraint found on model_master(model_name). No action needed.")

        conn.commit()
        cur.close()
    except Exception as e:
        print(f"An error occurred during migration: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            db_pool.putconn(conn)

if __name__ == '__main__':
    print("Starting migration to remove unique constraints...")
    run_migration()
    print("Migration finished.")
