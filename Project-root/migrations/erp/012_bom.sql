-- BOM (Bill of Materials): Product Master + recipe lines + additional
-- costs, ported from Apps_Script/module_bom.js. Opens the Product side of
-- Phase 3 manufacturing, alongside Process Master's already-ported Process
-- side.

CREATE SEQUENCE IF NOT EXISTS erp.product_id_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS erp.bom_products (
    id SERIAL PRIMARY KEY,
    product_id VARCHAR(50) NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    remarks TEXT,
    sequence INTEGER NOT NULL DEFAULT 0,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_bom_products_id_ci
    ON erp.bom_products (lower(product_id)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_bom_products_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.bom_products
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


-- No sync columns -- a child with no independent lifecycle, same precedent
-- as erp.po_lines/erp.process_components. Always rewritten wholesale
-- alongside its product (saveBOM's delete-all-existing-then-reinsert).
-- process_group is a real, unvalidated soft reference to Process Master's
-- business ID (never checked against it on write, matching the source
-- exactly) -- process_master_id is a best-effort resolved FK alongside it,
-- same "text is source of truth, FK is for joins" precedent as item_id.
CREATE TABLE IF NOT EXISTS erp.bom_lines (
    id SERIAL PRIMARY KEY,
    header_id INTEGER NOT NULL REFERENCES erp.bom_products(id) ON DELETE CASCADE,
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT '',
    narration TEXT,
    rate NUMERIC NOT NULL DEFAULT 0,
    vendor VARCHAR(255),
    vendor_id INTEGER REFERENCES erp.vendors(id),
    qty_per_product NUMERIC NOT NULL DEFAULT 0,
    process_group VARCHAR(50),
    process_master_id INTEGER REFERENCES erp.process_master(id),
    color VARCHAR(255),
    item_id INTEGER REFERENCES erp.items(id)
);

CREATE INDEX IF NOT EXISTS ix_erp_bom_lines_header_id ON erp.bom_lines (header_id);
CREATE INDEX IF NOT EXISTS ix_erp_bom_lines_item_name_size ON erp.bom_lines (lower(item_name), lower(size));


-- No sync columns, same child precedent. process_name/contractor_name are
-- both free-text, never validated against Process Master or a future
-- Contractors table -- matches the source exactly (process_name is
-- display-only here, unlike bom_lines.process_group which is a real ref).
CREATE TABLE IF NOT EXISTS erp.bom_additional_costs (
    id SERIAL PRIMARY KEY,
    header_id INTEGER NOT NULL REFERENCES erp.bom_products(id) ON DELETE CASCADE,
    description VARCHAR(255) NOT NULL,
    rate NUMERIC NOT NULL DEFAULT 0,
    process_name VARCHAR(255),
    contractor_name VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS ix_erp_bom_additional_costs_header_id ON erp.bom_additional_costs (header_id);


-- Replaces CacheService's 6-hour BOM access token (module_bom.js's
-- verifyBOMAccess/_requireBOMAccess) -- the BOM sheet holds commercially
-- sensitive rates/costs, gated separately from ordinary login. No cleanup
-- job for expired rows, matching this project's "no infrastructure beyond
-- what's asked" discipline -- a stale row is simply never matched again.
CREATE TABLE IF NOT EXISTS erp.bom_access_tokens (
    token UUID PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
);
