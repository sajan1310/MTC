import psycopg2
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

def upgrade():
    """
    Upgrade script to add PO tracking columns.
    """
    conn = None
    try:
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            raise ValueError("DATABASE_URL environment variable not set")

        conn = psycopg2.connect(db_url)
        cur = conn.cursor()

        # Add received_quantity to purchase_order_items
        cur.execute("""
            ALTER TABLE purchase_order_items
            ADD COLUMN received_quantity INTEGER DEFAULT 0;
        """)

        # Add po_id to stock_receipts
        cur.execute("""
            ALTER TABLE stock_receipts
            ADD COLUMN po_id INTEGER REFERENCES purchase_orders(po_id);
        """)

        conn.commit()
        print("Upgrade complete: Added PO tracking columns.")

    except (Exception, psycopg2.DatabaseError) as error:
        print(f"Error during upgrade: {error}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

def downgrade():
    """
    Downgrade script to remove the changes.
    """
    conn = None
    try:
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            raise ValueError("DATABASE_URL environment variable not set")

        conn = psycopg2.connect(db_url)
        cur = conn.cursor()

        # Remove received_quantity from purchase_order_items
        cur.execute("""
            ALTER TABLE purchase_order_items
            DROP COLUMN IF EXISTS received_quantity;
        """)

        # Remove po_id from stock_receipts
        cur.execute("""
            ALTER TABLE stock_receipts
            DROP COLUMN IF EXISTS po_id;
        """)

        conn.commit()
        print("Downgrade complete: Removed PO tracking columns.")

    except (Exception, psycopg2.DatabaseError) as error:
        print(f"Error during downgrade: {error}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        if sys.argv[1] == 'upgrade':
            upgrade()
        elif sys.argv[1] == 'downgrade':
            downgrade()
