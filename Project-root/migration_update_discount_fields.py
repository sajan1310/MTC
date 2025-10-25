import psycopg2
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

def upgrade():
    """
    Upgrade script to change discount to a percentage.
    """
    conn = None
    try:
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            raise ValueError("DATABASE_URL environment variable not set")

        conn = psycopg2.connect(db_url)
        cur = conn.cursor()

        # Rename discount_amount to discount_percentage
        cur.execute("""
            ALTER TABLE stock_receipts
            RENAME COLUMN discount_amount TO discount_percentage;
        """)

        # Add a new discount_amount column
        cur.execute("""
            ALTER TABLE stock_receipts
            ADD COLUMN discount_amount NUMERIC(10, 2) DEFAULT 0;
        """)

        conn.commit()
        print("Upgrade complete: Updated discount fields in stock_receipts.")

    except (Exception, psycopg2.DatabaseError) as error:
        print(f"Error during upgrade: {error}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

def downgrade():
    """
    Downgrade script to revert the changes.
    """
    conn = None
    try:
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            raise ValueError("DATABASE_URL environment variable not set")

        conn = psycopg2.connect(db_url)
        cur = conn.cursor()

        # Remove the new discount_amount column
        cur.execute("""
            ALTER TABLE stock_receipts
            DROP COLUMN IF EXISTS discount_amount;
        """)

        # Rename discount_percentage back to discount_amount
        cur.execute("""
            ALTER TABLE stock_receipts
            RENAME COLUMN discount_percentage TO discount_amount;
        """)

        conn.commit()
        print("Downgrade complete: Reverted discount fields in stock_receipts.")

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
