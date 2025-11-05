import os
import sys

from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from database import get_conn

load_dotenv()


def upgrade():
    """
    Removes the unique constraint from the 'variation_name' column in 'variation_master'.
    """
    with get_conn() as (conn, cur):
        cur.execute(
            "ALTER TABLE variation_master DROP CONSTRAINT IF EXISTS variation_master_variation_name_key;"
        )
        conn.commit()
        print("Upgrade complete: Removed unique constraint from variation_master.")


def downgrade():
    """
    Re-adds the unique constraint to the 'variation_name' column in 'variation_master'.
    """
    with get_conn() as (conn, cur):
        cur.execute(
            "ALTER TABLE variation_master ADD CONSTRAINT variation_master_variation_name_key UNIQUE (variation_name);"
        )
        conn.commit()
        print("Downgrade complete: Re-added unique constraint to variation_master.")
