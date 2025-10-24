import os
import psycopg2
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

def up():
    """Create the new tables for suppliers, purchase orders, and stock entries."""
    conn = None
    try:
        conn = psycopg2.connect(
            host=os.environ.get('DB_HOST'),
            database=os.environ.get('DB_NAME'),
            user=os.environ.get('DB_USER'),
            password=os.environ.get('DB_PASS')
        )
        cur = conn.cursor()
        
        # 1. Suppliers Table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS suppliers (
                supplier_id SERIAL PRIMARY KEY,
                firm_name VARCHAR(255) NOT NULL UNIQUE,
                address TEXT,
                gstin VARCHAR(15)
            );
        """)
        
        # 2. Supplier Contacts Table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS supplier_contacts (
                contact_id SERIAL PRIMARY KEY,
                supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE CASCADE,
                contact_name VARCHAR(255) NOT NULL,
                contact_phone VARCHAR(20),
                contact_email VARCHAR(255)
            );
        """)
        
        # 3. Supplier Item Rates Table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS supplier_item_rates (
                rate_id SERIAL PRIMARY KEY,
                supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE CASCADE,
                item_id INTEGER NOT NULL REFERENCES item_master(item_id) ON DELETE CASCADE,
                rate NUMERIC(10, 2) NOT NULL,
                UNIQUE(supplier_id, item_id)
            );
        """)
        
        # 4. Purchase Orders Table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS purchase_orders (
                po_id SERIAL PRIMARY KEY,
                po_number VARCHAR(50) UNIQUE,
                supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE RESTRICT,
                order_date DATE NOT NULL DEFAULT CURRENT_DATE,
                status VARCHAR(20) NOT NULL DEFAULT 'Draft', -- e.g., Draft, Ordered, Partially Received, Completed
                total_amount NUMERIC(12, 2)
            );
        """)
        
        # 5. Purchase Order Items Table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS purchase_order_items (
                po_item_id SERIAL PRIMARY KEY,
                po_id INTEGER NOT NULL REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
                variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
                quantity INTEGER NOT NULL,
                rate NUMERIC(10, 2) NOT NULL
            );
        """)
        
        # 6. Stock Entries Table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS stock_entries (
                entry_id SERIAL PRIMARY KEY,
                variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
                supplier_id INTEGER REFERENCES suppliers(supplier_id) ON DELETE SET NULL,
                po_id INTEGER REFERENCES purchase_orders(po_id) ON DELETE SET NULL,
                quantity_added INTEGER NOT NULL,
                entry_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                cost_per_unit NUMERIC(10, 2),
                notes TEXT
            );
        """)
        
        conn.commit()
        print("Migration 'up' executed successfully: All tables created.")
        
    except Exception as e:
        if conn:
            conn.rollback()
        print(f"Error during 'up' migration: {e}")
    finally:
        if conn:
            conn.close()

def down():
    """Drop the tables created in the 'up' migration."""
    conn = None
    try:
        conn = psycopg2.connect(
            host=os.environ.get('DB_HOST'),
            database=os.environ.get('DB_NAME'),
            user=os.environ.get('DB_USER'),
            password=os.environ.get('DB_PASS')
        )
        cur = conn.cursor()
        
        # Drop tables in reverse order of creation due to dependencies
        cur.execute("DROP TABLE IF EXISTS stock_entries;")
        cur.execute("DROP TABLE IF EXISTS purchase_order_items;")
        cur.execute("DROP TABLE IF EXISTS purchase_orders;")
        cur.execute("DROP TABLE IF EXISTS supplier_item_rates;")
        cur.execute("DROP TABLE IF EXISTS supplier_contacts;")
        cur.execute("DROP TABLE IF EXISTS suppliers;")
        
        conn.commit()
        print("Migration 'down' executed successfully: All tables dropped.")
        
    except Exception as e:
        if conn:
            conn.rollback()
        print(f"Error during 'down' migration: {e}")
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == 'down':
        down()
    else:
        up()
