import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Renames 'discount_amount' to 'discount_percentage' and adds a new
    'discount_amount' column.
    """
    with get_conn() as (conn, cur):
        # Rename original discount_amount to discount_percentage
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock_receipts' AND column_name='discount_amount') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock_receipts' AND column_name='discount_percentage') THEN
                    ALTER TABLE stock_receipts RENAME COLUMN discount_amount TO discount_percentage;
                END IF;
            END$$;
        """
        )

        # Add a new discount_amount column for the fixed value
        cur.execute(
            """
            ALTER TABLE stock_receipts
            ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10, 2) DEFAULT 0;
        """
        )

        conn.commit()
        print("Upgrade complete: Updated discount fields in stock_receipts.")


def downgrade():
    """
    Reverts the changes, renaming 'discount_percentage' back to 'discount_amount'
    and removing the new 'discount_amount' column.
    """
    with get_conn() as (conn, cur):
        # Remove the new discount_amount column
        cur.execute(
            """
            ALTER TABLE stock_receipts
            DROP COLUMN IF EXISTS discount_amount;
        """
        )

        # Rename discount_percentage back to discount_amount
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stock_receipts' AND column_name='discount_percentage') THEN
                    ALTER TABLE stock_receipts RENAME COLUMN discount_percentage TO discount_amount;
                END IF;
            END$$;
        """
        )

        conn.commit()
        print("Downgrade complete: Reverted discount fields in stock_receipts.")
