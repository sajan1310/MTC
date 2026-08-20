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
from . import items_service
from . import process_service
from . import tags_service
from . import warehouse_service
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

_PRODUCTION_STATUS_OPTIONS = ("Pending", "In Progress", "Completed", "Cancelled")
_COLOR_GROUP_COMMON = config_maps.COMPONENT_COLOR_GROUP_COMMON
_COLOR_COMBO_DELIMITER = config_maps.COLOR_COMBO_DELIMITER


def _coerce_row_id(row_idx, message: str) -> int:
    """The `int(row_idx)` + try/except that each by-id entry point here
    opened with, four times over, differing only in wording. (The bulk
    delete keeps its own loop: an unparseable id there is one unselectable
    row to skip, not a reason to fail the whole request.)"""
    try:
        return int(row_idx)
    except (TypeError, ValueError):
        raise ValueError(message)


def _coerce_json_list(value, message: str) -> list:
    """A client-submitted JSON array that may arrive already decoded (JSON
    request body) or still as a string (form post) -- both shapes reach
    every one of these endpoints. Anything that is neither is treated as
    absent rather than rejected, which is what each of the three
    hand-rolled copies of this did.
    """
    if isinstance(value, str):
        try:
            value = json.loads(value) if value else []
        except ValueError:
            raise ValueError(message)
    return value if isinstance(value, list) else []


def _matches_expected(product_id: str, qty: float, expected_product_id, expected_qty) -> bool:
    """The optimistic-concurrency comparison shared by delete_production,
    delete_production_bulk and save_production_sheet. Both expectations
    must be supplied to be checked at all -- a caller that sends neither
    is opting out, which is why these params are optional.
    """
    if expected_product_id is None or expected_qty is None:
        return True
    return (
        product_id.strip().lower() == str(expected_product_id or "").strip().lower()
        and abs(qty - float(expected_qty)) <= 0.0001
    )


def _is_color_scoped(color_group: str) -> bool:
    """A component/pool bucket is scoped to one color only when it names a
    real color group -- blank and the COMMON sentinel both mean "applies to
    the whole lot", and must read against the pool's total rather than any
    one color's sub-total."""
    return bool(color_group) and color_group.upper() != _COLOR_GROUP_COMMON


def _pool_available_qty(pool_entry, color_group: str) -> float:
    """One bucket's available quantity, read from the color sub-total or
    the total depending on whether the caller is asking about a
    color-scoped need. Shared by _validate_pool_availability and
    get_process_wip_data, which had drifted apart only in variable names.
    """
    if not pool_entry:
        return 0.0
    if _is_color_scoped(color_group):
        return pool_entry["byColor"].get(color_group.lower(), 0.0)
    return pool_entry["total"]


def _write_component_json(cur, row_id, consumed, custom) -> None:
    """Writes back whichever of a lot's two component arrays actually
    changed, leaving the other untouched via COALESCE. Shared by the two
    bulk rewriters (the rename cascade and the Items Master resync), which
    carried identical copies of this statement.
    """
    cur.execute(
        """
        UPDATE erp.production
        SET components_consumed = COALESCE(%s, components_consumed),
            custom_components = COALESCE(%s, custom_components)
        WHERE id = %s
        """,
        (
            json.dumps(consumed) if consumed is not None else None,
            json.dumps(custom) if custom is not None else None,
            row_id,
        ),
    )


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
    """Next free LOT-<prefix>-NNNN, scanning every lot that has ever held a
    number under this prefix -- SOFT-DELETED ONES INCLUDED.

    Excluding deleted rows (as this did) made the sequence rewind: delete
    the newest lot under a prefix and the next save is handed that exact
    same lot number, while the deleted row still sits in the table holding
    it (deletes here are soft -- see delete_production's `deleted_at =
    NOW()`, and ix_erp_production_lot_number is non-unique so nothing
    objects). Lot Number is the human identifier every printed Production
    Sheet, Work Order, Issue-Stock reference and audit message quotes, so
    two rows sharing one is a real ambiguity -- and restoring the deleted
    lot would leave two live rows with the same number.

    The prefix filter runs in SQL rather than over every lot in the table:
    lower(lot_number) LIKE lower(...) is exactly what
    ix_erp_production_lot_number indexes, and the regex below still has the
    final say on shape (LIKE can't express "digits only", and % would also
    match e.g. LOT-AB-01-REWORK).

    LIKE metacharacters in the prefix are escaped as defence in depth only:
    save_process already constrains Lot Prefix to 1-6 letters/digits, so
    none can occur today. It is one line because the failure it prevents is
    silent and expensive -- a trailing backslash would escape the pattern's
    own %, match nothing, and hand out a lot number already in use.
    """
    prefix = str(lot_prefix or "").strip().upper()
    pattern = re.compile(rf"^LOT-{re.escape(prefix)}-(\d+)$", re.IGNORECASE)
    like_prefix = prefix.replace("\\", r"\\").replace("%", r"\%").replace("_", r"\_")
    cur.execute(
        "SELECT lot_number FROM erp.production WHERE lower(lot_number) LIKE lower(%s)",
        (f"LOT-{like_prefix}-%",),
    )
    max_num = 0
    for row in cur.fetchall():
        match = pattern.match(str(row["lot_number"] or "").strip())
        if match:
            num = int(match.group(1))
            if num > max_num:
                max_num = num
    return f"LOT-{prefix}-{max_num + 1:04d}"


