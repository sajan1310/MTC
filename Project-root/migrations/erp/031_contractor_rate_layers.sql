-- Two-layer Contractor Rates, replacing the flat (contractor_name,
-- process_name) rate card from 013_contractors.sql: with ~200 individual
-- Process records (many just size variants of the same operation), a
-- per-process rate card was unmaintainable. Layer 1 keys on
-- (contractor, process_type, size) instead -- process_type is the
-- existing free-text tag on process_master.processType, size is derived
-- server-side from a lot's Process outputItemName (contractors_service.
-- _get_size_from_output_item_name), never a new user input. Layer 2 is
-- an optional per-unit extra charge (e.g. "Mounting Tyre/Tube"), added to
-- the Layer 1 rate before multiplying by qty, keyed on (contractor,
-- service_type), selected per Production lot.
--
-- No pre-existing rate data needs preserving (confirmed with the user),
-- so contractor_rates is dropped and recreated rather than altered in
-- place.

DROP TABLE IF EXISTS erp.contractor_rates;

-- No sync columns -- same precedent as the table it replaces: addressed
-- by (contractor_name, process_type, size), not a header+lines child.
-- Hard-deleted alongside its contractor.
CREATE TABLE erp.contractor_rates (
    id SERIAL PRIMARY KEY,
    contractor_name VARCHAR(255) NOT NULL,
    contractor_id INTEGER REFERENCES erp.contractors(id),
    process_type VARCHAR(255) NOT NULL,
    size VARCHAR(50) NOT NULL,
    rate_per_unit NUMERIC NOT NULL DEFAULT 0,
    remarks TEXT
);

CREATE UNIQUE INDEX ux_erp_contractor_rates_key_ci
    ON erp.contractor_rates (lower(contractor_name), lower(process_type), lower(size));


-- Layer 2, added to the Layer 1 rate per unit (not a flat per-lot fee --
-- see contractor_payable = (contractor_rate + extra_charge_amount) * qty
-- in production_service.py). Same no-sync-columns / hard-delete-with-
-- contractor precedent as contractor_rates.
CREATE TABLE IF NOT EXISTS erp.contractor_service_charges (
    id SERIAL PRIMARY KEY,
    contractor_name VARCHAR(255) NOT NULL,
    contractor_id INTEGER REFERENCES erp.contractors(id),
    service_type VARCHAR(255) NOT NULL,
    charge_amount NUMERIC NOT NULL DEFAULT 0,
    remarks TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_contractor_service_charges_key_ci
    ON erp.contractor_service_charges (lower(contractor_name), lower(service_type));


-- Snapshot of whichever Layer 2 charge (if any) applied to this lot, so
-- a lot's stamped contractor_payable stays reconstructable after the
-- rate card itself later changes.
ALTER TABLE erp.production
    ADD COLUMN IF NOT EXISTS extra_charge_type VARCHAR(255),
    ADD COLUMN IF NOT EXISTS extra_charge_amount NUMERIC NOT NULL DEFAULT 0;
