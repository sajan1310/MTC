import sys
import os
from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from database import get_conn

load_dotenv()

def upgrade():
    """
    Creates a unique index on item_master to prevent duplicate items.
    """
    with get_conn() as (conn, cur):
        # Drop the existing constraint and index if they exist
        cur.execute("ALTER TABLE item_master DROP CONSTRAINT IF EXISTS unique_item_definition;")
        cur.execute("DROP INDEX IF EXISTS unique_item_definition;")

        # Create the new unique index
        cur.execute("""
            CREATE UNIQUE INDEX unique_item_definition 
            ON item_master (name, COALESCE(model, ''), COALESCE(variation, ''), COALESCE(description, ''));
        """)
        
        conn.commit()
        print("Upgrade complete: unique_item_definition index created.")

def downgrade():
    """
    Removes the unique_item_definition index.
    """
    with get_conn() as (conn, cur):
        cur.execute("DROP INDEX IF EXISTS unique_item_definition;")
        
        conn.commit()
        print("Downgrade complete: unique_item_definition index removed.")