def _poolneed_key(item_name_lower: str, color_group: str) -> str:
    return f"{item_name_lower}||{color_group.lower() if _is_color_scoped(color_group) else ''}"


def _with_master_narration(cur, components: list) -> list:
    """Overwrites each component's `narration` with the current Items
    Master narration for its name+size, leaving it alone when Items Master
    doesn't know the item or has nothing set (see
    items_service.get_item_narration_map, which omits blanks for exactly
    this reason). Ports module_production.js#_withMasterNarration.

    Applied at the two points that WRITE a lot's component JSON --
    save_production and save_production_sheet -- so the snapshot is always
    stored fresh rather than persisting whatever the client happened to have
    on screen. Without this, a lot saved from a form still holding a stale
    narration (or an Edit Lot reopened long after the item's narration was
    corrected) would quietly write the stale text back and undo
    refresh_production_components_from_items_master.
    """
    if not components:
        return components
    narration_map = items_service.get_item_narration_map(cur)
    for comp in components:
        name = str(comp.get("itemName") or "").strip()
        if not name:
            continue
        master = narration_map.get(f'{name.lower()}|{str(comp.get("size") or "").strip().lower()}')
        if master:
            comp["narration"] = master
    return components


def _consolidate_duplicate_components(components: list) -> list:
    """Collapses more than one submitted line for the same physical
    consumption (same itemName+size+colorGroup) into one, instead of
    writing them as separate array entries that would each independently
    debit Stock (ITEM) or Warehouse Pool (POOL) for the same material --
    this is the guard against a lot's own components_consumed silently
    double-deducting, whatever client-side bug produced the duplicate (a
    stale row left behind after switching a component's source, a
    reconstruction bug in the Edit Lot form, a double-submitted add, ...).

    Two lines for the same item+size+colorGroup but DIFFERENT sourceType
    (one ITEM, one POOL) are refused outright rather than merged -- an
    ITEM qty and a POOL qty debit two different systems (Stock vs
    Warehouse Pool), so summing them would silently pick one meaning and
    discard the other. This is exactly the "changed a component's source
    from Stock to Warehouse Pool (or back) on an already-completed lot"
    case: if the old line wasn't actually replaced, both would otherwise
    fire, deducting the same material from both places for one lot.

    Two lines that agree on sourceType are safe to sum -- same system,
    same physical meaning, and summing is exactly what a lot that
    legitimately lists the same item twice (e.g. two recipe rows for one
    item) already implies.
    """
    order: list = []
    groups: dict = {}
    for c in components:
        key = (
            str(c.get("itemName") or "").strip().lower(),
            str(c.get("size") or "").strip().lower(),
            str(c.get("colorGroup") or "").strip().lower(),
        )
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(c)

    result = []
    for key in order:
        entries = groups[key]
        if len(entries) == 1:
            result.append(entries[0])
            continue

        source_types = {e["sourceType"] for e in entries}
        if len(source_types) > 1:
            raise ValueError(
                f'"{entries[0]["itemName"]}" is listed as consumed from both Stock and Warehouse Pool '
                "in this lot. Remove the duplicate line (keep only the correct source) before saving --"
                " saving both would deduct this item from both places for the same lot."
            )

        merged = dict(entries[0])
        merged["qty"] = sum(e["qty"] for e in entries)
        result.append(merged)

    return result


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
        is_color_scoped = _is_color_scoped(color_group)
        key = _poolneed_key(item_name.lower(), color_group)
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
        current_available_qty = _pool_available_qty(
            pool_available_map.get(need["itemName"].lower()), need["colorGroup"] if need["isColorScoped"] else ""
        )
        available_for_this_lot = current_available_qty + already_consumed.get(key, 0)
        if need["qty"] > available_for_this_lot + 0.0001:
            label = f'{need["itemName"]}" in color "{need["colorGroup"]}' if need["isColorScoped"] else need["itemName"]
            return f'Only {available_for_this_lot} unit(s) of "{label}" are available in the Warehouse Pool.'
    return None


