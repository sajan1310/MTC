"""Stock, ported from Apps_Script/module_stock.js.

Current Stock is computed live (never stored) via _get_stock_terms. All
five terms (Bill, Return, Wastage, Issue, Production) are real as of Phase
3g -- the last one, Production's ITEM-sourced components_consumed qty on
Completed lots, was the final gap this function's own docstring called out
since Phase 1c. See that phase's plan for why this isn't a SQL view (this
formula needed 5 undesigned future schemas, not one predictable column
name) -- each term was filled in only once its source table's real schema
existed.

A stock count is where an item's Current Stock starts from (migration 049).
The newest ADJUST or RESET row in erp.stock_adjustments is the item's
anchor: Current Stock = what was counted + only the movements that take
effect after the count. An item nobody has counted starts from
erp.stock.initial_stock, as it always did. See _get_stock_terms.

getStockAdjustmentHistory reads a real erp.stock_adjustments table instead
of the source's regex-parsed Logs-sheet workaround -- the feature (queryable
adjustment history) is retained, the GAS-specific plumbing isn't.

Not ported: initStockSheet/backfillPoAndBillBaseQty (GAS sheet-bootstrap/
legacy-column-migration, no Postgres equivalent needed -- schema is created
correctly from day one via SQL migrations), renameItemMasterForStockEdit
(fires from a Sheets onEdit trigger; no RPC equivalent for that interaction
model, and the protection it offers is already covered by saveItem's own
rename path).
"""

from __future__ import annotations

from typing import NamedTuple

import psycopg2.extras

import database
from . import items_service
from . import locks
from . import units_service
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method


# ─────────────────────────────────────────────────────────────────────────
# When a movement takes effect, judged against an item's latest count
# ─────────────────────────────────────────────────────────────────────────
#
# A count is a statement about a shelf at a moment (erp.stock_adjustments.
# created_at). Everything that took effect at or before that moment is
# already inside the counted figure and must never move the item again,
# however late it is entered, completed or edited. So every movement needs a
# moment too, and these expressions are the only place one is worked out --
# the Stock formula and the Item Ledger both read them.
#
# Lots, returns, wastage and issues are physical events, dated to the day
# they happened, and take the Warehouse Pool's rule (warehouse_service.
# _effective_at): a row entered on its own date knows its time of day;
# anything else -- backdated, or written before created_at existed, which
# migrations 045/046 backfilled to midnight -- takes the start of its date.
# A count taken during a day therefore absorbs what that day had already
# done. Measured since the activity log began: 113 of the 124 lots dated on
# a count day were entered before the count.
#
# Bills are not physical events. A bill's date is the supplier's invoice
# date, not when the goods reached the shelf, and the bill form already
# asks the operator about exactly that case -- checkStockAdjustmentConflicts
# offers "Ledger only" when a count may already hold those goods. So a bill
# takes effect when it was ENTERED, the moment the operator vouched for it.
# A bill written before migration 046 has no entry time (created_at was
# backfilled to midnight of its date) and takes the END of that day instead:
# all 14 bills dated on a count day since the activity log began were
# entered after the count, none before.
#
# Evaluated in the session's TimeZone, which database.init_app pins to
# DB_TIMEZONE on every connection -- the frame migration 046's backfill was
# written in, so the midnight test below means what it says.


def _doc_moment_sql(day: str, created: str) -> str:
    return (
        f"(CASE WHEN {created} IS NOT NULL AND {created}::date = {day} "
        f"THEN {created} ELSE {day}::timestamptz END)"
    )


_BILL_MOMENT_SQL = (
    "(CASE WHEN h.created_at IS NULL OR h.created_at = h.bill_date::timestamptz "
    "THEN (h.bill_date + 1)::timestamptz - interval '1 microsecond' "
    "ELSE h.created_at END)"
)
_LOT_MOMENT_SQL = _doc_moment_sql("p.production_date", "p.created_at")

# Each item's newest count: the figure its Current Stock starts from, and the
# moment that decides which movements it already holds. ADJUST is a count
# typed on the Stock page, RESET a re-import of the whole figure. A MERGE row
# is never an anchor -- nobody counted anything -- see items_service.
# _merge_stock_and_delete. Ties on created_at go to the higher id, the row
# entered last.
#
# MATERIALIZED is load-bearing. Postgres cannot estimate how many lots
# survive the JSONB filters in _PRODUCTION_CONSUMED_SQL (it guesses one), so
# left to inline this CTE it re-sorted erp.stock_adjustments once per lot:
# 7.4 s for the production term on the 2026-10-07 snapshot instead of ~0.1 s.
# Computed once, it is a few hundred rows hashed for every join.
_ANCHOR_CTE = """
    anchor AS MATERIALIZED (
        SELECT DISTINCT ON (lower(btrim(item_name)), lower(btrim(COALESCE(size, ''))))
               lower(btrim(item_name))          AS name_k,
               lower(btrim(COALESCE(size, ''))) AS size_k,
               id, created_at AS at, new_value
          FROM erp.stock_adjustments
         WHERE action IN ('ADJUST', 'RESET')
         ORDER BY lower(btrim(item_name)), lower(btrim(COALESCE(size, ''))),
                  created_at DESC, id DESC
    )
"""


