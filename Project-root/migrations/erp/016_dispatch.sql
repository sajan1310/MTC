-- Dispatch, ported from Apps_Script/module_dispatch.js -- the Dispatched
-- Goods ledger. Registering DISPATCH activates three already-shipped
-- guarded stubs with zero further code changes:
-- contractors_service._get_dispatch_logistics_payable_rows (Phase 3d),
-- bom_service._get_product_ids_in_use's DISPATCH leg (Phase 3c), and
-- warehouse_service._recalculate_warehouse_pool's Pass 3 (deferred since
-- Phase 3e/3g).
--
-- Full sync columns + soft delete, matching every other editable
-- "document" table (PO/Bill/Return/BOM/Contractors/Production) -- unlike
-- Wastage/Issue's create-only ledgers, Dispatch supports true
-- edit-in-place. This is also required for the already-shipped
-- _get_dispatch_logistics_payable_rows guard, which already queries
-- WHERE deleted_at IS NULL.
--
-- dispatch_number uses a real Postgres SEQUENCE, the same deliberate
-- deviation already applied to PO/Process/Product IDs: a global,
-- unscoped counter (unlike Production's per-Lot-Prefix lot numbers,
-- which stayed regex-scan).

CREATE SEQUENCE IF NOT EXISTS erp.dispatch_number_seq START 1001;

CREATE TABLE IF NOT EXISTS erp.dispatch (
    id SERIAL PRIMARY KEY,
    dispatch_number VARCHAR(50) NOT NULL,
    dispatch_date DATE NOT NULL,
    order_number VARCHAR(50),
    client_name VARCHAR(255),
    product_id VARCHAR(50) NOT NULL,
    bom_product_id INTEGER REFERENCES erp.bom_products(id),
    product_name VARCHAR(255) NOT NULL,
    qty NUMERIC NOT NULL,
    transport VARCHAR(255),
    remarks TEXT,
    invoice_number VARCHAR(100),
    private_mark VARCHAR(100),
    gr_number VARCHAR(100),
    logistics_contractor VARCHAR(255),
    contractor_id INTEGER REFERENCES erp.contractors(id),
    logistics_rate NUMERIC NOT NULL DEFAULT 0,
    logistics_cost NUMERIC NOT NULL DEFAULT 0,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_erp_dispatch_product_id ON erp.dispatch (lower(product_id));
CREATE INDEX IF NOT EXISTS ix_erp_dispatch_order_number ON erp.dispatch (lower(order_number));
CREATE INDEX IF NOT EXISTS ix_erp_dispatch_dispatch_number ON erp.dispatch (lower(dispatch_number));

CREATE TRIGGER trg_erp_dispatch_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.dispatch
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();
