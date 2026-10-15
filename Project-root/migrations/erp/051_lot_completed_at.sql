-- When a lot was marked Completed, so a pool count cannot swallow a lot
-- that was finished after it.
--
-- A Warehouse Pool count (migration 045) absorbs everything dated at or
-- before it. A lot was judged by its own date -- the start of that date when
-- it was entered on another day -- and lots here are entered days AHEAD of
-- their date and marked Completed when the work is done: of the 753 lots
-- whose completion the activity log records, 535 were completed after their
-- date. So a count taken during a lot's day, before the lot was finished,
-- swallowed it. Fitted Frame 14 inch Jungle King IBC Steel Rim lost 30
-- frames that way on 2026-10-02 (LOT-FTD026-0014, dated 02/10, completed
-- 17:46, under a 13:19 count) and 23 more on 06/10 (LOT-FTD026-0016); each
-- loss surfaced as a negative that was patched by hand, and each patch
-- swallowed the next lot.
--
-- Scored against the 2026-10-14 snapshot: where two consecutive counts of
-- a bucket disagree on which lots fell between them, the completion time
-- puts the book nearer the later count in 35 of 51 pairs (total error 662
-- units against 1,152 for the date).
--
-- warehouse_service judges a lot by completed_at only when the lot was
-- entered on or before its own date. A lot entered AFTER its date is past
-- work typed in late, and a count taken in between already holds it --
-- the case migration 045 was written for, which keeps its date. completed_at
-- is the FIRST time the lot was marked Completed: switching a finished lot
-- back to In Progress and Completed again does not make it new stock.
ALTER TABLE erp.production
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Backfill from the activity log, which starts 2026-08-26: the first move
-- INTO Completed per lot, from either write path (the status buttons log
-- new_status, the lot form logs the form's status). Lots with no logged
-- completion stay NULL and keep being judged by their date.
--
-- With the row-version trigger off for this statement only. Left on, it
-- stamped updated_at and bumped row_version on all 754 backfilled lots
-- (checked on the 2026-10-14 backup): every one would read as edited at
-- deploy time, and an edit form or queued phone save holding the old
-- version would be refused as a conflict. Filling in a fact about the past
-- is not an edit. DDL is transactional, so a failure rolls this back too.
ALTER TABLE erp.production DISABLE TRIGGER trg_erp_production_touch_row_version;

WITH ev AS (
    SELECT a.id, a.logged_at,
           substring(a.detail FROM 'Lot #([^ ]+) ') AS lot,
           lower(CASE WHEN a.action = 'updateProductionStatus'
                      THEN a.args ->> 'new_status'
                      ELSE a.args -> 'form_data' ->> 'status' END) AS st
      FROM erp.activity_log a
     WHERE a.status = 'success'
       AND a.action IN ('updateProductionStatus', 'saveProduction')
),
seq AS (
    SELECT lot, st, logged_at,
           lag(st) OVER (PARTITION BY lot ORDER BY logged_at, id) AS prev
      FROM ev
     WHERE lot IS NOT NULL AND st IS NOT NULL
),
done AS (
    SELECT lot, min(logged_at) AS at
      FROM seq
     WHERE st = 'completed' AND prev IS DISTINCT FROM 'completed'
     GROUP BY lot
)
UPDATE erp.production p
   SET completed_at = done.at
  FROM done
 WHERE p.lot_number = done.lot
   AND p.deleted_at IS NULL
   AND p.completed_at IS NULL;

ALTER TABLE erp.production ENABLE TRIGGER trg_erp_production_touch_row_version;
