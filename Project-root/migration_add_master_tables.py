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

        # --- 1. Create new master tables ---
        print("Creating model_master and variation_master tables...")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS model_master (
                model_id SERIAL PRIMARY KEY,
                model_name VARCHAR(255) UNIQUE NOT NULL
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS variation_master (
                variation_id SERIAL PRIMARY KEY,
                variation_name VARCHAR(255) UNIQUE NOT NULL
            );
        """)
        print("Tables created successfully.")

        # --- 2. Populate master tables with unique, non-empty values ---
        print("Populating master tables with existing data...")
        cur.execute("""
            INSERT INTO model_master (model_name)
            SELECT DISTINCT model FROM item_master WHERE model IS NOT NULL AND model != ''
            ON CONFLICT (model_name) DO NOTHING;
        """)
        cur.execute("""
            INSERT INTO variation_master (variation_name)
            SELECT DISTINCT variation FROM item_master WHERE variation IS NOT NULL AND variation != ''
            ON CONFLICT (variation_name) DO NOTHING;
        """)
        print("Master tables populated.")

        # --- 3. Add foreign key columns to item_master ---
        print("Adding foreign key columns to item_master...")
        cur.execute("ALTER TABLE item_master ADD COLUMN IF NOT EXISTS model_id INTEGER REFERENCES model_master(model_id);")
        cur.execute("ALTER TABLE item_master ADD COLUMN IF NOT EXISTS variation_id INTEGER REFERENCES variation_master(variation_id);")
        print("Foreign key columns added.")

        # --- 4. Update foreign key columns with data from master tables ---
        print("Updating foreign key references in item_master...")
        cur.execute("""
            UPDATE item_master
            SET model_id = model_master.model_id
            FROM model_master
            WHERE item_master.model = model_master.model_name;
        """)
        cur.execute("""
            UPDATE item_master
            SET variation_id = variation_master.variation_id
            FROM variation_master
            WHERE item_master.variation = variation_master.variation_name;
        """)
        print("Foreign key references updated.")

        # --- 5. (Optional but recommended) Remove old columns ---
        print("Removing old model and variation columns from item_master...")
        cur.execute("ALTER TABLE item_master DROP COLUMN IF EXISTS model;")
        cur.execute("ALTER TABLE item_master DROP COLUMN IF EXISTS variation;")
        print("Old columns removed.")

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
