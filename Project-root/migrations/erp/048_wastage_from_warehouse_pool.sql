-- Wastage can be written off the Warehouse Pool, not only Items Stock.
--
-- A wastage line has always named an Items Master item and debited Items
-- Stock (stock_service's WASTAGE term). Processed goods go bad too -- a
-- painted frame comes out of the booth with a run in it -- and those units
-- live in a Warehouse Pool bucket, not in Items Stock. There was no way to
-- record them leaving: the bucket kept showing frames nobody could use.
--
-- source_type says which ledger a line debits, with the same two values and
-- the same meaning erp.process_components.source_type already gives them
-- (migration 010): 'ITEM' is an Items Master item, 'POOL' is a Warehouse
-- Pool bucket. Every existing row is an ITEM line, which the default makes
-- true without a backfill.
--
-- A POOL line names its bucket the way warehouse_service keys one: Output
-- Item Name (item_name), Product Tag and Color. size stays '' -- buckets have
-- none -- and unit stays 'Pcs', because the pool counts units.
ALTER TABLE erp.wastage_lines
    ADD COLUMN IF NOT EXISTS source_type VARCHAR(10) NOT NULL DEFAULT 'ITEM'
        CHECK (source_type IN ('ITEM', 'POOL'));
ALTER TABLE erp.wastage_lines
    ADD COLUMN IF NOT EXISTS color VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE erp.wastage_lines
    ADD COLUMN IF NOT EXISTS product_tag VARCHAR(50) NOT NULL DEFAULT '';

-- How much of a bucket's consumed_qty was wastage rather than a downstream
-- lot or a dispatch.
--
-- consumed_qty stays the one figure available_qty is computed from, so
-- nothing that reads availability changes. But Ready to Dispatch reports a
-- finished-goods bucket's consumed_qty as "Dispatched"
-- (dispatch_service._compute_ready_to_dispatch_map), and on those buckets it
-- was exactly that -- until damaged finished goods could be written off.
-- Without this column a write-off would read as a shipment nobody made.
--
-- A cache column like the rest of this table: _recalculate_warehouse_pool
-- rewrites it in full on every rebuild.
ALTER TABLE erp.warehouse_pool
    ADD COLUMN IF NOT EXISTS wasted_qty NUMERIC NOT NULL DEFAULT 0;