def backfill_production_consumed_item_refs(cur, old_name: str, old_size: str, new_name: str, new_size: str) -> None:
    """Repoints an Items Master rename/merge into every lot's saved
    components_consumed/custom_components JSON -- called from
    items_service._propagate_item_identity_change. Ports
    backfillProductionConsumedItemRefs (module_production.js).

    components_consumed entries with sourceType 'POOL' are a different
    identity space (a Warehouse Pool bucket's Output Item Name, not an
    Items Master item) and must never be touched here, same rule as
    Process Components' ITEM-vs-POOL distinction. custom_components (the
    Production Sheet print customization list) has no sourceType marker at
    all -- every entry there is renamed unconditionally, matching source.
    """

    def _repoint(components, match_source_type: bool):
        if not components:
            return None
        changed = False
        for comp in components:
            if match_source_type and str(comp.get("sourceType") or "").strip().upper() == "POOL":
                continue
            row_name = str(comp.get("itemName") or "").strip().lower()
            row_size = str(comp.get("size") or "").strip().lower()
            if row_name == old_name.strip().lower() and row_size == old_size.strip().lower():
                comp["itemName"] = new_name
                comp["size"] = new_size
                changed = True
        return components if changed else None

    cur.execute("SELECT id, components_consumed, custom_components FROM erp.production WHERE deleted_at IS NULL")
    rows = cur.fetchall()
    for row in rows:
        rewritten_consumed = _repoint(row["components_consumed"] or [], match_source_type=True)
        rewritten_custom = _repoint(row["custom_components"] or [], match_source_type=False)
        if rewritten_consumed is None and rewritten_custom is None:
            continue
        _write_component_json(cur, row["id"], rewritten_consumed, rewritten_custom)


_PRODUCTION_SELECT_COLS = """
    id, production_date, product_id, product_name, qty, assigned_by, assigned_to,
    status, remarks, custom_components, sheet_remarks, process_id, lot_number,
    contractor_rate, contractor_payable, extra_charge_type, extra_charge_amount,
    output_item_name, components_consumed, color, color_breakdown
"""


def _row_to_production_record(row) -> dict:
    return {
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
        "processId": row["process_id"] or "",
        "lotNumber": row["lot_number"] or "",
        "contractorRate": float(row["contractor_rate"]),
        "contractorPayable": float(row["contractor_payable"]),
        "extraChargeType": row["extra_charge_type"] or "",
        "extraChargeAmount": float(row["extra_charge_amount"]),
        "outputItemName": row["output_item_name"] or "",
        "componentsConsumed": row["components_consumed"] or [],
        "color": row["color"] or "",
        "colorBreakdown": row["color_breakdown"] or [],
    }


@rpc_method("getProductionData")
def get_production_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(f"SELECT {_PRODUCTION_SELECT_COLS} FROM erp.production WHERE deleted_at IS NULL")
        rows = cur.fetchall()

    records = [_row_to_production_record(row) for row in rows]
    records.sort(key=lambda r: (r["dateRaw"] or "", r["rowIdx"]), reverse=True)
    return build_response(True, records)


def _fetch_production_record(cur, row_idx):
    """Reads one freshly-written production row back by id, so
    save_production can hand it to the client for an in-place row-patch
    instead of a full reload."""
    cur.execute(f"SELECT {_PRODUCTION_SELECT_COLS} FROM erp.production WHERE id = %s", (row_idx,))
    row = cur.fetchone()
    return _row_to_production_record(row) if row else None


