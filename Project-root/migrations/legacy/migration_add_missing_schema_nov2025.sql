-- Add missing columns
ALTER TABLE production_lots ADD COLUMN IF NOT EXISTS worst_case_estimated_cost NUMERIC;
ALTER TABLE item_master ADD COLUMN IF NOT EXISTS category VARCHAR;

-- Add missing indexes
CREATE INDEX IF NOT EXISTS idx_substitute_groups_deleted_at ON substitute_groups (deleted_at);
CREATE INDEX IF NOT EXISTS idx_item_master_category ON item_master (category);