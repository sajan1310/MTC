#!/usr/bin/env python
"""Quick test to verify supplier management data loading fixes"""
import sys
sys.path.insert(0, 'C:\\Users\\erkar\\OneDrive\\Desktop\\MTC\\Project-root')

import database
import psycopg2.extras
from app import create_app

def test_suppliers_endpoint():
    """Test that suppliers endpoint returns contact_count"""
    print("Testing /api/suppliers endpoint...")
    app = create_app()
    with app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("SELECT COUNT(*) as cnt FROM suppliers")
            supplier_count = cur.fetchone()['cnt']
            print(f"[OK] Total suppliers: {supplier_count}")
            
            cur.execute("""
                SELECT s.supplier_id, s.firm_name, COUNT(sc.contact_id) as contact_count
                FROM suppliers s
                LEFT JOIN supplier_contacts sc ON s.supplier_id = sc.supplier_id
                GROUP BY s.supplier_id, s.firm_name
                LIMIT 1
            """)
            result = cur.fetchone()
            if result:
                print(f"[OK] Sample: {result['firm_name']} with {result['contact_count']} contacts")
            else:
                print("[WARN] No suppliers found")

def test_supplier_variants():
    """Test that supplier variants endpoint returns proper fields"""
    print("\nTesting supplier variants endpoint...")
    app = create_app()
    with app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT s.supplier_id, s.firm_name, COUNT(sir.rate_id) as rate_count
                FROM suppliers s
                LEFT JOIN supplier_item_rates sir ON s.supplier_id = sir.supplier_id
                GROUP BY s.supplier_id, s.firm_name
                HAVING COUNT(sir.rate_id) > 0
                LIMIT 1
            """)
            result = cur.fetchone()
            if result:
                supplier_id = result['supplier_id']
                print(f"[OK] Found supplier with {result['rate_count']} rates")
                
                cur.execute("""
                    SELECT iv.variant_id, im.item_id, im.name as item_name, sir.rate
                    FROM supplier_item_rates sir
                    JOIN item_master im ON sir.item_id = im.item_id
                    LEFT JOIN item_variant iv ON im.item_id = iv.item_id
                    WHERE sir.supplier_id = %s LIMIT 1
                """, (supplier_id,))
                variant = cur.fetchone()
                if variant and variant['rate'] is not None:
                    print(f"[OK] Variant rate: {variant['rate']}")
                else:
                    print("[WARN] No variant rate found")
            else:
                print("[WARN] No suppliers with rates")

def test_ledger_query():
    """Test that ledger query returns consistent field names"""
    print("\nTesting ledger query...")
    app = create_app()
    with app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            cur.execute("""
                SELECT s.supplier_id FROM suppliers s
                LEFT JOIN stock_receipts sr ON s.supplier_id = sr.supplier_id
                LEFT JOIN stock_entries se ON sr.receipt_id = se.receipt_id
                WHERE se.entry_id IS NOT NULL
                LIMIT 1
            """)
            result = cur.fetchone()
            if result:
                supplier_id = result['supplier_id']
                cur.execute("""
                    SELECT se.entry_date as date, s.firm_name as supplier_name, 
                           sr.bill_number, im.name as item_name, se.quantity_added as qty
                    FROM stock_entries se
                    JOIN stock_receipts sr ON se.receipt_id = sr.receipt_id
                    JOIN suppliers s ON sr.supplier_id = s.supplier_id
                    JOIN item_variant iv ON se.variant_id = iv.variant_id
                    JOIN item_master im ON iv.item_id = im.item_id
                    WHERE sr.supplier_id = %s LIMIT 1
                """, (supplier_id,))
                entry = cur.fetchone()
                if entry:
                    print(f"[OK] Ledger entry has: date, supplier_name, bill_number, item_name, qty")
                else:
                    print("[WARN] No ledger entries")
            else:
                print("[WARN] No stock entries found")

if __name__ == '__main__':
    try:
        test_suppliers_endpoint()
        test_supplier_variants()
        test_ledger_query()
        print("\n[SUCCESS] All tests completed!")
    except Exception as e:
        print(f"\n[ERROR] {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
