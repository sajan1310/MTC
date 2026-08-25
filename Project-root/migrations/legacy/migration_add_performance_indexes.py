"""
Migration: Add performance indexes to frequently queried columns.

Indexes are created concurrently to avoid table locks.
Downgrade drops all created indexes.
"""

from database import get_conn


def upgrade():
    statements = [
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_item_master_name ON item_master(name);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_item_master_category ON item_master(category);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_item_variant_item_id ON item_variant(item_id);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_item_variant_composite ON item_variant(item_id, color_id, size_id);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supplier_rates_item_supplier ON supplier_item_rates(item_id, supplier_id);",
        "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_supplier_rates_unique ON supplier_item_rates(item_id, supplier_id, effective_date);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_po_number ON purchase_orders(po_number);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_po_date ON purchase_orders(created_at DESC);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_item_date ON stock_ledger(item_id, transaction_date DESC);",
    ]
    with get_conn() as (conn, cur):
        for s in statements:
            try:
                cur.execute(s)
            except Exception:
                # Index creation is non-critical; continue on error (e.g., missing table)
                pass


def downgrade():
    drops = [
        "DROP INDEX CONCURRENTLY IF EXISTS idx_item_master_name;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_item_master_category;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_item_variant_item_id;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_item_variant_composite;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_supplier_rates_item_supplier;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_supplier_rates_unique;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_po_number;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_po_supplier;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_po_date;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_stock_item_date;",
    ]
    with get_conn() as (conn, cur):
        for s in drops:
            try:
                cur.execute(s)
            except Exception:
                pass
