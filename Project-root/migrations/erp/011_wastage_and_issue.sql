-- Wastage Log + Issued Stock Log, ported from Apps_Script/module_wastage.js
-- and module_issue.js. Both fill in a previously-stubbed term of Stock's
-- live Current Stock formula
-- (stock_service._get_billed_and_consumed_qty_maps).
--
-- No unique index on wastage_id/issue_id -- the source itself never checks
-- for a collision on its generated WST-/ISS-YYYYMMDD-HHMMSS ID (unlike PO/
-- Process/Return's business IDs), so a plain (non-unique) index is used for
-- query performance only, matching that lack of a constraint deliberately.

CREATE TABLE IF NOT EXISTS erp.wastage_headers (
    id SERIAL PRIMARY KEY,
    wastage_id VARCHAR(50) NOT NULL,
    wastage_date DATE NOT NULL,
    vendor VARCHAR(255),
    vendor_id INTEGER REFERENCES erp.vendors(id),
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_erp_wastage_headers_wastage_id ON erp.wastage_headers (lower(wastage_id));

CREATE TRIGGER trg_erp_wastage_headers_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.wastage_headers
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


-- No sync columns -- a child with no independent lifecycle, same precedent
-- as erp.return_lines. Always rewritten wholesale alongside its header (in
-- practice, always written once -- saveWastage is create-only).
CREATE TABLE IF NOT EXISTS erp.wastage_lines (
    id SERIAL PRIMARY KEY,
    header_id INTEGER NOT NULL REFERENCES erp.wastage_headers(id) ON DELETE CASCADE,
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT '',
    qty NUMERIC NOT NULL DEFAULT 0,
    unit VARCHAR(255) NOT NULL DEFAULT 'Pcs',
    reason TEXT,
    base_qty NUMERIC NOT NULL DEFAULT 0,
    item_id INTEGER REFERENCES erp.items(id)
);

CREATE INDEX IF NOT EXISTS ix_erp_wastage_lines_header_id ON erp.wastage_lines (header_id);
CREATE INDEX IF NOT EXISTS ix_erp_wastage_lines_item_name_size ON erp.wastage_lines (lower(item_name), lower(size));


CREATE TABLE IF NOT EXISTS erp.issue_headers (
    id SERIAL PRIMARY KEY,
    issue_id VARCHAR(50) NOT NULL,
    issue_date DATE NOT NULL,
    issued_to VARCHAR(255) NOT NULL,
    reference VARCHAR(255),
    -- Derived snapshot (matched against Vendor Master by issued_to at save
    -- time), not a direct user input -- see issue_service._match_vendor_name.
    vendor VARCHAR(255),
    vendor_id INTEGER REFERENCES erp.vendors(id),
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_erp_issue_headers_issue_id ON erp.issue_headers (lower(issue_id));

CREATE TRIGGER trg_erp_issue_headers_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.issue_headers
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


CREATE TABLE IF NOT EXISTS erp.issue_lines (
    id SERIAL PRIMARY KEY,
    header_id INTEGER NOT NULL REFERENCES erp.issue_headers(id) ON DELETE CASCADE,
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT '',
    qty NUMERIC NOT NULL DEFAULT 0,
    unit VARCHAR(255) NOT NULL DEFAULT 'Pcs',
    base_qty NUMERIC NOT NULL DEFAULT 0,
    rate NUMERIC NOT NULL DEFAULT 0,
    item_id INTEGER REFERENCES erp.items(id)
);

CREATE INDEX IF NOT EXISTS ix_erp_issue_lines_header_id ON erp.issue_lines (header_id);
CREATE INDEX IF NOT EXISTS ix_erp_issue_lines_item_name_size ON erp.issue_lines (lower(item_name), lower(size));
