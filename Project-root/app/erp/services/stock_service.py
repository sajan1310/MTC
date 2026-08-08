"""Stock, ported from Apps_Script/module_stock.js.

Current Stock is computed live (never stored) via
_get_billed_and_consumed_qty_maps. All five terms (Bill, Return, Wastage,
Issue, Production) are real as of Phase 3g -- the last one, Production's
ITEM-sourced components_consumed qty on Completed lots, was the final gap
this function's own docstring called out since Phase 1c. See that phase's
plan for why this isn't a SQL view (this formula needed 5 undesigned
future schemas, not one predictable column name) -- each term was filled
in only once its source table's real schema existed.

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

from datetime import datetime

import psycopg2.extras

import database
from . import items_service
from . import units_service
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method


def _get_billed_and_consumed_qty_maps(cur) -> tuple[dict, dict]:
    """Returns (bill_qty_map, consumed_qty_map), each keyed by
    "item_name_lower|size_lower" -> net base-unit qty affecting Current Stock.

    BILL, RETURN, WASTAGE, and ISSUE all net into bill_qty_map (Bill adds,
    the other three subtract, same direction Return does). PRODUCTION is
    the one term that lands in consumed_qty_map instead, kept semantically
    separate to mirror the source's own two-map split: ITEM-sourced
    components_consumed qty on Completed lots (POOL-sourced entries debit
    Warehouse Pool instead -- see warehouse_service._recalculate_warehouse_pool's
    Pass 2, not this function).
    """
    bill_qty_map: dict = {}
    cur.execute(
        """
        SELECT l.item_name, l.size, l.base_qty
        FROM erp.bill_lines l
        JOIN erp.bill_headers h ON h.id = l.header_id
        WHERE h.deleted_at IS NULL AND l.affects_stock = TRUE
        """
    )
    for row in cur.fetchall():
        key = f'{(row["item_name"] or "").strip().lower()}|{(row["size"] or "").strip().lower()}'
        if not key.split("|")[0]:
            continue
        bill_qty_map[key] = bill_qty_map.get(key, 0) + float(row["base_qty"] or 0)

    # Return is the mirror image of a bill -- goods sent back to a vendor
    # debit Stock, no affects_stock-style opt-out exists for it.
    cur.execute(
        """
        SELECT l.item_name, l.size, l.base_qty
        FROM erp.return_lines l
        JOIN erp.return_headers h ON h.id = l.header_id
        WHERE h.deleted_at IS NULL
        """
    )
    for row in cur.fetchall():
        key = f'{(row["item_name"] or "").strip().lower()}|{(row["size"] or "").strip().lower()}'
        if not key.split("|")[0]:
            continue
        bill_qty_map[key] = bill_qty_map.get(key, 0) - float(row["base_qty"] or 0)

    # Wastage and Issue both debit Stock directly, same direction as Return.
    cur.execute(
        """
        SELECT l.item_name, l.size, l.base_qty
        FROM erp.wastage_lines l
        JOIN erp.wastage_headers h ON h.id = l.header_id
        WHERE h.deleted_at IS NULL
        """
    )
    for row in cur.fetchall():
        key = f'{(row["item_name"] or "").strip().lower()}|{(row["size"] or "").strip().lower()}'
        if not key.split("|")[0]:
            continue
        bill_qty_map[key] = bill_qty_map.get(key, 0) - float(row["base_qty"] or 0)

    cur.execute(
        """
        SELECT l.item_name, l.size, l.base_qty
        FROM erp.issue_lines l
        JOIN erp.issue_headers h ON h.id = l.header_id
        WHERE h.deleted_at IS NULL
        """
    )
    for row in cur.fetchall():
        key = f'{(row["item_name"] or "").strip().lower()}|{(row["size"] or "").strip().lower()}'
        if not key.split("|")[0]:
            continue
        bill_qty_map[key] = bill_qty_map.get(key, 0) - float(row["base_qty"] or 0)

    consumed_qty_map: dict = {}
    if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
        item_unit_map = items_service.get_item_unit_info_map(cur)
        units_map = units_service.get_units_map()

        cur.execute(
            f"SELECT components_consumed FROM {table} WHERE deleted_at IS NULL AND lower(status) = 'completed'"
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
                qty = float(comp.get("qty") or 0)

                # Blank unit = "already in the item's Base Unit" -- an
                # unconvertible unit must never block the Stock computation,
                # same fallback-to-entered-qty precedent every other term uses.
                unit = str(comp.get("unit") or "").strip()
                if unit:
                    unit_info = items_service.lookup_item_unit_info(item_unit_map, item_name, size)
                    try:
                        qty = units_service.convert_qty_to_base_unit(qty, unit, unit_info, units_map)
                    except ValueError:
                        pass

                key = f"{item_name.lower()}|{size.lower()}"
                consumed_qty_map[key] = consumed_qty_map.get(key, 0) + qty

    return bill_qty_map, consumed_qty_map


def _find_stock_row(cur, name: str, size: str):
    cur.execute(
        "SELECT id FROM erp.stock WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL",
        (name, size or ""),
    )
    row = cur.fetchone()
    return row["id"] if row else None


@rpc_method("getStockData")
def get_stock_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        bill_qty_map, consumed_qty_map = _get_billed_and_consumed_qty_maps(cur)
        cur.execute(
            """
            SELECT id, item_name, size, initial_stock, threshold, dead_stock
            FROM erp.stock
            WHERE deleted_at IS NULL
            ORDER BY id DESC
            """
        )
        rows = cur.fetchall()

    records = []
    for row in rows:
        key = f'{row["item_name"].strip().lower()}|{(row["size"] or "").strip().lower()}'
        billed = bill_qty_map.get(key, 0)
        consumed = consumed_qty_map.get(key, 0)
        initial = float(row["initial_stock"])
        current = initial + billed - consumed
        threshold = float(row["threshold"])
        records.append(
            {
                "name": row["item_name"],
                "size": row["size"] or "",
                "initialStock": initial,
                "currentStock": current,
                "threshold": threshold,
                "isLowStock": current < threshold,
                "deadStock": bool(row["dead_stock"]),
                # rowIdx maps to erp.stock.id -- the source's literal sheet-row
                # position has no Postgres equivalent; id serves the same
                # "stable per-row identifier" purpose (sorted newest-first).
                "rowIdx": row["id"],
            }
        )
    return build_response(True, records)


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
    dead_stock_val = is_dead_stock is True or str(is_dead_stock).strip().lower() == "true"

    row_id = _find_stock_row(cur, item_name, size)
    if row_id is None:
        raise ValueError("Item not found in Stock database.")

    cur.execute(
        "UPDATE erp.stock SET dead_stock = %s, updated_by = %s WHERE id = %s",
        (dead_stock_val, get_current_user_id(), row_id),
    )
    item_label = f'"{item_name}"' + (f" ({size})" if size else "")
    dead_stock_message = f"{item_label} marked as dead stock." if dead_stock_val else f"{item_label} removed from dead stock."
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

    bill_qty_map, consumed_qty_map = _get_billed_and_consumed_qty_maps(cur)
    key = f'{row["item_name"].strip().lower()}|{(row["size"] or "").strip().lower()}'
    billed = bill_qty_map.get(key, 0)
    consumed = consumed_qty_map.get(key, 0)
    old_current_stock = float(row["initial_stock"]) + billed - consumed

    if new_stock_val == old_current_stock:
        # buildResponse() forces data to null on failure -- bypassed here
        # (matches the source) so the UI can reconcile a stale on-screen
        # value instead of being stuck re-submitting a rejected no-op edit.
        return {
            "success": False,
            "data": {"oldCurrentStock": old_current_stock, "newCurrentStock": old_current_stock},
            "message": "New stock value is the same as the current value -- nothing to adjust.",
        }

    new_initial_stock = new_stock_val - billed + consumed
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

    bill_qty_map, consumed_qty_map = _get_billed_and_consumed_qty_maps(cur)
    user_id = get_current_user_id()

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

        key = f"{name.lower()}|{size.lower()}"
        billed = bill_qty_map.get(key, 0)
        consumed = consumed_qty_map.get(key, 0)
        new_initial_stock = qty - billed + consumed

        cur.execute(
            "SELECT id, initial_stock FROM erp.stock WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL",
            (name, size),
        )
        existing = cur.fetchone()

        if existing:
            old_current_stock = float(existing["initial_stock"]) + billed - consumed
            cur.execute(
                "UPDATE erp.stock SET initial_stock = %s, updated_by = %s WHERE id = %s",
                (new_initial_stock, user_id, existing["id"]),
            )
            if qty != old_current_stock:
                cur.execute(
                    """
                    INSERT INTO erp.stock_adjustments (item_name, size, action, old_value, new_value, reason, created_by)
                    VALUES (%s, %s, 'RESET', %s, %s, 'Re-imported initial stock', %s)
                    """,
                    (name, size, old_current_stock, qty, user_id),
                )
            updated_count += 1
        else:
            cur.execute(
                "INSERT INTO erp.stock (item_name, size, initial_stock, updated_by) VALUES (%s, %s, %s, %s)",
                (name, size, new_initial_stock, user_id),
            )
            added_count += 1

    # Keep Items Master automatically in sync with any newly imported Stock
    # items. Uses the same cursor/transaction (not the RPC-exposed,
    # separately-transactional import_items_from_stock()) so it sees the
    # rows just inserted above -- a separate transaction wouldn't, under
    # Postgres's default read-committed isolation.
    items_service._import_items_from_stock(cur)

    message = f"Stock import completed. Items updated: {updated_count}, Items added: {added_count}."
    return build_response(True, {"updatedCount": updated_count, "addedCount": added_count}, message)


@rpc_method("getStockAdjustmentHistory")
def get_stock_adjustment_history():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
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

        history = get_stock_adjustment_history()
        if not history["success"] or not history["data"]:
            return build_response(True, [])

        latest_by_key: dict = {}
        for rec in history["data"]:
            key = f'{str(rec["itemName"]).strip().lower()}|{str(rec["size"]).strip().lower()}'
            rec_date = datetime.fromisoformat(rec["date"]).date()
            if key not in latest_by_key or rec_date > latest_by_key[key]["date"]:
                latest_by_key[key] = {"date": rec_date, "reason": rec["reason"]}

        conflicts = []
        seen_keys = set()
        for item in items:
            item = item or {}
            key = f'{str(item.get("name") or "").strip().lower()}|{str(item.get("size") or "").strip().lower()}'
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
