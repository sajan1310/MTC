"""
Migration: Add performance indexes to frequently queried columns.

Indexes are created concurrently to avoid table locks.
Downgrade drops all created indexes.
"""
from alembic import op
import sqlalchemy as sa

def upgrade():
    # Item master table
    op.execute('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_item_master_name ON item_master(name);')
    op.execute('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_item_master_category ON item_master(category);')
    # Item variant
    op.execute('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_item_variant_item_id ON item_variant(item_id);')
    op.execute('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_item_variant_composite ON item_variant(item_id, color_id, size_id);')
    # Supplier rates
    op.execute('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_supplier_rates_item_supplier ON supplier_item_rates(item_id, supplier_id);')
    op.execute('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_supplier_rates_unique ON supplier_item_rates(item_id, supplier_id, effective_date);')
    # Purchase orders
    op.execute('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_po_number ON purchase_orders(po_number);')
    op.execute('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);')
    op.execute('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_po_date ON purchase_orders(created_at DESC);')
    # Stock ledger
    op.execute('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stock_item_date ON stock_ledger(item_id, transaction_date DESC);')

def downgrade():
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS idx_item_master_name;')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS idx_item_master_category;')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS idx_item_variant_item_id;')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS idx_item_variant_composite;')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS idx_supplier_rates_item_supplier;')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS idx_supplier_rates_unique;')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS idx_po_number;')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS idx_po_supplier;')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS idx_po_date;')
    op.execute('DROP INDEX CONCURRENTLY IF EXISTS idx_stock_item_date;')
