import os
import sys

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from database import init_app, get_conn
from migrations.migrations import MockApp

app = MockApp()
init_app(app)

with get_conn() as (conn, cur):
    # Inspect available columns
    def has_col(table, column):
        cur.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name=%s AND column_name=%s;",
            (table, column),
        )
        return cur.fetchone() is not None

    po_has_po_number = has_col("purchase_orders", "po_number")
    po_has_notes = has_col("purchase_orders", "notes")
    sr_has_bill_number = has_col("stock_receipts", "bill_number")
    sr_has_notes = has_col("stock_receipts", "notes")
    se_has_cost = has_col("stock_entries", "cost_per_unit")
    se_has_qty = has_col("stock_entries", "quantity_added")
    se_has_variant = has_col("stock_entries", "variant_id")

    print(
        "Column presence:",
        dict(
            po_has_po_number=po_has_po_number,
            po_has_notes=po_has_notes,
            sr_has_bill_number=sr_has_bill_number,
            sr_has_notes=sr_has_notes,
            se_has_cost=se_has_cost,
            se_has_qty=se_has_qty,
            se_has_variant=se_has_variant,
        ),
    )

    # Build SELECT parts
    po_select = [
        "'po'::text AS event_type",
        "po.po_id::bigint AS event_id",
        "po.supplier_id::bigint AS supplier_id",
        "po.order_date::timestamp AS event_date",
    ]
    po_select.append(
        "po.po_number::text AS reference_number"
        if po_has_po_number
        else "NULL::text AS reference_number"
    )
    po_select.extend(
        [
            "NULL::bigint AS receipt_id",
            "NULL::bigint AS stock_entry_id",
            "NULL::bigint AS variant_id",
            "NULL::numeric AS quantity",
            "NULL::numeric AS cost_per_unit",
            "po.status::text AS po_status",
            "po.notes::text AS notes" if po_has_notes else "NULL::text AS notes",
        ]
    )

    receipt_select = [
        "'receipt'::text AS event_type",
        "sr.receipt_id::bigint AS event_id",
        "sr.supplier_id::bigint AS supplier_id",
        "sr.receipt_date::timestamp AS event_date",
    ]
    receipt_select.append(
        "sr.bill_number::text AS reference_number"
        if sr_has_bill_number
        else "NULL::text AS reference_number"
    )
    receipt_select.extend(
        [
            "sr.receipt_id::bigint AS receipt_id",
            "se.entry_id::bigint AS stock_entry_id",
            (
                "se.variant_id::bigint AS variant_id"
                if se_has_variant
                else "NULL::bigint AS variant_id"
            ),
            (
                "se.quantity_added::numeric AS quantity"
                if se_has_qty
                else "NULL::numeric AS quantity"
            ),
            (
                "se.cost_per_unit::numeric AS cost_per_unit"
                if se_has_cost
                else "NULL::numeric AS cost_per_unit"
            ),
            "NULL::text AS po_status",
            "sr.notes::text AS notes" if sr_has_notes else "NULL::text AS notes",
        ]
    )

    create_view_sql = (
        f"DROP VIEW IF EXISTS supplier_ledger; CREATE VIEW supplier_ledger AS SELECT {', '.join(po_select)} FROM purchase_orders po "
        f"UNION ALL SELECT {', '.join(receipt_select)} FROM stock_receipts sr JOIN stock_entries se ON se.receipt_id = sr.receipt_id;"
    )

    print("Creating supplier_ledger with SQL length", len(create_view_sql))
    try:
        cur.execute(create_view_sql)
        conn.commit()
        print("supplier_ledger view created successfully")
    except Exception as e:
        conn.rollback()
        print("Failed to create supplier_ledger view:", e)

    # Try to create indexes where possible
    index_sqls = [
        "CREATE INDEX IF NOT EXISTS idx_stock_entries_variant_id ON stock_entries (variant_id);",
        "CREATE INDEX IF NOT EXISTS idx_stock_entries_supplier_id ON stock_entries (supplier_id);",
        "CREATE INDEX IF NOT EXISTS idx_stock_receipts_supplier_date ON stock_receipts (supplier_id, receipt_date DESC);",
        "CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier_date ON purchase_orders (supplier_id, order_date DESC);",
    ]
    for s in index_sqls:
        try:
            cur.execute(s)
        except Exception:
            pass
    conn.commit()
    print("Index creation attempted (errors ignored)")
