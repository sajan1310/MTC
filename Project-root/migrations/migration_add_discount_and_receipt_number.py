import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Adds 'discount_amount' and 'receipt_number' columns to the stock_receipts table.
    """
    with get_conn() as (conn, cur):
        # Add discount_amount and receipt_number columns
        cur.execute("""
            ALTER TABLE stock_receipts
            ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10, 2) DEFAULT 0,
            ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(255);
        """)

        # Add a sequence for the receipt number
        cur.execute("CREATE SEQUENCE IF NOT EXISTS stock_receipt_number_seq;")

        conn.commit()
        print("Upgrade complete: Added discount and receipt number to stock_receipts.")


def downgrade():
    """
    Removes 'discount_amount' and 'receipt_number' columns and the sequence.
    """
    with get_conn() as (conn, cur):
        # Remove the columns
        cur.execute("""
            ALTER TABLE stock_receipts
            DROP COLUMN IF EXISTS discount_amount,
            DROP COLUMN IF EXISTS receipt_number;
        """)

        # Drop the sequence
        cur.execute("DROP SEQUENCE IF EXISTS stock_receipt_number_seq;")

        conn.commit()
        print(
            "Downgrade complete: Removed discount and receipt number from stock_receipts."
        )
