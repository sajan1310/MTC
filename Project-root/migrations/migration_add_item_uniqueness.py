import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Adds a unique index to the item_master table to enforce item uniqueness.
    """
    with get_conn() as (conn, cur):
        # Drop old constraint and index if they exist
        cur.execute(
            "ALTER TABLE item_master DROP CONSTRAINT IF EXISTS unique_item_master_name_model_variation_desc;"
        )
        cur.execute(
            "DROP INDEX IF EXISTS unique_item_master_name_model_variation_desc;"
        )

        # Create a new unique index
        cur.execute(
            """
            CREATE UNIQUE INDEX unique_item_master_name_model_variation_desc
            ON item_master (name, model_id, variation_id, COALESCE(description, ''));
        """
        )

        conn.commit()
        print("Upgrade complete: Added unique index to item_master.")


def downgrade():
    """
    Removes the unique index from the item_master table.
    """
    with get_conn() as (conn, cur):
        cur.execute(
            "DROP INDEX IF EXISTS unique_item_master_name_model_variation_desc;"
        )

        conn.commit()
        print("Downgrade complete: Removed unique index from item_master.")
