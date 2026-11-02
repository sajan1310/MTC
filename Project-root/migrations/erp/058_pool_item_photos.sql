-- A photo for each Warehouse Pool item: a painted frame, a fitted rim, any
-- Process's Output Item.
--
-- Photos lived on Items Master alone (erp.items.image, migration 024). A
-- pool item is not an Items Master item -- it is a Process's Output Item
-- Name -- so an inspection checklist row for one had nowhere to put a
-- photo, and the camera appeared only on the odd pool row whose name and
-- size happened to match an Items Master item (the owner, 2026-11-02:
-- "sometimes it randomly appears, expected is the uniform availability").
--
-- One photo per item name, every colour and product tag of it alike, as an
-- Items Master item has one photo whatever colour it is bought in. Keyed by
-- the name case-insensitively, the way the pool keys its buckets
-- (warehouse_service._build_warehouse_pool_buckets), so two Processes that
-- write the same Output Item Name share one photo as they share buckets.
-- process_service._rename_pool_output_item_name_everywhere carries the
-- photo across a rename.
--
-- The photo is a base64 data: URL, as on erp.items, served at
-- /erp/pool-photo/<id>?v=<row_version>. A row exists only while there is a
-- photo; nothing is soft-deleted here.

CREATE TABLE IF NOT EXISTS erp.pool_item_photos (
    id SERIAL PRIMARY KEY,
    output_item_name VARCHAR(255) NOT NULL,
    image TEXT NOT NULL,
    row_version BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by INTEGER REFERENCES public.users(user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_erp_pool_item_photos_name_ci
    ON erp.pool_item_photos (lower(output_item_name));

CREATE TRIGGER trg_erp_pool_item_photos_touch_row_version
    BEFORE INSERT OR UPDATE ON erp.pool_item_photos
    FOR EACH ROW EXECUTE FUNCTION erp.touch_row_version();
