import os
import psycopg2
from psycopg2 import pool
from dotenv import load_dotenv

# Load environment variables from a .env file
load_dotenv()

try:
    db_pool = pool.SimpleConnectionPool(
        1, 10,
        host=os.environ.get('DB_HOST', '127.0.0.1'),
        database=os.environ.get('DB_NAME', 'MTC'),
        user=os.environ.get('DB_USER', 'postgres'),
        password=os.environ.get('DB_PASS')
    )
    print("Database connection pool created successfully.")
except psycopg2.OperationalError as e:
    print(f"FATAL: Could not connect to the database: {e}")
    db_pool = None

def migrate():
    if not db_pool:
        print("Cannot migrate, database pool is not available.")
        return

    conn = None
    try:
        conn = db_pool.getconn()
        cur = conn.cursor()
        print("Connection retrieved from pool.")

        # --- 1. Remove the unique constraint from variation_master ---
        print("Removing unique constraint from variation_master table...")
        cur.execute("ALTER TABLE variation_master DROP CONSTRAINT IF EXISTS variation_master_variation_name_key;")
        print("Constraint removed successfully.")

        conn.commit()
        print("\nMigration completed successfully!")

    except Exception as e:
        print(f"\nAn error occurred during migration: {e}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            db_pool.putconn(conn)
            print("Connection returned to pool.")

if __name__ == '__main__':
    migrate()
