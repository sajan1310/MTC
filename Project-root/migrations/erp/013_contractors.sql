-- Contractors + Contractor Rates + Contractor Payments, ported from
-- Apps_Script/module_contractors.js. Registering CONTRACTOR_RATES here
-- activates process_service._rename_process_name_in_contractor_rates,
-- a guarded no-op since Phase 3a.

CREATE TABLE IF NOT EXISTS erp.contractors (
    id SERIAL PRIMARY KEY,
    contractor_name VARCHAR(255) NOT NULL,
    contact VARCHAR(255),
    address TEXT,
    gst_pan VARCHAR(50),
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_contractors_name_ci
    ON erp.contractors (lower(contractor_name)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_contractors_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.contractors
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


-- No sync columns -- addressed by (contractor_name, process_name) pair,
-- not a header+lines child. Hard-deleted alongside its contractor
-- (deleteContractor physically removes these rows in the source too, not
-- a soft-invisible-via-join pattern -- there's no deleted_at here to join
-- through anyway).
CREATE TABLE IF NOT EXISTS erp.contractor_rates (
    id SERIAL PRIMARY KEY,
    contractor_name VARCHAR(255) NOT NULL,
    contractor_id INTEGER REFERENCES erp.contractors(id),
    process_name VARCHAR(255) NOT NULL,
    rate_per_unit NUMERIC NOT NULL DEFAULT 0,
    remarks TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_contractor_rates_pair_ci
    ON erp.contractor_rates (lower(contractor_name), lower(process_name));


-- Append-only, no sync columns -- same precedent as erp.rate_history /
-- erp.stock_adjustments.
CREATE TABLE IF NOT EXISTS erp.contractor_payments (
    id SERIAL PRIMARY KEY,
    payment_date DATE NOT NULL,
    contractor_name VARCHAR(255) NOT NULL,
    contractor_id INTEGER REFERENCES erp.contractors(id),
    amount NUMERIC NOT NULL,
    mode_reference VARCHAR(255),
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_erp_contractor_payments_contractor_name
    ON erp.contractor_payments (lower(contractor_name));
