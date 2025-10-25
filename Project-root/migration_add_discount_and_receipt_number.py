import psycopg2
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

def upgrade():
    """
    Upgrade script to add discount and receipt number to stock_receipts.
    """
    conn = None
    try:
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            raise ValueError("DATABASE_URL environment variable not set")

        conn = psycopg2.connect(db_url)
        cur = conn.cursor()

        # Add discount_amount and receipt_number columns
        cur.execute("""
            ALTER TABLE stock_receipts
            ADD COLUMN discount_amount NUMERIC(10, 2) DEFAULT 0,
            ADD COLUMN receipt_number VARCHAR(255);
        """)

        # Optional: Add a sequence for the receipt number
        cur.execute("CREATE SEQUENCE IF NOT EXISTS stock_receipt_number_seq;")

        conn.commit()
        print("Upgrade complete: Added discount and receipt number to stock_receipts.")

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

        # Remove the columns
        cur.execute("""
            ALTER TABLE stock_receipts
            DROP COLUMN IF EXISTS discount_amount,
            DROP COLUMN IF EXISTS receipt_number;
        """)

        # Drop the sequence
        cur.execute("DROP SEQUENCE IF EXISTS stock_receipt_number_seq;")

        conn.commit()
        print("Downgrade complete: Removed discount and receipt number from stock_receipts.")

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
