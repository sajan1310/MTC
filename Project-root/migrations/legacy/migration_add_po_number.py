import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Adds a 'po_number' column to the purchase_orders table, populates it,
    and adds a unique constraint.
    """
    with get_conn() as (conn, cur):
        # Add po_number column
        cur.execute(
            "ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS po_number VARCHAR(255);"
        )

        # Create a sequence for PO numbers
        cur.execute("CREATE SEQUENCE IF NOT EXISTS purchase_order_number_seq START 1;")

        # Update existing POs
        cur.execute(
            "SELECT po_id FROM purchase_orders WHERE po_number IS NULL ORDER BY po_id;"
        )
        pos = cur.fetchall()
        for po in pos:
            po_id = po[0]
            cur.execute("SELECT nextval('purchase_order_number_seq')")
            seq_val = cur.fetchone()[0]
            po_number = f"PO-{seq_val:04d}"
            cur.execute(
                "UPDATE purchase_orders SET po_number = %s WHERE po_id = %s",
                (po_number, po_id),
            )

        # Add a unique constraint
        cur.execute(
            """
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_po_number') THEN
                    ALTER TABLE purchase_orders ADD CONSTRAINT unique_po_number UNIQUE (po_number);
                END IF;
            END$$;
        """
        )

        conn.commit()
        print("Upgrade complete: Added and populated po_number in purchase_orders.")


def downgrade():
    """
    Removes the 'po_number' column and its sequence from the purchase_orders table.
    """
    with get_conn() as (conn, cur):
        # Remove the po_number column
        cur.execute("ALTER TABLE purchase_orders DROP COLUMN IF EXISTS po_number;")

        # Drop the sequence
        cur.execute("DROP SEQUENCE IF EXISTS purchase_order_number_seq;")

        conn.commit()
        print("Downgrade complete: Removed po_number from purchase_orders.")
