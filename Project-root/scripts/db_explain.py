"""Run EXPLAIN ANALYZE for representative queries used by stock ledger and variant ledger.

Usage: python scripts/db_explain.py

This script will connect using the project's `database.get_conn()` helper and print EXPLAIN ANALYZE output.

Note: Running EXPLAIN ANALYZE will execute the queries; use with caution against production databases.
"""

from __future__ import annotations
import sys
import database

queries = {
    "stock_receipts_base": (
        "SELECT sr.*, s.firm_name FROM stock_receipts sr JOIN suppliers s ON sr.supplier_id = s.supplier_id WHERE sr.supplier_id = %s ORDER BY sr.receipt_date DESC LIMIT 10",
        (1,),
    ),
    "stock_receipts_variant_exists": (
        "SELECT sr.* FROM stock_receipts sr WHERE EXISTS (SELECT 1 FROM stock_entries se WHERE se.receipt_id = sr.receipt_id AND se.variant_id = %s) ORDER BY sr.receipt_date DESC LIMIT 10",
        (1,),
    ),
    "supplier_ledger_view_sample": (
        "SELECT event_date, event_type, reference_number FROM supplier_ledger WHERE supplier_id = %s ORDER BY event_date DESC LIMIT 10",
        (1,),
    ),
}


def run_explain(sql, params):
    try:
        with database.get_conn() as (conn, cur):
            cur.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) " + sql, params)
            rows = cur.fetchall()
            print("\n".join(r[0] for r in rows))
    except Exception as e:
        print("Failed to run EXPLAIN for query:", e)


if __name__ == "__main__":
    print("Running EXPLAIN ANALYZE for representative queries...")
    for name, (q, params) in queries.items():
        print("\n---", name, "---")
        run_explain(q, params)
    print("\nDone.")
