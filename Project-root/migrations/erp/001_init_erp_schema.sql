-- ERP skeleton schema (Phase 0). Domain tables (~38, one per Apps Script
-- sheet tab) are added incrementally in later migrations as each module is
-- ported -- see app/erp/config_maps.py for the column source of truth.

CREATE SCHEMA IF NOT EXISTS erp;

-- Clock-skew-free sync cursor for offline-sync (Phase 6). Every mutable
-- table's row_version comes from this sequence.
CREATE SEQUENCE IF NOT EXISTS erp.change_seq;

-- Tracks which migrations/erp/*.sql files have been applied. Deliberately
-- separate from the app's two existing (and mutually inconsistent)
-- migration trackers (migrations_applied / schema_migrations in the public
-- schema) -- ERP migrations are fully self-contained.
CREATE TABLE IF NOT EXISTS erp.migrations_applied (
    id SERIAL PRIMARY KEY,
    migration_name VARCHAR(255) NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Small key/value settings store -- e.g. the BOM access password hash
-- (Phase 3) and other app-level ERP settings that don't warrant their own
-- table.
CREATE TABLE IF NOT EXISTS erp.app_settings (
    key VARCHAR(255) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
