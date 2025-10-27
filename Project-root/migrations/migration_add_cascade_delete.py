import sys
import os
from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from database import get_conn

load_dotenv()

def upgrade():
    """
    Adds ON DELETE CASCADE to foreign key constraints on the item_master table.
    """
    with get_conn() as (conn, cur):
        # Drop existing foreign key constraints
        cur.execute("ALTER TABLE item_master DROP CONSTRAINT IF EXISTS item_master_model_id_fkey;")
        cur.execute("ALTER TABLE item_master DROP CONSTRAINT IF EXISTS item_master_variation_id_fkey;")

        # Add new foreign key constraints with ON DELETE CASCADE
        cur.execute("""
            ALTER TABLE item_master
            ADD CONSTRAINT item_master_model_id_fkey
            FOREIGN KEY (model_id)
            REFERENCES model_master(model_id)
            ON DELETE CASCADE;
        """)
        cur.execute("""
            ALTER TABLE item_master
            ADD CONSTRAINT item_master_variation_id_fkey
            FOREIGN KEY (variation_id)
            REFERENCES variation_master(variation_id)
            ON DELETE CASCADE;
        """)
        
        conn.commit()
        print("Upgrade complete: Added ON DELETE CASCADE to foreign keys.")

def downgrade():
    """
    Removes the ON DELETE CASCADE from the foreign key constraints.
    """
    with get_conn() as (conn, cur):
        # Drop existing foreign key constraints
        cur.execute("ALTER TABLE item_master DROP CONSTRAINT IF EXISTS item_master_model_id_fkey;")
        cur.execute("ALTER TABLE item_master DROP CONSTRAINT IF EXISTS item_master_variation_id_fkey;")

        # Re-add foreign key constraints without ON DELETE CASCADE
        cur.execute("""
            ALTER TABLE item_master
            ADD CONSTRAINT item_master_model_id_fkey
            FOREIGN KEY (model_id)
            REFERENCES model_master(model_id);
        """)
        cur.execute("""
            ALTER TABLE item_master
            ADD CONSTRAINT item_master_variation_id_fkey
            FOREIGN KEY (variation_id)
            REFERENCES variation_master(variation_id);
        """)
        
        conn.commit()
        print("Downgrade complete: Removed ON DELETE CASCADE from foreign keys.")
