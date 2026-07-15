-- PO Tracker: the first denormalized sheet, split into header+lines.
-- vendor_id/item_id are best-effort resolved FKs (nullable) -- the text
-- columns (vendor/item_name/size) remain the source of truth for display
-- and matching, matching the source's own denormalized-snapshot design
-- (kept in sync by rename cascades, not by joining through the FK).

CREATE SEQUENCE IF NOT EXISTS erp.po_number_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS erp.po_headers (
    id SERIAL PRIMARY KEY,
    po_number VARCHAR(50) NOT NULL,
    po_date DATE,
    vendor VARCHAR(255) NOT NULL,
    vendor_id INTEGER REFERENCES erp.vendors(id),
    contact VARCHAR(255),
    po_description TEXT,
    po_remarks TEXT,
    supplier_remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_po_headers_number_ci
    ON erp.po_headers (lower(po_number)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_po_headers_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.po_headers
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


-- No sync columns -- a child with no independent lifecycle, same precedent
-- as erp.item_vendors. Always rewritten wholesale alongside its header.
CREATE TABLE IF NOT EXISTS erp.po_lines (
    id SERIAL PRIMARY KEY,
    header_id INTEGER NOT NULL REFERENCES erp.po_headers(id) ON DELETE CASCADE,
    item_name VARCHAR(255) NOT NULL,
    narration TEXT,
    size VARCHAR(255) NOT NULL DEFAULT '',
    qty NUMERIC NOT NULL DEFAULT 0,
    unit VARCHAR(255) NOT NULL DEFAULT 'Pcs',
    price NUMERIC NOT NULL DEFAULT 0,
    base_qty NUMERIC NOT NULL DEFAULT 0,
    base_rate NUMERIC NOT NULL DEFAULT 0,
    item_id INTEGER REFERENCES erp.items(id)
);

CREATE INDEX IF NOT EXISTS ix_erp_po_lines_header_id ON erp.po_lines (header_id);
CREATE INDEX IF NOT EXISTS ix_erp_po_lines_item_name_size ON erp.po_lines (lower(item_name), lower(size));


-- Append-only, no sync columns -- matches erp.stock_adjustments.
CREATE TABLE IF NOT EXISTS erp.rate_history (
    id SERIAL PRIMARY KEY,
    rate_date DATE NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT '',
    narration TEXT,
    vendor_name VARCHAR(255) NOT NULL,
    rate NUMERIC NOT NULL,
    po_number VARCHAR(50),
    bill_number VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_erp_rate_history_item ON erp.rate_history (lower(item_name), lower(size));
