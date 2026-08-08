"""Warehouse Pool Opening + Warehouse Pool, ported from
Apps_Script/module_warehouse.js. Opens the "in-process inventory" side of
Phase 3 manufacturing -- see migrations/erp/014_warehouse_pool.sql.

Registering WAREHOUSE_POOL_OPENING activates three dormant guarded
cascades/guards from earlier phases with zero code changes:
tags_service._rename_color_everywhere (color rename -> the color column),
process_service._rename_pool_output_item_name_everywhere (Output Item Name
rename -> output_item_name), and process_service._get_process_ids_in_use
(a Process delete-guard). All three were written against this exact
schema's to_snake_case(...) column names.

Warehouse Pool itself is a materialized/cached table -- fully truncated
and rewritten by _recalculate_warehouse_pool() on every mutating call, NOT
computed live like this project's own Stock. getWarehousePoolData (a
plain read) never triggers a rebuild.

Pass 1 (credit Completed lots' output) and Pass 2 (debit POOL-sourced
consumption) landed in Phase 3g (Production), extending Phase 3e's Pass-0
`buckets` accumulator with two more loops rather than rewriting it, guarded
via `TABLE_NAMES.get("PRODUCTION")`. Pass 3 (debit finished-goods buckets
by Dispatch quantity, including the greedy multi-color-bucket drain for a
tagged/untagged key that spans more than one color) landed in Phase 4a
(Dispatch), guarded via `TABLE_NAMES.get("DISPATCH_HEADERS"/"DISPATCH_
LINES")` the same way -- Dispatch itself moved from a flat table to
header+lines in migration 023, so Pass 3 reads a join now, but the
aggregation algorithm is unchanged (see the query's own comment).

getPoolAvailableQty is a genuine exception to this port's usual
{success, data, message} envelope: the source function returns a bare
number, not buildResponse(...) -- same "genuine exception" category as
getNextProcessId/getNextProductId, ported verbatim. getPoolAvailableQtyMap
is an internal batch-read optimization (its own doc comment frames it as
"use this instead of calling getPoolAvailableQty() in a loop" -- advice
for other SERVER code, not a UI consumer) -- ported as a plain Python
helper, not RPC-exposed. _checkPoolCreditRemovalWarning is real as of
Phase 3g too, now that deleteProduction/deleteProductionBulk are real
callers.

adjustWarehousePoolManually's audit trail: the source writes to the
generic Logs sheet (URI-encoded record ID + regex-parsed details string)
-- not ported; same "dedicated audit table, not the GAS Logs-sheet
workaround" treatment stock_service.py's erp.stock_adjustments already
established. erp.warehouse_pool_adjustments mirrors that table's shape
and read pattern (LEFT JOIN to public.users for a display email) exactly.

Not ported: initWarehousePoolSheet/initWarehousePoolOpeningSheet/
ensureWarehousePoolColorColumn (GAS sheet-bootstrap, no Postgres
equivalent needed).
"""

from __future__ import annotations

import math
import re
from datetime import date

import psycopg2.extras

import database
from . import items_service
from . import process_service
from . import units_service
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

_COLOR_GROUP_COMMON = config_maps.COMPONENT_COLOR_GROUP_COMMON

# Sort position for a color-breakdown entry whose axis the recipe can no
# longer explain (renamed, removed, or legacy data with no axisKey) -- it
# sorts after every axis the recipe DOES know. See _compose_lot_color_key.
_UNORDERED_AXIS_POSITION = float("inf")


def _validate_number(value, min_value: float, max_value: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n) or n < min_value or n > max_value:
        return 0.0
    return n


