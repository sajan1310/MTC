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

            # Re-associate related records before deleting
            for item_id in ids_to_delete:
                print(f"  Re-associating records from {item_id} to {id_to_keep}...")
                
                # Update item_variant table
                try:
                    cur.execute("""
                        UPDATE item_variant
                        SET item_id = %s
                        WHERE item_id = %s;
                    """, (id_to_keep, item_id))
                    print(f"    Re-associated variants from item_id {item_id}.")
                except Exception as e:
                    print(f"    Could not re-associate variants for item_id {item_id}: {e}")
                    # If there's a unique constraint violation, you might need to handle it
                    # by deleting the duplicate variant or merging its data.
                    # For now, we'll skip the deletion of the master item if this fails.
                    continue

                # Now it's safe to delete the duplicate item_master record
                cur.execute("DELETE FROM item_master WHERE item_id = %s;", (item_id,))
                print(f"    Deleted duplicate item_master record for item_id {item_id}.")

        conn.commit()
        print("\nDeduplication completed successfully!")

if __name__ == '__main__':
    deduplicate()
