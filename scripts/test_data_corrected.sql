-- Corrected Test Data for Schema Validation
-- Query actual IDs and use them for inserts

-- Get latest IDs
SELECT item_id FROM item_master ORDER BY item_id DESC LIMIT 1;
SELECT color_id FROM color_master ORDER BY color_id DESC LIMIT 1;
SELECT size_id FROM size_master ORDER BY size_id DESC LIMIT 1;
SELECT user_id FROM users ORDER BY user_id DESC LIMIT 1;
SELECT supplier_id FROM suppliers ORDER BY supplier_id DESC LIMIT 1;

-- Insert item_variant using actual IDs
-- Replace <item_id>, <color_id>, <size_id> with results from above
INSERT INTO item_variant (item_id, color_id, size_id, opening_stock) VALUES (<item_id>, <color_id>, <size_id>, 100) RETURNING variant_id;

-- Insert production_lots using actual user_id
-- Replace <user_id> with result from above
INSERT INTO production_lots (process_id, lot_number, created_by, status, quantity) VALUES (1, 'LOT-TEST-1', <user_id>, 'Planning', 10) RETURNING id;

-- Insert purchase_orders using actual supplier_id
-- Replace <supplier_id> with result from above
INSERT INTO purchase_orders (po_number, supplier_id, order_date, status) VALUES ('PO-TEST-1', <supplier_id>, CURRENT_DATE, 'Draft') RETURNING po_id;
