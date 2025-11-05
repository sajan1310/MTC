-- Migration: Add performance indexes
-- Date: 2025-10-25
-- Description: Improves query performance for inventory management

-- Inventory queries optimization
CREATE INDEX IF NOT EXISTS idx_item_variant_item_id
ON item_variant(item_id);

CREATE INDEX IF NOT EXISTS idx_item_variant_stock_check
ON item_variant(item_id, opening_stock, threshold);

CREATE INDEX IF NOT EXISTS idx_item_master_name
ON item_master(name);

CREATE INDEX IF NOT EXISTS idx_item_master_model
ON item_master(model_id);

CREATE INDEX IF NOT EXISTS idx_item_master_variation
ON item_master(variation_id);

-- Master data lookups optimization
CREATE INDEX IF NOT EXISTS idx_color_master_name
ON color_master(color_name);

CREATE INDEX IF NOT EXISTS idx_size_master_name
ON size_master(size_name);

CREATE INDEX IF NOT EXISTS idx_model_master_name
ON model_master(model_name);

CREATE INDEX IF NOT EXISTS idx_variation_master_name
ON variation_master(variation_name);

-- Supplier queries optimization
CREATE INDEX IF NOT EXISTS idx_suppliers_firm_name
ON suppliers(firm_name);

CREATE INDEX IF NOT EXISTS idx_supplier_item_rates_lookup
ON supplier_item_rates(supplier_id, item_id);

-- Purchase orders optimization
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier
ON purchase_orders(supplier_id, order_date DESC);

CREATE INDEX IF NOT EXISTS idx_stock_entries_variant
ON stock_entries(variant_id, entry_date DESC);

-- User management optimization
CREATE INDEX IF NOT EXISTS idx_users_email
ON users(email);

CREATE INDEX IF NOT EXISTS idx_users_role
ON users(role);

-- Verify indexes were created
SELECT
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
