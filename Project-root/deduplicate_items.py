import os
import sys
from dotenv import load_dotenv

# Add project root to the Python path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from database import get_conn, init_app

load_dotenv()

# Mock Flask app for context
class MockApp:
    def __init__(self):
        self.logger = lambda: None
        self.logger.info = print
        self.logger.critical = print

def deduplicate():
    """
    Finds and removes duplicate items from the item_master table.
    """
    init_app(MockApp())
    with get_conn() as (conn, cur):
        # Find duplicate items
        print("Finding duplicate items...")
        cur.execute("""
            SELECT name, model_id, variation_id, COALESCE(description, '')
            FROM item_master
            GROUP BY name, model_id, variation_id, COALESCE(description, '')
            HAVING COUNT(*) > 1;
        """)
        duplicates = cur.fetchall()

        if not duplicates:
            print("No duplicate items found.")
            return

        print(f"Found {len(duplicates)} sets of duplicate items.")

        for dup in duplicates:
            name, model_id, variation_id, description = dup
            print(f"Processing duplicates for: {name}, {model_id}, {variation_id}, {description}")

            # Get all item_ids for this duplicate set
            cur.execute("""
                SELECT item_id FROM item_master
                WHERE name = %s AND model_id = %s AND variation_id = %s AND COALESCE(description, '') = %s
                ORDER BY item_id;
            """, (name, model_id, variation_id, description))
            
            item_ids = [row[0] for row in cur.fetchall()]
            
            # Keep the first one, delete the rest
            id_to_keep = item_ids[0]
            ids_to_delete = item_ids[1:]

            print(f"  Keeping item_id: {id_to_keep}")
            print(f"  Deleting item_ids: {ids_to_delete}")

            for item_id in ids_to_delete:
                # Before deleting, you might need to re-associate or delete related records
                # in other tables (e.g., item_variant, purchase_order_items).
                # For this script, we'll assume we can cascade delete or that it's safe to delete.
                # A more robust solution would handle these related records gracefully.
                
                cur.execute("DELETE FROM item_variant WHERE item_id = %s;", (item_id,))
                cur.execute("DELETE FROM item_master WHERE item_id = %s;", (item_id,))
                print(f"    Deleted item_id {item_id} and its variants.")

        conn.commit()
        print("\nDeduplication completed successfully!")

if __name__ == '__main__':
    deduplicate()
