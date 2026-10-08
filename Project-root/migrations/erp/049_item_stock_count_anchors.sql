-- A stock count is where Items Stock starts from, not a difference.
--
-- adjust_stock_manually stored a count by back-solving initial_stock:
-- `initial_stock = counted - billed + consumed`, using whatever movements
-- existed at that instant. That is true against exactly one ledger state.
-- Anything dated earlier that reached the formula afterwards -- a lot
-- completed after the count, a backdated issue, an edit to an old lot --
-- landed on top of a figure somebody had physically counted. Audited
-- against the 2026-10-07 snapshot: 78 of 613 items' latest counts no
-- longer held (net -4,234 units); BB-AXLE 2-C's 08-04 count of 12,200 read
-- 11,902, moved by one 298-frame lot dated 07-08. It is the defect
-- migration 045 fixed for the Warehouse Pool, still open on Items Stock.
--
-- stock_service now treats the newest ADJUST or RESET row of an item as
-- its anchor: Current Stock = the counted figure + only the movements that
-- take effect after the count. No column is needed for that -- each row
-- already carries the counted figure (new_value) and the moment it was
-- taken (created_at).
--
-- One new kind of row is. A merge used to fold the removed item's
-- initial_stock into the kept one. The anchored formula does not read
-- initial_stock for a counted item, so a merge into a counted item would
-- silently drop the merged-in stock. Such a merge now writes a MERGE row
-- here instead: a movement (new_value - old_value) dated at the merge, never
-- an anchor, because nobody counted anything. Existing data needs no
-- backfill: the four merges logged after their kept item's count (the Spice
-- Kids and Jungle King chain-cover stickers) merged in items that had
-- themselves been counted at zero, so the old fold and the anchored formula
-- give the same figure for both surviving items -- checked on the snapshot.
ALTER TABLE erp.stock_adjustments
    DROP CONSTRAINT IF EXISTS stock_adjustments_action_check;
ALTER TABLE erp.stock_adjustments
    ADD CONSTRAINT stock_adjustments_action_check
        CHECK (action IN ('ADJUST', 'RESET', 'MERGE'));
