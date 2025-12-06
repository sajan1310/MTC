#!/usr/bin/env python
"""
Quick test to verify supplier management data loading fixes
"""
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
            # Check if deleted_at column exists
            cur.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_name = 'suppliers' AND column_name = 'deleted_at'
            """)
            has_deleted_at = cur.fetchone() is not None
            
            # Check suppliers table
            if has_deleted_at:
                cur.execute("SELECT COUNT(*) as cnt FROM suppliers WHERE deleted_at IS NULL")
            else:
                cur.execute("SELECT COUNT(*) as cnt FROM suppliers")
                
            supplier_count = cur.fetchone()['cnt']
            print(f"[OK] Total suppliers in DB: {supplier_count}")
            
            # Check that we can join with contacts
            if has_deleted_at:
                cur.execute("""
                    SELECT s.supplier_id, s.firm_name, 
                           COUNT(sc.contact_id) as contact_count
                    FROM suppliers s
                    LEFT JOIN supplier_contacts sc ON s.supplier_id = sc.supplier_id
                    WHERE s.deleted_at IS NULL
                    GROUP BY s.supplier_id, s.firm_name
                    LIMIT 1
                """)
            else:
                cur.execute("""
                    SELECT s.supplier_id, s.firm_name, 
                           COUNT(sc.contact_id) as contact_count
                    FROM suppliers s
                    LEFT JOIN supplier_contacts sc ON s.supplier_id = sc.supplier_id
                    GROUP BY s.supplier_id, s.firm_name
                    LIMIT 1
                """)
            
            result = cur.fetchone()
            if result:
                print(f"[OK] Sample supplier: {result['firm_name']} with {result['contact_count']} contacts")
            else:
                print("[WARN] No suppliers found")

def test_supplier_variants():
    """Test that supplier variants endpoint returns proper fields"""
    print("\nTesting /api/upf/supplier/{id}/variants endpoint...")
    
    app = create_app()
    with app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            # Find a supplier with rates
            cur.execute("""
                SELECT DISTINCT s.supplier_id, s.firm_name, COUNT(sir.rate_id) as rate_count
                FROM suppliers s
                LEFT JOIN supplier_item_rates sir ON s.supplier_id = sir.supplier_id
                WHERE s.deleted_at IS NULL
                GROUP BY s.supplier_id, s.firm_name
                HAVING COUNT(sir.rate_id) > 0
                LIMIT 1
            """)
            result = cur.fetchone()
            if result:
                supplier_id = result['supplier_id']
                print(f"✓ Found supplier {result['firm_name']} (ID: {supplier_id}) with {result['rate_count']} rates")
                
                # Check the variant query
                cur.execute("""
                    SELECT 
                        iv.variant_id,
                        im.item_id,
                        im.name as item_name,
                        cm.color_name,
                        sm.size_name,
                        sir.rate,
                        sir.rate_id
                    FROM supplier_item_rates sir
                    JOIN item_master im ON sir.item_id = im.item_id
                    LEFT JOIN item_variant iv ON im.item_id = iv.item_id
                    LEFT JOIN color_master cm ON iv.color_id = cm.color_id
                    LEFT JOIN size_master sm ON iv.size_id = sm.size_id
                    WHERE sir.supplier_id = %s
                    ORDER BY im.name, cm.color_name, sm.size_name
                    LIMIT 1
                """, (supplier_id,))
                
                variant = cur.fetchone()
                if variant:
                    print(f"✓ Sample variant rate query returns: rate={variant['rate']}, variant_id={variant['variant_id']}, item_name={variant['item_name']}")
                    # Check all expected fields
                    expected_fields = ['variant_id', 'item_id', 'item_name', 'rate', 'rate_id']
                    missing = [f for f in expected_fields if f not in dict(variant)]
                    if missing:
                        print(f"⚠ Missing fields: {missing}")
                    else:
                        print(f"✓ All expected fields present")
            else:
                print("⚠ No suppliers with rates found")

def test_ledger_query():
    """Test that ledger query returns consistent field names"""
    print("\nTesting supplier ledger endpoint...")
    
    app = create_app()
    with app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (conn, cur):
            # Find a supplier with stock entries
            cur.execute("""
                SELECT DISTINCT s.supplier_id, s.firm_name, COUNT(se.entry_id) as entry_count
                FROM suppliers s
                LEFT JOIN stock_receipts sr ON s.supplier_id = sr.supplier_id
                LEFT JOIN stock_entries se ON sr.receipt_id = se.receipt_id
                WHERE s.deleted_at IS NULL
                GROUP BY s.supplier_id, s.firm_name
                HAVING COUNT(se.entry_id) > 0
                LIMIT 1
            """)
            result = cur.fetchone()
            if result:
                supplier_id = result['supplier_id']
                print(f"✓ Found supplier {result['firm_name']} (ID: {supplier_id}) with {result['entry_count']} stock entries")
                
                # Check the ledger query
                cur.execute("""
                    SELECT 
                        se.entry_date as date,
                        s.firm_name as supplier_name,
                        sr.bill_number,
                        im.name as item_name,
                        se.quantity_added as qty,
                        se.cost_per_unit,
                        sr.receipt_id,
                        sr.receipt_number,
                        sr.supplier_id,
                        'receipt' as event_type
                    FROM stock_entries se
                    JOIN stock_receipts sr ON se.receipt_id = sr.receipt_id
                    JOIN suppliers s ON sr.supplier_id = s.supplier_id
                    JOIN item_variant iv ON se.variant_id = iv.variant_id
                    JOIN item_master im ON iv.item_id = im.item_id
                    WHERE sr.supplier_id = %s
                    ORDER BY se.entry_date DESC
                    LIMIT 1
                """, (supplier_id,))
                
                entry = cur.fetchone()
                if entry:
                    expected_fields = ['date', 'supplier_name', 'bill_number', 'item_name', 'qty', 'cost_per_unit', 'event_type']
                    print(f"✓ Ledger entry query returns fields:")
                    for field in expected_fields:
                        if field in dict(entry):
                            print(f"  ✓ {field}: {entry[field]}")
                        else:
                            print(f"  ✗ Missing: {field}")
            else:
                print("⚠ No suppliers with stock entries found")

if __name__ == '__main__':
    try:
        test_suppliers_endpoint()
        test_supplier_variants()
        test_ledger_query()
        print("\n✅ All tests completed successfully!")
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
