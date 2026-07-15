-- Items Master + the minimal Stock row plumbing Items depends on
-- (module_stock.js's syncStockForItem row CRUD only -- no derived Current
-- Stock formula yet, that needs Bills/Returns/Wastage/Issue/Production).

CREATE TABLE IF NOT EXISTS erp.items (
    id SERIAL PRIMARY KEY,
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT '',
    remarks TEXT,
    narration TEXT,
    specification TEXT,
    base_unit VARCHAR(255) NOT NULL DEFAULT 'Pcs',
    purchase_unit VARCHAR(255),
    weight_per_base_unit NUMERIC NOT NULL DEFAULT 0,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_items_name_size_ci
    ON erp.items (lower(item_name), lower(size)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_items_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.items
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


-- Rewritten wholesale alongside its parent item on every saveItem -- no sync
-- columns of its own, the parent's row_version is what's tracked.
CREATE TABLE IF NOT EXISTS erp.item_vendors (
    id SERIAL PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES erp.items(id) ON DELETE CASCADE,
    vendor VARCHAR(255) NOT NULL,
    rate NUMERIC NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_erp_item_vendors_item_id ON erp.item_vendors (item_id);


CREATE TABLE IF NOT EXISTS erp.stock (
    id SERIAL PRIMARY KEY,
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT '',
    initial_stock NUMERIC NOT NULL DEFAULT 0,
    threshold NUMERIC NOT NULL DEFAULT 0,
    dead_stock BOOLEAN NOT NULL DEFAULT FALSE,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_stock_name_size_ci
    ON erp.stock (lower(item_name), lower(size)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_stock_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.stock
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();
