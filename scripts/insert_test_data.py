"""
Automated Test Data Insertion for Schema Validation
This script fetches latest IDs and inserts required test data for validation.
"""
import psycopg2
import os

DB_NAME = os.getenv('DB_NAME', 'MTC')
DB_USER = os.getenv('DB_USER', 'postgres')
DB_HOST = os.getenv('DB_HOST', '127.0.0.1')
DB_PORT = os.getenv('DB_PORT', '5432')
DB_PASSWORD = os.getenv('DB_PASS', 'abcd')

def get_conn():
    return psycopg2.connect(dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD, host=DB_HOST, port=DB_PORT)

def main():
    conn = get_conn()
    cur = conn.cursor()
    import datetime
    try:
        # Get latest IDs
        cur.execute('SELECT item_id FROM item_master ORDER BY item_id DESC LIMIT 1;')
        item_id = cur.fetchone()[0]
        cur.execute('SELECT color_id FROM color_master ORDER BY color_id DESC LIMIT 1;')
        color_id = cur.fetchone()[0]
        cur.execute('SELECT size_id FROM size_master ORDER BY size_id DESC LIMIT 1;')
        size_id = cur.fetchone()[0]
        cur.execute('SELECT user_id FROM users ORDER BY user_id DESC LIMIT 1;')
        user_id = cur.fetchone()[0]
        cur.execute('SELECT supplier_id FROM suppliers ORDER BY supplier_id DESC LIMIT 1;')
        supplier_id = cur.fetchone()[0]
        # Insert item_variant
        cur.execute('INSERT INTO item_variant (item_id, color_id, size_id, opening_stock) VALUES (%s, %s, %s, 100) RETURNING variant_id;', (item_id, color_id, size_id))
        variant_id = cur.fetchone()[0]
        # Generate unique lot_number and po_number
        ts = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
        lot_number = f'LOT-TEST-{ts}'
        po_number = f'PO-TEST-{ts}'
        # Insert production_lots
        cur.execute('INSERT INTO production_lots (process_id, lot_number, created_by, status, quantity) VALUES (%s, %s, %s, %s, %s) RETURNING id;', (1, lot_number, user_id, 'Planning', 10))
        lot_id = cur.fetchone()[0]
        # Insert purchase_orders
        cur.execute('INSERT INTO purchase_orders (po_number, supplier_id, order_date, status) VALUES (%s, %s, CURRENT_DATE, %s) RETURNING po_id;', (po_number, supplier_id, 'Draft'))
        po_id = cur.fetchone()[0]
        conn.commit()
        print(f"Inserted test data: variant_id={variant_id}, lot_id={lot_id}, user_id={user_id}, supplier_id={supplier_id}, po_id={po_id}")
    except Exception as e:
        conn.rollback()
        print(f"Test data insertion failed: {e}")
    finally:
        cur.close()
        conn.close()

if __name__ == '__main__':
    main()
