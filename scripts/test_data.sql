-- Test Data for Schema Validation
-- Add minimal records for foreign key checks

-- Insert item_variant
INSERT INTO item_master (name, model_id, variation_id) VALUES ('Test Item', 1, 1) RETURNING item_id;
-- Assume item_id = 1
INSERT INTO color_master (color_name) VALUES ('Red') RETURNING color_id;
-- Assume color_id = 1
INSERT INTO size_master (size_name) VALUES ('M') RETURNING size_id;
-- Assume size_id = 1
INSERT INTO item_variant (item_id, color_id, size_id, opening_stock) VALUES (1, 1, 1, 100) RETURNING variant_id;
-- Assume variant_id = 1

-- Insert user
INSERT INTO users (name, email, role) VALUES ('Test User', 'testuser@example.com', 'admin') RETURNING user_id;
-- Assume user_id = 1

-- Insert suppliers
INSERT INTO suppliers (firm_name) VALUES ('Test Supplier') RETURNING supplier_id;
-- Assume supplier_id = 1

-- Insert production_lots
INSERT INTO production_lots (process_id, lot_number, created_by, status, quantity) VALUES (1, 'LOT-TEST-1', 1, 'Planning', 10) RETURNING id;
-- Assume id = 1

-- Insert purchase_orders
INSERT INTO purchase_orders (po_number, supplier_id, order_date, status) VALUES ('PO-TEST-1', 1, CURRENT_DATE, 'Draft') RETURNING po_id;
-- Assume po_id = 1
