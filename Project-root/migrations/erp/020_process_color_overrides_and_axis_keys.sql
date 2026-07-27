-- Process Color Links same-process axis-key columns + Process Color
-- Overrides, ported from Apps_Script's config.js (ae9dbe7/36b3b42).
-- AXIS_A_KEY/AXIS_B_KEY let a link pair two axes of the SAME process (not
-- just cross-process); a blank axis key means "that side's own single
-- Warehouse-Pool-detected axis" -- the original/only meaning this table
-- ever had, so every pre-existing row keeps resolving exactly as before.
ALTER TABLE erp.process_color_links
    ADD COLUMN IF NOT EXISTS axis_a_key VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS axis_b_key VARCHAR(255) NOT NULL DEFAULT '';

-- One row per (Process, Color) the user has manually curated away from the
-- auto-computed "known colors" default (see
-- process_service._compute_known_colors_for_process). ACTION is always the
-- CURRENT state for that pair -- a later save for the same (Process,
-- Color) overwrites the row rather than appending a second one, so this
-- stays a small curated set, not a growing log.
--   EXCLUDE: this color must never appear as a known/placeholder
--     combination for this process, even though it would otherwise show up
--     via Color Master widening or a prior INCLUDE. Can only hide
--     zero-data noise -- never rejects a color that's actually configured
--     on the process's own recipe or has real Warehouse Pool history (see
--     process_service.exclude_warehouse_pool_colors).
--   INCLUDE: force-adds this color as known even though nothing else would
--     produce it. Also how a prior EXCLUDE gets undone (INCLUDE simply
--     overwrites it for that color).
CREATE TABLE IF NOT EXISTS erp.process_color_overrides (
    id SERIAL PRIMARY KEY,
    process_id VARCHAR(50) NOT NULL,
    color VARCHAR(255) NOT NULL,
    action VARCHAR(10) NOT NULL CHECK (action IN ('INCLUDE', 'EXCLUDE')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_process_color_overrides_process_color_ci
    ON erp.process_color_overrides (lower(process_id), lower(color));