@rpc_method("getProcessWipData")
def get_process_wip_data(process_id):
    components = process_service.get_process_components_data(process_id)["data"]
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        pool_qty_map = warehouse_service._get_pool_available_qty_map(cur)

    records = []
    for c in components:
        if c["sourceType"] != "POOL":
            continue
        available_qty = _pool_available_qty(
            pool_qty_map.get(str(c["itemName"] or "").strip().lower()), str(c.get("colorGroup") or "").strip()
        )
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

    # Output Item Name defaults to the process's own -- editable per lot
    # (e.g. this run actually produced a variant/rework SKU) without
    # touching the process master, which every *other* lot still inherits.
    # Warehouse Pool crediting/consumption already keys off this column
    # per production row (see _recalculate_warehouse_pool), so a custom
    # name here simply lands in its own pool bucket instead of the
    # process's usual one -- exactly scoped to this lot.
    output_item_name = str(form_data.get("outputItemName") or "").strip() or process["outputItemName"]

    # Read once, reused for both color-group validation and Primary Axis
    # qty resolution below -- avoids doubling reads on the busiest write path.
    color_components = process_service.get_process_components_data(process_id)["data"]
    pool_rows = process_service._get_all_warehouse_pool_rows_for_color_axes(cur)
    color_links = process_service._get_all_process_color_links(cur)
    color_master_names = process_service._get_color_master_names(cur)
    color_overrides = process_service._get_all_process_color_overrides(cur).get(process_id.lower())
    # Logged colors are passed in for the same reason the checklist the
    # operator filled in includes them (getProcessColorGroups ->
    # _compute_known_colors_for_process): without them a process whose
    # color mode comes entirely from its own Production history validates
    # as non-color here, the else branch below reads the plain `qty` the
    # client already deleted, and the lot lands with qty 0. See
    # _compute_color_groups_with_overrides_for_process's own docstring.
    logged_colors = process_service._get_production_logged_colors_by_process(cur, process_id).get(process_id.lower(), [])
    available_color_groups = process_service._compute_color_groups_with_overrides_for_process(
        process_id, color_components, pool_rows, color_links, color_master_names, color_overrides, logged_colors
    )

    raw_breakdown = _coerce_json_list(form_data.get("colorBreakdown"), "Invalid color breakdown data format.")

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
            if entry["color"]:
                color_breakdown.append(entry)

        if not color_breakdown:
            raise ValueError(
                "At least one Color is required for this lot "
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

        # Auto-register any genuinely new color the operator typed via
        # "+ Add Custom Sub-Group" into Color Master, so it's available
        # everywhere else Color Master feeds a picker instead of staying
        # invisible outside this one process's own logged history.
        custom_color_names = [c["color"] for c in color_breakdown if c["isCustom"]]
        if custom_color_names:
            tags_service.ensure_color_master_entries(cur, custom_color_names)

        color = ", ".join(f'{c["color"]} ({c["size"]})' if c["size"] else c["color"] for c in color_breakdown)

        # The operator can pick (or change) the Primary Axis directly on the
        # Production Lot form -- that choice arrives as
        # formData.primaryColorAxis and takes precedence over the process's
        # stored default for THIS lot. Neither picked here nor stored on the
        # process (and not a stale stored label either): the process still
        # falls back to its first axis in recipe order rather than to
        # legacy "sum every axis" summing, so a multi-axis lot can't
        # double-count just because nobody has been into the Process editor
        # yet (see process_service._default_primary_color_axis_label, which
        # resolves the identical default at save and read time). A process
        # with no axes at all resolves to none of this and keeps the legacy
        # branch below, unchanged.
        submitted_primary_color_axis = str(form_data.get("primaryColorAxis") or "").strip()
        stored_primary_color_axis = str(process.get("primaryColorAxis") or "").strip()
        requested_primary_color_axis = submitted_primary_color_axis or stored_primary_color_axis
        axes = process_service._compute_color_axes_for_process(process_id, color_components, pool_rows, color_links)

        # 2+ axes with NEITHER a per-lot pick NOR a process-level default is
        # the one case with nothing a human has ever actually decided --
        # save_process now requires a Primary Axis choice going forward (see
        # its own 2+ axes check), but a process saved before that existed can
        # still reach here with a blank stored value. Silently defaulting to
        # the first axis in recipe order is exactly the "nobody decided,
        # a reorder could flip it later" behavior this is meant to end, so
        # this is the one gap left for the operator to close right here on
        # the Production Lot form -- after which the write-back below
        # persists their pick as the process's default, so this only ever
        # blocks a given process's first lot post-migration.
        if not requested_primary_color_axis and len(axes) >= 2:
            raise ValueError(
                "This process has more than one independent Color Axis. Pick which group is \"Primary\" on this "
                "lot (or set a default Primary Axis for this process in the Process editor) before saving."
            )

        primary_axis = (
            next((a for a in axes if a["label"].lower() == requested_primary_color_axis.lower()), None)
            if requested_primary_color_axis
            else None
        ) or (axes[0] if axes else None)
        primary_color_axis = primary_axis["label"] if primary_axis else ""

        primary_axis_colors_lower = None
        primary_axis_key_lower = None
        real_axis_keys_lower = None
        if primary_axis:
            primary_axis_colors_lower = {c.lower() for c in primary_axis["colors"]}
            primary_axis_key_lower = primary_axis["key"].lower()
            real_axis_keys_lower = {a["key"].lower() for a in axes}

        if primary_axis_colors_lower is not None:
            # A submitted axisKey is only an AXIS identity when it's
            # actually one of this process's axis keys -- the same field
            # also carries a legacy pool-signature group id, the "Other
            # Colors" bucket, or a custom sub-group id. Comparing one of
            # those straight to the primary axis key would read every such
            # row as "not primary", zeroing the lot's quantity and then
            # failing the guard below outright. Those rows fall back to the
            # flag the client already computed for them instead -- the same
            # rule the no-primary-axis branch applies to every row.
            def _is_primary_axis_row(c):
                axis_key_lower = c["axisKey"].lower() if c["axisKey"] else ""
                if axis_key_lower and axis_key_lower in real_axis_keys_lower:
                    return axis_key_lower == primary_axis_key_lower
                if axis_key_lower or c["isCustom"]:
                    return c["countsTowardTotal"] is not False
                return c["color"].lower() in primary_axis_colors_lower

            qty = sum(c["qty"] for c in color_breakdown if _is_primary_axis_row(c))

            # The total itself may legitimately be zero or negative (a
            # correction/reversal lot, or an explicit zero-output record).
            # What's still rejected is a Primary-Axis-configured process
            # where NO checked row actually belongs to the primary group at
            # all (e.g. only a non-primary "Mudguard Color" row was checked)
            # -- that's an operator forgetting to address the primary axis,
            # not a deliberate zero.
            if not any(_is_primary_axis_row(c) for c in color_breakdown):
                raise ValueError(f'At least one "{primary_color_axis}" color is required for this lot.')
        else:
            qty = sum(c["qty"] for c in color_breakdown if c["countsTowardTotal"])

        # Write the resolved axis back onto the process when it isn't what's
        # stored, in the two cases where that's this lot's to decide: the
        # operator explicitly picked/changed it on this form and it resolved
        # to a real axis (adopt it as the process's default going forward),
        # or the process's own cell is still blank (fill it with the
        # default just used, so the column stops being blank without
        # waiting for a Process-editor save -- see
        # refresh_process_primary_color_axes for the same fill in bulk). A
        # stored label that no longer resolves is deliberately NOT
        # overwritten here: this lot falls back to the default for its own
        # quantity, but a stale client payload shouldn't silently rewrite a
        # configured choice.
        submitted_resolved = bool(submitted_primary_color_axis) and bool(primary_axis) and (
            submitted_primary_color_axis.lower() == primary_color_axis.lower()
        )
        if (
            primary_axis
            and primary_color_axis.lower() != stored_primary_color_axis.lower()
            and (submitted_resolved or not stored_primary_color_axis)
        ):
            process_service._set_process_primary_color_axis(cur, process_id, primary_color_axis)
    else:
        # Zero and negative quantities are both allowed -- a lot can be
        # logged as a correction/reversal (e.g. a prior over-count) without
        # editing history, mirroring adjust_stock_manually/
        # adjust_warehouse_pool_manually.
        qty = _validate_number(form_data.get("qty"), -10000000, 10000000)

    raw_components = _coerce_json_list(form_data.get("componentsConsumed"), "Invalid components consumed data format.")

    clean_components = []
    for c in raw_components:
        c = c or {}
        item_name = str(c.get("itemName") or "").strip()
        # Zero and negative consumption are both allowed -- e.g. a
        # correction/reversal lot that credits stock/pool back, mirroring
        # the output qty's own zero/negative handling above.
        qty_c = _validate_number(c.get("qty"), -10000000, 10000000)
        if item_name:
            clean_components.append(
                {
                    "itemName": item_name,
                    "size": str(c.get("size") or "").strip(),
                    "narration": str(c.get("narration") or "").strip(),
                    "color": str(c.get("color") or "").strip(),
                    "sourceType": "POOL" if str(c.get("sourceType") or "").strip().upper() == "POOL" else "ITEM",
                    "qty": qty_c,
                    "colorGroup": str(c.get("colorGroup") or "").strip() or _COLOR_GROUP_COMMON,
                    "unit": str(c.get("unit") or "").strip(),
                }
            )
    clean_components = _with_master_narration(cur, clean_components)

    if color_breakdown:
        breakdown_colors_lower = set()
        for c in color_breakdown:
            breakdown_colors_lower.add(c["color"].lower())
            for token in c["color"].split(_COLOR_COMBO_DELIMITER):
                breakdown_colors_lower.add(token.strip().lower())
        # process_service._is_common_color_group, not a bare == _COLOR_GROUP_
        # COMMON compare: a COMMON component's colorGroup is only guaranteed
        # to be that exact spelling when this save's own blank-defaulting
        # (above) set it -- a component whose colorGroup was submitted
        # non-blank as "Common"/"common" (typed that way on the recipe) is
        # just as much the sentinel, and a case-sensitive compare would drop
        # it out of clean_components entirely (a real consumption silently
        # never written, understating Warehouse Pool Pass 2's debit for it).
        # Ports GAS e37529e's isCommonColorGroup fix.
        clean_components = [
            c for c in clean_components
            if process_service._is_common_color_group(c["colorGroup"]) or c["colorGroup"].lower() in breakdown_colors_lower
        ]

    clean_components = _consolidate_duplicate_components(clean_components)

    if not clean_components:
        raise ValueError("At least one component consumed is required for this lot.")

    is_final_stage = bool(process.get("isFinalStage"))
    product_id = str(form_data.get("productId") or "").strip() if is_final_stage else ""
    product_name = str(form_data.get("productName") or "").strip() if is_final_stage else ""

    production_date = date_utils.to_safe_date(form_data.get("date")) or date.today()
    assigned_by = str(form_data.get("assignedBy") or "").strip()

    # Same whitelist update_production_status has always enforced -- this
    # path accepted ANY string, and everything downstream that decides
    # whether a lot's material movements happen at all keys off
    # `lower(status) = 'completed'` (warehouse_service's Pass 1 pool credit
    # and Pass 2 pool debit, stock_service's consumption term). A status
    # that isn't one of the four options is therefore not a cosmetic label
    # error: the lot is written, shows a status nobody can select from the
    # UI, and silently never credits the Warehouse Pool nor debits Stock.
    # Rejecting it here means the two write paths for the same column can
    # no longer disagree about what a valid status is.
    status = str(form_data.get("status") or "Pending").strip() or "Pending"
    if status not in _PRODUCTION_STATUS_OPTIONS:
        raise ValueError(f'Invalid status "{status}".')

    remarks = str(form_data.get("remarks") or "").strip()

    row_idx = form_data.get("rowIdx")
    is_edit = bool(row_idx)

    existing = None
    if is_edit:
        target_id = _coerce_row_id(row_idx, "Invalid production record selected for edit.")
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

    # Only run the pool-availability check when this save will leave the
    # lot Completed -- a Pending save never touches the pool, so checking
    # availability against it here would produce a misleading "pool will
    # go negative" warning on a lot that isn't finished yet.
    pool_warning = (
        _validate_pool_availability(cur, pool_needed, original_pool_consumed)
        if status.lower() == "completed"
        else None
    )

    # Size is never a form input -- derived server-side from this lot's
    # Process outputItemName, mirroring the client's own Size cascade
    # dropdown (App.Utils.getSizeFromOutputItemName), so Layer 1's rate key
    # falls out of the single Process the operator already picked.
    size = contractors_service._get_size_from_output_item_name(process["outputItemName"])
    contractor_rate = contractors_service._get_contractor_rate(cur, assigned_to, process["processType"], size)

    extra_charge_type = str(form_data.get("extraChargeType") or "").strip()
    extra_charge_amount = (
        contractors_service._get_extra_charge(cur, assigned_to, extra_charge_type) if extra_charge_type else 0.0
    )

    contractor_payable = (contractor_rate + extra_charge_amount) * qty

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
                contractor_rate = %s, contractor_payable = %s, extra_charge_type = %s, extra_charge_amount = %s,
                output_item_name = %s,
                components_consumed = %s, color = %s, color_breakdown = %s, updated_by = %s
            WHERE id = %s
            """,
            (
                production_date, product_id, product_name, resolved_bom_product_id,
                qty, assigned_by, assigned_to, resolved_contractor_id, status, remarks,
                process_id, resolved_process_master_id, lot_number,
                contractor_rate, contractor_payable, extra_charge_type or None, extra_charge_amount,
                output_item_name,
                components_json, color, color_breakdown_json, user_id,
                existing["id"],
            ),
        )
        new_row_idx = existing["id"]
    else:
        cur.execute(
            """
            INSERT INTO erp.production
                (production_date, product_id, product_name, bom_product_id, qty, assigned_by, assigned_to,
                 contractor_id, status, remarks, process_id, process_master_id, lot_number,
                 contractor_rate, contractor_payable, extra_charge_type, extra_charge_amount,
                 output_item_name, components_consumed, color,
                 color_breakdown, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                production_date, product_id, product_name, resolved_bom_product_id, qty, assigned_by, assigned_to,
                resolved_contractor_id, status, remarks, process_id, resolved_process_master_id, lot_number,
                contractor_rate, contractor_payable, extra_charge_type or None, extra_charge_amount,
                output_item_name, components_json, color,
                color_breakdown_json, user_id,
            ),
        )
        new_row_idx = cur.fetchone()["id"]

    warehouse_service._recalculate_warehouse_pool(cur)

    message = f"Lot #{lot_number} updated." if is_edit else f"Lot #{lot_number} saved."
    if pool_warning:
        message = f"{message} Warning: {pool_warning} Warehouse Pool stock will now show negative for this item."

    # Read this lot's own just-written row back so the client can patch it
    # into an already-loaded list in place instead of a full reload.
    fresh_row = _fetch_production_record(cur, new_row_idx)

    return build_response(True, {"lotNumber": lot_number, "row": fresh_row}, message)


