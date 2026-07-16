-- Production, ported from Apps_Script/module_production.js -- the
-- capstone of Phase 3 manufacturing. Registering PRODUCTION activates
-- several already-shipped guarded stubs with zero code changes:
-- contractors_service._contractor_in_use_message/_rename_contractor_everywhere
-- and bom_service._get_product_ids_in_use.
--
-- Full sync columns + soft delete, matching every other "document" table
-- (PO/Bill/Return) -- a deliberate deviation from the source's hard
-- sheet.deleteRow. custom_components/components_consumed/color_breakdown
-- use JSONB (the first use in this schema): genuinely client-submitted,
-- read-modify-write-wholesale blobs the source itself never normalized
-- into child rows either.

CREATE TABLE IF NOT EXISTS erp.production (
    id SERIAL PRIMARY KEY,
    production_date DATE NOT NULL,
    product_id VARCHAR(50),
    product_name VARCHAR(255),
    bom_product_id INTEGER REFERENCES erp.bom_products(id),
    qty NUMERIC NOT NULL,
    assigned_by VARCHAR(255),
    assigned_to VARCHAR(255) NOT NULL,
    contractor_id INTEGER REFERENCES erp.contractors(id),
    status VARCHAR(20) NOT NULL DEFAULT 'Pending',
    remarks TEXT,
    custom_components JSONB,
    sheet_remarks TEXT,
    process_id VARCHAR(50) NOT NULL,
    process_master_id INTEGER REFERENCES erp.process_master(id),
    lot_number VARCHAR(50) NOT NULL,
    contractor_rate NUMERIC NOT NULL DEFAULT 0,
    contractor_payable NUMERIC NOT NULL DEFAULT 0,
    output_item_name VARCHAR(255),
    components_consumed JSONB,
    color VARCHAR(1000),
    color_breakdown JSONB,
    order_number VARCHAR(50),
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_erp_production_status ON erp.production (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_erp_production_process_id ON erp.production (process_id);
CREATE INDEX IF NOT EXISTS ix_erp_production_lot_number ON erp.production (lower(lot_number));

CREATE TRIGGER trg_erp_production_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.production
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();