def _iter_completed_production_components(cur):
    """Yields one normalized dict per ITEM-sourced component line on a
    Completed production lot -- the SINGLE definition of "production
    consumption" in this codebase.

    Both the Current Stock formula (_get_stock_terms's
    PRODUCTION term) and the Item Ledger (get_item_ledger_data) read this
    generator rather than each re-deriving "what did production eat". The
    Item Ledger previously reconstructed an ESTIMATE client-side from the
    BOM recipe (lot.qty x bom.qtyPerProduct) instead of the lot's own
    recorded components_consumed, which could not agree with Stock by
    construction: it silently dropped every non-final-stage lot (only
    final-stage lots carry a productId to match a BOM by -- see
    save_production), and even for the lots it did match it showed the
    planned recipe rather than what was actually consumed (the two
    legitimately drift -- cf. bom_service.get_bom_process_components_drift).

    POOL-sourced components are excluded here for the same reason Stock
    excludes them: they debit the Warehouse Pool, not Items Stock (see
    warehouse_service._build_warehouse_pool_buckets's Pass 2).

    Quantities are converted to the item's Base Unit exactly as the Stock
    formula does -- blank unit means "already in Base Unit", and an
    unconvertible unit falls back to the as-entered qty rather than
    blocking the read. `enteredQty`/`unit` are carried alongside `baseQty`
    so the ledger can show what the operator actually typed while still
    totalling in base units.
    """
    table = config_maps.TABLE_NAMES.get("PRODUCTION")
    if not table:
        return

    item_unit_map = items_service.get_item_unit_info_map(cur)
    units_map = units_service.get_units_map(cur)

    cur.execute(
        f"""
        SELECT p.lot_number, p.production_date, p.process_id, p.product_name,
               p.output_item_name, p.components_consumed,
               {_LOT_MOMENT_SQL} AS stock_at
        FROM {table} p
        WHERE p.deleted_at IS NULL AND lower(p.status) = 'completed'
        """
    )
    for row in cur.fetchall():
        for comp in row["components_consumed"] or []:
            if not isinstance(comp, dict):
                continue
            if str(comp.get("sourceType") or "").strip().upper() == "POOL":
                continue
            item_name = str(comp.get("itemName") or "").strip()
            if not item_name:
                continue
            size = str(comp.get("size") or "").strip()
            entered_qty = float(comp.get("qty") or 0)

            # Blank unit = "already in the item's Base Unit" -- an
            # unconvertible unit must never block the Stock computation,
            # same fallback-to-entered-qty precedent every other term uses.
            qty = entered_qty
            unit = str(comp.get("unit") or "").strip()
            if unit:
                unit_info = items_service.lookup_item_unit_info(
                    item_unit_map, item_name, size
                )
                try:
                    qty = units_service.convert_qty_to_base_unit(
                        qty, unit, unit_info, units_map
                    )
                except ValueError:
                    pass

            yield {
                "itemName": item_name,
                "size": size,
                "baseQty": qty,
                "enteredQty": entered_qty,
                "unit": unit,
                "lotNumber": str(row["lot_number"] or "").strip(),
                "productionDate": row["production_date"],
                # When this consumption takes effect against a count -- the
                # same _LOT_MOMENT_SQL the Stock formula filters on.
                "stockAt": row["stock_at"],
                "processId": str(row["process_id"] or "").strip(),
                "productName": str(row["product_name"] or "").strip(),
                "outputItemName": str(row["output_item_name"] or "").strip(),
            }


# The four line-table terms of the Current Stock formula, aggregated in SQL
# (PERF-002 step 1).
#
# These four used to be four separate SELECTs whose every row was transferred
# into Python and folded into a dict -- the entire history of every bill,
# return, wastage note and stock issue, on every Stock read, every Item Ledger
# view and every dashboard load. At five years of the audit's own projected
# volume that is six figures of rows to answer a question about a few hundred
# items.
#
# All four use `base_qty`, which is already normalised to the item's Base Unit
# at WRITE time, so there is no business logic to move -- this is pure
# aggregation and the database does it far better. The PRODUCTION term is
# different and stays partly in Python; see _production_consumed_map.
#
# The predicates mirror the Python they replace exactly:
#   - bill lines are additive and honour affects_stock; the other three debit
#   - every header filtered on deleted_at IS NULL
#   - a blank item name is skipped (`if not key.split("|")[0]: continue`)
#   - keys are lower(strip(...)), matching f'{name.strip().lower()}|{size...}'
#
# A wastage line written off the Warehouse Pool (source_type 'POOL',
# migration 048) is excluded: it names a pool bucket, not an Items Master
# item, and debits the pool instead -- the same split production's POOL
# components already have.
#
# A fifth branch carries merges (migration 049): a MERGE row in
# erp.stock_adjustments moves the kept item by new_value - old_value at the
# moment of the merge, exactly like a dated movement. And every branch now
# says when its row takes effect, so the outer query can drop whatever an
# item's newest count already holds -- see the moment expressions at the top
# of this module.
#
# `{line_keys}` / `{adj_keys}` are empty for the whole-table read and an IN
# filter for a page of items -- see _MOVEMENT_SQL_FOR_ITEMS below.
_MOVEMENT_ROWS_SQL = f"""
        SELECT lower(btrim(l.item_name))          AS name_k,
               lower(btrim(COALESCE(l.size, ''))) AS size_k,
               l.base_qty                         AS delta,
               {_BILL_MOMENT_SQL}                 AS at
          FROM erp.bill_lines l
          JOIN erp.bill_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL AND l.affects_stock = TRUE{{line_keys}}
        UNION ALL
        SELECT lower(btrim(l.item_name)), lower(btrim(COALESCE(l.size, ''))),
               -l.base_qty, {_doc_moment_sql("h.return_date", "h.created_at")}
          FROM erp.return_lines l
          JOIN erp.return_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL{{line_keys}}
        UNION ALL
        SELECT lower(btrim(l.item_name)), lower(btrim(COALESCE(l.size, ''))),
               -l.base_qty, {_doc_moment_sql("h.wastage_date", "h.created_at")}
          FROM erp.wastage_lines l
          JOIN erp.wastage_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL AND l.source_type <> 'POOL'{{line_keys}}
        UNION ALL
        SELECT lower(btrim(l.item_name)), lower(btrim(COALESCE(l.size, ''))),
               -l.base_qty, {_doc_moment_sql("h.issue_date", "h.created_at")}
          FROM erp.issue_lines l
          JOIN erp.issue_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL{{line_keys}}
        UNION ALL
        SELECT lower(btrim(item_name)), lower(btrim(COALESCE(size, ''))),
               new_value - old_value, created_at
          FROM erp.stock_adjustments
         WHERE action = 'MERGE'{{adj_keys}}
"""

