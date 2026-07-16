"""Production, ported from Apps_Script/module_production.js -- the
capstone of Phase 3 manufacturing.

Registering TABLE_NAMES["PRODUCTION"] (migrations/erp/015_production.sql)
activates several already-shipped guarded stubs with zero code changes,
verified by this module's own tests rather than by inspection alone:
contractors_service._contractor_in_use_message/_rename_contractor_everywhere
(a Contractor referenced by a lot can't be deleted; renaming a Contractor
reaches production.assigned_to) and bom_service's BOM Product delete-guard
(a Product referenced by a lot can't be deleted).

Color handling is the most intricate part of saveProduction: Process
Components + Warehouse Pool rows + Process Color Links are each read once
per save and reused for both process_service._compute_color_groups_for_process
(validsation of the submitted colorBreakdown) and
process_service._compute_color_axes_for_process (Primary Axis qty
resolution) -- both landed in Phase 3f specifically for this caller.

Unlike PO/Process/Product IDs (global business-ID sequences), lot numbers
stay a regex-scan-per-prefix (_generate_lot_number) -- see the approved
plan for the full reasoning (a per-prefix sequence would mean creating
Postgres sequences at runtime from a dynamic, user-defined Lot Prefix; the
source itself accepts the same low-concurrency race with no equivalent
replicated here).

Stock is this project's own live-computed view (never materialized) --
unlike the source's recalculateStock(), which had to be called explicitly
because Stock was a real cached sheet, nothing here needs to "trigger" a
Stock rebuild: the next getStockData call already reflects any Production
change via stock_service._get_billed_and_consumed_qty_maps's PRODUCTION
term. Warehouse Pool, by contrast, IS a materialized table in this port
(same as source), so warehouse_service._recalculate_warehouse_pool(cur) is
called unconditionally after every mutating call here, matching source's
own unconditional recalculateWarehousePool() calls.

componentsConsumed is entirely client-submitted -- sanitized/filtered but
never re-derived or cross-validated against the process's actual Process
Components recipe, faithfully matching source's trust-the-client design.

getProductionData deliberately omits orderNumber from its response even
though the column exists -- a confirmed source gap (module_production.js
never includes it either), not fixed here.

saveProduction's edit path has no optimistic-concurrency check at all,
unlike deleteProduction/deleteProductionBulk/updateProductionStatus/
saveProductionSheet (all of which take optional expected* params) -- a
real asymmetry in the source, faithfully preserved.
"""

from __future__ import annotations

import json
import math
import re
from datetime import date

import psycopg2.extras

import database
from . import contractors_service
from . import process_service
from . import warehouse_service
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

_PRODUCTION_STATUS_OPTIONS = ("Pending", "In Progress", "Completed", "Cancelled")
_COLOR_GROUP_COMMON = config_maps.COMPONENT_COLOR_GROUP_COMMON
_COLOR_COMBO_DELIMITER = config_maps.COLOR_COMBO_DELIMITER


def _validate_number(value, min_value: float, max_value: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n) or n < min_value or n > max_value:
        return 0.0
    return n


