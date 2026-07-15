-- Vendors master, same shape as Phase 1a's erp.units / tag masters.

CREATE TABLE IF NOT EXISTS erp.vendors (
    id SERIAL PRIMARY KEY,
    vendor_name VARCHAR(255) NOT NULL,
    contact VARCHAR(255),
    address TEXT,
    gstin VARCHAR(50),
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_vendors_name_ci
    ON erp.vendors (lower(vendor_name)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_vendors_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.vendors
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();
