-- Processed items received against a production lot, in parts.
--
-- A lot was either Completed or not. A job-work lot often comes back in
-- pieces: LOT-PC20SK-0002 sent 600 frames for powder coating on 07/10 and was
-- still "In Progress" three weeks later, with no way to say how many had come
-- back or to use the ones that had. A receipt records one delivery: on this
-- date, this many of the lot's output came back, colour by colour.
--
-- What a receipt does (the owner's rules, 2026-10-29):
--   - Its items go into the Warehouse Pool at the moment it was received,
--     and the lot's materials are used up for those items, colour by colour.
--     warehouse_service and stock_service read receipts alongside Completed
--     lots; see app/erp/services/lot_receipts.py for the arithmetic.
--   - The lot's balance is its quantity less what was received.
--   - Marking a partly received lot Completed counts the balance as received
--     then: Completed still means the whole lot. Cancelled keeps what was
--     received and drops only the balance.
--   - The contractor is owed for what was received.
--
-- A lot with no receipts behaves exactly as before.
--
-- Receipts are kept off erp.production for the reason lot_inspections is:
-- the lot's own columns already carry meaning. A receipt is a record about a
-- lot, made by someone at a moment, and the moment is what the pool's
-- recounts judge it by.

CREATE TABLE IF NOT EXISTS erp.production_receipts (
    id               SERIAL PRIMARY KEY,
    -- Lots are soft-deleted, so this can never dangle. A deleted lot's
    -- receipts are ignored with it.
    production_id    INTEGER NOT NULL REFERENCES erp.production(id),
    receipt_date     DATE NOT NULL,
    -- The sum of this receipt's lines.
    qty              NUMERIC NOT NULL CHECK (qty > 0),
    remarks          TEXT NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by       INTEGER REFERENCES public.users(user_id),
    -- Who received the goods, as they were named at the time, so the record
    -- keeps saying it after the account is renamed.
    created_by_name  VARCHAR(150),
    -- A receipt entered by mistake is deleted, never edited: the moment it
    -- was entered is what the Warehouse Pool judged it by.
    deleted_at       TIMESTAMPTZ,
    deleted_by       INTEGER REFERENCES public.users(user_id)
);

CREATE INDEX IF NOT EXISTS ix_erp_production_receipts_lot
    ON erp.production_receipts (production_id) WHERE deleted_at IS NULL;

-- One row per colour of the lot that came back. `color` and `size` name one
-- of the lot's counting colour_breakdown entries (the ones that sum to its
-- quantity), exactly as spelled there; a lot without colours has a single
-- line with both blank. A colour rename reaches these through
-- tags_service._rename_color_everywhere, as it reaches the lot.
CREATE TABLE IF NOT EXISTS erp.production_receipt_lines (
    id          SERIAL PRIMARY KEY,
    receipt_id  INTEGER NOT NULL REFERENCES erp.production_receipts(id) ON DELETE CASCADE,
    color       TEXT NOT NULL DEFAULT '',
    size        TEXT NOT NULL DEFAULT '',
    qty         NUMERIC NOT NULL CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS ix_erp_production_receipt_lines_receipt
    ON erp.production_receipt_lines (receipt_id);