def _find_bom_product_id(cur, product_id_str: str):
    if not product_id_str:
        return None
    cur.execute(
        "SELECT id FROM erp.bom_products WHERE lower(product_id) = lower(%s) AND deleted_at IS NULL",
        (product_id_str,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _find_process_master_id(cur, process_id_str: str):
    if not process_id_str:
        return None
    cur.execute(
        "SELECT id FROM erp.process_master WHERE lower(process_id) = lower(%s) AND deleted_at IS NULL",
        (process_id_str,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _find_contractor_id_by_name(cur, name: str):
    if not name:
        return None
    cur.execute(
        "SELECT id FROM erp.contractors WHERE lower(contractor_name) = lower(%s) AND deleted_at IS NULL",
        (name,),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def _generate_lot_number(cur, lot_prefix: str) -> str:
    prefix = str(lot_prefix or "").strip().upper()
    pattern = re.compile(rf"^LOT-{re.escape(prefix)}-(\d+)$", re.IGNORECASE)
    cur.execute("SELECT lot_number FROM erp.production WHERE deleted_at IS NULL")
    max_num = 0
    for row in cur.fetchall():
        match = pattern.match(str(row["lot_number"] or "").strip())
        if match:
            num = int(match.group(1))
            if num > max_num:
                max_num = num
    return f"LOT-{prefix}-{max_num + 1:04d}"


def _poolneed_key(item_name_lower: str, color_group: str) -> str:
    is_color_scoped = bool(color_group) and color_group.upper() != _COLOR_GROUP_COMMON
    return f"{item_name_lower}||{color_group.lower() if is_color_scoped else ''}"


def _build_pool_needed_map(components: list) -> dict:
    pool_needed: dict = {}
    for c in components or []:
        c = c or {}
        if str(c.get("sourceType") or "").strip().upper() != "POOL":
            continue
        item_name = str(c.get("itemName") or "").strip()
        if not item_name:
            continue
        color_group = str(c.get("colorGroup") or "").strip()
        item_name_lower = item_name.lower()
        is_color_scoped = bool(color_group) and color_group.upper() != _COLOR_GROUP_COMMON
        key = _poolneed_key(item_name_lower, color_group)
        entry = pool_needed.setdefault(
            key,
            {"itemName": item_name, "colorGroup": color_group if is_color_scoped else "", "isColorScoped": is_color_scoped, "qty": 0.0},
        )
        entry["qty"] += float(c.get("qty") or 0)
    return pool_needed


def _validate_pool_availability(cur, pool_needed: dict, already_consumed: dict = None) -> str | None:
    pool_available_map = warehouse_service._get_pool_available_qty_map(cur)
    already_consumed = already_consumed or {}
    for key, need in pool_needed.items():
        entry = pool_available_map.get(need["itemName"].lower())
        if not entry:
            current_available_qty = 0.0
        elif need["isColorScoped"]:
            current_available_qty = entry["byColor"].get(need["colorGroup"].lower(), 0.0)
        else:
            current_available_qty = entry["total"]
        available_for_this_lot = current_available_qty + already_consumed.get(key, 0)
        if need["qty"] > available_for_this_lot + 0.0001:
            label = f'{need["itemName"]}" in color "{need["colorGroup"]}' if need["isColorScoped"] else need["itemName"]
            return f'Only {available_for_this_lot} unit(s) of "{label}" are available in the Warehouse Pool.'
    return None


@rpc_method("getProductionData")
def get_production_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            """
            SELECT id, production_date, product_id, product_name, qty, assigned_by, assigned_to,
                   status, remarks, custom_components, sheet_remarks, process_id, lot_number,
                   contractor_payable, output_item_name, components_consumed, color, color_breakdown
            FROM erp.production
            WHERE deleted_at IS NULL
            """
        )
        rows = cur.fetchall()

    records = []
    for row in rows:
        process_id = row["process_id"] or ""
        records.append(
            {
                "rowIdx": row["id"],
                "date": date_utils.to_display_string(row["production_date"]) or "",
                "dateRaw": date_utils.to_iso_string(row["production_date"]) or "",
                "productId": row["product_id"] or "",
                "productName": row["product_name"] or "",
                "qty": float(row["qty"]),
                "assignedBy": row["assigned_by"] or "",
                "assignedTo": row["assigned_to"] or "",
                "status": row["status"] or "",
                "remarks": row["remarks"] or "",
                "customComponents": row["custom_components"] or [],
                "sheetRemarks": row["sheet_remarks"] or "",
                "processId": process_id,
                "lotNumber": row["lot_number"] or "",
                "contractorPayable": float(row["contractor_payable"]),
                "outputItemName": row["output_item_name"] or "",
                "componentsConsumed": row["components_consumed"] or [],
                "color": row["color"] or "",
                "colorBreakdown": row["color_breakdown"] or [],
            }
        )

    records.sort(key=lambda r: (r["dateRaw"] or "", r["rowIdx"]), reverse=True)
    return build_response(True, records)


@rpc_method("getProcessWipData")
def get_process_wip_data(process_id):
    components = process_service.get_process_components_data(process_id)["data"]
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        pool_qty_map = warehouse_service._get_pool_available_qty_map(cur)

    records = []
    for c in components:
        if c["sourceType"] != "POOL":
            continue
        entry = pool_qty_map.get(str(c["itemName"] or "").strip().lower())
        color_group = str(c.get("colorGroup") or "").strip()
        is_color_scoped = bool(color_group) and color_group.upper() != _COLOR_GROUP_COMMON
        if not entry:
            available_qty = 0.0
        elif is_color_scoped:
            available_qty = entry["byColor"].get(color_group.lower(), 0.0)
        else:
            available_qty = entry["total"]
        records.append({"outputItemName": c["itemName"], "availableQty": available_qty})

    return build_response(True, records)


@rpc_method("saveProduction", mutation=True)
@database.transactional
def save_production(conn, cur, form_data):
    form_data = form_data or {}

    process_id = str(form_data.get("processId") or "").strip()
    if not process_id:
        raise ValueError("A Process must be selected for this lot.")

    assigned_to = str(form_data.get("assignedTo") or "").strip()
    if not assigned_to:
        raise ValueError("A Contractor (Assigned To) is required for this lot.")

    all_processes = process_service._get_all_processes(cur)
    process = warehouse_service._find_process_record(process_id, all_processes)
    if process is None:
        raise ValueError(f'Process "{process_id}" was not found. It may have been deleted.')

    # Read once, reused for both color-group validation and Primary Axis
    # qty resolution below -- avoids doubling reads on the busiest write path.
    color_components = process_service.get_process_components_data(process_id)["data"]
    pool_rows = process_service._get_all_warehouse_pool_rows_for_color_axes(cur)
    color_links = process_service._get_all_process_color_links(cur)
    available_color_groups = process_service._compute_color_groups_for_process(color_components, pool_rows, color_links)

    raw_breakdown = form_data.get("colorBreakdown")
    if isinstance(raw_breakdown, str):
        try:
            raw_breakdown = json.loads(raw_breakdown) if raw_breakdown else []
        except ValueError:
            raise ValueError("Invalid color breakdown data format.")
    if not isinstance(raw_breakdown, list):
        raw_breakdown = []

    has_custom_breakdown = any((c or {}).get("isCustom") for c in raw_breakdown)

    qty = None
    color = ""
    color_breakdown = []

    if available_color_groups or has_custom_breakdown:
        for c in raw_breakdown:
            c = c or {}
            entry = {
                "color": str(c.get("color") or "").strip(),
                "size": str(c.get("size") or "").strip(),
                "qty": _validate_number(c.get("qty"), -10000000, 10000000),
                "isCustom": bool(c.get("isCustom")),
                "countsTowardTotal": c.get("countsTowardTotal") is not False,
                "axisKey": str(c.get("axisKey") or "").strip(),
            }
            if entry["color"] and entry["qty"] != 0:
                color_breakdown.append(entry)

        if not color_breakdown:
            raise ValueError(
                "At least one Color with a non-zero quantity is required for this lot "
                "(this process has color-specific components)."
            )

        invalid_color = next(
            (
                c
                for c in color_breakdown
                if not c["isCustom"] and not any(ag.lower() == c["color"].lower() for ag in available_color_groups)
            ),
            None,
        )
        if invalid_color:
            raise ValueError(
                f'Color "{invalid_color["color"]}" is not a configured color sub-group for this process. '
                "It may have been removed -- refresh and re-select."
            )

        color = ", ".join(f'{c["color"]} ({c["size"]})' if c["size"] else c["color"] for c in color_breakdown)

        submitted_primary_color_axis = str(form_data.get("primaryColorAxis") or "").strip()
        primary_color_axis = submitted_primary_color_axis or str(process.get("primaryColorAxis") or "").strip()
        primary_axis_colors_lower = None
        primary_axis_key_lower = None
        if primary_color_axis:
            axes = process_service._compute_color_axes_for_process(color_components, pool_rows, color_links)
            primary_axis = next((a for a in axes if a["label"].lower() == primary_color_axis.lower()), None)
            if primary_axis:
                primary_axis_colors_lower = {c.lower() for c in primary_axis["colors"]}
                primary_axis_key_lower = primary_axis["key"].lower()

        if primary_axis_colors_lower is not None:
            qty = 0.0
            for c in color_breakdown:
                is_known_primary_color = (
                    (c["axisKey"].lower() == primary_axis_key_lower) if c["axisKey"] else (c["color"].lower() in primary_axis_colors_lower)
                )
                counts_as_custom = c["isCustom"] and c["countsTowardTotal"]
                if is_known_primary_color or counts_as_custom:
                    qty += c["qty"]
        else:
            qty = sum(c["qty"] for c in color_breakdown if c["countsTowardTotal"])

        if qty == 0:
            if primary_color_axis:
                raise ValueError(f'At least one "{primary_color_axis}" color with a non-zero quantity is required for this lot.')
            raise ValueError(
                "At least one Color with a non-zero quantity is required for this lot "
                "(this process has color-specific components)."
            )

        if (
            submitted_primary_color_axis
            and primary_axis_colors_lower is not None
            and submitted_primary_color_axis.lower() != str(process.get("primaryColorAxis") or "").strip().lower()
        ):
            process_service._set_process_primary_color_axis(cur, process_id, submitted_primary_color_axis)
    else:
        qty = _validate_number(form_data.get("qty"), -10000000, 10000000)
        if qty == 0:
            raise ValueError("Production Quantity cannot be zero.")

    raw_components = form_data.get("componentsConsumed")
    if isinstance(raw_components, str):
        try:
            raw_components = json.loads(raw_components) if raw_components else []
        except ValueError:
            raise ValueError("Invalid components consumed data format.")
    if not isinstance(raw_components, list):
        raw_components = []

    clean_components = []
    for c in raw_components:
        c = c or {}
        item_name = str(c.get("itemName") or "").strip()
        qty_c = _validate_number(c.get("qty"), 0, 10000000)
        if item_name and qty_c > 0:
            clean_components.append(
                {
                    "itemName": item_name,
                    "size": str(c.get("size") or "").strip(),
                    "color": str(c.get("color") or "").strip(),
                    "sourceType": "POOL" if str(c.get("sourceType") or "").strip().upper() == "POOL" else "ITEM",
                    "qty": qty_c,
                    "colorGroup": str(c.get("colorGroup") or "").strip() or _COLOR_GROUP_COMMON,
                    "unit": str(c.get("unit") or "").strip(),
                }
            )

    if color_breakdown:
        breakdown_colors_lower = set()
        for c in color_breakdown:
            breakdown_colors_lower.add(c["color"].lower())
            for token in c["color"].split(_COLOR_COMBO_DELIMITER):
                breakdown_colors_lower.add(token.strip().lower())
        clean_components = [
            c for c in clean_components if c["colorGroup"] == _COLOR_GROUP_COMMON or c["colorGroup"].lower() in breakdown_colors_lower
        ]

    if not clean_components:
        raise ValueError("At least one component consumed is required for this lot.")

    is_final_stage = bool(process.get("isFinalStage"))
    product_id = str(form_data.get("productId") or "").strip() if is_final_stage else ""
    product_name = str(form_data.get("productName") or "").strip() if is_final_stage else ""

    production_date = date_utils.to_safe_date(form_data.get("date")) or date.today()
    assigned_by = str(form_data.get("assignedBy") or "").strip()
    status = str(form_data.get("status") or "Pending").strip() or "Pending"
    remarks = str(form_data.get("remarks") or "").strip()

    row_idx = form_data.get("rowIdx")
    is_edit = bool(row_idx)

    existing = None
    if is_edit:
        try:
            target_id = int(row_idx)
        except (TypeError, ValueError):
            raise ValueError("Invalid production record selected for edit.")
        cur.execute(
            "SELECT id, process_id, lot_number, status, components_consumed FROM erp.production WHERE id = %s AND deleted_at IS NULL",
            (target_id,),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError("Invalid production record selected for edit.")

        current_process_id = str(existing["process_id"] or "").strip()
        if current_process_id and current_process_id.lower() != process_id.lower():
            raise ValueError("Process cannot be changed on an existing lot. Delete and recreate it under the new process instead.")

        lot_number = str(existing["lot_number"] or "").strip() or _generate_lot_number(cur, process["lotPrefix"])
    else:
        lot_number = _generate_lot_number(cur, process["lotPrefix"])

    pool_needed = _build_pool_needed_map(clean_components)

    original_pool_consumed: dict = {}
    if is_edit and existing is not None:
        previous_status = str(existing["status"] or "").strip().lower()
        if previous_status == "completed":
            for c in existing["components_consumed"] or []:
                c = c or {}
                if str(c.get("sourceType") or "").strip().upper() != "POOL":
                    continue
                item_name_lower = str(c.get("itemName") or "").strip().lower()
                color_group = str(c.get("colorGroup") or "").strip()
                key = _poolneed_key(item_name_lower, color_group)
                original_pool_consumed[key] = original_pool_consumed.get(key, 0) + float(c.get("qty") or 0)

    pool_warning = _validate_pool_availability(cur, pool_needed, original_pool_consumed)

    contractor_rate = contractors_service._get_contractor_rate(cur, assigned_to, process["processName"])
    contractor_payable = contractor_rate * qty

    components_json = json.dumps(clean_components)
    color_breakdown_json = json.dumps(color_breakdown) if color_breakdown else None
    resolved_process_master_id = _find_process_master_id(cur, process_id)
    resolved_bom_product_id = _find_bom_product_id(cur, product_id) if product_id else None
    resolved_contractor_id = _find_contractor_id_by_name(cur, assigned_to)
    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            """
            UPDATE erp.production SET
                production_date = %s, product_id = %s, product_name = %s, bom_product_id = %s,
                qty = %s, assigned_by = %s, assigned_to = %s, contractor_id = %s, status = %s, remarks = %s,
                process_id = %s, process_master_id = %s, lot_number = %s,
                contractor_rate = %s, contractor_payable = %s, output_item_name = %s,
                components_consumed = %s, color = %s, color_breakdown = %s, updated_by = %s
            WHERE id = %s
            """,
            (
                production_date, product_id, product_name, resolved_bom_product_id,
                qty, assigned_by, assigned_to, resolved_contractor_id, status, remarks,
                process_id, resolved_process_master_id, lot_number,
                contractor_rate, contractor_payable, process["outputItemName"],
                components_json, color, color_breakdown_json, user_id,
                existing["id"],
            ),
        )
    else:
        cur.execute(
            """
            INSERT INTO erp.production
                (production_date, product_id, product_name, bom_product_id, qty, assigned_by, assigned_to,
                 contractor_id, status, remarks, process_id, process_master_id, lot_number,
                 contractor_rate, contractor_payable, output_item_name, components_consumed, color,
                 color_breakdown, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                production_date, product_id, product_name, resolved_bom_product_id, qty, assigned_by, assigned_to,
                resolved_contractor_id, status, remarks, process_id, resolved_process_master_id, lot_number,
                contractor_rate, contractor_payable, process["outputItemName"], components_json, color,
                color_breakdown_json, user_id,
            ),
        )

    warehouse_service._recalculate_warehouse_pool(cur)

    message = "Production log updated successfully." if is_edit else "Production log saved successfully."
    if pool_warning:
        message = f"{message} Warning: {pool_warning} Warehouse Pool stock will now show negative for this item."

    return build_response(True, {"lotNumber": lot_number}, message)


@rpc_method("deleteProduction", mutation=True)
@database.transactional
def delete_production(conn, cur, row_idx, expected_product_id=None, expected_qty=None):
    try:
        target_id = int(row_idx)
    except (TypeError, ValueError):
        raise ValueError("Invalid production record selected for deletion.")

    cur.execute(
        "SELECT product_id, qty, output_item_name, color_breakdown FROM erp.production WHERE id = %s AND deleted_at IS NULL",
        (target_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("Invalid production record selected for deletion.")

    product_id = str(row["product_id"] or "").strip()
    qty = float(row["qty"] or 0)

    if expected_product_id is not None and expected_qty is not None:
        if product_id.lower() != str(expected_product_id or "").strip().lower() or abs(qty - float(expected_qty)) > 0.0001:
            raise ValueError("Data mismatch: The record has been modified or shifted. Please refresh.")

    pool_credit_warning = None
    if not product_id:
        pool_credit_warning = warehouse_service._check_pool_credit_removal_warning(
            cur, row["output_item_name"], row["color_breakdown"], qty
        )

    cur.execute("UPDATE erp.production SET deleted_at = NOW(), updated_by = %s WHERE id = %s", (get_current_user_id(), target_id))

    warehouse_service._recalculate_warehouse_pool(cur)

    message = "Production log deleted successfully."
    if pool_credit_warning:
        message = f"{message} {pool_credit_warning}"
    return build_response(True, None, message)


@rpc_method("deleteProductionBulk", mutation=True)
@database.transactional
def delete_production_bulk(conn, cur, row_idxs, expected_rows=None):
    target_ids = []
    for r in row_idxs or []:
        try:
            target_ids.append(int(r))
        except (TypeError, ValueError):
            continue

    if not target_ids:
        return build_response(True, None, "No production records selected.")

    expected_by_id = {}
    for e in expected_rows or []:
        e = e or {}
        if e.get("rowIdx") is not None:
            try:
                expected_by_id[int(e["rowIdx"])] = e
            except (TypeError, ValueError):
                continue

    cur.execute(
        "SELECT id, product_id, qty, output_item_name, color_breakdown FROM erp.production WHERE deleted_at IS NULL AND id = ANY(%s)",
        (target_ids,),
    )
    rows_by_id = {row["id"]: row for row in cur.fetchall()}

    deletable_ids = []
    skipped_mismatch = 0
    pool_credit_warnings = []
    for target_id in target_ids:
        row = rows_by_id.get(target_id)
        if row is None:
            continue
        product_id = str(row["product_id"] or "").strip()
        qty = float(row["qty"] or 0)

        expected = expected_by_id.get(target_id)
        if expected and expected.get("expectedProductId") is not None and expected.get("expectedQty") is not None:
            if (
                product_id.lower() != str(expected.get("expectedProductId") or "").strip().lower()
                or abs(qty - float(expected.get("expectedQty"))) > 0.0001
            ):
                skipped_mismatch += 1
                continue

        if not product_id:
            warning = warehouse_service._check_pool_credit_removal_warning(cur, row["output_item_name"], row["color_breakdown"], qty)
            if warning:
                pool_credit_warnings.append(warning)

        deletable_ids.append(target_id)

    if not deletable_ids:
        return build_response(False, None, "Data mismatch: the selected record(s) have been modified or shifted. Please refresh.")

    user_id = get_current_user_id()
    cur.execute("UPDATE erp.production SET deleted_at = NOW(), updated_by = %s WHERE id = ANY(%s)", (user_id, deletable_ids))
    rows_deleted = cur.rowcount

    warehouse_service._recalculate_warehouse_pool(cur)

    if skipped_mismatch > 0:
        message = (
            f"Deleted {rows_deleted} production record(s). Skipped {skipped_mismatch} that were modified or "
            "shifted -- please refresh and retry those."
        )
    else:
        message = f"Deleted {rows_deleted} production record(s)."
    if pool_credit_warnings:
        message = f"{message} " + " ".join(pool_credit_warnings)

    return build_response(True, None, message)


@rpc_method("updateProductionStatus", mutation=True)
@database.transactional
def update_production_status(conn, cur, row_idx, expected_qty, new_status):
    try:
        target_id = int(row_idx)
    except (TypeError, ValueError):
        raise ValueError("Invalid production record selected.")

    status = str(new_status or "").strip()
    if status not in _PRODUCTION_STATUS_OPTIONS:
        raise ValueError(f'Invalid status "{status}".')

    cur.execute(
        "SELECT qty, status, components_consumed FROM erp.production WHERE id = %s AND deleted_at IS NULL",
        (target_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("Invalid production record selected.")

    qty = float(row["qty"] or 0)
    if expected_qty is not None and abs(qty - float(expected_qty)) > 0.0001:
        raise ValueError("Data mismatch: The record has been modified or shifted. Please refresh.")

    previous_status = str(row["status"] or "").strip().lower()
    pool_warning = None
    if status.lower() == "completed" and previous_status != "completed":
        pool_warning = _validate_pool_availability(cur, _build_pool_needed_map(row["components_consumed"] or []))

    cur.execute("UPDATE erp.production SET status = %s, updated_by = %s WHERE id = %s", (status, get_current_user_id(), target_id))

    warehouse_service._recalculate_warehouse_pool(cur)

    message = "Status updated successfully."
    if pool_warning:
        message = f"{message} Warning: {pool_warning} Warehouse Pool stock will now show negative for this item."
    return build_response(True, {"status": status}, message)


@rpc_method("saveProductionSheet", mutation=True)
@database.transactional
def save_production_sheet(conn, cur, row_idx, expected_product_id, expected_qty, custom_components, sheet_remarks):
    try:
        target_id = int(row_idx)
    except (TypeError, ValueError):
        raise ValueError("Invalid production record selected.")

    cur.execute("SELECT product_id, qty FROM erp.production WHERE id = %s AND deleted_at IS NULL", (target_id,))
    row = cur.fetchone()
    if row is None:
        raise ValueError("Invalid production record selected.")

    product_id = str(row["product_id"] or "").strip()
    qty = float(row["qty"] or 0)
    if expected_product_id is not None and expected_qty is not None:
        if product_id.lower() != str(expected_product_id or "").strip().lower() or abs(qty - float(expected_qty)) > 0.0001:
            raise ValueError("Data mismatch: The record has been modified or shifted. Please refresh.")

    if isinstance(custom_components, str):
        try:
            components = json.loads(custom_components) if custom_components else []
        except ValueError:
            raise ValueError("Invalid component data format.")
    else:
        components = custom_components or []
    if not isinstance(components, list):
        raise ValueError("Invalid component data format.")

    clean_components = []
    for comp in components:
        comp = comp or {}
        item_name = str(comp.get("itemName") or "").strip()
        if not item_name:
            continue
        clean_components.append(
            {
                "itemName": item_name,
                "size": str(comp.get("size") or "").strip(),
                "narration": str(comp.get("narration") or "").strip(),
                "color": str(comp.get("color") or "").strip(),
                "requiredQty": _validate_number(comp.get("requiredQty"), 0, 10000000),
            }
        )

    remarks = str(sheet_remarks or "").strip()[:500]

    cur.execute(
        "UPDATE erp.production SET custom_components = %s, sheet_remarks = %s WHERE id = %s",
        (json.dumps(clean_components), remarks, target_id),
    )

    return build_response(True, {"customComponents": clean_components, "sheetRemarks": remarks}, "Production sheet saved successfully.")
