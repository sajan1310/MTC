import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Creates tables for suppliers, purchase orders, and stock entries.
    """
    with get_conn() as (conn, cur):
        # Suppliers and related tables
        cur.execute("""
            CREATE TABLE IF NOT EXISTS suppliers (
                supplier_id SERIAL PRIMARY KEY,
                firm_name VARCHAR(255) NOT NULL UNIQUE,
                address TEXT,
                gstin VARCHAR(15)
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS supplier_contacts (
                contact_id SERIAL PRIMARY KEY,
                supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE CASCADE,
                contact_name VARCHAR(255) NOT NULL,
                contact_phone VARCHAR(20),
                contact_email VARCHAR(255)
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS supplier_item_rates (
                rate_id SERIAL PRIMARY KEY,
                supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE CASCADE,
                item_id INTEGER NOT NULL REFERENCES item_master(item_id) ON DELETE CASCADE,
                rate NUMERIC(10, 2) NOT NULL,
                UNIQUE(supplier_id, item_id)
            );
        """)

        # Purchase orders and related tables
        cur.execute("""
            CREATE TABLE IF NOT EXISTS purchase_orders (
                po_id SERIAL PRIMARY KEY,
                po_number VARCHAR(50) UNIQUE,
                supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE RESTRICT,
                order_date DATE NOT NULL DEFAULT CURRENT_DATE,
                status VARCHAR(20) NOT NULL DEFAULT 'Draft',
                total_amount NUMERIC(12, 2)
            );
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS purchase_order_items (
                po_item_id SERIAL PRIMARY KEY,
                po_id INTEGER NOT NULL REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
                variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
                quantity INTEGER NOT NULL,
                rate NUMERIC(10, 2) NOT NULL
            );
        """)

        # Stock entries
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
        print("Upgrade complete: Suppliers and PO tables created.")


def downgrade():
    """
    Drops all tables created in the upgrade.
    """
    with get_conn() as (conn, cur):
        cur.execute("DROP TABLE IF EXISTS stock_entries;")
        cur.execute("DROP TABLE IF EXISTS purchase_order_items;")
        cur.execute("DROP TABLE IF EXISTS purchase_orders;")
        cur.execute("DROP TABLE IF EXISTS supplier_item_rates;")
        cur.execute("DROP TABLE IF EXISTS supplier_contacts;")
        cur.execute("DROP TABLE IF EXISTS suppliers;")

        conn.commit()
        print("Downgrade complete: Suppliers and PO tables dropped.")
