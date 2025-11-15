import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Adds 'received_quantity' to purchase_order_items and 'po_id' to stock_receipts.
    """
    with get_conn() as (conn, cur):
        # Add received_quantity to purchase_order_items
        cur.execute(
            """
            ALTER TABLE purchase_order_items
            ADD COLUMN IF NOT EXISTS received_quantity INTEGER DEFAULT 0;
        """
        )

        # Add po_id to stock_receipts
        cur.execute(
            """
            ALTER TABLE stock_receipts
            ADD COLUMN IF NOT EXISTS po_id INTEGER REFERENCES purchase_orders(po_id);
        """
        )

        conn.commit()
        print("Upgrade complete: Added PO tracking columns.")


def downgrade():
    """
    Removes 'received_quantity' from purchase_order_items and 'po_id' from stock_receipts.
    """
    with get_conn() as (conn, cur):
        # Remove received_quantity from purchase_order_items
        cur.execute(
            """
            ALTER TABLE purchase_order_items
            DROP COLUMN IF EXISTS received_quantity;
        """
        )

        # Remove po_id from stock_receipts
        cur.execute(
            """
            ALTER TABLE stock_receipts
            DROP COLUMN IF EXISTS po_id;
        """
        )

        conn.commit()
        print("Downgrade complete: Removed PO tracking columns.")
