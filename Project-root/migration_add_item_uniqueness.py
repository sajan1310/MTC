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

        # --- 1. Drop the old constraint if it exists ---
        print("Dropping old unique constraint if it exists...")
        cur.execute("""
            ALTER TABLE item_master
            DROP CONSTRAINT IF EXISTS unique_item_master_name_model_variation_desc;
        """)
        print("Old constraint dropped.")

        # --- 2. Add the new unique index ---
        print("Adding unique index to item_master table...")
        cur.execute("""
            DROP INDEX IF EXISTS unique_item_master_name_model_variation_desc;
        """)
        cur.execute("""
            CREATE UNIQUE INDEX unique_item_master_name_model_variation_desc
            ON item_master (name, model_id, variation_id, COALESCE(description, ''));
        """)
        print("Index created successfully.")

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