# A movement counts toward Current Stock when its item has never been
# counted, or when it takes effect AFTER the newest count. At-or-before is
# already inside the counted figure -- the same `<=` warehouse_service's
# frozen() applies to a recounted bucket. A row with no moment at all is
# treated as having always been there.
_MOVEMENT_SQL_TEMPLATE = """
    WITH {anchor_cte}
    SELECT m.name_k, m.size_k, SUM(m.delta) AS net
      FROM ({rows}) m
      LEFT JOIN anchor a ON a.name_k = m.name_k AND a.size_k = m.size_k
     WHERE m.name_k <> ''
       AND (a.at IS NULL OR m.at > a.at)
     GROUP BY 1, 2
"""

_MOVEMENT_SQL = _MOVEMENT_SQL_TEMPLATE.format(
    anchor_cte=_ANCHOR_CTE,
    rows=_MOVEMENT_ROWS_SQL.format(line_keys="", adj_keys=""),
)

# Production's ITEM-sourced consumption, expanded and pre-aggregated in SQL.
#
# This one cannot move to SQL wholesale: each component's qty may be recorded
# in a unit other than the item's Base Unit, and converting it is real business
# logic (units_service.convert_qty_to_base_unit handles same-family ratios,
# Weight->Count via weight-per-base-unit, and a documented fallback).
# Reimplementing that in SQL would duplicate a business rule, which is exactly
# what this codebase has been careful not to do.
#
# So SQL does the part it is good at -- unnesting the JSONB array, discarding
# POOL-sourced entries, and collapsing everything to one row per
# (item, size, unit) -- and Python still performs the conversion, once per
# GROUP rather than once per component.
#
# That regrouping is exact, not an approximation: convert_qty_to_base_unit is
# strictly linear in qty on both of its branches
# (`q * factor / divisor`, no rounding, no clamping), so
# convert(sum(q)) == sum(convert(q)) for a fixed unit. Verified by test against
# the row-by-row implementation, which is retained for the Item Ledger.
#
# A lot dated at or before an item's newest count is inside that count
# whenever it was completed -- the defect migration 049 closes: completing a
# lot days after a count used to take its components off a figure that had
# already been counted without them.
#
# The components are expanded once, into their own MATERIALIZED CTE, and
# only then joined to the anchors. Joined inside the lateral expansion, the
# planner -- which estimates one surviving lot -- ran a separate hash join
# per lot against every anchor: 0.41 s on the 2026-10-07 snapshot, twice the
# unanchored query. One join over the whole expansion keeps it level.
_PRODUCTION_CONSUMED_SQL = (
    """
    WITH """
    + _ANCHOR_CTE
    + """,
    comps AS MATERIALIZED (
        SELECT lower(btrim(comp ->> 'itemName'))                 AS name_k,
               lower(btrim(COALESCE(comp ->> 'size', '')))       AS size_k,
               btrim(COALESCE(comp ->> 'unit', ''))              AS unit,
               COALESCE(NULLIF(comp ->> 'qty', '')::numeric, 0)  AS qty,
               """
    + _LOT_MOMENT_SQL
    + """                                       AS at
        FROM {table} p
        CROSS JOIN LATERAL jsonb_array_elements(p.components_consumed) AS comp
        WHERE p.deleted_at IS NULL
          AND lower(p.status) = 'completed'
          -- jsonb_array_elements ERRORS on a non-array. The Python it
          -- replaces iterated whatever was there and skipped non-dict
          -- entries, so a lot whose components_consumed is an object must
          -- be ignored, not fatal.
          AND jsonb_typeof(p.components_consumed) = 'array'
          AND jsonb_typeof(comp) = 'object'
          AND upper(btrim(COALESCE(comp ->> 'sourceType', ''))) <> 'POOL'
          AND btrim(COALESCE(comp ->> 'itemName', '')) <> ''
    )
    SELECT c.name_k, c.size_k, c.unit, SUM(c.qty) AS qty
    FROM comps c
    LEFT JOIN anchor a ON a.name_k = c.name_k AND a.size_k = c.size_k
    WHERE a.at IS NULL OR c.at > a.at
    GROUP BY 1, 2, 3
"""
)


