import psycopg2
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

def upgrade():
    """
    Upgrade script to add po_number to purchase_orders table.
    """
    conn = None
    try:
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            raise ValueError("DATABASE_URL environment variable not set")

        conn = psycopg2.connect(db_url)
        cur = conn.cursor()

        # Add po_number column if it doesn't exist
        cur.execute("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_orders' AND column_name='po_number') THEN
                    ALTER TABLE purchase_orders ADD COLUMN po_number VARCHAR(255);
                END IF;
            END$$;
        """)

        # Create a sequence for PO numbers
        cur.execute("CREATE SEQUENCE IF NOT EXISTS purchase_order_number_seq START 1;")

        # Update existing POs with a PO number
        cur.execute("SELECT po_id FROM purchase_orders ORDER BY po_id;")
        pos = cur.fetchall()
        for po in pos:
            po_id = po[0]
            cur.execute("SELECT nextval('purchase_order_number_seq')")
            seq_val = cur.fetchone()[0]
            po_number = f"PO-{seq_val:04d}"
            cur.execute("UPDATE purchase_orders SET po_number = %s WHERE po_id = %s", (po_number, po_id))

        # Add a unique constraint
        cur.execute("ALTER TABLE purchase_orders ADD CONSTRAINT unique_po_number UNIQUE (po_number);")

        conn.commit()
        print("Upgrade complete: Added po_number to purchase_orders.")

    except (Exception, psycopg2.DatabaseError) as error:
        print(f"Error during upgrade: {error}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

def downgrade():
    """
    Downgrade script to remove the po_number column.
    """
    conn = None
    try:
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            raise ValueError("DATABASE_URL environment variable not set")

        conn = psycopg2.connect(db_url)
        cur = conn.cursor()

        # Remove the po_number column
        cur.execute("""
            ALTER TABLE purchase_orders
            DROP COLUMN IF EXISTS po_number;
        """)

        # Drop the sequence
        cur.execute("DROP SEQUENCE IF EXISTS purchase_order_number_seq;")

        conn.commit()
        print("Downgrade complete: Removed po_number from purchase_orders.")

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
