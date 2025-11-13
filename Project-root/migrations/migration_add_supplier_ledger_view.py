"""
Migration: Create supplier_ledger view and add performance indexes

This creates a plain SQL view `supplier_ledger` that unifies purchase order events
and receipt/stock_entry rows into a single timeline useful for supplier-ledger
queries. It also creates a small set of indexes recommended for the queries we
intend to run from the existing API endpoints.

This migration is safe to run multiple times (drops view if present then creates).
"""

from database import get_conn


def upgrade():
    # Build the CREATE VIEW statement dynamically to tolerate variations in existing schema
    # (some deployments may lack optional columns like stock_receipts.notes). We construct
    # the select-list conditionally and then EXECUTE the final CREATE VIEW statement.
    view_sql = """
DO $$
DECLARE
    sr_has_notes boolean := EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'stock_receipts' AND column_name = 'notes'
    );
    po_has_notes boolean := EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_name = 'purchase_orders' AND column_name = 'notes'
    );
    sql text;
BEGIN
    sql := 'DROP VIEW IF EXISTS supplier_ledger; CREATE VIEW supplier_ledger AS ' ||
             'SELECT ''po''::text AS event_type, po.po_id::bigint AS event_id, po.supplier_id::bigint AS supplier_id, ' ||
             'po.order_date::timestamp AS event_date, ' ||
             (CASE WHEN po_has_notes THEN 'po.po_number::text AS reference_number, NULL::bigint AS receipt_id, NULL::bigint AS stock_entry_id, NULL::bigint AS variant_id, NULL::numeric AS quantity, NULL::numeric AS cost_per_unit, po.status::text AS po_status, po.notes::text AS notes' ELSE 'po.po_number::text AS reference_number, NULL::bigint AS receipt_id, NULL::bigint AS stock_entry_id, NULL::bigint AS variant_id, NULL::numeric AS quantity, NULL::numeric AS cost_per_unit, po.status::text AS po_status, NULL::text AS notes' END) ||
             ' FROM purchase_orders po UNION ALL SELECT ''receipt''::text AS event_type, sr.receipt_id::bigint AS event_id, sr.supplier_id::bigint AS supplier_id, sr.receipt_date::timestamp AS event_date, sr.bill_number::text AS reference_number, sr.receipt_id::bigint AS receipt_id, se.entry_id::bigint AS stock_entry_id, se.variant_id::bigint AS variant_id, se.quantity_added::numeric AS quantity, se.cost_per_unit::numeric AS cost_per_unit, NULL::text AS po_status, ' ||(CASE WHEN sr_has_notes THEN 'sr.notes::text' ELSE 'NULL::text' END)||' AS notes FROM stock_receipts sr JOIN stock_entries se ON se.receipt_id = sr.receipt_id;';
    EXECUTE sql;
END $$;
"""

    index_stmts = [
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_entries_variant_id ON stock_entries (variant_id);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_entries_supplier_id ON stock_entries (supplier_id);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_receipts_supplier_date ON stock_receipts (supplier_id, receipt_date DESC);",
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_purchase_orders_supplier_date ON purchase_orders (supplier_id, order_date DESC);",
    ]

    with get_conn() as (conn, cur):
        # Create view
        cur.execute(view_sql)
        # Create indexes if possible; ignore errors when tables missing
        for s in index_stmts:
            try:
                cur.execute(s)
            except Exception:
                pass
        conn.commit()


def downgrade():
    drops = [
        "DROP VIEW IF EXISTS supplier_ledger;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_stock_entries_variant_id;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_stock_entries_supplier_id;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_stock_receipts_supplier_date;",
        "DROP INDEX CONCURRENTLY IF EXISTS idx_purchase_orders_supplier_date;",
    ]
    with get_conn() as (conn, cur):
        for s in drops:
            try:
                cur.execute(s)
            except Exception:
                pass
        conn.commit()
