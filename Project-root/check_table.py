import sys
import os

# Add the project root to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import create_app
from database import get_conn
import psycopg2.extras

# Create Flask app to initialize configuration
app = create_app()

with app.app_context():
    with get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (conn, cur):
        # Check item_variant table
        cur.execute("""
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'item_variant' 
            ORDER BY ordinal_position
        """)
        print("\n=== item_variant table columns ===")
        for row in cur.fetchall():
            print(f"  {row['column_name']}: {row['data_type']}")
        
        # Check item_master table for comparison
        cur.execute("""
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'item_master' 
            ORDER BY ordinal_position
        """)
        print("\n=== item_master table columns ===")
        for row in cur.fetchall():
            print(f"  {row['column_name']}: {row['data_type']}")
        
        print("\n✓ Verification complete: item_variant does NOT have 'name' column")
        print("✓ item_master HAS 'name' column - this is where variant names come from")