# The same aggregation, restricted to a named set of items.
#
# This is what makes pagination worth having (PERF-002 step 2). Returning 50
# rows instead of 800 saves payload, but the expensive half is computing
# movement for every item that has ever existed -- so a paginated read that
# still full-scans has fixed the symptom and not the cost.
#
# Restricted to a page's items, these four scans become index lookups: the
# `lower(item_name), lower(size)` expression indexes on all four line tables
# (migrations 008/009/011) match this predicate exactly. That is the
# difference between O(all history) and O(rows for 50 items). The anchor CTE
# is not narrowed the same way: it reads erp.stock_adjustments, a table of a
# few hundred rows that one count at a time adds to.
_MOVEMENT_SQL_FOR_ITEMS = _MOVEMENT_SQL_TEMPLATE.format(
    anchor_cte=_ANCHOR_CTE,
    rows=_MOVEMENT_ROWS_SQL.format(
        line_keys="\n           AND (lower(l.item_name), lower(COALESCE(l.size, ''))) IN %(keys)s",
        adj_keys="\n           AND (lower(item_name), lower(COALESCE(size, ''))) IN %(keys)s",
    ),
)


def _movement_map(cur, keys: list | None = None) -> dict:
    """Net bill/return/wastage/issue/merge movement that took effect after
    each item's newest count (all of it, for an item never counted),
    optionally for `keys` only.

    `keys` is a list of (name_lower, size_lower) tuples.
    """
    if keys is None:
        cur.execute(_MOVEMENT_SQL)
    elif not keys:
        return {}
    else:
        cur.execute(_MOVEMENT_SQL_FOR_ITEMS, {"keys": tuple(keys)})
    return {
        f"{row['name_k']}|{row['size_k']}": float(row["net"] or 0)
        for row in cur.fetchall()
    }


def _production_consumed_map(cur, keys: list | None = None) -> dict:
    """{"name|size": base-unit qty} consumed by Completed production lots
    that took effect after each item's newest count (all of them, for an
    item never counted).

    The PRODUCTION term of the Current Stock formula. Equivalent to folding
    _iter_completed_production_components (which is retained, because the Item
    Ledger needs per-lot detail this cannot give), but without transferring
    every component of every lot into Python.
    """
    table = config_maps.TABLE_NAMES.get("PRODUCTION")
    if not table:
        return {}

    # Deliberately NOT restricted to `keys`, unlike the movement half.
    #
    # Measured, not assumed. The four line tables carry
    # `lower(item_name), lower(size)` expression indexes, so restricting them
    # to a page turns four full scans into index lookups -- 60ms to 18ms at
    # five years of volume. JSONB component arrays have no such index: the
    # expansion has to happen before an item name exists to filter on, so an
    # item filter cannot avoid any work, it can only add a row-wise IN
    # evaluated against every expanded component. Benchmarked on the same
    # data: unfiltered 82ms, filter-after-expansion 397ms,
    # filter-during-expansion 642ms.
    #
    # So this computes every item every time and the caller looks up the ones
    # it wants -- which is still a large improvement on the row-by-row Python
    # fold it replaced, and `keys` is accepted only to keep the two halves'
    # signatures symmetrical.
    cur.execute(_PRODUCTION_CONSUMED_SQL.format(table=table))
    rows = cur.fetchall()
    if not rows:
        return {}

    # Only fetched when there is something to convert -- both are extra
    # queries, and the common no-production case should not pay for them.
    item_unit_map = items_service.get_item_unit_info_map(cur)
    units_map = units_service.get_units_map(cur)

    consumed: dict = {}
    for row in rows:
        qty = float(row["qty"] or 0)
        unit = row["unit"]
        if unit:
            # Blank unit means "already in the item's Base Unit" -- same
            # convention as the row-by-row version, which guarded on `if unit:`.
            unit_info = items_service.lookup_item_unit_info(
                item_unit_map, row["name_k"], row["size_k"]
            )
            try:
                qty = units_service.convert_qty_to_base_unit(
                    qty, unit, unit_info, units_map
                )
            except ValueError:
                # An unconvertible unit must never block a Stock read -- fall
                # back to the as-entered qty, exactly as before.
                pass
        key = f"{row['name_k']}|{row['size_k']}"
        consumed[key] = consumed.get(key, 0) + qty
    return consumed


def _anchor_map(cur, keys: list | None = None) -> dict:
    """{"name|size": (moment, counted qty, adjustment id)} -- each counted
    item's newest count, read from _ANCHOR_CTE so it is the very row the two
    aggregates above filtered against. `keys` as in _movement_map."""
    if keys is not None and not keys:
        return {}
    sql = f"WITH {_ANCHOR_CTE} SELECT name_k, size_k, id, at, new_value FROM anchor"
    if keys is None:
        cur.execute(sql)
    else:
        cur.execute(sql + " WHERE (name_k, size_k) IN %(keys)s", {"keys": tuple(keys)})
    return {
        f"{row['name_k']}|{row['size_k']}": (
            row["at"],
            float(row["new_value"]),
            row["id"],
        )
        for row in cur.fetchall()
    }


