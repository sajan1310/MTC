"""Quick test script to check variant and category data"""

import sys

sys.path.insert(0, ".")

from flask import Flask
import database
import psycopg2.extras
from config import Config


def test_data():
    # Initialize Flask app and database
    app = Flask(__name__)
    app.config.from_object(Config)
    database.init_app(app)

    with app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (
            conn,
            cur,
        ):
            # First, check the actual columns in item_category_master
            cur.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_name='item_category_master' 
                ORDER BY ordinal_position
            """)
            cat_columns = [r["column_name"] for r in cur.fetchall()]
            print(f"✓ item_category_master columns: {cat_columns}")

            # Check variants
            cur.execute(
                "SELECT COUNT(*) as count FROM item_variant WHERE deleted_at IS NULL"
            )
            variant_count = cur.fetchone()["count"]
            print(f"✓ Active variants: {variant_count}")

            # Check categories - use correct column name
            if "deleted_at" in cat_columns:
                cur.execute(
                    "SELECT COUNT(*) as count FROM item_category_master WHERE deleted_at IS NULL"
                )
            else:
                cur.execute("SELECT COUNT(*) as count FROM item_category_master")
            category_count = cur.fetchone()["count"]
            print(f"✓ Categories: {category_count}")

            # Check item master
            cur.execute(
                "SELECT COUNT(*) as count FROM item_master WHERE deleted_at IS NULL"
            )
            item_count = cur.fetchone()["count"]
            print(f"✓ Active items: {item_count}")

            # Sample variant query (same as the API)
            if variant_count > 0:
                cur.execute("""
                    SELECT 
                        iv.variant_id as id,
                        im.name || ' - ' || cm.color_name || ' - ' || sm.size_name as name,
                        COALESCE(mm.model_name, 'N/A') as model,
                        COALESCE(ibm.item_brand_name, 'N/A') as brand
                    FROM item_variant iv
                    JOIN item_master im ON iv.item_id = im.item_id
                    JOIN color_master cm ON iv.color_id = cm.color_id
                    JOIN size_master sm ON iv.size_id = sm.size_id
                    LEFT JOIN model_master mm ON im.model_id = mm.model_id
                    LEFT JOIN item_brand_master ibm ON im.item_brand_id = ibm.item_brand_id
                    WHERE iv.deleted_at IS NULL AND im.deleted_at IS NULL
                    LIMIT 3
                """)
                print("\n✓ Sample variants:")
                for row in cur.fetchall():
                    print(f"  - {row['name']} (ID: {row['id']})")

            if category_count > 0:
                # Determine correct column names
                name_col = (
                    "item_category_name"
                    if "item_category_name" in cat_columns
                    else "category_name"
                )
                if "deleted_at" in cat_columns:
                    cur.execute(f"""
                        SELECT item_category_id as id, {name_col} as name
                        FROM item_category_master 
                        WHERE deleted_at IS NULL
                        LIMIT 5
                    """)
                else:
                    cur.execute(f"""
                        SELECT item_category_id as id, {name_col} as name
                        FROM item_category_master 
                        LIMIT 5
                    """)
                print("\n✓ Sample categories:")
                for row in cur.fetchall():
                    print(f"  - {row['name']} (ID: {row['id']})")


if __name__ == "__main__":
    try:
        test_data()
        print("\n✅ All checks passed!")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback

        traceback.print_exc()
