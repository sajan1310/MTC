-- Bill Ledger: header+lines, like PO Tracker, but a real structural
-- difference -- PO_NUMBER is line-level here (one bill can combine items
-- fulfilling several different POs, or 'DIRECT'), and the header's identity
-- key is (vendor, bill_number), not bill_number alone (the same bill number
-- can legitimately recur across different vendors).

CREATE TABLE IF NOT EXISTS erp.bill_headers (
    id SERIAL PRIMARY KEY,
    bill_number VARCHAR(50) NOT NULL,
    vendor VARCHAR(255) NOT NULL,
    vendor_id INTEGER REFERENCES erp.vendors(id),
    contact VARCHAR(255),
    bill_date DATE NOT NULL,
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_bill_headers_vendor_number_ci
    ON erp.bill_headers (lower(vendor), lower(bill_number)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_bill_headers_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.bill_headers
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


-- No sync columns -- a child with no independent lifecycle, same precedent
-- as erp.po_lines/erp.item_vendors.
CREATE TABLE IF NOT EXISTS erp.bill_lines (
    id SERIAL PRIMARY KEY,
    header_id INTEGER NOT NULL REFERENCES erp.bill_headers(id) ON DELETE CASCADE,
    po_number VARCHAR(50),
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT '',
    narration TEXT,
    qty NUMERIC NOT NULL DEFAULT 0,
    unit VARCHAR(255) NOT NULL DEFAULT 'Pcs',
    price NUMERIC NOT NULL DEFAULT 0,
    gst_rate_pct NUMERIC NOT NULL DEFAULT 18,
    base_qty NUMERIC NOT NULL DEFAULT 0,
    base_rate NUMERIC NOT NULL DEFAULT 0,
    affects_stock BOOLEAN NOT NULL DEFAULT TRUE,
    item_id INTEGER REFERENCES erp.items(id)
);

CREATE INDEX IF NOT EXISTS ix_erp_bill_lines_header_id ON erp.bill_lines (header_id);
CREATE INDEX IF NOT EXISTS ix_erp_bill_lines_item_name_size ON erp.bill_lines (lower(item_name), lower(size));
CREATE INDEX IF NOT EXISTS ix_erp_bill_lines_po_number ON erp.bill_lines (lower(po_number));