def _find_process_master_id(cur, process_id_str: str):
    if not process_id_str:
        return None
    cur.execute(
        "SELECT id FROM erp.process_master WHERE lower(process_id) = lower(%s) AND deleted_at IS NULL",
        (process_id_str,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _find_process_record(process_id_str: str, all_processes: list):
    target = str(process_id_str or "").strip().lower()
    for p in all_processes:
        if p["processId"].strip().lower() == target:
            return p
    return None


def color_segments(color) -> list:
    """The individual axis values of a composite bucket color -- "Black /
    Blue-White / Kraft" -> ["Black", "Blue-White", "Kraft"]. Ported from
    module_warehouse.js#_colorSegments.

    Public (no leading underscore) because dispatch_service resolves a
    process's Dispatch Differentiator value by matching these segments
    against that axis's own colors. Segment POSITION is never meaningful:
    mirror axes are folded away and unchecked axes contribute nothing, so a
    composite has no fixed slot per axis.
    """
    return [s.strip() for s in str(color or "").split(config_maps.COLOR_COMBO_DELIMITER) if s.strip()]


def _color_order_key(color) -> str:
    """Order-independent identity for a composite color: its segments
    lowercased and sorted, joined with a delimiter that can't occur in a
    color name. "Blue-White / Black / Grey" and "Blue-White / Grey / Black"
    describe the SAME physical unit -- one frame color, one rim color, one
    mudguard color -- so they must resolve to one bucket.

    Used to catch (and heal) historical rows credited before
    _compose_lot_color_key imposed a canonical order. Ported from
    module_warehouse.js#_colorOrderKey.
    """
    return "\0".join(sorted(s.lower() for s in color_segments(color)))


def _compose_lot_color_key(primary_entry: dict, independent_entries: list, axis_order: dict | None) -> str:
    """A lot's composite bucket color in a CANONICAL, repeatable segment
    order, so the same real combination always keys the same bucket. Ported
    from module_warehouse.js#_composeLotColorKey.

    EVERY axis takes the position THIS PROCESS'S OWN RECIPE gives it -- the
    primary included (see process_service.get_axis_order_by_process). A POOL
    recipe row is the association with the upstream process that produces
    it, so recipe row order is exactly "this process's inputs, in the
    sequence the operator arranged them", and it is also the order the
    Production checklist renders. A recipe listing Fitted Rim above Painted
    Frame credits "Black / Blue-White", and the operator can change that
    reading by reordering the recipe.

    The primary axis is deliberately NOT anchored first: the quantity-bearing
    axis is not necessarily the one you name first, so a lot of frames on
    black rims would otherwise read "Blue-White / Black" no matter where the
    recipe put the rim.

    Order previously came straight from the Color Breakdown array, i.e. from
    checklist order, which followed Warehouse Pool row order -- itself
    rebuilt on every recalculation. Two lots of the very same product could
    therefore be credited as "Blue-White / Black / Grey" and "Blue-White /
    Grey / Black" and have their stock split across two buckets. Needs 3+
    axes (2+ independent ones) to bite.

    A primary color that is itself a composite (inherited from upstream)
    stays intact as one unit -- only its position among this stage's axes is
    decided here, never its internal order.

    `axis_order` is {axisKeyLower: position} for this lot's own process. An
    axis missing from it (renamed, removed, or a legacy entry with no
    axisKey at all) sorts after every known one, then by axis key and color,
    so the result is always fully determined even when the recipe can no
    longer explain an entry.
    """
    order = axis_order or {}

    def sort_key(entry):
        axis_key = str(entry.get("axisKey") or "").strip().lower()
        position = order.get(axis_key, _UNORDERED_AXIS_POSITION) if axis_key else _UNORDERED_AXIS_POSITION
        # Same (or absent) axis key -- fall back to the color itself so the
        # result is still fully determined rather than input-order dependent.
        return (position, axis_key, str(entry.get("color") or "").strip().lower())

    ordered = sorted(
        (e for e in [primary_entry, *(independent_entries or [])] if e and str(e.get("color") or "").strip()),
        key=sort_key,
    )
    return config_maps.COLOR_COMBO_DELIMITER.join(str(e["color"]).strip() for e in ordered)


def _color_names_match(a, b) -> bool:
    """Same hyphen/slash/whitespace-segment substring heuristic as
    production.js's client-side _colorNamesMatch ("Red" matches
    "Red-White") -- used to decide whether a lot's non-primary
    colorBreakdown entry (e.g. a Mudguard Color) is redundant with its
    primary entry (e.g. Rim Color) when combining Pass 1's pool credit.
    """
    x = str(a or "").strip().lower()
    y = str(b or "").strip().lower()
    if not x or not y:
        return False
    if x == y:
        return True
    shorter, longer = (x, y) if len(x) <= len(y) else (y, x)
    escaped = re.escape(shorter)
    return re.search(rf"(^|[-/\s]){escaped}($|[-/\s])", longer) is not None


def _resolve_composite_color_token(candidate_colors: list, token_lower: str) -> str | None:
    """Resolves a single-axis-token colorGroup (e.g. "BCP") against a set of
    live bucket color strings for the same item, one of which may be a
    composite of 2+ independent pool axes (e.g. "BCP / Blue-White" -- see
    config_maps.COLOR_COMBO_DELIMITER). A Process Component recipe row's
    Color Sub-Group is configured manually from Color Master, independently
    of whatever string the upstream item's own credits actually landed
    under, so an exact-string bucket match alone can miss a composite
    bucket that legitimately contains this token.

    Only resolves when EXACTLY ONE candidate composite color contains the
    token as one of its parts -- a token shared by 2+ composite buckets is
    genuinely ambiguous and is deliberately left unresolved rather than
    guessed. `candidate_colors` are already lowercased/trimmed.
    """
    if not token_lower or token_lower in candidate_colors:
        return None
    delimiter = config_maps.COLOR_COMBO_DELIMITER
    matches = {
        c
        for c in candidate_colors
        if delimiter in c and any(part.strip() == token_lower for part in c.split(delimiter))
    }
    return next(iter(matches)) if len(matches) == 1 else None


def _get_warehouse_pool_opening_rows(cur) -> list:
    cur.execute("SELECT output_item_name, process_id, product_tag, color, qty FROM erp.warehouse_pool_opening")
    rows = []
    for row in cur.fetchall():
        name = str(row["output_item_name"] or "").strip()
        if not name:
            continue
        # Zero is skipped (no-op); negative IS kept -- a downward manual
        # correction appends a negative delta row and it must survive this
        # read or the correction silently reverts on the next rebuild.
        qty = float(row["qty"] or 0)
        if qty == 0:
            continue
        rows.append(
            {
                "outputItemName": name,
                "processId": str(row["process_id"] or "").strip(),
                "productTag": str(row["product_tag"] or "").strip(),
                "color": str(row["color"] or "").strip(),
                "qty": qty,
            }
        )
    return rows


def _build_warehouse_pool_buckets(cur, include_opening: bool = True) -> dict:
    """Core of _recalculate_warehouse_pool, factored out so
    _get_real_history_colors_by_process can replay the same Pass 1-3
    credit/debit logic with include_opening=False -- i.e. everything
    EXCEPT the manually-recorded Opening Balances (Pass 0) -- to tell
    "real" Production/Dispatch history apart from a manual entry when
    deciding whether a Warehouse Pool color combination is safe to delete.
    Passes 1-2 are guarded via TABLE_NAMES.get("PRODUCTION"); Pass 3
    (Dispatch debit) via TABLE_NAMES.get("DISPATCH_HEADERS"/"DISPATCH_
    LINES") -- both real and live, not deferred.
    """
    buckets: dict = {}

    def get_bucket(output_item_name: str, process_id: str, product_tag: str, color: str) -> dict:
        key = (
            str(output_item_name or "").strip().lower(),
            str(product_tag or "").strip().lower(),
            str(color or "").strip().lower(),
        )
        bucket = buckets.get(key)
        if bucket is None:
            bucket = {
                "outputItemName": str(output_item_name or "").strip(),
                "processId": str(process_id or "").strip(),
                "productTag": str(product_tag or "").strip(),
                "color": str(color or "").strip(),
                "producedQty": 0.0,
                "consumedQty": 0.0,
            }
            buckets[key] = bucket
        return bucket

    # Pass 0: seed buckets from manually-recorded Opening Balances -- the
    # one durable source of "stock that didn't come from a Production lot".
    if include_opening:
        for r in _get_warehouse_pool_opening_rows(cur):
            bucket = get_bucket(r["outputItemName"], r["processId"], r["productTag"], r["color"])
            bucket["producedQty"] += r["qty"]

    if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
        # Pass 1: credit every Completed lot's own output to its pool
        # bucket(s). A color-agnostic lot credits the single blank-color
        # bucket. A multi-color lot's colorBreakdown entries are combined
        # into composite bucket(s) whenever the pairing is unambiguous:
        # every entry that counts toward the lot's total (countsTowardTotal
        # is not False -- the primary axis, or the only entry on a
        # single-axis/legacy lot) becomes its OWN composite bucket carrying
        # its own qty, paired with the genuinely independent other entries.
        # A redundant axis (whose checked value _color_names_match-es a
        # primary -- the same batch described a second way) is folded in
        # rather than credited separately: this is what turns two
        # independent credits (10 under "Red-White", 10 under "Black") into
        # one real "Red-White / Black" bucket.
        #
        # "Unambiguous" means no single axis contributes 2+ independent
        # entries -- see the axis_counts check below. Anything less
        # clean-cut falls back to crediting every entry under its own
        # single color.
        #
        # Axis order for each process's own recipe, so a composite's segment
        # order is canonical rather than colorBreakdown array order (which
        # follows pool row order, itself rebuilt on every recalculation) --
        # otherwise two lots of the same product credit two
        # differently-ordered buckets and split its stock.
        axis_order_by_process = process_service.get_axis_order_by_process(cur)

        cur.execute(
            f"""
            SELECT process_id, output_item_name, product_id, color_breakdown, qty
            FROM {table}
            WHERE deleted_at IS NULL AND lower(status) = 'completed'
            """
        )
        for row in cur.fetchall():
            output_item_name = str(row["output_item_name"] or "").strip()
            if not output_item_name:
                continue
            process_id = str(row["process_id"] or "").strip()
            product_tag = str(row["product_id"] or "").strip()
            color_breakdown = row["color_breakdown"] or []

            if color_breakdown:
                # Zero/negative kept -- a negative per-color qty is a
                # correction/reversal lot that credits this bucket back
                # down, mirroring the flat (non-color) path below which
                # never filtered by sign either.
                def credit_color(color, qty):
                    color = str(color or "").strip()
                    if not color:
                        return
                    get_bucket(output_item_name, process_id, product_tag, color)["producedQty"] += float(qty or 0)

                primary_entries = [
                    e for e in color_breakdown if e and e.get("countsTowardTotal") is not False and str(e.get("color") or "").strip()
                ]
                other_entries = [
                    e for e in color_breakdown if e and e.get("countsTowardTotal") is False and str(e.get("color") or "").strip()
                ]

                combined = False
                if primary_entries:
                    # A primary color inherited from upstream can itself be a
                    # composite, and its segments are OTHER processes' axes --
                    # a downstream axis cannot be a mirror of one of those, it
                    # just happens to share the name. Such an entry matches a
                    # whole segment EXACTLY (seat "Black" against a frame
                    # credited "Black / Blue-White"), whereas a real mirror is
                    # a variant of the primary color rather than one of its
                    # segments verbatim ("Blue" against "Blue-White"). Only
                    # composite primaries get this exception, so a plain
                    # single-axis primary keeps exactly its old behavior.
                    primary_colors = [str(e.get("color") or "").strip() for e in primary_entries]
                    inherited_segments_lower = set()
                    for primary_color in primary_colors:
                        segments = color_segments(primary_color)
                        if len(segments) >= 2:  # a chained/composite primary
                            inherited_segments_lower.update(s.lower() for s in segments)

                    def _is_independent(entry):
                        color_lower = str(entry.get("color") or "").strip().lower()
                        if color_lower in inherited_segments_lower:
                            return True  # collision, keep as its own axis
                        return not any(_color_names_match(pc, entry.get("color")) for pc in primary_colors)

                    independent = [e for e in other_entries if _is_independent(e)]

                    # Each distinct axis among the independent entries must
                    # contribute exactly one. Entries carrying a real axisKey
                    # are grouped by it, so two DIFFERENT axes (Mudguard +
                    # Rim) each contributing one combine safely no matter how
                    # many that adds up to. An entry with NO axisKey at all
                    # (legacy data, or a free-form color with no real axis
                    # structure) has no grouping info to disambiguate by, so
                    # every blank-axisKey entry shares ONE pooled key: a
                    # single such entry still combines (matching the original
                    # one-independent-entry case), but 2+ of them collide and
                    # correctly fall back to per-entry crediting -- the exact
                    # "no stored cross-axis pairing to tell which goes with
                    # which" case this whole block is guarding.
                    axis_counts: dict = {}
                    for entry in independent:
                        axis_key = str(entry.get("axisKey") or "").strip().lower() or "__no_axis_key__"
                        axis_counts[axis_key] = axis_counts.get(axis_key, 0) + 1

                    if not any(count > 1 for count in axis_counts.values()):
                        # One composite bucket PER primary color, each
                        # carrying its own primary qty. An independent axis
                        # holding a single color for the whole lot (Rim =
                        # Black on all 40 units) pairs with every primary
                        # color -- which goes with which is not in question
                        # when that axis only has one.
                        axis_order = axis_order_by_process.get(process_id.lower())
                        for primary_entry in primary_entries:
                            credit_color(
                                _compose_lot_color_key(primary_entry, independent, axis_order),
                                primary_entry.get("qty"),
                            )
                        combined = True

                if not combined:
                    for entry in color_breakdown:
                        entry = entry or {}
                        credit_color(entry.get("color"), entry.get("qty"))
            else:
                qty = float(row["qty"] or 0)
                get_bucket(output_item_name, process_id, product_tag, "")["producedQty"] += qty

        # Pass 2: debit POOL-sourced components consumed by Completed lots
        # from the (untagged, intermediate) bucket of the upstream item. A
        # component scoped to a specific color (colorGroup other than
        # COMMON) debits that color's bucket; a COMMON component debits the
        # blank-color bucket. A component with a non-blank Unit is
        # converted to the item's Base Unit first (blank unit means
        # "already in Base Unit"), matching stock_service's identical
        # handling for ITEM-sourced components -- a POOL row's Unit was
        # previously silently ignored, understating pool consumption by
        # whatever that row's conversion factor is (e.g. a Dozen row
        # debiting as if it were 1 Pcs).
        cur.execute(
            f"SELECT components_consumed FROM {table} WHERE deleted_at IS NULL AND lower(status) = 'completed'"
        )
        pool_item_unit_map = None
        pool_units_map = None
        for row in cur.fetchall():
            for comp in row["components_consumed"] or []:
                comp = comp or {}
                if str(comp.get("sourceType") or "").strip().upper() != "POOL":
                    continue
                item_name = str(comp.get("itemName") or "").strip()
                if not item_name:
                    continue
                qty = float(comp.get("qty") or 0)

                unit = str(comp.get("unit") or "").strip()
                if unit:
                    if pool_item_unit_map is None:
                        pool_item_unit_map = items_service.get_item_unit_info_map(cur)
                    if pool_units_map is None:
                        pool_units_map = units_service.get_units_map()
                    unit_info = items_service.lookup_item_unit_info(pool_item_unit_map, item_name, "")
                    try:
                        qty = units_service.convert_qty_to_base_unit(qty, unit, unit_info, pool_units_map)
                    except ValueError:
                        # Unconvertible (e.g. no Weight-per-Base-Unit set
                        # yet) -- fall back to the as-entered qty rather
                        # than blocking the whole recalculation over one
                        # bad recipe row.
                        pass

                color_group = str(comp.get("colorGroup") or "").strip()
                color = color_group if color_group and color_group.upper() != _COLOR_GROUP_COMMON else ""

                # See _resolve_composite_color_token -- a manually
                # -configured single-token Color Sub-Group can legitimately
                # refer to one part of a composite bucket credited under
                # Pass 1 above; resolve it to that bucket's real key when
                # unambiguous, rather than debiting a phantom single-token
                # bucket that was never credited.
                if color and (item_name.lower(), "", color.lower()) not in buckets:
                    item_name_lower = item_name.lower()
                    candidates = [
                        b
                        for b in buckets.values()
                        if b["outputItemName"].lower() == item_name_lower and not b["productTag"]
                    ]

                    # A consumption recorded before _compose_lot_color_key
                    # imposed a canonical segment order names the same
                    # combination in a different order ("Blue-White / Grey /
                    # Black" for what is now credited as "Blue-White / Black
                    # / Grey"). Match on the order-independent identity
                    # first, so historical rows debit the real bucket instead
                    # of opening a phantom negative one. Only when exactly
                    # one bucket carries that segment set -- otherwise there
                    # is nothing to disambiguate with.
                    want_order_key = _color_order_key(color)
                    order_matches = [b for b in candidates if _color_order_key(b["color"]) == want_order_key]
                    if len(order_matches) == 1:
                        color = order_matches[0]["color"]
                    else:
                        resolved = _resolve_composite_color_token(
                            [b["color"].lower() for b in candidates], color.lower()
                        )
                        if resolved:
                            color = resolved

                get_bucket(item_name, "", "", color)["consumedQty"] += qty

    if (headers_table := config_maps.TABLE_NAMES.get("DISPATCH_HEADERS")) and (
        lines_table := config_maps.TABLE_NAMES.get("DISPATCH_LINES")
    ):
        # Pass 3: debit finished-goods buckets by Dispatch quantity. A
        # Product-tagged bucket is matched by its tag; an untagged
        # final-stage bucket has no tag, so Dispatch's own "Product ID"
        # for that lot is the Output Item Name itself (see
        # dispatch_service._compute_ready_to_dispatch_map) -- fall back to
        # matching on that, restricted to final-stage buckets so an
        # untagged intermediate-WIP bucket sharing the same Output Item
        # Name from a non-final process is never touched. Dispatch is
        # header+lines (migration 023) -- this aggregation already treated
        # every row as just a (product_id, qty) contribution regardless of
        # which physical row it came from, so switching the source query to
        # a join needs no change to the aggregation itself.
        cur.execute(
            f"SELECT l.product_id, l.qty FROM {lines_table} l "
            f"JOIN {headers_table} h ON h.id = l.header_id WHERE h.deleted_at IS NULL"
        )
        dispatch_qty_by_key: dict = {}
        for row in cur.fetchall():
            product_id = str(row["product_id"] or "").strip()
            if not product_id:
                continue
            key = product_id.lower()
            dispatch_qty_by_key[key] = dispatch_qty_by_key.get(key, 0) + float(row["qty"] or 0)

        final_stage_ids = {
            p["processId"].strip().lower() for p in process_service._get_all_processes(cur) if p["isFinalStage"]
        }

        # Dispatch carries no color of its own, so a Product Tag (or
        # untagged Output Item Name) credited across multiple color
        # buckets (a multi-color final-stage lot) can't be debited by
        # color -- greedily drain whichever color buckets have stock
        # first, dumping any leftover (over-dispatch beyond total
        # availability) on the first bucket so the total consumedQty
        # across all matching buckets still equals the total dispatched
        # qty.
        for key, dispatched_qty in dispatch_qty_by_key.items():
            remaining = dispatched_qty
            matching = [b for b in buckets.values() if b["productTag"] and b["productTag"].lower() == key]
            if not matching:
                matching = [
                    b
                    for b in buckets.values()
                    if not b["productTag"]
                    and b["outputItemName"].lower() == key
                    and b["processId"]
                    and b["processId"].lower() in final_stage_ids
                ]
            if not matching:
                continue

            for bucket in matching:
                if remaining <= 0:
                    break
                available = max(bucket["producedQty"] - bucket["consumedQty"], 0)
                take = min(remaining, available)
                bucket["consumedQty"] += take
                remaining -= take

            if remaining > 0:
                matching[0]["consumedQty"] += remaining

    return buckets


def _recalculate_warehouse_pool(cur) -> None:
    """Full rebuild of erp.warehouse_pool from source data -- mirrors
    recalculateStock()'s "always rebuild from source data" approach.
    """
    buckets = _build_warehouse_pool_buckets(cur, include_opening=True)

    # Rewrite the table from scratch (small dataset -- process count is tiny).
    cur.execute("DELETE FROM erp.warehouse_pool")
    for bucket in buckets.values():
        if not bucket["outputItemName"]:
            continue
        cur.execute(
            """
            INSERT INTO erp.warehouse_pool
                (output_item_name, process_id, product_tag, produced_qty, consumed_qty, available_qty, color)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                bucket["outputItemName"],
                bucket["processId"],
                bucket["productTag"],
                bucket["producedQty"],
                bucket["consumedQty"],
                bucket["producedQty"] - bucket["consumedQty"],
                bucket["color"],
            ),
        )


def _get_real_history_colors_by_process(cur) -> dict:
    """processIdLower -> set of colorLower with real (non-manual) history:
    produced via a Completed Production lot (Pass 1) or consumed via a
    Pool-sourced component / Dispatch (Pass 2-3). Deliberately excludes
    Pass 0 (Opening Balances and adjustWarehousePoolManually corrections,
    both recorded in erp.warehouse_pool_opening) so a color whose only
    warehouse_pool activity is manual can be told apart from one with real
    production/consumption history -- see exclude_warehouse_pool_colors,
    which uses this instead of erp.warehouse_pool's own produced/consumed
    qty (that column includes Pass 0 and so can't make the distinction).
    """
    buckets = _build_warehouse_pool_buckets(cur, include_opening=False)
    result: dict = {}
    for bucket in buckets.values():
        process_id = bucket["processId"].strip().lower()
        color = bucket["color"].strip().lower()
        if not process_id or not color:
            continue
        if bucket["producedQty"] == 0 and bucket["consumedQty"] == 0:
            continue
        result.setdefault(process_id, set()).add(color)
    return result


def _get_warehouse_pool_bucket_available_qty(cur, output_item_name: str, product_tag: str, color: str) -> float:
    cur.execute(
        """
        SELECT available_qty FROM erp.warehouse_pool
        WHERE lower(output_item_name) = lower(%s) AND lower(COALESCE(product_tag, '')) = lower(%s)
              AND lower(COALESCE(color, '')) = lower(%s)
        """,
        (str(output_item_name or "").strip(), str(product_tag or "").strip(), str(color or "").strip()),
    )
    row = cur.fetchone()
    return float(row["available_qty"]) if row else 0.0


def _get_pool_available_qty_map(cur) -> dict:
    """{itemNameLower: {"total": n, "byColor": {colorLower: n}}} for every
    UNTAGGED (intermediate WIP) bucket -- a component scoped to COMMON may
    draw from `total`; one scoped to a specific color draws from
    `byColor[colorLower]`. Internal batch-read helper, not RPC-exposed --
    see module docstring.
    """
    result: dict = {}
    cur.execute("SELECT output_item_name, product_tag, color, available_qty FROM erp.warehouse_pool")
    for row in cur.fetchall():
        item_name = str(row["output_item_name"] or "").strip().lower()
        product_tag = str(row["product_tag"] or "").strip()
        if not item_name or product_tag:
            continue
        color = str(row["color"] or "").strip().lower()
        available_qty = float(row["available_qty"] or 0)

        entry = result.setdefault(item_name, {"total": 0.0, "byColor": {}})
        entry["total"] += available_qty
        entry["byColor"][color] = entry["byColor"].get(color, 0.0) + available_qty
    return result


def _check_pool_credit_removal_warning(cur, output_item_name: str, color_breakdown, flat_qty) -> str | None:
    """Warns (never blocks) when removing a Completed lot's own credit to
    the Warehouse Pool -- via un-completing its status or deleting it
    outright -- would leave a bucket negative, i.e. a downstream lot
    already consumed this credit. Mirrors _validate_pool_availability's
    informational-only pattern for the opposite direction (a lot's own
    POOL-sourced consumption). `color_breakdown` is None/empty for a flat
    (non-color) lot, in which case `flat_qty` is used instead.
    """
    name = str(output_item_name or "").strip()
    if not name:
        return None

    pool_map = _get_pool_available_qty_map(cur)
    entry = pool_map.get(name.lower())
    if not entry:
        return None

    if color_breakdown:
        credits = [
            {"color": str((e or {}).get("color") or "").strip(), "qty": float((e or {}).get("qty") or 0)}
            for e in color_breakdown
        ]
    else:
        credits = [{"color": "", "qty": float(flat_qty or 0)}]

    shortfalls = []
    for c in credits:
        if c["qty"] <= 0:
            continue
        current_available = entry["byColor"].get(c["color"].lower(), 0)
        would_be = current_available - c["qty"]
        if would_be < -0.0001:
            label = f'"{name}"' + (f' ({c["color"]})' if c["color"] else "")
            shortfalls.append(f"{label}: {would_be:.2f}")

    if not shortfalls:
        return None
    return (
        f"Warning: this leaves the Warehouse Pool negative for {', '.join(shortfalls)} "
        "-- a downstream lot already consumed this credit. The pool balance will show negative until corrected."
    )


# ─────────────────────────────────────────────────────────────────────────
# Warehouse Pool Opening
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getWarehousePoolOpeningData")
def get_warehouse_pool_opening_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        process_name_by_id = {
            p["processId"].strip().lower(): p["processName"] for p in process_service._get_all_processes(cur)
        }
        cur.execute(
            """
            SELECT id, output_item_name, process_id, product_tag, color, qty, opening_date, remarks
            FROM erp.warehouse_pool_opening
            """
        )
        rows = cur.fetchall()

    records = []
    for row in rows:
        output_item_name = row["output_item_name"] or ""
        if not output_item_name:
            continue
        process_id = row["process_id"] or ""
        records.append(
            {
                "rowIdx": row["id"],
                "outputItemName": output_item_name,
                "processId": process_id,
                "processName": process_name_by_id.get(process_id.lower(), process_id),
                "productTag": row["product_tag"] or "",
                "color": row["color"] or "",
                "qty": float(row["qty"]),
                "date": date_utils.to_display_string(row["opening_date"]) or "",
                "dateRaw": date_utils.to_iso_string(row["opening_date"]) or "",
                "remarks": row["remarks"] or "",
            }
        )

    records.sort(key=lambda r: (r["dateRaw"] or "", r["rowIdx"]), reverse=True)
    return build_response(True, records)


@rpc_method("saveWarehousePoolOpening", mutation=True)
@database.transactional
def save_warehouse_pool_opening(conn, cur, form_data):
    form_data = form_data or {}

    process_id = str(form_data.get("processId") or "").strip()
    if not process_id:
        raise ValueError("A Process is required.")

    all_processes = process_service._get_all_processes(cur)
    process = _find_process_record(process_id, all_processes)
    if process is None:
        raise ValueError("Selected Process was not found.")
    if not process["outputItemName"]:
        raise ValueError(f'Process "{process["processName"]}" has no Output Item Name configured.')

    # Product Tag is meaningful only for a final-stage process's own
    # finished output -- silently blanked (not rejected) for any other
    # process, matching the source exactly.
    product_tag = str(form_data.get("productTag") or "").strip() if process["isFinalStage"] else ""
    color = str(form_data.get("color") or "").strip()

    # A process with known colors (from its own component recipe, linked
    # processes, or colors already seen in Production/Warehouse Pool) tracks
    # stock per-color -- an opening balance logged without one would land in
    # an untagged bucket a color-aware Production/Dispatch lot never looks
    # at. Mirrors the same _compute_known_colors_for_process call the form's
    # own Color dropdown (getProcessColorGroups) is populated from, so
    # "the dropdown showed choices" and "a color is required" always agree.
    if not color:
        components = process_service.get_process_components_data(process_id)["data"]
        pool_rows_for_axes = process_service._get_all_warehouse_pool_rows_for_color_axes(cur)
        color_links = process_service._get_all_process_color_links(cur)
        overrides = process_service._get_all_process_color_overrides(cur).get(process_id.lower())
        logged_colors = list(process_service._get_production_logged_colors_by_process(cur).get(process_id.lower(), []))
        known = process_service._compute_known_colors_for_process(
            process_id, components, pool_rows_for_axes, color_links, logged_colors, overrides
        )
        if known["colors"]:
            raise ValueError(f'Process "{process["processName"]}" tracks stock per-color -- choose a Color for this opening balance.')

    qty = _validate_number(form_data.get("qty"), -10000000, 10000000)
    if qty == 0:
        raise ValueError("Opening Quantity cannot be zero.")

    opening_date = date_utils.to_safe_date(form_data.get("date")) or date.today()
    # No MAX_REMARKS_LENGTH truncation here -- a genuine inconsistency in
    # the source (Process/BOM/Contractor Rate all truncate, this doesn't),
    # faithfully preserved.
    remarks = str(form_data.get("remarks") or "").strip()

    process_master_id = _find_process_master_id(cur, process["processId"])
    user_id = get_current_user_id()

    cur.execute(
        """
        INSERT INTO erp.warehouse_pool_opening
            (output_item_name, process_id, process_master_id, product_tag, color, qty, opening_date, remarks, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            process["outputItemName"], process["processId"], process_master_id, product_tag, color,
            qty, opening_date, remarks, user_id,
        ),
    )

    _recalculate_warehouse_pool(cur)

    return build_response(True, None, f'Opening stock for "{process["outputItemName"]}" recorded.')


@rpc_method("deleteWarehousePoolOpening", mutation=True)
@database.transactional
def delete_warehouse_pool_opening(conn, cur, row_idx, expected_output_item_name=None, expected_qty=None):
    try:
        target_id = int(row_idx)
    except (TypeError, ValueError):
        raise ValueError("Invalid opening stock entry selected for deletion.")

    cur.execute("SELECT output_item_name, qty FROM erp.warehouse_pool_opening WHERE id = %s", (target_id,))
    row = cur.fetchone()
    if row is None:
        raise ValueError("Invalid opening stock entry selected for deletion.")

    # Optimistic-concurrency check, only applied if BOTH expected values
    # were provided -- matches delete_contractor_payment's precedent.
    if expected_output_item_name is not None and expected_qty is not None:
        if (
            str(row["output_item_name"] or "").strip().lower() != str(expected_output_item_name or "").strip().lower()
            or abs(float(row["qty"]) - float(expected_qty)) > 0.0001
        ):
            raise ValueError("Data mismatch: The entry has been modified or shifted. Please refresh.")

    cur.execute("DELETE FROM erp.warehouse_pool_opening WHERE id = %s", (target_id,))
    _recalculate_warehouse_pool(cur)

    return build_response(True, None, "Opening stock entry deleted successfully.")


@rpc_method("adjustWarehousePoolManually", mutation=True)
@database.transactional
def adjust_warehouse_pool_manually(conn, cur, output_item_name, process_id, product_tag, color, new_available_qty, reason):
    item_name = str(output_item_name or "").strip()
    if not item_name:
        raise ValueError("Output Item Name is required.")

    proc_id = str(process_id or "").strip()
    if not proc_id:
        raise ValueError("Originating Process is required.")

    all_processes = process_service._get_all_processes(cur)
    if _find_process_record(proc_id, all_processes) is None:
        raise ValueError("Originating Process was not found.")

    try:
        new_qty = float(new_available_qty)
    except (TypeError, ValueError):
        new_qty = math.nan
    if not math.isfinite(new_qty):
        raise ValueError("Corrected quantity must be a valid number.")

    reason_text = str(reason or "").strip()
    if not reason_text:
        raise ValueError("A reason is required for manual stock corrections.")

    tag = str(product_tag or "").strip()
    color_val = str(color or "").strip()

    old_qty = _get_warehouse_pool_bucket_available_qty(cur, item_name, tag, color_val)
    delta = new_qty - old_qty
    if delta == 0:
        # buildResponse() forces data to null on failure -- bypassed here
        # (matches the source) so the UI can reconcile a stale on-screen
        # value instead of being stuck re-submitting a rejected no-op edit.
        return {
            "success": False,
            "data": {"oldAvailableQty": old_qty, "newAvailableQty": old_qty},
            "message": "New quantity is the same as the current value -- nothing to adjust.",
        }

    process_master_id = _find_process_master_id(cur, proc_id)
    user_id = get_current_user_id()

    cur.execute(
        """
        INSERT INTO erp.warehouse_pool_opening
            (output_item_name, process_id, process_master_id, product_tag, color, qty, opening_date, remarks, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (item_name, proc_id, process_master_id, tag, color_val, delta, date.today(), f"Correction: {reason_text}", user_id),
    )

    _recalculate_warehouse_pool(cur)

    cur.execute(
        """
        INSERT INTO erp.warehouse_pool_adjustments (output_item_name, product_tag, color, old_value, new_value, reason, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (item_name, tag, color_val, old_qty, new_qty, reason_text, user_id),
    )

    return build_response(
        True, {"oldAvailableQty": old_qty, "newAvailableQty": new_qty}, "Warehouse Pool stock adjusted successfully."
    )


@rpc_method("getWarehousePoolAdjustmentHistory")
def get_warehouse_pool_adjustment_history():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT wpa.output_item_name, wpa.product_tag, wpa.color, wpa.old_value, wpa.new_value,
                   wpa.reason, wpa.created_at, u.email AS user_email
            FROM erp.warehouse_pool_adjustments wpa
            LEFT JOIN public.users u ON u.user_id = wpa.created_by
            ORDER BY wpa.created_at DESC
            """
        )
        rows = cur.fetchall()

    records = [
        {
            "date": row["created_at"].isoformat(),
            "outputItemName": row["output_item_name"],
            "productTag": row["product_tag"] or "",
            "color": row["color"] or "",
            "oldValue": float(row["old_value"]),
            "newValue": float(row["new_value"]),
            "reason": row["reason"] or "",
            "user": row["user_email"] or "",
        }
        for row in rows
    ]
    return build_response(True, records)


# ─────────────────────────────────────────────────────────────────────────
# Warehouse Pool
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getWarehousePoolData")
def get_warehouse_pool_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT id, output_item_name, process_id, product_tag, produced_qty, consumed_qty, available_qty, color
            FROM erp.warehouse_pool
            """
        )
        rows = cur.fetchall()

    records = [
        {
            "rowIdx": row["id"],
            "outputItemName": row["output_item_name"] or "",
            "processId": row["process_id"] or "",
            "productTag": row["product_tag"] or "",
            "producedQty": float(row["produced_qty"]),
            "consumedQty": float(row["consumed_qty"]),
            "availableQty": float(row["available_qty"]),
            "color": row["color"] or "",
        }
        for row in rows
        if row["output_item_name"]
    ]
    records.sort(key=lambda r: (r["outputItemName"].lower(), r["color"].lower()))
    return build_response(True, records)


@rpc_method("getPoolAvailableQty")
def get_pool_available_qty(output_item_name):
    # Bare number return, not build_response(...) -- see module docstring.
    target = str(output_item_name or "").strip().lower()
    if not target:
        return 0
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        entry = _get_pool_available_qty_map(cur).get(target)
    return entry["total"] if entry else 0
