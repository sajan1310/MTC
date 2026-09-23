-- An opening balance takes effect on the date it is FOR, not the moment
-- somebody typed it.
--
-- Migration 045 gave erp.warehouse_pool_opening an opening_at, so that a
-- count taken at 18:00 could outrank a lot booked at 15:00 on the same date,
-- and gave the column a DEFAULT of NOW(). adjust_warehouse_pool_manually
-- sets it deliberately. save_warehouse_pool_opening never did, so every
-- ordinary opening balance took that default -- and the default is only
-- right for a row dated today.
--
-- Backdate one and the two fields disagree outright: opening_date says
-- 2 September, opening_at says the afternoon of the 23rd. _build_warehouse_
-- pool_buckets judges the freeze on opening_at, so an opening balance for
-- stock that was on the shelf three weeks ago read as having arrived AFTER
-- a recount taken today, and was credited on top of a count that already
-- included it. Measured on the test database: a bucket counted at 40, given
-- a backdated opening of 12, reported 52.
--
-- That is the exact double-apply migration 045 exists to prevent, left open
-- on the one table 045 was written for. Production and Dispatch were never
-- exposed to it because neither stores a booked-at moment that can be wrong
-- -- both call _effective_at on the row's own date, which falls back to the
-- start of that day. save_warehouse_pool_opening now stamps opening_at with
-- that same function at write time.
--
-- The rows already written this way are identifiable exactly, with no
-- guessing. 045's own backfill left EVERY row it touched with
-- opening_at::date = opening_date -- it used created_at only where the two
-- dates already agreed, and midnight of opening_date otherwise. So a row
-- where they now disagree can only have come from an insert that took the
-- default while being dated for another day, which is precisely the defect.
--
-- Recount anchors (counted_qty IS NOT NULL) are excluded and left exactly as
-- they are. adjust_warehouse_pool_manually always dates them for the day it
-- writes them, so none should match this predicate in the first place; the
-- guard is there because an anchor's stored moment is evidence about when
-- somebody stood at a shelf, and a migration should not move that even if
-- some row surprises us.
--
-- This moves numbers, and it is meant to. A bucket that was credited a
-- backdated opening on top of a count that already contained it will fall by
-- that opening's qty on the next rebuild -- the double-count coming off. A
-- backdated opening on a bucket that has never been recounted is unaffected
-- arithmetically (there is no anchor, so nothing was ever frozen); only its
-- position in the ledger's date order changes, which is a straightforward
-- improvement.

-- `opening_at::date` below is evaluated in the SESSION's timezone, and
-- the rows being judged had their opening_date derived from the APP's
-- local clock. Those are two different sources, and a session that
-- happened to be UTC would read a row written at 02:00 IST as belonging
-- to the previous day -- then 'repair' a row that was never broken,
-- moving its effective moment back far enough for a recount to absorb
-- it. Declare the frame instead of inheriting it, so this repair means
-- the same thing wherever it is run. Asia/Kolkata is what the server
-- runs (reported as its Asia/Calcutta alias) and what config.py pins
-- onto every application connection as DB_TIMEZONE.
SET LOCAL TimeZone = 'Asia/Kolkata';

UPDATE erp.warehouse_pool_opening
   SET opening_at = opening_date::timestamptz
 WHERE counted_qty IS NULL
   AND opening_at IS NOT NULL
   AND opening_at::date <> opening_date;