class StockTerms(NamedTuple):
    """The pieces Current Stock is made of, each keyed "name_lower|size_lower".

    - anchors:  the newest count per counted item, (moment, counted, id)
    - moved:    Bill (+), Return/Wastage/Issue (-) and Merge (+/-) movement
                that took effect after that count
    - consumed: Completed-lot Production consumption after that count

    BILL, RETURN, WASTAGE, ISSUE and MERGE all net into `moved`; PRODUCTION
    lands in `consumed`, kept separate to mirror the source's own two-map
    split. ITEM-sourced components only -- POOL-sourced ones debit the
    Warehouse Pool (warehouse_service._recalculate_warehouse_pool's Pass 2).
    """

    anchors: dict
    moved: dict
    consumed: dict

    def current(self, key: str, initial_stock) -> float:
        """Current Stock for one key: the newest count if the item has been
        counted, its initial_stock if not, plus what happened since."""
        anchor = self.anchors.get(key)
        base = anchor[1] if anchor else float(initial_stock or 0)
        return base + self.moved.get(key, 0.0) - self.consumed.get(key, 0.0)


def _get_stock_terms(cur, keys: list | None = None) -> StockTerms:
    """Everything Current Stock is computed from. Use StockTerms.current() to
    combine it -- never `initial_stock + moved - consumed` by hand, which is
    the formula as it stood before counts were anchors and is wrong for
    every counted item.

    Before migration 049 this returned two maps that every caller added to
    initial_stock, and adjust_stock_manually stored a count by back-solving
    initial_stock against the movements that existed at that instant. Any
    movement dated before the count that reached the formula later -- a lot
    completed after the count, a backdated issue, an edit to an old lot --
    then moved a figure somebody had counted with their hands: 78 of 613
    counted items no longer showed their count on the 2026-10-07 snapshot.
    Now the count itself is the starting point and only what took effect
    after it is added, so nothing that predates a count can move it.
    """
    # One aggregate query instead of four full-table transfers plus four
    # Python fold loops (PERF-002). See _MOVEMENT_SQL for how the predicates
    # map onto the code this replaces.
    #
    # `keys` restricts the movement half and the anchors to a set of
    # (name_lower, size_lower) tuples, which is what makes a paginated read
    # cheap rather than merely smaller. None means "every item", the
    # whole-table behaviour every existing caller relies on.
    return StockTerms(
        anchors=_anchor_map(cur, keys),
        moved=_movement_map(cur, keys),
        # Guarded via TABLE_NAMES inside the helper itself -- a no-op until
        # erp.production exists, same as before this was factored out.
        consumed=_production_consumed_map(cur, keys),
    )


def _find_stock_row(cur, name: str, size: str):
    cur.execute(
        "SELECT id FROM erp.stock WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL",
        (name, size or ""),
    )
    row = cur.fetchone()
    return row["id"] if row else None


# Sortable columns available WITHOUT computing Current Stock for every item.
# These live on erp.stock itself, so a page can be selected first and the
# movement aggregation restricted to it.
_STOCK_SORTABLE = {
    "name": "item_name",
    "size": "size",
    "initialStock": "initial_stock",
    "threshold": "threshold",
    "deadStock": "dead_stock",
    "rowIdx": "id",
}

# Sorts that are DERIVED from the aggregation and therefore cannot narrow it:
# you cannot order by a value you have not computed yet. Requesting one of
# these falls back to computing every item, then sorting, then slicing --
# correct, and no slower than the old unpaginated behaviour, but it forfeits
# the saving. Named explicitly so the trade-off is visible rather than
# surprising.
_STOCK_DERIVED_SORTS = {"currentStock", "isLowStock"}

_DEFAULT_PAGE_SIZE = 50
_MAX_PAGE_SIZE = 500


def _stock_key(name, size) -> str:
    return f"{str(name or '').strip().lower()}|{str(size or '').strip().lower()}"


def _stock_record(row, terms: StockTerms) -> dict:
    key = _stock_key(row["item_name"], row["size"])
    initial = float(row["initial_stock"])
    current = terms.current(key, initial)
    anchor = terms.anchors.get(key)
    threshold = float(row["threshold"])
    return {
        "name": row["item_name"],
        "size": row["size"] or "",
        "initialStock": initial,
        "currentStock": current,
        # The count Current Stock starts from, when the item has one -- see
        # _get_stock_terms. None for an item nobody has counted.
        "lastCountQty": anchor[1] if anchor else None,
        "lastCountAt": anchor[0].isoformat() if anchor else None,
        "threshold": threshold,
        "isLowStock": current < threshold,
        "deadStock": bool(row["dead_stock"]),
        # rowIdx maps to erp.stock.id -- the source's literal sheet-row
        # position has no Postgres equivalent; id serves the same
        # "stable per-row identifier" purpose (sorted newest-first).
        "rowIdx": row["id"],
    }


