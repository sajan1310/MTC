-- A recount is a count, not a difference.
--
-- adjust_warehouse_pool_manually stored only `delta = new_qty - old_qty`.
-- That difference is true against exactly one ledger state: the one that
-- existed at the instant it was measured. Anything dated earlier that
-- arrives afterwards -- a lot completed late, a backdated dispatch, an
-- edited quantity -- lands underneath the recount and moves a figure a
-- person put their hands on. Audited against this database on 2026-09-12:
-- 57 of 314 recounted buckets no longer matched what was counted, 691
-- units gross. 52 lots carrying 14,431 units are dated on or before a
-- recount but were edited after it.
--
-- The net was only -47 units, which is why it went unnoticed for a month:
-- over- and under-statements very nearly cancel, so every total looked
-- plausible while individual buckets were wrong by up to 120.
--
-- Two columns fix it.
--
-- counted_qty -- when non-null this row is a RECOUNT, and it carries the
-- absolute figure somebody counted rather than a delta. Pass 0 seeds the
-- bucket with it and discards everything dated at or before it: that
-- history is already inside the count. `qty` keeps the delta so the
-- existing ledger line, the audit trail and getWarehousePoolOpeningData
-- read exactly as they did.
--
-- opening_at -- the moment the entry takes effect, so ordering inside a
-- single day is decided by data instead of by luck. A lot booked at 15:00
-- and a recount taken at 18:00 on the same date have an unambiguous order
-- now; before this they were both "2026-08-31" and the recount lost.
--
-- The backfill rule for a row that predates this column is "date known,
-- time unknown -> start of that day". A historical same-day lot therefore
-- sorts before a timed recount, which is the conservative reading and the
-- one the floor confirmed: a count taken during the day is a count of what
-- that day had already produced.

ALTER TABLE erp.warehouse_pool_opening
    ADD COLUMN IF NOT EXISTS opening_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS counted_qty NUMERIC(14, 2);

-- Rows entered on the date they are dated for keep their real timestamp;
-- everything else falls back to midnight of its own date.
UPDATE erp.warehouse_pool_opening
   SET opening_at = CASE
           WHEN created_at IS NOT NULL AND opening_date = created_at::date
               THEN created_at
           ELSE opening_date::timestamptz
       END
 WHERE opening_at IS NULL;

ALTER TABLE erp.warehouse_pool_opening
    ALTER COLUMN opening_at SET DEFAULT NOW();

-- Which historical correction rows were genuine hand recounts: the ones
-- adjust_warehouse_pool_manually also wrote an audit row for, in the same
-- transaction and therefore within a second or two. Against this database
-- 406 of 408 audit rows match exactly one opening row that way; the other
-- 2 are ambiguous and are deliberately left as plain deltas rather than
-- guessed at. Bulk-imported opening rows carry no audit row at all and are
-- correctly untouched -- they are seed data, not counts.
WITH candidate AS (
    SELECT o.id AS opening_id,
           a.id AS adj_id,
           a.new_value,
           count(*) OVER (PARTITION BY o.id) AS adj_matches,
           count(*) OVER (PARTITION BY a.id) AS opening_matches
      FROM erp.warehouse_pool_opening o
      JOIN erp.warehouse_pool_adjustments a
        ON lower(trim(o.output_item_name)) = lower(trim(a.output_item_name))
       AND lower(trim(coalesce(o.product_tag, ''))) = lower(trim(coalesce(a.product_tag, '')))
       AND lower(trim(coalesce(o.color, ''))) = lower(trim(coalesce(a.color, '')))
       AND abs(extract(epoch FROM (o.created_at - a.created_at))) <= 2
     WHERE o.remarks LIKE 'Correction: %'
       AND o.created_at IS NOT NULL
       AND a.created_at IS NOT NULL
)
UPDATE erp.warehouse_pool_opening o
   SET counted_qty = c.new_value
  FROM candidate c
 WHERE o.id = c.opening_id
   AND o.counted_qty IS NULL
   AND c.adj_matches = 1
   AND c.opening_matches = 1;

-- The anchor lookup runs once per rebuild and reads only the newest
-- recount per bucket, keyed the way get_bucket() keys a bucket.
CREATE INDEX IF NOT EXISTS ix_erp_warehouse_pool_opening_anchor
    ON erp.warehouse_pool_opening (
        lower(output_item_name), lower(coalesce(product_tag, '')),
        lower(coalesce(color, '')), opening_at DESC
    )
    WHERE counted_qty IS NOT NULL;

-- Production and Dispatch need the same "when was this actually booked"
-- signal, for the same reason: a lot dated 31 August tells you nothing
-- about whether it was entered before or after that evening's recount.
-- Neither table had a creation timestamp -- only updated_at, which moves
-- every time somebody edits the row and so cannot stand in for one.
ALTER TABLE erp.production
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE erp.production
   SET created_at = production_date::timestamptz
 WHERE created_at IS NULL AND production_date IS NOT NULL;
ALTER TABLE erp.production
    ALTER COLUMN created_at SET DEFAULT NOW();

ALTER TABLE erp.dispatch_headers
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;
UPDATE erp.dispatch_headers
   SET created_at = dispatch_date::timestamptz
 WHERE created_at IS NULL AND dispatch_date IS NOT NULL;
ALTER TABLE erp.dispatch_headers
    ALTER COLUMN created_at SET DEFAULT NOW();

-- Seventeen rows whose day and month were transposed on the way in.
--
-- The bulk import of 2026-07-31 (579 rows, one timestamp, created_by NULL)
-- walked the calendar in ascending date order. Read the stored dates back
-- and that ascent has exactly one backward step:
--
--     id 356  2026-07-07
--     id 357  2026-08-07  ] 13 rows
--     id 370  2026-11-07  ]  4 rows
--     id 374  2026-07-13  <- the only step backwards in 579 rows
--     id 380  2026-07-14
--     id 388  2026-07-15
--
-- Read those two blocks as day-month and the break disappears: 6 Jul, 7
-- Jul, 8 Jul, 11 Jul, 13 Jul, 14 Jul, 15 Jul, 22, 25, 30. Monotonic, zero
-- breaks. The dates that survived are the tell -- 13, 14, 15, 22, 25 and 30
-- cannot be mistaken for a month, and only days 1-12 were ever at risk.
--
-- This is not cosmetic once the anchors above exist. A row dated 7 November
-- reads as four months AFTER the 5 August recount that already absorbed it,
-- so the pool credits it a second time on top of the count. Measured on a
-- clone of the live database: leaving these as they are turns the fix into
-- roughly 4,300 units of stock that was never made, across Jungle King 14
-- inch, Orbit Sports 20 inch and Runway 20 inch. Corrected, the same
-- rebuild moves 63 buckets by a net -167 units.
--
-- Quantities are untouched. Only the date moves -- and the quantities are
-- load-bearing: the 5 August recounts were taken against a pool that
-- already held these rows, so reversing them would drive those buckets to
-- roughly -469 each.
UPDATE erp.warehouse_pool_opening
   SET opening_date = DATE '2026-07-08',
       opening_at   = DATE '2026-07-08'::timestamptz
 WHERE opening_date = DATE '2026-08-07'
   AND created_at::date = DATE '2026-07-31';

UPDATE erp.warehouse_pool_opening
   SET opening_date = DATE '2026-07-11',
       opening_at   = DATE '2026-07-11'::timestamptz
 WHERE opening_date = DATE '2026-11-07'
   AND created_at::date = DATE '2026-07-31';
