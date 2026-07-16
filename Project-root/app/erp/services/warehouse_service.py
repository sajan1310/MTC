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
(Dispatch), guarded via `TABLE_NAMES.get("DISPATCH")` the same way.

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
from datetime import date

import psycopg2.extras

import database
from . import process_service
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

_COLOR_GROUP_COMMON = config_maps.COMPONENT_COLOR_GROUP_COMMON


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


def _recalculate_warehouse_pool(cur) -> None:
    """Full rebuild of erp.warehouse_pool from source data -- mirrors
    recalculateStock()'s "always rebuild from source data" approach.
    Passes 1-2 are guarded via TABLE_NAMES.get("PRODUCTION") (real as of
    Phase 3g); Pass 3 (Dispatch debit) stays guarded/deferred.
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
    for r in _get_warehouse_pool_opening_rows(cur):
        bucket = get_bucket(r["outputItemName"], r["processId"], r["productTag"], r["color"])
        bucket["producedQty"] += r["qty"]

    if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
        # Pass 1: credit every Completed lot's own output to its pool
        # bucket(s). A multi-color lot's color_breakdown is split into one
        # bucket per color; a color-agnostic lot credits the single
        # blank-color bucket by its flat qty.
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
                for entry in color_breakdown:
                    entry = entry or {}
                    color = str(entry.get("color") or "").strip()
                    qty = float(entry.get("qty") or 0)
                    if not color or qty <= 0:
                        continue
                    get_bucket(output_item_name, process_id, product_tag, color)["producedQty"] += qty
            else:
                qty = float(row["qty"] or 0)
                get_bucket(output_item_name, process_id, product_tag, "")["producedQty"] += qty

        # Pass 2: debit POOL-sourced components consumed by Completed lots
        # from the (untagged, intermediate) bucket of the upstream item. A
        # component scoped to a specific color (colorGroup other than
        # COMMON) debits that color's bucket; a COMMON component debits the
        # blank-color bucket.
        cur.execute(
            f"SELECT components_consumed FROM {table} WHERE deleted_at IS NULL AND lower(status) = 'completed'"
        )
        for row in cur.fetchall():
            for comp in row["components_consumed"] or []:
                comp = comp or {}
                if str(comp.get("sourceType") or "").strip().upper() != "POOL":
                    continue
                item_name = str(comp.get("itemName") or "").strip()
                if not item_name:
                    continue
                qty = float(comp.get("qty") or 0)
                color_group = str(comp.get("colorGroup") or "").strip()
                color = color_group if color_group and color_group.upper() != _COLOR_GROUP_COMMON else ""
                get_bucket(item_name, "", "", color)["consumedQty"] += qty

    if table := config_maps.TABLE_NAMES.get("DISPATCH"):
        # Pass 3: debit finished-goods buckets by Dispatch quantity. A
        # Product-tagged bucket is matched by its tag; an untagged
        # final-stage bucket has no tag, so Dispatch's own "Product ID"
        # for that lot is the Output Item Name itself (see
        # dispatch_service._compute_ready_to_dispatch_map) -- fall back to
        # matching on that, restricted to final-stage buckets so an
        # untagged intermediate-WIP bucket sharing the same Output Item
        # Name from a non-final process is never touched.
        cur.execute(f"SELECT product_id, qty FROM {table} WHERE deleted_at IS NULL")
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

    return build_response(True, None, "Opening stock recorded successfully.")


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
