-- Process Master + Process Components + Process Color Links, ported from
-- Apps_Script/module_process.js. Opens Phase 3 (manufacturing) the same way
-- 006_vendors.sql opened Phase 2.

CREATE SEQUENCE IF NOT EXISTS erp.process_id_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS erp.process_master (
    id SERIAL PRIMARY KEY,
    process_id VARCHAR(50) NOT NULL,
    process_name VARCHAR(255) NOT NULL,
    sequence INTEGER NOT NULL DEFAULT 0,
    lot_prefix VARCHAR(10) NOT NULL,
    is_final_stage BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    remarks TEXT,
    output_item_name VARCHAR(255) NOT NULL,
    process_type VARCHAR(255),
    primary_color_axis VARCHAR(255),
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_process_master_id_ci
    ON erp.process_master (lower(process_id)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_process_master_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.process_master
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


-- No sync columns -- a child with no independent lifecycle, same precedent
-- as erp.po_lines. Always rewritten wholesale alongside its process
-- (_saveProcessComponentsForProcess's delete-then-append replace).
CREATE TABLE IF NOT EXISTS erp.process_components (
    id SERIAL PRIMARY KEY,
    master_id INTEGER NOT NULL REFERENCES erp.process_master(id) ON DELETE CASCADE,
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT '',
    narration TEXT,
    qty_per_unit NUMERIC NOT NULL DEFAULT 1,
    remarks TEXT,
    source_type VARCHAR(10) NOT NULL DEFAULT 'ITEM' CHECK (source_type IN ('ITEM', 'POOL')),
    color_group VARCHAR(255) NOT NULL DEFAULT 'COMMON',
    color_axis VARCHAR(255),
    unit VARCHAR(255),
    item_id INTEGER REFERENCES erp.items(id)
);

CREATE INDEX IF NOT EXISTS ix_erp_process_components_master_id ON erp.process_components (master_id);
CREATE INDEX IF NOT EXISTS ix_erp_process_components_item_name_size ON erp.process_components (lower(item_name), lower(size));


-- No sync columns -- a preference row, not a real-quantity reference, so it
-- never blocks a delete like Production/BOM do. ON DELETE CASCADE is a
-- safety net for a future hard-delete/purge tool, not the normal delete
-- path: deleteProcess only soft-deletes process_master, so read-time
-- filtering in process_service (skip a link if the other side's process is
-- gone) is what actually makes a deleted process's links disappear today.
-- Directional storage (A/B) normalized at read time too.
CREATE TABLE IF NOT EXISTS erp.process_color_links (
    id SERIAL PRIMARY KEY,
    process_a_id INTEGER NOT NULL REFERENCES erp.process_master(id) ON DELETE CASCADE,
    color_a VARCHAR(255) NOT NULL,
    process_b_id INTEGER NOT NULL REFERENCES erp.process_master(id) ON DELETE CASCADE,
    color_b VARCHAR(255) NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_erp_process_color_links_a ON erp.process_color_links (process_a_id);
CREATE INDEX IF NOT EXISTS ix_erp_process_color_links_b ON erp.process_color_links (process_b_id);
