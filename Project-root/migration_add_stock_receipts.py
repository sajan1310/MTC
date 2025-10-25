import psycopg2
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

def upgrade():
    """
    Upgrade script to add stock_receipts table and modify stock_entries.
    """
    conn = None
    try:
        # Get the database connection URL from the environment variables
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            raise ValueError("DATABASE_URL environment variable not set")

        # Connect to the database
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()

        # Create the stock_receipts table
        cur.execute("""
            CREATE TABLE stock_receipts (
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
            ADD COLUMN receipt_id INTEGER REFERENCES stock_receipts(receipt_id);
        """)

        # Commit the changes
        conn.commit()
        print("Upgrade complete: stock_receipts table created and stock_entries updated.")

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
        # Get the database connection URL from the environment variables
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            raise ValueError("DATABASE_URL environment variable not set")

        # Connect to the database
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()

        # Remove the receipt_id from stock_entries
        cur.execute("""
            ALTER TABLE stock_entries
            DROP COLUMN IF EXISTS receipt_id;
        """)

        # Drop the stock_receipts table
        cur.execute("DROP TABLE IF EXISTS stock_receipts;")

        # Commit the changes
        conn.commit()
        print("Downgrade complete: stock_receipts table dropped and stock_entries reverted.")

    except (Exception, psycopg2.DatabaseError) as error:
        print(f"Error during downgrade: {error}")
        if conn:
            conn.rollback()
    finally:
        if conn:
            conn.close()

if __name__ == "__main__":
    # This allows running the script directly for upgrades or downgrades.
    # For example: python migration_add_stock_receipts.py upgrade
    import sys
    if len(sys.argv) > 1:
        if sys.argv[1] == 'upgrade':
            upgrade()
        elif sys.argv[1] == 'downgrade':
            downgrade()
