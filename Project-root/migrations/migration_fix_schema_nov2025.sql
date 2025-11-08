-- ============================================================================
-- Combined SQL Migration: Fix Schema Mismatches (November 2025)
-- File: migration_fix_schema_nov2025.sql
-- Purpose:
--   * Align production_lots schema (created_by, worst_case_estimated_cost, status constraint)
--   * Add item_master.category
--   * Add substitute_groups.deleted_at (soft delete support)
--   * Correct import_jobs foreign key (users.id -> users.user_id)
--   * Add helpful indexes (idempotent)
-- Safety:
--   * Fully idempotent (uses IF EXISTS / IF NOT EXISTS / conditional DO blocks)
--   * Non‑destructive (no data drops). Existing statuses preserved; constraint uses lower(status).
-- Run:
--   psql -h <host> -U <user> -d <db> -f migration_fix_schema_nov2025.sql
-- ============================================================================
BEGIN;

-- 1. Columns -----------------------------------------------------------------
ALTER TABLE production_lots
    ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE production_lots
    ADD COLUMN IF NOT EXISTS worst_case_estimated_cost NUMERIC(12,2);
ALTER TABLE item_master
    ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE substitute_groups
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- 1b. Fix incorrect foreign key on import_jobs (should reference users.user_id)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name='import_jobs' AND constraint_name='fk_user'
    ) THEN
        -- Drop existing fk_user (regardless of column reference) and recreate
        EXECUTE 'ALTER TABLE import_jobs DROP CONSTRAINT fk_user';
    END IF;
    -- Ensure users.user_id exists (prevent error if base table name differs)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='users' AND column_name='user_id'
    ) THEN
        EXECUTE 'ALTER TABLE import_jobs ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE';
    END IF;
END$$;

-- 2. Normalize production_lots status constraint ------------------------------
-- Drop old constraint if present
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname='production_lots' AND c.conname='production_lots_status_check'
    ) THEN
        EXECUTE 'ALTER TABLE production_lots DROP CONSTRAINT production_lots_status_check';
    END IF;
END$$;

-- Create unified case-insensitive CHECK
ALTER TABLE production_lots
ADD CONSTRAINT production_lots_status_check
CHECK (lower(status) IN (
    'planning','ready','in progress','in_progress','active','inactive','draft','completed','failed','cancelled','archived'
));

-- 3. Helpful Indexes ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_substitute_groups_deleted_at ON substitute_groups(deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_item_master_category ON item_master(category);
CREATE INDEX IF NOT EXISTS idx_production_lots_status ON production_lots(status);

COMMIT;

-- Verification Queries (Optional - comment out for strict CI) -----------------
-- SELECT column_name FROM information_schema.columns WHERE table_name='production_lots' AND column_name IN ('created_by','worst_case_estimated_cost');
-- SELECT column_name FROM information_schema.columns WHERE table_name='item_master' AND column_name='category';
-- SELECT column_name FROM information_schema.columns WHERE table_name='substitute_groups' AND column_name='deleted_at';
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='production_lots_status_check';
-- SELECT * FROM information_schema.table_constraints WHERE table_name='import_jobs' AND constraint_name='fk_user';
-- ============================================================================
