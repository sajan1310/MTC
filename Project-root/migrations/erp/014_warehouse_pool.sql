-- Warehouse Pool Opening + Warehouse Pool, ported from
-- Apps_Script/module_warehouse.js. Registering WAREHOUSE_POOL_OPENING
-- activates three dormant guarded cascades from earlier phases with zero
-- code changes: tags_service._rename_color_everywhere (color),
-- process_service._rename_pool_output_item_name_everywhere
-- (output_item_name), and process_service._get_process_ids_in_use (a
-- Process delete-guard).
--
-- Only Pass 0 (Opening Balances) of recalculateWarehousePool() lands this
-- round -- Passes 1/2 (Production credit/debit) and Pass 3 (Dispatch
-- debit) land with their respective modules, extending the same
-- accumulator rather than rewriting it.

CREATE TABLE IF NOT EXISTS erp.warehouse_pool_opening (
    id SERIAL PRIMARY KEY,
    output_item_name VARCHAR(255) NOT NULL,
    process_id VARCHAR(50) NOT NULL,
    process_master_id INTEGER REFERENCES erp.process_master(id),
    product_tag VARCHAR(50),
    color VARCHAR(255),
    qty NUMERIC NOT NULL,
    opening_date DATE NOT NULL,
    remarks TEXT,
    created_by INTEGER REFERENCES public.users(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_erp_warehouse_pool_opening_item
    ON erp.warehouse_pool_opening (lower(output_item_name));


-- Materialized cache -- fully truncated + rewritten by
-- warehouse_service._recalculate_warehouse_pool on every call, same
-- "small dataset, cheap to rebuild" approach as erp.stock's live Current
-- Stock formula (except this one really is stored, not computed live).
CREATE TABLE IF NOT EXISTS erp.warehouse_pool (
    id SERIAL PRIMARY KEY,
    output_item_name VARCHAR(255) NOT NULL,
    process_id VARCHAR(50),
    product_tag VARCHAR(50),
    produced_qty NUMERIC NOT NULL DEFAULT 0,
    consumed_qty NUMERIC NOT NULL DEFAULT 0,
    available_qty NUMERIC NOT NULL DEFAULT 0,
    color VARCHAR(255),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_erp_warehouse_pool_item
    ON erp.warehouse_pool (lower(output_item_name));


-- Append-only audit trail, mirrors erp.stock_adjustments exactly -- a
-- dedicated table instead of the source's generic Logs-sheet workaround
-- (URI-encoded record ID + regex-parsed details string).
CREATE TABLE IF NOT EXISTS erp.warehouse_pool_adjustments (
    id SERIAL PRIMARY KEY,
    output_item_name VARCHAR(255) NOT NULL,
    product_tag VARCHAR(50),
    color VARCHAR(255),
    old_value NUMERIC NOT NULL,
    new_value NUMERIC NOT NULL,
    reason TEXT,
    created_by INTEGER REFERENCES public.users(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
