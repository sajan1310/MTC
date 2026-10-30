-- The earlier lots a production lot was connected to, by the person logging it.
--
-- Nothing linked one lot to another: the Warehouse Pool records what a lot
-- consumed against an item and a colour, never against the lot that made it.
-- Logging a Packing lot, there was no way to see when the frames behind it
-- were fitted or painted without leaving the form (the owner, 2026-10-30).
--
-- A row here is the operator's own statement: "this lot came from that one".
-- The pool cannot prove it, because stock from different lots mixes in a
-- bucket. So it is information and nothing more: the Warehouse Pool, Stock
-- and the contractor ledger never read this table.
--
-- Connecting lots is optional. Nothing is back-filled: older lots simply have
-- no rows here, and connections start with the lots logged from now on.
--
-- Kept off erp.production for the reason receipts are (055): this is a record
-- about a lot, not one of the lot's own columns. Lots are soft-deleted, so
-- neither reference can dangle; a link to a lot deleted later stays, and is
-- shown as deleted.

CREATE TABLE IF NOT EXISTS erp.production_lot_refs (
    production_id      INTEGER NOT NULL REFERENCES erp.production(id),
    ref_production_id  INTEGER NOT NULL REFERENCES erp.production(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by         INTEGER REFERENCES public.users(user_id),
    PRIMARY KEY (production_id, ref_production_id),
    CONSTRAINT production_lot_refs_not_self
        CHECK (production_id <> ref_production_id)
);

-- "Which lots was this one connected to" is the primary key's own prefix.
-- This one answers the reverse: "which lots used this one".
CREATE INDEX IF NOT EXISTS ix_erp_production_lot_refs_ref
    ON erp.production_lot_refs (ref_production_id);