@rpc_method("deleteProduction", mutation=True)
@database.transactional
def delete_production(conn, cur, row_idx, expected_product_id=None, expected_qty=None):
    target_id = _coerce_row_id(row_idx, "Invalid production record selected for deletion.")

    cur.execute(
        "SELECT product_id, qty, output_item_name, color_breakdown, lot_number FROM erp.production WHERE id = %s AND deleted_at IS NULL",
        (target_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("Invalid production record selected for deletion.")

    product_id = str(row["product_id"] or "").strip()
    qty = float(row["qty"] or 0)

    if not _matches_expected(product_id, qty, expected_product_id, expected_qty):
        raise ValueError("Data mismatch: The record has been modified or shifted. Please refresh.")

    pool_credit_warning = None
    if not product_id:
        pool_credit_warning = warehouse_service._check_pool_credit_removal_warning(
            cur, row["output_item_name"], row["color_breakdown"], qty
        )

    cur.execute("UPDATE erp.production SET deleted_at = NOW(), updated_by = %s WHERE id = %s", (get_current_user_id(), target_id))

    warehouse_service._recalculate_warehouse_pool(cur)

    message = f'Lot #{row["lot_number"]} deleted.'
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

        expected = expected_by_id.get(target_id) or {}
        if not _matches_expected(product_id, qty, expected.get("expectedProductId"), expected.get("expectedQty")):
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
    target_id = _coerce_row_id(row_idx, "Invalid production record selected.")

    status = str(new_status or "").strip()
    if status not in _PRODUCTION_STATUS_OPTIONS:
        raise ValueError(f'Invalid status "{status}".')

    cur.execute(
        "SELECT qty, status, components_consumed, lot_number FROM erp.production WHERE id = %s AND deleted_at IS NULL",
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

    message = f'Lot #{row["lot_number"]} status updated to "{status}".'
    if pool_warning:
        message = f"{message} Warning: {pool_warning} Warehouse Pool stock will now show negative for this item."
    return build_response(True, {"status": status}, message)


@rpc_method("saveProductionSheet", mutation=True)
@database.transactional
def save_production_sheet(conn, cur, row_idx, expected_product_id, expected_qty, custom_components, sheet_remarks):
    target_id = _coerce_row_id(row_idx, "Invalid production record selected.")

    cur.execute("SELECT product_id, qty, lot_number FROM erp.production WHERE id = %s AND deleted_at IS NULL", (target_id,))
    row = cur.fetchone()
    if row is None:
        raise ValueError("Invalid production record selected.")

    product_id = str(row["product_id"] or "").strip()
    qty = float(row["qty"] or 0)
    if not _matches_expected(product_id, qty, expected_product_id, expected_qty):
        raise ValueError("Data mismatch: The record has been modified or shifted. Please refresh.")

    components = _coerce_json_list(custom_components, "Invalid component data format.")

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
    clean_components = _with_master_narration(cur, clean_components)

    remarks = str(sheet_remarks or "").strip()[:500]

    # updated_by stamped like every other write path in this module
    # (save_production/delete_production/delete_production_bulk/
    # update_production_status all set it) -- a Production Sheet edit is a
    # real change to a stored column, and leaving it off meant the row kept
    # naming whoever last touched the lot ITSELF as the author of a sheet
    # customization they never made.
    cur.execute(
        "UPDATE erp.production SET custom_components = %s, sheet_remarks = %s, updated_by = %s WHERE id = %s",
        (json.dumps(clean_components), remarks, get_current_user_id(), target_id),
    )

    return build_response(True, {"customComponents": clean_components, "sheetRemarks": remarks}, f'Production sheet for Lot #{row["lot_number"]} saved.')


@rpc_method("refreshProductionComponentsFromItemsMaster", mutation=True)
@database.transactional
def refresh_production_components_from_items_master(conn, cur):
    """Rewrites narration/unit/item-name STORED on every already-logged
    lot's components_consumed and custom_components to the current Items
    Master values. Ports module_production.js#
    refreshProductionComponentsFromItemsMaster.

    Why this is needed at all: narration/unit/name are all metadata the
    operator maintains in Items Master, but a lot COPIES them into its own
    JSON snapshot at log time (see save_production/save_production_sheet's
    _with_master_narration call). A lot logged before an Items Master value
    was written/corrected, or before an item was renamed/re-cased, carries
    stale data forever unless explicitly refreshed here -- new and re-saved
    lots already write narration fresh via _with_master_narration, so in
    normal use this is a one-off catch-up pass.

    itemName is only ever corrected to the SAME identity's current
    casing/spelling (matched case-insensitively) -- this never repoints a
    component to a different item; a real rename to a different name is
    already handled by the rename cascade
    (backfill_production_consumed_item_refs).

    unit is synced unconditionally to the item's current Base Unit,
    including onto components whose stored unit is blank -- a blank
    nominally already means "this item's Base Unit", but leaving it blank
    keeps every reader dependent on resolving it live against Items Master.
    Stamping the real unit in makes the stored snapshot self-describing.
    This assumes a component's qty was entered in the item's Base Unit at
    the time -- the common case; if an item's Base Unit was itself later
    changed to a genuinely different unit, a lot that deliberately recorded
    consumption in the OLD Base Unit would have its quantity reinterpreted
    under the new one (confirmed acceptable, matching narration's own
    philosophy of unconditional sync). Only applied to components_consumed
    -- custom_components has no `unit` field at all (see
    save_production_sheet's narrower schema) and must not gain one here.

    sourceType is deliberately NOT filtered -- the lookup is by name+size,
    and a POOL row whose name happens to be a real Items Master item is the
    same physical item, which is how the display layer resolves it too
    (contrast backfill_production_consumed_item_refs, which must skip POOL
    rows because it rewrites item IDENTITY, not metadata).

    Idempotent and safe to re-run: a component already fully in sync is
    left untouched, and a row is only written when something in it actually
    changed.
    """
    master_map = items_service.get_item_master_refresh_map(cur)
    if not master_map:
        return build_response(
            True, {"lotsScanned": 0, "lotsUpdated": 0, "fieldsUpdated": 0, "details": []}, "Items Master is empty -- nothing to sync."
        )

    def _resync(components: list, has_unit: bool) -> tuple:
        """Returns (rewritten components, or None when nothing changed;
        number of individual fields corrected) -- the count used to be
        accumulated through a one-element list passed in as a mutable box."""
        if not components:
            return None, 0
        fields_changed = 0
        for comp in components:
            name = str(comp.get("itemName") or "").strip()
            if not name:
                continue
            master = master_map.get(f'{name.lower()}|{str(comp.get("size") or "").strip().lower()}')
            if not master:
                continue  # unknown item -- keep stored as-is

            if master["canonicalName"] and comp["itemName"] != master["canonicalName"]:
                comp["itemName"] = master["canonicalName"]
                fields_changed += 1
            if master["narration"] and str(comp.get("narration") or "").strip() != master["narration"]:
                comp["narration"] = master["narration"]
                fields_changed += 1
            if has_unit and "unit" in comp and master["baseUnit"] and str(comp.get("unit") or "").strip() != master["baseUnit"]:
                comp["unit"] = master["baseUnit"]
                fields_changed += 1
        return (components if fields_changed else None), fields_changed

    cur.execute(
        "SELECT id, lot_number, components_consumed, custom_components FROM erp.production WHERE deleted_at IS NULL"
    )
    rows = cur.fetchall()

    fields_updated = 0
    details = []
    lots_updated = 0

    for row in rows:
        rewritten_consumed, consumed_fields = _resync(row["components_consumed"] or [], has_unit=True)
        rewritten_custom, custom_fields = _resync(row["custom_components"] or [], has_unit=False)
        fields_updated += consumed_fields + custom_fields
        if rewritten_consumed is None and rewritten_custom is None:
            continue

        lots_updated += 1
        lot_label = str(row["lot_number"] or "").strip() or f"row {row['id']}"
        details.append(f"{lot_label}: fields refreshed")

        _write_component_json(cur, row["id"], rewritten_consumed, rewritten_custom)

    if fields_updated == 0:
        message = f"All {len(rows)} production lot(s) already match Items Master -- nothing to change."
    else:
        message = f"Refreshed {fields_updated} field(s) (narration/unit/name) across {lots_updated} of {len(rows)} production lot(s)."

    return build_response(
        True,
        {"lotsScanned": len(rows), "lotsUpdated": lots_updated, "fieldsUpdated": fields_updated, "details": details},
        message,
    )
