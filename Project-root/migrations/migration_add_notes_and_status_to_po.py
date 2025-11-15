import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Adds 'notes' and 'status' columns to the purchase_orders table.
    """
    with get_conn() as (conn, cur):
        cur.execute(
            """
            ALTER TABLE purchase_orders
            ADD COLUMN IF NOT EXISTS notes TEXT,
            ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Draft' NOT NULL;
        """
        )
        conn.commit()
        print("Upgrade complete: Added notes and status to purchase_orders.")


def downgrade():
    """
    Removes 'notes' and 'status' columns from the purchase_orders table.
    """
    with get_conn() as (conn, cur):
        cur.execute(
            """
            ALTER TABLE purchase_orders
            DROP COLUMN IF EXISTS notes,
            DROP COLUMN IF EXISTS status;
        """
        )
        conn.commit()
        print("Downgrade complete: Removed notes and status from purchase_orders.")