@rpc_method("getStockData")
def get_stock_data(page=None, page_size=None, search=None, sort=None, direction=None):
    """Stock rows with Current Stock.

    Called with no arguments it behaves exactly as it always has: every row,
    newest first, returned as a bare list. Every existing caller -- desktop
    stock.js, mobile.js, the dashboard, the Item Ledger -- keeps working
    untouched (PERF-002 keeps the RPC contract additive).

    Passing `page` switches on the paginated form and changes the envelope's
    `data` to {rows, page, pageSize, total}. That is a deliberate opt-in: a
    caller that asks for a page is a caller that has been updated to read one.

    The point of the paginated form is NOT smaller payloads. It is that the
    page is selected from erp.stock first -- a small, indexed table -- and the
    movement aggregation is then restricted to those items, turning four
    full-history scans into index lookups. A paginated read that still
    aggregated everything would have fixed the symptom and left the cost.
    """
    if page is None:
        # ── Unpaginated: unchanged behaviour ──────────────────────────────
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            _conn,
            cur,
        ):
            terms = _get_stock_terms(cur)
            cur.execute(
                """
                SELECT id, item_name, size, initial_stock, threshold, dead_stock
                FROM erp.stock
                WHERE deleted_at IS NULL
                ORDER BY id DESC
                """
            )
            rows = cur.fetchall()
        return build_response(True, [_stock_record(r, terms) for r in rows])

    # ── Paginated ─────────────────────────────────────────────────────────
    try:
        page = max(1, int(page))
    except (TypeError, ValueError):
        raise ValueError("page must be a positive whole number.")
    try:
        size = int(page_size) if page_size not in (None, "") else _DEFAULT_PAGE_SIZE
    except (TypeError, ValueError):
        raise ValueError("pageSize must be a whole number.")
    size = max(1, min(size, _MAX_PAGE_SIZE))

    term = str(search or "").strip().lower()
    sort_key = str(sort or "rowIdx").strip()
    descending = str(direction or "desc").strip().lower() != "asc"

    if sort_key not in _STOCK_SORTABLE and sort_key not in _STOCK_DERIVED_SORTS:
        raise ValueError(f'Cannot sort Stock by "{sort_key}".')

    where = ["deleted_at IS NULL"]
    params: dict = {}
    if term:
        # Matches the client-side filter the desktop already applies to the
        # full list, so moving a module to the paginated form does not change
        # what a search finds.
        where.append(
            "(lower(item_name) LIKE %(term)s OR lower(COALESCE(size, '')) LIKE %(term)s)"
        )
        params["term"] = f"%{term}%"
    where_sql = " AND ".join(where)

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute(f"SELECT count(*) AS n FROM erp.stock WHERE {where_sql}", params)
        total = int(cur.fetchone()["n"])

        if sort_key in _STOCK_DERIVED_SORTS:
            # Cannot narrow: the sort key is the thing being computed. Compute
            # everything, sort, then slice -- no worse than the unpaginated
            # path, and honest about it.
            terms = _get_stock_terms(cur)
            cur.execute(
                f"SELECT id, item_name, size, initial_stock, threshold, dead_stock "
                f"FROM erp.stock WHERE {where_sql}",
                params,
            )
            records = [_stock_record(r, terms) for r in cur.fetchall()]
            records.sort(key=lambda r: r[sort_key], reverse=descending)
            window = records[(page - 1) * size : (page - 1) * size + size]
        else:
            column = _STOCK_SORTABLE[sort_key]
            order = "DESC" if descending else "ASC"
            params.update({"limit": size, "offset": (page - 1) * size})
            cur.execute(
                f"SELECT id, item_name, size, initial_stock, threshold, dead_stock "
                f"FROM erp.stock WHERE {where_sql} "
                # id as a tiebreaker so paging is stable when the sort column
                # has duplicates -- otherwise a row can appear on two pages or
                # on none.
                f"ORDER BY {column} {order}, id DESC LIMIT %(limit)s OFFSET %(offset)s",
                params,
            )
            rows = cur.fetchall()
            keys = [
                (r["item_name"].strip().lower(), (r["size"] or "").strip().lower())
                for r in rows
            ]
            terms = _get_stock_terms(cur, keys)
            window = [_stock_record(r, terms) for r in rows]

    return build_response(
        True,
        {
            "rows": window,
            "page": page,
            "pageSize": size,
            "total": total,
        },
    )


@rpc_method("updateThreshold", mutation=True)
@database.transactional
def update_threshold(conn, cur, item_name, size, threshold):
    try:
        threshold_val = float(threshold)
    except (TypeError, ValueError):
        threshold_val = -1
    if threshold_val < 0:
        raise ValueError("Threshold must be a valid non-negative number.")

    row_id = _find_stock_row(cur, item_name, size)
    if row_id is None:
        raise ValueError("Item not found in Stock database.")

    cur.execute(
        "UPDATE erp.stock SET threshold = %s, updated_by = %s WHERE id = %s",
        (threshold_val, get_current_user_id(), row_id),
    )
    item_label = f'"{item_name}"' + (f" ({size})" if size else "")
    return build_response(True, None, f"{item_label} threshold updated.")


