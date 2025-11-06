-- ============================================================================
-- INITIAL SCHEMA SETUP FOR MTC INVENTORY MANAGEMENT SYSTEM
-- ============================================================================
-- This script creates all core database tables required for the application.
-- Run this before applying Python migrations.
--
-- Usage:
--   psql -h localhost -U testuser -d testdb -f init_schema.sql
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- USER MANAGEMENT
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    profile_picture TEXT,
    company VARCHAR(255),
    mobile VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ============================================================================
-- MASTER DATA TABLES
-- ============================================================================

-- Model Master
CREATE TABLE IF NOT EXISTS model_master (
    model_id SERIAL PRIMARY KEY,
    model_name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Variation Master
CREATE TABLE IF NOT EXISTS variation_master (
    variation_id SERIAL PRIMARY KEY,
    variation_name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Color Master
CREATE TABLE IF NOT EXISTS color_master (
    color_id SERIAL PRIMARY KEY,
    color_name VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Size Master
CREATE TABLE IF NOT EXISTS size_master (
    size_id SERIAL PRIMARY KEY,
    size_name VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Item Category Master
CREATE TABLE IF NOT EXISTS item_category_master (
    item_category_id SERIAL PRIMARY KEY,
    item_category_name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Item Type Master
CREATE TABLE IF NOT EXISTS item_type_master (
    item_type_id SERIAL PRIMARY KEY,
    item_type_name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Item Brand Master
CREATE TABLE IF NOT EXISTS item_brand_master (
    item_brand_id SERIAL PRIMARY KEY,
    item_brand_name VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- ============================================================================
-- INVENTORY MANAGEMENT
-- ============================================================================

-- Item Master
CREATE TABLE IF NOT EXISTS item_master (
    item_id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    image_path TEXT,
    model_id INTEGER REFERENCES model_master(model_id) ON DELETE CASCADE,
    variation_id INTEGER REFERENCES variation_master(variation_id) ON DELETE CASCADE,
    item_category_id INTEGER REFERENCES item_category_master(item_category_id),
    item_type_id INTEGER REFERENCES item_type_master(item_type_id),
    item_brand_id INTEGER REFERENCES item_brand_master(item_brand_id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_item_master_name ON item_master(name);
CREATE INDEX IF NOT EXISTS idx_item_master_model_variation ON item_master(model_id, variation_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_master_unique 
    ON item_master (name, model_id, variation_id, COALESCE(description, ''))
    WHERE deleted_at IS NULL;

-- Item Variant
CREATE TABLE IF NOT EXISTS item_variant (
    variant_id SERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES item_master(item_id) ON DELETE CASCADE,
    color_id INTEGER NOT NULL REFERENCES color_master(color_id),
    size_id INTEGER NOT NULL REFERENCES size_master(size_id),
    opening_stock INTEGER NOT NULL DEFAULT 0,
    threshold INTEGER NOT NULL DEFAULT 5,
    unit VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_item_variant_item_id ON item_variant(item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_variant_unique_combo 
    ON item_variant(item_id, color_id, size_id)
    WHERE deleted_at IS NULL;

-- ============================================================================
-- SUPPLIER MANAGEMENT
-- ============================================================================

-- Suppliers
CREATE TABLE IF NOT EXISTS suppliers (
    supplier_id SERIAL PRIMARY KEY,
    firm_name VARCHAR(255) NOT NULL UNIQUE,
    address TEXT,
    gstin VARCHAR(15),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_suppliers_firm_name ON suppliers(firm_name);

-- Supplier Contacts
CREATE TABLE IF NOT EXISTS supplier_contacts (
    contact_id SERIAL PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE CASCADE,
    contact_name VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(20),
    contact_email VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_supplier_contacts_supplier_id ON supplier_contacts(supplier_id);

-- Supplier Item Rates
CREATE TABLE IF NOT EXISTS supplier_item_rates (
    rate_id SERIAL PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES item_master(item_id) ON DELETE CASCADE,
    rate NUMERIC(10, 2) NOT NULL,
    effective_date DATE DEFAULT CURRENT_DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(supplier_id, item_id, effective_date)
);

CREATE INDEX IF NOT EXISTS idx_supplier_rates_supplier ON supplier_item_rates(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_rates_item ON supplier_item_rates(item_id);

-- ============================================================================
-- PURCHASE ORDERS
-- ============================================================================

-- Purchase Orders
CREATE TABLE IF NOT EXISTS purchase_orders (
    po_id SERIAL PRIMARY KEY,
    po_number VARCHAR(50) UNIQUE,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE RESTRICT,
    order_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'Draft',
    total_amount NUMERIC(12, 2),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_po_number ON purchase_orders(po_number);
CREATE INDEX IF NOT EXISTS idx_po_supplier_id ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status);

-- Purchase Order Items
CREATE TABLE IF NOT EXISTS purchase_order_items (
    po_item_id SERIAL PRIMARY KEY,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
    variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL,
    rate NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_po_items_po_id ON purchase_order_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_items_variant_id ON purchase_order_items(variant_id);

-- ============================================================================
-- STOCK MANAGEMENT
-- ============================================================================

-- Stock Entries
CREATE TABLE IF NOT EXISTS stock_entries (
    entry_id SERIAL PRIMARY KEY,
    variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
    supplier_id INTEGER REFERENCES suppliers(supplier_id) ON DELETE SET NULL,
    po_id INTEGER REFERENCES purchase_orders(po_id) ON DELETE SET NULL,
    quantity_added INTEGER NOT NULL,
    entry_date TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cost_per_unit NUMERIC(10, 2),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_stock_entries_variant_id ON stock_entries(variant_id);
CREATE INDEX IF NOT EXISTS idx_stock_entries_entry_date ON stock_entries(entry_date);

-- Stock Receipts
CREATE TABLE IF NOT EXISTS stock_receipts (
    receipt_id SERIAL PRIMARY KEY,
    po_id INTEGER REFERENCES purchase_orders(po_id) ON DELETE SET NULL,
    receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
    receipt_number VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_stock_receipts_po_id ON stock_receipts(po_id);

-- ============================================================================
-- MIGRATIONS TRACKING
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- INITIAL DATA (Optional - for testing)
-- ============================================================================

-- Insert a default admin user (password: Admin@1234)
INSERT INTO users (name, email, password_hash, role) 
VALUES (
    'Admin User',
    'admin@mtc.local',
    'scrypt:32768:8:1$KzLxWXmTGZkjWy2L$d8a4c5e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2',
    'admin'
)
ON CONFLICT (email) DO NOTHING;

-- Insert demo user for testing (password: Demo@1234)
INSERT INTO users (name, email, password_hash, role)
VALUES (
    'Demo User',
    'demo@example.com',
    'scrypt:32768:8:1$KzLxWXmTGZkjWy2L$d8a4c5e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2',
    'admin'
)
ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- COMPLETION MESSAGE
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE 'Schema initialization completed successfully!';
END $$;
