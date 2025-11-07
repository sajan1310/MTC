-- Missing Tables for Universal Process Framework
-- Run this against the MTC database to complete schema synchronization
-- Date: November 7, 2025

-- ============================================================================
-- 1. VARIANT_USAGE TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS variant_usage (
    id SERIAL PRIMARY KEY,
    process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
    variant_id INTEGER NOT NULL REFERENCES item_variant(variant_id) ON DELETE RESTRICT,
    quantity NUMERIC(10,4) NOT NULL CHECK (quantity > 0),
    cost_per_unit NUMERIC(10,2),
    total_cost NUMERIC(12,2),
    substitute_group_id INTEGER,
    is_alternative BOOLEAN DEFAULT FALSE,
    alternative_order INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_variant_usage_subprocess ON variant_usage(process_subprocess_id);
CREATE INDEX IF NOT EXISTS idx_variant_usage_variant ON variant_usage(variant_id);
CREATE INDEX IF NOT EXISTS idx_variant_usage_group ON variant_usage(substitute_group_id);

COMMENT ON TABLE variant_usage IS 'Tracks variants (items) used in each subprocess with quantities and costs';
COMMENT ON COLUMN variant_usage.substitute_group_id IS 'References substitute_groups for OR group functionality';

-- ============================================================================
-- 2. COST_ITEMS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS cost_items (
    id SERIAL PRIMARY KEY,
    process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
    cost_type VARCHAR(50) NOT NULL CHECK (cost_type IN ('labor', 'electricity', 'maintenance', 'service', 'overhead', 'packing', 'transport', 'other')),
    description TEXT,
    amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
    unit VARCHAR(20),
    quantity NUMERIC(10,2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cost_items_subprocess ON cost_items(process_subprocess_id);
CREATE INDEX IF NOT EXISTS idx_cost_items_type ON cost_items(cost_type);

COMMENT ON TABLE cost_items IS 'Tracks various cost items (labor, electricity, etc.) for each subprocess';

-- ============================================================================
-- 3. SUBSTITUTE_GROUPS TABLE (OR Groups)
-- ============================================================================
CREATE TABLE IF NOT EXISTS substitute_groups (
    id SERIAL PRIMARY KEY,
    process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
    group_name VARCHAR(255) NOT NULL,
    group_description TEXT,
    selection_method VARCHAR(50) DEFAULT 'dropdown' CHECK (selection_method IN ('dropdown', 'radio', 'list')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_substitute_groups_subprocess ON substitute_groups(process_subprocess_id);

COMMENT ON TABLE substitute_groups IS 'Defines OR groups for alternative variant selections in subprocesses';
COMMENT ON COLUMN substitute_groups.selection_method IS 'UI method for selecting alternatives: dropdown, radio buttons, or list';

-- ============================================================================
-- 4. ADD FOREIGN KEY CONSTRAINT
-- ============================================================================
-- Add foreign key from variant_usage to substitute_groups
-- This allows tracking which variants belong to which OR groups
ALTER TABLE variant_usage
    ADD CONSTRAINT fk_variant_usage_substitute_group
    FOREIGN KEY (substitute_group_id)
    REFERENCES substitute_groups(id)
    ON DELETE CASCADE;

-- ============================================================================
-- 5. OPTIONAL: PROCESS_TIMING TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS process_timing (
    id SERIAL PRIMARY KEY,
    process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
    estimated_duration NUMERIC(10,2),
    actual_duration NUMERIC(10,2),
    duration_unit VARCHAR(20) DEFAULT 'minutes' CHECK (duration_unit IN ('minutes', 'hours', 'days')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(process_subprocess_id)
);

CREATE INDEX IF NOT EXISTS idx_process_timing_subprocess ON process_timing(process_subprocess_id);

COMMENT ON TABLE process_timing IS 'Tracks estimated vs actual time for subprocess execution';

-- ============================================================================
-- 6. OPTIONAL: CONDITIONAL_FLAGS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS conditional_flags (
    id SERIAL PRIMARY KEY,
    process_subprocess_id INTEGER NOT NULL REFERENCES process_subprocesses(id) ON DELETE CASCADE,
    condition_type VARCHAR(50) CHECK (condition_type IN ('quality_check', 'rework', 'alternative_path', 'skip_step')),
    description TEXT,
    is_enabled BOOLEAN DEFAULT FALSE,
    condition_value VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conditional_flags_subprocess ON conditional_flags(process_subprocess_id);

COMMENT ON TABLE conditional_flags IS 'Defines conditional logic and branching within processes';

-- ============================================================================
-- 7. UPDATE TRIGGER FOR TIMESTAMPS
-- ============================================================================
-- Create trigger function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply triggers to tables with updated_at
DROP TRIGGER IF EXISTS update_variant_usage_updated_at ON variant_usage;
CREATE TRIGGER update_variant_usage_updated_at
    BEFORE UPDATE ON variant_usage
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_cost_items_updated_at ON cost_items;
CREATE TRIGGER update_cost_items_updated_at
    BEFORE UPDATE ON cost_items
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_substitute_groups_updated_at ON substitute_groups;
CREATE TRIGGER update_substitute_groups_updated_at
    BEFORE UPDATE ON substitute_groups
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_process_timing_updated_at ON process_timing;
CREATE TRIGGER update_process_timing_updated_at
    BEFORE UPDATE ON process_timing
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_conditional_flags_updated_at ON conditional_flags;
CREATE TRIGGER update_conditional_flags_updated_at
    BEFORE UPDATE ON conditional_flags
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 8. VERIFICATION QUERIES
-- ============================================================================

-- Verify all tables were created
DO $$
DECLARE
    missing_tables TEXT[];
    table_name TEXT;
BEGIN
    missing_tables := ARRAY[]::TEXT[];
    
    FOREACH table_name IN ARRAY ARRAY['variant_usage', 'cost_items', 'substitute_groups', 'process_timing', 'conditional_flags']
    LOOP
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = table_name) THEN
            missing_tables := array_append(missing_tables, table_name);
        END IF;
    END LOOP;
    
    IF array_length(missing_tables, 1) IS NULL THEN
        RAISE NOTICE '✅ All tables created successfully!';
    ELSE
        RAISE NOTICE '❌ Missing tables: %', array_to_string(missing_tables, ', ');
    END IF;
END $$;

-- Show table counts
SELECT 
    'variant_usage' as table_name, 
    COUNT(*) as row_count 
FROM variant_usage
UNION ALL
SELECT 
    'cost_items', 
    COUNT(*) 
FROM cost_items
UNION ALL
SELECT 
    'substitute_groups', 
    COUNT(*) 
FROM substitute_groups;

-- Show all UPF-related tables
SELECT 
    tablename, 
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables 
WHERE tablename IN (
    'processes', 
    'subprocesses', 
    'process_subprocesses', 
    'variant_usage', 
    'cost_items', 
    'substitute_groups',
    'additional_costs',
    'profitability',
    'process_timing',
    'conditional_flags'
)
ORDER BY tablename;

-- ============================================================================
-- COMPLETION MESSAGE
-- ============================================================================

DO $$
BEGIN
    RAISE NOTICE '================================================================================';
    RAISE NOTICE '✅ MISSING UPF TABLES CREATED SUCCESSFULLY!';
    RAISE NOTICE '================================================================================';
    RAISE NOTICE 'Created tables:';
    RAISE NOTICE '  - variant_usage (with indexes and triggers)';
    RAISE NOTICE '  - cost_items (with indexes and triggers)';
    RAISE NOTICE '  - substitute_groups (with indexes and triggers)';
    RAISE NOTICE '  - process_timing (optional, with indexes and triggers)';
    RAISE NOTICE '  - conditional_flags (optional, with indexes and triggers)';
    RAISE NOTICE '';
    RAISE NOTICE 'Foreign keys configured:';
    RAISE NOTICE '  - variant_usage -> process_subprocesses';
    RAISE NOTICE '  - variant_usage -> item_variant';
    RAISE NOTICE '  - variant_usage -> substitute_groups';
    RAISE NOTICE '  - cost_items -> process_subprocesses';
    RAISE NOTICE '  - substitute_groups -> process_subprocesses';
    RAISE NOTICE '';
    RAISE NOTICE 'Next steps:';
    RAISE NOTICE '  1. Test process editor variant management';
    RAISE NOTICE '  2. Test cost item creation';
    RAISE NOTICE '  3. Test OR group functionality';
    RAISE NOTICE '  4. Run: python Project-root/scripts/verify_upf_endpoints.py';
    RAISE NOTICE '================================================================================';
END $$;
