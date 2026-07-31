-- Dispatch Differentiator, ported from Apps_Script's PROCESS_COL.
-- DISPATCH_DIFFERENTIATOR (1288076/6a22f0e).
--
-- Names the ONE color axis of a final-stage process whose value identifies
-- the product on the Ready to Dispatch list. A final-stage pool color is the
-- whole chain's composite ("Black / Blue-White / Brown / Kraft"), but
-- dispatch usually cares about just one part of it, so the list splits into
-- one row per distinct value of this axis, labelled "<Output Item> / <value>".
--
-- Stored as the axis LABEL (not a key), the same convention as
-- PRIMARY_COLOR_AXIS, so both pickers on the Process form offer the same
-- option list and a renamed axis degrades the same way (falls back to one
-- aggregate row rather than erroring).
--
-- Blank on every pre-existing row, which reads as "no differentiator" -- the
-- pre-feature behavior of one aggregate row per product.
ALTER TABLE erp.process_master
    ADD COLUMN IF NOT EXISTS dispatch_differentiator VARCHAR(255) NOT NULL DEFAULT '';
