-- Stock Groups: user-defined named collections of item/size rows (Stock
-- tab), so the Low Stock Report preview can filter/print "group-wise"
-- (e.g. a saved "Stickers" or "Mudguard Bolts" group) instead of the user
-- hand-picking the same set of items every time. Follows the same
-- surrogate-id + soft-delete + row_version shape as the other masters
-- (see 003_masters.sql).

CREATE TABLE IF NOT EXISTS erp.stock_group_master (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    remarks TEXT,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id),
    client_uuid UUID UNIQUE,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_stock_group_master_name_ci
    ON erp.stock_group_master (lower(name)) WHERE deleted_at IS NULL;

CREATE TRIGGER trg_erp_stock_group_master_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.stock_group_master
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();


-- Rewritten wholesale alongside its parent group on every
-- setStockGroupItems (DELETE all rows for the group, then re-INSERT the
-- submitted set) -- same pattern as erp.item_vendors alongside erp.items.
-- No sync columns of its own; the parent group's row_version is what's
-- tracked. References item/size by the same text natural key erp.stock
-- itself uses (not a numeric FK to erp.stock.id) so a group can list a
-- size that doesn't have a stock row yet.
CREATE TABLE IF NOT EXISTS erp.stock_group_items (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES erp.stock_group_master(id) ON DELETE CASCADE,
    item_name VARCHAR(255) NOT NULL,
    size VARCHAR(255) NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_stock_group_items_group_name_size_ci
    ON erp.stock_group_items (group_id, lower(item_name), lower(size));

CREATE INDEX IF NOT EXISTS ix_erp_stock_group_items_group_id ON erp.stock_group_items (group_id);
