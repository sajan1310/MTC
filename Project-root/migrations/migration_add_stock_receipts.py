import sys
import os
from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from database import get_conn

load_dotenv()

def upgrade():
    """
    Creates the stock_receipts table and adds a foreign key to stock_entries.
    """
    with get_conn() as (conn, cur):
        # Create the stock_receipts table
        cur.execute("""
            CREATE TABLE IF NOT EXISTS stock_receipts (
                receipt_id SERIAL PRIMARY KEY,
                bill_number VARCHAR(255),
                supplier_id INTEGER REFERENCES suppliers(supplier_id),
                receipt_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                total_amount NUMERIC(10, 2),
                tax_percentage NUMERIC(5, 2),
                grand_total NUMERIC(10, 2)
            );
        """)

        # Add receipt_id to stock_entries table
        cur.execute("""
            ALTER TABLE stock_entries
            ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES stock_receipts(receipt_id);
        """)
        
        conn.commit()
        print("Upgrade complete: stock_receipts created and stock_entries updated.")

def downgrade():
    """
    Removes the stock_receipts table and the foreign key from stock_entries.
    """
    with get_conn() as (conn, cur):
        # Remove the receipt_id from stock_entries
        cur.execute("""
            ALTER TABLE stock_entries
            DROP COLUMN IF EXISTS receipt_id;
        """)

        # Drop the stock_receipts table
        cur.execute("DROP TABLE IF EXISTS stock_receipts;")
        
        conn.commit()
        print("Downgrade complete: stock_receipts dropped and stock_entries reverted.")
