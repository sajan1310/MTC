"""
Migration: Add Production Lot Variant Selections Table
Purpose: Store variant selections made by users for production lots (OR group choices)
"""
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2
from config import Config


def up():
    """Create production_lot_variant_selections table"""
    conn = psycopg2.connect(Config.DATABASE_URL)
    cur = conn.cursor()
    
    try:
        print("Creating production_lot_variant_selections table...")
        
        cur.execute("""
            CREATE TABLE IF NOT EXISTS production_lot_variant_selections (
                id SERIAL PRIMARY KEY,
                lot_id INTEGER NOT NULL REFERENCES production_lots(id) ON DELETE CASCADE,
                or_group_id INTEGER REFERENCES or_groups(id) ON DELETE SET NULL,
                variant_usage_id INTEGER NOT NULL,
                quantity_override DECIMAL(10, 3),
                reason TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
                
                CONSTRAINT unique_lot_group_selection UNIQUE(lot_id, or_group_id)
            );
        """)
        
        # Indexes for performance
        print("Creating indexes on production_lot_variant_selections...")
        
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_lot_selections_lot_id 
            ON production_lot_variant_selections(lot_id);
        """)
        
        cur.execute("""
            CREATE INDEX IF NOT EXISTS idx_lot_selections_group_id 
            ON production_lot_variant_selections(or_group_id) 
            WHERE or_group_id IS NOT NULL;
        """)
        
        conn.commit()
        print("✓ Production lot variant selections table created successfully")
        
    except psycopg2.Error as e:
        conn.rollback()
        print(f"✗ Error creating table: {e}")
        raise
    finally:
        cur.close()
        conn.close()


def down():
    """Drop production_lot_variant_selections table"""
    conn = psycopg2.connect(Config.DATABASE_URL)
    cur = conn.cursor()
    
    try:
        print("Dropping production_lot_variant_selections table...")
        cur.execute("DROP TABLE IF EXISTS production_lot_variant_selections CASCADE;")
        conn.commit()
        print("✓ Table dropped successfully")
        
    except psycopg2.Error as e:
        conn.rollback()
        print(f"✗ Error dropping table: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == '__main__':
    import sys
    
    if len(sys.argv) > 1 and sys.argv[1] == 'down':
        down()
    else:
        up()
