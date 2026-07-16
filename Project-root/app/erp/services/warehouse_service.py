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

Only Pass 0 (Opening Balances) of recalculateWarehousePool() lands this
round -- Passes 1/2 (Production credit/debit of Completed lots) and Pass 3
(Dispatch debit) are deferred to the Production round, which extends
_recalculate_warehouse_pool's buckets accumulator with two more loops
before the final write-back, rather than rewriting it (the source itself
gates those passes behind `if (prodSheet)`/`if (dispatchSheet)`).

getPoolAvailableQty is a genuine exception to this port's usual
{success, data, message} envelope: the source function returns a bare
number, not buildResponse(...) -- same "genuine exception" category as
getNextProcessId/getNextProductId, ported verbatim. getPoolAvailableQtyMap
is an internal batch-read optimization (its own doc comment frames it as
"use this instead of calling getPoolAvailableQty() in a loop" -- advice
for other SERVER code, not a UI consumer) -- ported as a plain Python
helper, not RPC-exposed, for the Production round to call.
_checkPoolCreditRemovalWarning has zero callers until Production exists
(only deleteProduction/deleteProductionBulk call it) -- not ported yet.

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
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method


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
    recalculateStock()'s "always rebuild from source data" approach. Only
    Pass 0 (Opening Balances) exists this round; the Production round adds
    Pass 1 (credit Completed lots' output) and Pass 2 (debit POOL-sourced
    consumption) as two more loops feeding the same `buckets` dict before
    the write-back, and a later Dispatch round adds Pass 3.
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
