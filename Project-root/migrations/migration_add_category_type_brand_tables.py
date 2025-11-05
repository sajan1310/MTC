import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Creates master tables for item categories, types, and brands.
    """
    with get_conn() as (conn, cur):
        # Create master tables
        cur.execute("""
            CREATE TABLE IF NOT EXISTS item_category_master (
                item_category_id SERIAL PRIMARY KEY,
                item_category_name VARCHAR(255) UNIQUE NOT NULL
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS item_type_master (
                item_type_id SERIAL PRIMARY KEY,
                item_type_name VARCHAR(255) UNIQUE NOT NULL
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS item_brand_master (
                item_brand_id SERIAL PRIMARY KEY,
                item_brand_name VARCHAR(255) UNIQUE NOT NULL
            );
        """)

        # Add foreign key columns to item_master
        cur.execute(
            "ALTER TABLE item_master ADD COLUMN IF NOT EXISTS item_category_id INTEGER REFERENCES item_category_master(item_category_id);"
        )
        cur.execute(
            "ALTER TABLE item_master ADD COLUMN IF NOT EXISTS item_type_id INTEGER REFERENCES item_type_master(item_type_id);"
        )
        cur.execute(
            "ALTER TABLE item_master ADD COLUMN IF NOT EXISTS item_brand_id INTEGER REFERENCES item_brand_master(item_brand_id);"
        )

        conn.commit()
        print("Upgrade complete: Category, Type, and Brand master tables created.")


def downgrade():
    """
    Removes the master tables for item categories, types, and brands.
    """
    with get_conn() as (conn, cur):
        # Remove foreign key columns from item_master
        cur.execute("ALTER TABLE item_master DROP COLUMN IF EXISTS item_category_id;")
        cur.execute("ALTER TABLE item_master DROP COLUMN IF EXISTS item_type_id;")
        cur.execute("ALTER TABLE item_master DROP COLUMN IF EXISTS item_brand_id;")

        # Drop master tables
        cur.execute("DROP TABLE IF EXISTS item_category_master;")
        cur.execute("DROP TABLE IF EXISTS item_type_master;")
        cur.execute("DROP TABLE IF EXISTS item_brand_master;")

        conn.commit()
        print("Downgrade complete: Category, Type, and Brand master tables removed.")