@rpc_method("updateDeadStock", mutation=True)
@database.transactional
def update_dead_stock(conn, cur, item_name, size, is_dead_stock):
    dead_stock_val = (
        is_dead_stock is True or str(is_dead_stock).strip().lower() == "true"
    )

    row_id = _find_stock_row(cur, item_name, size)
    if row_id is None:
        raise ValueError("Item not found in Stock database.")

    cur.execute(
        "UPDATE erp.stock SET dead_stock = %s, updated_by = %s WHERE id = %s",
        (dead_stock_val, get_current_user_id(), row_id),
    )
    item_label = f'"{item_name}"' + (f" ({size})" if size else "")
    dead_stock_message = (
        f"{item_label} marked as dead stock."
        if dead_stock_val
        else f"{item_label} removed from dead stock."
    )
    return build_response(True, {"deadStock": dead_stock_val}, dead_stock_message)


@rpc_method("adjustStockManually", mutation=True)
@database.transactional
def adjust_stock_manually(conn, cur, item_name, size, new_current_stock, reason):
    try:
        new_stock_val = float(new_current_stock)
    except (TypeError, ValueError):
        raise ValueError("Corrected stock must be a valid number.")

    reason_text = str(reason or "").strip()
    if not reason_text:
        raise ValueError("A reason is required for manual stock adjustments.")

    # DATA-002. This is a read-modify-write over a derived value:
    # old_current_stock is computed from the movements, and initial_stock is
    # moved by the difference. Two operators correcting the same item at the
    # same moment both read the same old value and the second write silently
    # discards the first -- a lost update, with an adjustments-log entry for
    # each that makes it look as though both took effect.
    locks.lock_keys(cur, locks.STOCK, [f"{item_name}|{size or ''}"])

    cur.execute(
        """
        SELECT id, item_name, size, initial_stock FROM erp.stock
        WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL
        """,
        (item_name, size or ""),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("Item not found in Stock database.")

    key = _stock_key(row["item_name"], row["size"])
    terms = _get_stock_terms(cur, [tuple(key.split("|", 1))])
    old_current_stock = terms.current(key, row["initial_stock"])

    if new_stock_val == old_current_stock:
        # buildResponse() forces data to null on failure -- bypassed here
        # (matches the source) so the UI can reconcile a stale on-screen
        # value instead of being stuck re-submitting a rejected no-op edit.
        return {
            "success": False,
            "data": {
                "oldCurrentStock": old_current_stock,
                "newCurrentStock": old_current_stock,
            },
            "message": "New stock value is the same as the current value -- nothing to adjust.",
        }

    # The row inserted below IS the count from here on: _get_stock_terms
    # starts this item from new_value and adds only what takes effect after
    # created_at, so nothing dated before this moment can move it again.
    #
    # initial_stock still moves by exactly the difference the row records.
    # The formula no longer reads it for a counted item, but the Item Ledger
    # does: initial_stock less every count's (new - old) is the stock the
    # item opened with before anybody counted it, and that is where the
    # ledger's history starts (items_service.get_item_ledger_data).
    new_initial_stock = float(row["initial_stock"]) + (
        new_stock_val - old_current_stock
    )
    user_id = get_current_user_id()

    cur.execute(
        "UPDATE erp.stock SET initial_stock = %s, updated_by = %s WHERE id = %s",
        (new_initial_stock, user_id, row["id"]),
    )
    cur.execute(
        """
        INSERT INTO erp.stock_adjustments (item_name, size, action, old_value, new_value, reason, created_by)
        VALUES (%s, %s, 'ADJUST', %s, %s, %s, %s)
        """,
        (item_name, size or "", old_current_stock, new_stock_val, reason_text, user_id),
    )

    item_label = f'"{row["item_name"]}"' + (f" ({row['size']})" if row["size"] else "")
    return build_response(
        True,
        {"oldCurrentStock": old_current_stock, "newCurrentStock": new_stock_val},
        f"{item_label} stock adjusted to {new_stock_val:g}.",
    )


@rpc_method("importStockData", mutation=True)
@database.transactional
def import_stock_data(conn, cur, items):
    if not isinstance(items, list) or not items:
        raise ValueError("Import file is empty or invalid.")

    terms = _get_stock_terms(cur)
    user_id = get_current_user_id()

    # A re-imported figure is a count like any other: the RESET row written
    # below becomes the item's anchor (see _get_stock_terms). `terms` was
    # read once, before any of them were written, so an item listed twice in
    # one file must start its second line from the first line's figure, not
    # from the stale read.
    imported_now: dict = {}

    updated_count = 0
    added_count = 0

    for item in items:
        item = item or {}
        name = str(item.get("name") or "").strip()
        size = str(item.get("size") or "").strip()
        try:
            qty = float(item.get("initialStock"))
        except (TypeError, ValueError):
            continue
        if not name or qty < 0:
            continue

        key = _stock_key(name, size)

        cur.execute(
            "SELECT id, initial_stock FROM erp.stock WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL",
            (name, size),
        )
        existing = cur.fetchone()

        if existing:
            old_current_stock = (
                imported_now[key]
                if key in imported_now
                else terms.current(key, existing["initial_stock"])
            )
            if qty != old_current_stock:
                # Same bookkeeping as adjust_stock_manually: initial_stock
                # moves by what the RESET row records.
                cur.execute(
                    "UPDATE erp.stock SET initial_stock = initial_stock + %s, updated_by = %s WHERE id = %s",
                    (qty - old_current_stock, user_id, existing["id"]),
                )
                cur.execute(
                    """
                    INSERT INTO erp.stock_adjustments (item_name, size, action, old_value, new_value, reason, created_by)
                    VALUES (%s, %s, 'RESET', %s, %s, 'Re-imported initial stock', %s)
                    """,
                    (name, size, old_current_stock, qty, user_id),
                )
                imported_now[key] = qty
            updated_count += 1
        else:
            # A new Stock row has no count behind it: its opening is
            # back-solved so it reads `qty` now, exactly as before.
            cur.execute(
                "INSERT INTO erp.stock (item_name, size, initial_stock, updated_by) VALUES (%s, %s, %s, %s)",
                (name, size, qty - terms.current(key, 0), user_id),
            )
            added_count += 1

    # Keep Items Master automatically in sync with any newly imported Stock
    # items. Uses the same cursor/transaction (not the RPC-exposed,
    # separately-transactional import_items_from_stock()) so it sees the
    # rows just inserted above -- a separate transaction wouldn't, under
    # Postgres's default read-committed isolation.
    items_service._import_items_from_stock(cur)

    message = f"Stock import completed. Items updated: {updated_count}, Items added: {added_count}."
    return build_response(
        True, {"updatedCount": updated_count, "addedCount": added_count}, message
    )


@rpc_method("getStockAdjustmentHistory")
def get_stock_adjustment_history():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute(
            """
            SELECT sa.item_name, sa.size, sa.action, sa.old_value, sa.new_value, sa.reason,
                   sa.created_at, u.email AS user_email
            FROM erp.stock_adjustments sa
            LEFT JOIN public.users u ON u.user_id = sa.created_by
            ORDER BY sa.created_at DESC
            """
        )
        rows = cur.fetchall()

    records = [
        {
            "date": row["created_at"].isoformat(),
            "action": row["action"],
            "itemName": row["item_name"],
            "size": row["size"] or "",
            "oldValue": float(row["old_value"]),
            "newValue": float(row["new_value"]),
            "reason": row["reason"] or "",
            "user": row["user_email"] or "",
        }
        for row in rows
    ]
    return build_response(True, records)


@rpc_method("checkStockAdjustmentConflicts")
def check_stock_adjustment_conflicts(items, bill_date):
    # Advisory only -- never let this check block a bill save on failure.
    try:
        bill_date_native = date_utils.to_safe_date(bill_date)
        if not bill_date_native or not isinstance(items, list) or not items:
            return build_response(True, [])

        # Latest adjustment per (item, size), computed in SQL for only the
        # items on THIS bill (PERF-005).
        #
        # This used to call get_stock_adjustment_history(), which is an
        # unbounded `SELECT ... ORDER BY created_at DESC` over the whole
        # adjustments table, and then reduce it to a latest-per-key map in
        # Python -- on every single bill save. Every row ever adjusted was
        # transferred and discarded to answer a question about a handful of
        # items. A blind LIMIT was not the fix: the same RPC method feeds
        # mobile.js's item ledger, which legitimately needs the full history,
        # so capping it there would silently truncate real data. Narrowing
        # THIS caller to what it actually needs is.
        keys = []
        for item in items:
            item = item or {}
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            keys.append((name.lower(), str(item.get("size") or "").strip().lower()))
        if not keys:
            return build_response(True, [])

        latest_by_key: dict = {}
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            _conn,
            cur,
        ):
            cur.execute(
                """
                SELECT DISTINCT ON (lower(item_name), lower(COALESCE(size, '')))
                       lower(item_name)                AS name_k,
                       lower(COALESCE(size, ''))       AS size_k,
                       created_at,
                       reason
                FROM erp.stock_adjustments
                WHERE (lower(item_name), lower(COALESCE(size, ''))) IN %s
                  -- Counts only. A MERGE row is a movement, not a count:
                  -- nothing on a shelf was looked at, so there is no
                  -- counted figure a bill could double up on.
                  AND action IN ('ADJUST', 'RESET')
                ORDER BY lower(item_name), lower(COALESCE(size, '')), created_at DESC
                """,
                (tuple(keys),),
            )
            for row in cur.fetchall():
                latest_by_key[f"{row['name_k']}|{row['size_k']}"] = {
                    "date": row["created_at"].date(),
                    "reason": row["reason"] or "",
                }

        conflicts = []
        seen_keys = set()
        for item in items:
            item = item or {}
            key = f"{str(item.get('name') or '').strip().lower()}|{str(item.get('size') or '').strip().lower()}"
            if key in seen_keys:
                continue
            latest = latest_by_key.get(key)
            if latest and latest["date"] >= bill_date_native:
                seen_keys.add(key)
                conflicts.append(
                    {
                        "itemName": item.get("name"),
                        "size": item.get("size") or "",
                        "adjustmentDate": latest["date"].isoformat(),
                        "reason": latest["reason"],
                    }
                )

        return build_response(True, conflicts)
    except Exception:  # noqa: BLE001 -- advisory only, never blocks a save
        return build_response(True, [])
