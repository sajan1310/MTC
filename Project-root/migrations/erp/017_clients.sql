-- Clients + PI/Estimates (Client Orders), ported from
-- Apps_Script/module_clients.js. Registering CLIENT_ORDERS_HEADERS/
-- CLIENT_ORDERS_LINES activates bom_service._get_product_ids_in_use's
-- Client Orders leg and dispatch_service._get_client_order_line_qty --
-- both guarded no-ops until now, and both fixed this round from a
-- flat-single-table assumption to this real header+lines split (the
-- same "flat key" mistake this project has hit and fixed several times
-- before finalizing a denormalized sheet's real schema).
--
-- erp.clients and erp.client_orders_headers get full sync columns +
-- soft delete, matching every other editable master/document table.
-- erp.client_orders_lines is a child table with no sync columns,
-- wholesale deleted+reinserted alongside its header on edit -- mirrors
-- erp.bom_lines exactly.
--
-- order_number uses a real Postgres SEQUENCE (erp.order_number_seq),
-- the same deliberate deviation already applied to PO/Process/Product/
-- Dispatch numbers: a global, unscoped counter.

CREATE SEQUENCE IF NOT EXISTS erp.order_number_seq START 1001;

CREATE TABLE IF NOT EXISTS erp.clients (
    id SERIAL PRIMARY KEY,
    client_name VARCHAR(255) NOT NULL,
    contact VARCHAR(50),
    address TEXT,
    gstin VARCHAR(50),
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_erp_clients_client_name ON erp.clients (lower(client_name));

CREATE TRIGGER trg_erp_clients_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.clients
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();

CREATE TABLE IF NOT EXISTS erp.client_orders_headers (
    id SERIAL PRIMARY KEY,
    order_number VARCHAR(50) NOT NULL,
    order_date DATE NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Estimate',
    order_remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_erp_client_orders_headers_order_number ON erp.client_orders_headers (lower(order_number));
CREATE INDEX IF NOT EXISTS ix_erp_client_orders_headers_client_name ON erp.client_orders_headers (lower(client_name));

CREATE TRIGGER trg_erp_client_orders_headers_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.client_orders_headers
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();

CREATE TABLE IF NOT EXISTS erp.client_orders_lines (
    id SERIAL PRIMARY KEY,
    header_id INTEGER NOT NULL REFERENCES erp.client_orders_headers(id),
    product_id VARCHAR(50) NOT NULL,
    bom_product_id INTEGER REFERENCES erp.bom_products(id),
    product_name VARCHAR(255) NOT NULL,
    qty NUMERIC NOT NULL,
    line_remarks TEXT,
    production_pushed VARCHAR(10) NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS ix_erp_client_orders_lines_header_id ON erp.client_orders_lines (header_id);
CREATE INDEX IF NOT EXISTS ix_erp_client_orders_lines_product_id ON erp.client_orders_lines (lower(product_id));
