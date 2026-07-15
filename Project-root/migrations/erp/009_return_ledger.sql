-- Return Ledger: vendor goods returns (defective/excess/wrong item), the
-- mirror image of Bill Ledger -- header+lines, but return_number alone is
-- the identity key (globally unique), unlike Bill's (vendor, billNumber)
-- composite.

CREATE TABLE IF NOT EXISTS erp.return_headers (
    id SERIAL PRIMARY KEY,
    return_number VARCHAR(50) NOT NULL,
    return_date DATE NOT NULL,
    vendor VARCHAR(255) NOT NULL,
    vendor_id INTEGER REFERENCES erp.vendors(id),
    contact VARCHAR(255),
    bill_number VARCHAR(50),
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_return_headers_number_ci
    ON erp.return_headers (lower(return_number)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_return_headers_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.return_headers
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


-- No sync columns -- a child with no independent lifecycle, same precedent
-- as erp.po_lines/erp.bill_lines.
CREATE TABLE IF NOT EXISTS erp.return_lines (
    id SERIAL PRIMARY KEY,
    header_id INTEGER NOT NULL REFERENCES erp.return_headers(id) ON DELETE CASCADE,
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT '',
    narration TEXT,
    qty NUMERIC NOT NULL DEFAULT 0,
    unit VARCHAR(255) NOT NULL DEFAULT 'Pcs',
    price NUMERIC NOT NULL DEFAULT 0,
    reason TEXT,
    base_qty NUMERIC NOT NULL DEFAULT 0,
    base_rate NUMERIC NOT NULL DEFAULT 0,
    item_id INTEGER REFERENCES erp.items(id)
);

CREATE INDEX IF NOT EXISTS ix_erp_return_lines_header_id ON erp.return_lines (header_id);
CREATE INDEX IF NOT EXISTS ix_erp_return_lines_item_name_size ON erp.return_lines (lower(item_name), lower(size));
