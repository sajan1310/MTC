-- Dispatch Plan cards capture, per line: an optional Rate (record-keeping
-- only, same "never read by any availability/pool-crediting math" framing
-- erp.dispatch_lines.rate already documents -- see 023_dispatch_header_
-- lines.sql), and a free-text Remarks note. Transport is captured per
-- line too even though it's conceptually one value per CARD (client +
-- date) -- erp.dispatch_plan_lines has no header table to hang a single
-- shared value off (027's own comment explains why), so it's denormalized
-- across every line of a card exactly like client_name/plan_date already
-- are, and kept in sync across a card's lines by the save path
-- (dispatch_service.save_dispatch_plan_line) whenever the operator edits
-- the one Transport box the UI shows per card.
--
-- All three exist purely to be carried forward into the real Dispatch
-- bill when a card is converted (save_dispatch's own rate/remarks/
-- transport fields) -- pure convenience for the operator, no guard or
-- pool math anywhere reads these columns.
ALTER TABLE erp.dispatch_plan_lines
    ADD COLUMN IF NOT EXISTS rate NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS remarks VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS transport VARCHAR(255) NOT NULL DEFAULT '';
