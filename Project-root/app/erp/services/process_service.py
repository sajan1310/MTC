"""Process Master + Process Components + Process Color Links, ported from
Apps_Script/module_process.js. Opens Phase 3 (manufacturing) the same way
module_vendors.js opened Phase 2 -- see migrations/erp/010_process_master.sql.

Registering PROCESS_MASTER/PROCESS_COMPONENTS/PROCESS_COLOR_LINKS in
config_maps.TABLE_NAMES this round activates three rename cascades written
back in Phase 1a as guarded no-ops (tags_service._rename_color_everywhere's
PROCESS_COMPONENTS/PROCESS_COLOR_LINKS targets and
_rename_process_type_everywhere's PROCESS_MASTER target) -- no code changes
needed there, confirming the "write cascades in full now, guarded" bet paid
off. items_service._propagate_item_identity_change also gained a third
guarded target this round (see its docstring).

getNextProcessId is a genuine exception to this port's usual {success, data,
message} envelope: the source function returns a bare string ('PRC-1001'),
not buildResponse(...) -- confirmed against both module_process.js:228 and
Script_Core.html's mock harness (`_mockAsync('PRC-1005').then(cb)`). Ported
verbatim as a bare-string return; the RPC bridge (app/erp/rpc.py) just
JSONifies whatever spec.func returns, so this needs no special-casing there.

Process ID generation uses a real Postgres SEQUENCE (erp.process_id_seq),
same deliberate deviation as PO's po_number_seq (Phase 2b): atomic and safe
under concurrency, versus the source's full-column regex-scan-for-max
approach. One consequence worth noting: the source's getNextProcessId is a
non-consuming *preview* (rescans and returns maxNum+1 without writing
anything), so previewing and then saving can each independently compute the
same next ID if nothing else was created in between. A Postgres sequence
consumes a value on every nextval() call, so a preview call followed by a
save can legitimately produce two different consecutive IDs (e.g. preview
shows PRC-1005, save actually assigns PRC-1006) -- harmless (still unique,
just occasionally non-contiguous), and the same tradeoff already accepted
for PO numbers.

deleteProcess raises a "not found" error for an unmatched Process ID rather
than the source's inherited deleteRowsById behavior (silently returns
success with "0 row(s) removed") -- module_po.js's deletePO has the same
silent-no-op source behavior, and this port's delete_po already deviates the
same way for the same reason: a stale-tab double-delete surfacing as an
error is more useful than a silent false-success, and it matches every
other delete endpoint already shipped in this codebase.

getProcessColorGroups/getProcessColorAxes/getAllProcessColorGroups and the
pure compute functions behind them (_compute_color_axes_for_process,
_compute_color_groups_for_process, _legacy_color_group_list,
_merge_linked_axes, _resolve_linked_color) are real as of Phase 3f, now
that Warehouse Pool (Phase 3e) makes them meaningful -- deferred from
Phase 3a specifically because they needed Process Color Links AND
Warehouse Pool both real to be testable, and because
_mergeLinkedAxes/_resolveLinkedColor's BFS-based cross-process axis-merge
algorithm (including transitive link chains) is genuinely independent
complexity deserving its own round. saveProduction (Production's own
round) is the only caller of any of this.

_setProcessPrimaryColorAxis and the Production leg of
_renamePoolOutputItemNameEverywhere are real as of Phase 3g, now that
Production exists to call/target them. The Dispatch leg (an untagged
final-stage lot's Output Item Name doubling as erp.dispatch.product_id/
product_name -- see that function's own docstring) was ported later,
alongside GAS 6a22f0e's fix for the exact staleness bug a missing cascade
there causes.
_renameProcessNameInContractorRates has been real since Phase 3d
(Contractors) -- its target table just isn't a flat rename_in_column call
here, see that function itself.
"""

from __future__ import annotations

import json
import math
import re

import psycopg2.extras

import database
from . import items_service
from . import rename_utils
from .current_user import get_current_user_id
from .. import config_maps
from ..envelope import build_response
from ..registry import rpc_method

_LOT_PREFIX_RE = re.compile(r"^[A-Z0-9]{1,6}$")
_COLOR_GROUP_COMMON = config_maps.COMPONENT_COLOR_GROUP_COMMON
_MAX_REMARKS_LENGTH = 500


def _validate_number(value, min_value: float, max_value: float) -> float:
    """Ports utils.js's validateNumber: 0 (never raises) if `value` isn't
    finite or falls outside [min_value, max_value]."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(n) or n < min_value or n > max_value:
        return 0.0
    return n


def _parse_json_array(raw, error_message: str) -> list:
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw) if raw else []
        except ValueError:
            raise ValueError(error_message)
    else:
        parsed = raw or []
    return parsed if isinstance(parsed, list) else []


# ─────────────────────────────────────────────────────────────────────────
# Process Master
# ─────────────────────────────────────────────────────────────────────────


def _get_all_processes(cur) -> list:
    """Collapses getProcessData's row-read and module_production.js's
    duplicate _getAllProcessRecords (an uncached copy of the same read) into
    one query -- see module docstring. Not sorted/filtered; callers apply
    Sequence order or an active-only filter themselves.
    """
    cur.execute(
        """
        SELECT process_id, process_name, sequence, lot_prefix, is_final_stage,
               active, remarks, output_item_name, process_type, primary_color_axis,
               dispatch_differentiator
        FROM erp.process_master
        WHERE deleted_at IS NULL
        """
    )
    return [
        {
            "processId": row["process_id"],
            "processName": row["process_name"],
            "sequence": row["sequence"],
            "lotPrefix": row["lot_prefix"],
            "isFinalStage": row["is_final_stage"],
            "active": row["active"],
            "remarks": row["remarks"] or "",
            "outputItemName": row["output_item_name"] or "",
            "processType": row["process_type"] or "",
            "primaryColorAxis": row["primary_color_axis"] or "",
            "dispatchDifferentiator": row["dispatch_differentiator"] or "",
        }
        for row in cur.fetchall()
    ]


def _process_lookup_by_id(cur) -> dict:
    """{processIdLower: {"id": db_id, "processName": ...}} for every
    non-deleted process -- internal FK resolution for color-link saves, not
    the RPC-facing shape _get_all_processes returns.
    """
    cur.execute("SELECT id, process_id, process_name FROM erp.process_master WHERE deleted_at IS NULL")
    return {
        row["process_id"].strip().lower(): {"id": row["id"], "processName": row["process_name"]}
        for row in cur.fetchall()
        if row["process_id"]
    }


def _get_process_ids_in_use(cur, process_ids: list) -> set:
    """Lower-cased Process IDs referenced by a Production lot, a Product's
    BOM component group, or a Warehouse Pool Opening balance -- unsafe to
    delete. Guarded via config_maps.TABLE_NAMES exactly like every other
    delete-guard in this codebase: PRODUCTION/WAREHOUSE_POOL_OPENING aren't
    registered yet, so those never block anything today (correct, since
    nothing can reference a process through them yet either); BOM is real
    as of Phase 3c.
    """
    requested = {str(p or "").strip().lower() for p in process_ids if str(p or "").strip()}
    in_use: set = set()
    if not requested:
        return in_use

    if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
        col = config_maps.to_snake_case("processId")
        cur.execute(f"SELECT DISTINCT {col} AS process_id FROM {table} WHERE deleted_at IS NULL")
        for row in cur.fetchall():
            pid = str(row["process_id"] or "").strip().lower()
            if pid in requested:
                in_use.add(pid)

    bom_lines_table = config_maps.TABLE_NAMES.get("BOM_LINES")
    bom_products_table = config_maps.TABLE_NAMES.get("BOM_PRODUCTS")
    if bom_lines_table and bom_products_table:
        # erp.bom_lines has no deleted_at of its own -- join through its
        # parent, same treatment as items_service._get_item_keys_in_use's
        # BOM_LINES/PROCESS_COMPONENTS branches.
        col = config_maps.to_snake_case("processGroup")
        cur.execute(
            f"""
            SELECT DISTINCT bl.{col} AS process_group
            FROM {bom_lines_table} bl
            JOIN {bom_products_table} bp ON bp.id = bl.header_id
            WHERE bp.deleted_at IS NULL
            """
        )
        for row in cur.fetchall():
            pid = str(row["process_group"] or "").strip().lower()
            if pid in requested:
                in_use.add(pid)

    if table := config_maps.TABLE_NAMES.get("WAREHOUSE_POOL_OPENING"):
        col = config_maps.to_snake_case("processId")
        cur.execute(f"SELECT DISTINCT {col} AS process_id FROM {table}")
        for row in cur.fetchall():
            pid = str(row["process_id"] or "").strip().lower()
            if pid in requested:
                in_use.add(pid)

    return in_use


def _rename_pool_output_item_name_everywhere(cur, old_name: str, new_name: str) -> None:
    """Propagates a Process Master Output Item Name rename to every
    de-normalized snapshot of it, so Warehouse Pool stays keyed
    consistently under the new name.
    """
    old = (old_name or "").strip()
    new = (new_name or "").strip()
    if not old or not new or old.lower() == new.lower():
        return

    if table := config_maps.TABLE_NAMES.get("PROCESS_COMPONENTS"):
        rename_utils.rename_in_column(
            cur, table, "item_name", old, new, extra_where=" AND source_type = 'POOL'"
        )

    if table := config_maps.TABLE_NAMES.get("WAREHOUSE_POOL_OPENING"):
        rename_utils.rename_in_column(cur, table, config_maps.to_snake_case("outputItemName"), old, new)

    if table := config_maps.TABLE_NAMES.get("PRODUCTION"):
        # Credit side: any lot's own output_item_name.
        rename_utils.rename_in_column(cur, table, "output_item_name", old, new)

        # Debit side: any OTHER lot's components_consumed JSON that consumed
        # this item as a POOL-sourced component. A structured rewrite, not
        # a plain column rename -- rename_utils has nothing for a value
        # nested inside a JSON array.
        cur.execute(f"SELECT id, components_consumed FROM {table} WHERE deleted_at IS NULL AND components_consumed IS NOT NULL")
        for row in cur.fetchall():
            components = row["components_consumed"] or []
            changed = False
            for comp in components:
                if not isinstance(comp, dict):
                    continue
                if (
                    str(comp.get("sourceType") or "").strip().upper() == "POOL"
                    and str(comp.get("itemName") or "").strip().lower() == old.lower()
                ):
                    comp["itemName"] = new
                    changed = True
            if changed:
                cur.execute(
                    f"UPDATE {table} SET components_consumed = %s WHERE id = %s",
                    (json.dumps(components), row["id"]),
                )

    # Dispatch: an UNTAGGED final-stage lot is dispatched under its Output
    # Item Name, which is what save_dispatch writes into a dispatch line's
    # product_id (see dispatch_service._compute_ready_to_dispatch_map:
    # `productId: product_tag if is_tagged else output_item_name`) and what
    # _recalculate_warehouse_pool's Pass 3 matches back against
    # bucket["outputItemName"] to debit the pool. Left un-renamed, Pass 3
    # finds no bucket for the old name, the entire dispatch debit silently
    # vanishes, and every already-shipped unit reappears as Ready to
    # Dispatch -- i.e. a rename made the business look like it still had
    # goods it had shipped. Ports module_process.js's 6a22f0e fix. Dispatch
    # is header+lines (migration 023): product_id/product_name live on
    # dispatch_lines, deleted_at on dispatch_headers, so every touch here is
    # a join/subquery against the header instead of a flat WHERE.
    if (dispatch_headers_table := config_maps.TABLE_NAMES.get("DISPATCH_HEADERS")) and (
        dispatch_lines_table := config_maps.TABLE_NAMES.get("DISPATCH_LINES")
    ):
        old_lower = old.lower()

        # A Dispatch line's product_id is EITHER a BOM Product ID (a tagged
        # final-stage lot) or an Output Item Name (an untagged one) -- the
        # column doesn't record which. Only the latter is ours to rename,
        # so a name that is also a real BOM Product ID is left alone
        # rather than risk rewriting a genuine product reference that
        # merely happens to share the string.
        is_also_bom_product_id = False
        if bom_products_table := config_maps.TABLE_NAMES.get("BOM_PRODUCTS"):
            cur.execute(
                f"SELECT 1 FROM {bom_products_table} WHERE lower(product_id) = lower(%s) AND deleted_at IS NULL",
                (old,),
            )
            is_also_bom_product_id = cur.fetchone() is not None

        if not is_also_bom_product_id:
            cur.execute(
                f"""
                UPDATE {dispatch_lines_table} l SET product_id = %s
                FROM {dispatch_headers_table} h
                WHERE h.id = l.header_id AND h.deleted_at IS NULL AND lower(l.product_id) = lower(%s)
                """,
                (new, old),
            )
            # Product Name is a de-normalized display copy of the same
            # value for an untagged output (see _compute_ready_to_dispatch_
            # map's base_name), so it goes stale the same way; rewritten
            # only where it still holds the old name exactly, or carries a
            # Dispatch Differentiator suffix ("<Output Item Name> / <value>",
            # see dispatch_service._differentiator_value) -- never where the
            # operator typed something else.
            cur.execute(
                f"""
                SELECT l.id, l.product_name FROM {dispatch_lines_table} l
                JOIN {dispatch_headers_table} h ON h.id = l.header_id
                WHERE h.deleted_at IS NULL AND l.product_name IS NOT NULL
                """
            )
            for row in cur.fetchall():
                current = str(row["product_name"] or "").strip()
                current_lower = current.lower()
                if current_lower == old_lower:
                    updated_name = new
                elif current_lower.startswith(old_lower + " / "):
                    updated_name = new + current[len(old):]
                else:
                    continue
                cur.execute(
                    f"UPDATE {dispatch_lines_table} SET product_name = %s WHERE id = %s",
                    (updated_name, row["id"]),
                )

    # erp.warehouse_pool itself is a materialized cache, entirely rewritten
    # by _recalculate_warehouse_pool() from the rows just renamed above --
    # renaming the source rows alone leaves the cached bucket keyed under
    # the OLD name until some unrelated mutation happens to trigger a
    # recalc. Recompute now so callers (e.g. getWarehousePoolData right
    # after this save) see the new name immediately. Same precedent as
    # tags_service._rename_color_everywhere. Deferred import: warehouse_
    # service imports this module at load time, so a top-level import here
    # would be circular.
    from . import warehouse_service

    warehouse_service._recalculate_warehouse_pool(cur)


def _set_process_primary_color_axis(cur, process_id: str, primary_color_axis: str) -> None:
    """Updates just one process's Primary Color Axis cell, without touching
    its recipe/components/color links -- used when the operator picks or
    changes the Primary Axis directly on the Production Lot form instead of
    going through the full Process editor. Silently no-ops if the process
    can't be found -- a best-effort "remember this choice for next time"
    side effect, not something a Production save should fail over.
    """
    cur.execute(
        "UPDATE erp.process_master SET primary_color_axis = %s WHERE lower(process_id) = lower(%s) AND deleted_at IS NULL",
        (primary_color_axis, process_id),
    )


def _rename_process_name_in_contractor_rates(cur, old_name: str, new_name: str) -> None:
    old = (old_name or "").strip()
    new = (new_name or "").strip()
    if not old or not new or old.lower() == new.lower():
        return
    if table := config_maps.TABLE_NAMES.get("CONTRACTOR_RATES"):
        rename_utils.rename_in_column(cur, table, config_maps.to_snake_case("processName"), old, new)


def _find_duplicate_component(components: list):
    seen = set()
    for comp in components or []:
        comp = comp or {}
        item_name = str(comp.get("itemName") or "").strip()
        if not item_name:
            continue
        size = str(comp.get("size") or "").strip()
        color_group = str(comp.get("colorGroup") or "").strip() or _COLOR_GROUP_COMMON
        key = f"{item_name.lower()}|{size.lower()}|{color_group.lower()}"
        if key in seen:
            return {"itemName": item_name, "size": size, "colorGroup": color_group}
        seen.add(key)
    return None


def _save_process_components_for_process(cur, master_id: int, components: list) -> None:
    """Replaces a process's entire component checklist -- delete-then-append,
    same pattern as PO/Bill line replacement on edit.
    """
    cur.execute("DELETE FROM erp.process_components WHERE master_id = %s", (master_id,))

    for comp in components or []:
        comp = comp or {}
        item_name = str(comp.get("itemName") or "").strip()
        if not item_name:
            continue
        size = str(comp.get("size") or "").strip()
        narration = str(comp.get("narration") or "").strip()
        qty_per_unit = _validate_number(comp.get("qtyPerUnit"), 0.0001, 1000000) or 1
        remarks = str(comp.get("remarks") or "").strip()
        source_type = "POOL" if str(comp.get("sourceType") or "").strip().upper() == "POOL" else "ITEM"
        color_group = str(comp.get("colorGroup") or "").strip() or _COLOR_GROUP_COMMON
        color_axis = str(comp.get("colorAxis") or "").strip()
        # Blank = "already in the item's Base Unit" -- see PROCESS_COMPONENTS_COL.UNIT.
        unit = str(comp.get("unit") or "").strip()

        # A POOL row's item_name is a Process's Output Item Name, a
        # different identity space than Items Master -- never resolved
        # against erp.items.
        item_id = items_service._find_item(cur, item_name, size) if source_type == "ITEM" else None

        cur.execute(
            """
            INSERT INTO erp.process_components
                (master_id, item_name, size, narration, qty_per_unit, remarks, source_type, color_group, color_axis, unit, item_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (master_id, item_name, size, narration, qty_per_unit, remarks, source_type, color_group, color_axis, unit, item_id),
        )


def _save_process_color_links_for_process(cur, master_id: int, process_id: str, links: list, process_lookup: dict) -> None:
    """Replaces every color-link row touching one process -- delete-then-
    append, mirrors _save_process_components_for_process. This process is
    always re-written as Process A regardless of which side originally
    created the row.

    A same-process link (other_process_id == process_id, pairing two of
    this process's OWN axes -- e.g. tag-based Rim Color <-> Mudguard
    Color) is only accepted when BOTH axis keys are given and differ; a
    same-process row with a blank/matching axis key is meaningless (there
    is no "this process's own pool axis, paired with itself") and is
    dropped, matching the original behavior from before axis keys existed
    (self-links were rejected unconditionally).
    """
    cur.execute("DELETE FROM erp.process_color_links WHERE process_a_id = %s OR process_b_id = %s", (master_id, master_id))

    self_lower = str(process_id or "").strip().lower()
    for link in links or []:
        link = link or {}
        other_process_id = str(link.get("otherProcessId") or "").strip()
        my_color = str(link.get("myColor") or "").strip()
        their_color = str(link.get("theirColor") or "").strip()
        my_axis_key = str(link.get("myAxisKey") or "").strip()
        their_axis_key = str(link.get("theirAxisKey") or "").strip()
        if not (other_process_id and my_color and their_color):
            continue

        is_self = other_process_id.lower() == self_lower
        if is_self:
            if not (my_axis_key and their_axis_key and my_axis_key.lower() != their_axis_key.lower()):
                continue
            other_id = master_id
        else:
            other = process_lookup.get(other_process_id.lower())
            if not other:
                continue
            other_id = other["id"]

        cur.execute(
            """
            INSERT INTO erp.process_color_links (process_a_id, color_a, process_b_id, color_b, axis_a_key, axis_b_key)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (master_id, my_color, other_id, their_color, my_axis_key, their_axis_key),
        )


# ─────────────────────────────────────────────────────────────────────────
# RPC methods
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getProcessData")
def get_process_data(active_only=False):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        processes = _get_all_processes(cur)
    if active_only:
        processes = [p for p in processes if p["active"]]
    processes.sort(key=lambda p: p["sequence"])
    return build_response(True, processes)


@rpc_method("getNextProcessId")
def get_next_process_id():
    # Bare string return, not build_response(...) -- see module docstring.
    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT nextval('erp.process_id_seq') AS n")
        n = cur.fetchone()[0]
    return f"PRC-{n}"


@rpc_method("saveProcess", mutation=True)
@database.transactional
def save_process(conn, cur, form_data):
    form_data = form_data or {}

    process_name = str(form_data.get("processName") or "").strip()
    if not process_name:
        raise ValueError("Process Name is required.")

    lot_prefix = str(form_data.get("lotPrefix") or "").strip().upper()
    if not lot_prefix or not _LOT_PREFIX_RE.match(lot_prefix):
        raise ValueError('Lot Prefix is required (1-6 letters/numbers, e.g. "FP").')

    output_item_name = str(form_data.get("outputItemName") or "").strip()
    if not output_item_name:
        raise ValueError("Output Item Name is required (the Warehouse Pool item this process produces).")

    # Optional -- categorizes the process for grouping (see Process Type
    # Master). Blank is allowed.
    process_type = str(form_data.get("processType") or "").strip()

    sequence = _validate_number(form_data.get("sequence"), 1, 100000)
    if sequence <= 0:
        raise ValueError("Sequence must be a positive number.")

    is_final_stage = bool(form_data.get("isFinalStage"))
    active = True if form_data.get("active") is None else bool(form_data.get("active"))
    remarks = str(form_data.get("remarks") or "").strip()[:_MAX_REMARKS_LENGTH]

    # Only a light shape check -- a stale/mismatched label falls back to
    # legacy behavior client-side rather than blocking save.
    primary_color_axis = str(form_data.get("primaryColorAxis") or "").strip()

    # Same light shape check, and same label-not-key convention, as
    # primaryColorAxis above: a stale label just means the Ready to Dispatch
    # list falls back to one aggregate row (see
    # dispatch_service._compute_ready_to_dispatch_map), never a failed save.
    dispatch_differentiator = str(form_data.get("dispatchDifferentiator") or "").strip()

    components = _parse_json_array(form_data.get("components"), "Invalid component data format.")
    color_links = _parse_json_array(form_data.get("colorLinks"), "Invalid color link data format.")

    # Uses the already-PERSISTED color links (_get_all_process_color_links),
    # not the just-submitted `color_links` above -- those arrive in a
    # process-relative client shape ({otherProcessId, myColor, ...}, see
    # _save_process_color_links_for_process), not the absolute
    # {processAId, processBId, ...} shape _compute_color_axes_for_process
    # expects. A link added in this very save therefore isn't reflected in
    # this one default-label resolution; links only affect axis
    # merging/labels, and the first-in-recipe-order pick itself is stable
    # either way, so this is a harmless simplification, not a correctness gap.
    if not primary_color_axis:
        pool_rows = _get_all_warehouse_pool_rows_for_color_axes(cur)
        saved_color_links = _get_all_process_color_links(cur)
        # _compute_color_axes_for_process indexes itemName/sourceType/
        # colorGroup directly (no .get() fallback) -- it's normally fed
        # DB-read rows (_fetch_process_components), which always carry
        # every key. `components` here is the raw, just-submitted client
        # array instead, which may omit any of them (e.g. a component with
        # no sourceType typed yet), so it needs the same normalization
        # _save_process_components_for_process applies before insert.
        axis_components = [
            {
                "itemName": str((c or {}).get("itemName") or "").strip(),
                "sourceType": "POOL" if str((c or {}).get("sourceType") or "").strip().upper() == "POOL" else "ITEM",
                "colorGroup": str((c or {}).get("colorGroup") or "").strip() or _COLOR_GROUP_COMMON,
                "colorAxis": str((c or {}).get("colorAxis") or "").strip(),
            }
            for c in components
            if str((c or {}).get("itemName") or "").strip()
        ]
        primary_color_axis = _default_primary_color_axis_label(
            str(form_data.get("processId") or "").strip(), axis_components, pool_rows, saved_color_links
        )

    dup = _find_duplicate_component(components)
    if dup:
        size_suffix = f" ({dup['size']})" if dup["size"] else ""
        group_label = (
            "Common Components"
            if _is_common_color_group(dup["colorGroup"])
            else f'the "{dup["colorGroup"]}" color sub-group'
        )
        raise ValueError(
            f'Duplicate component: "{dup["itemName"]}"{size_suffix} already exists in {group_label}. '
            f"Each item+size combination may only appear once per group — adjust its Qty / Unit "
            f"instead of adding it twice."
        )

    process_id_input = str(form_data.get("processId") or "").strip()
    is_edit = bool(process_id_input)

    existing_id = None
    old_output_item_name = ""
    old_process_name = ""
    if is_edit:
        cur.execute(
            "SELECT id, output_item_name, process_name FROM erp.process_master WHERE lower(process_id) = lower(%s) AND deleted_at IS NULL",
            (process_id_input,),
        )
        existing_row = cur.fetchone()
        if existing_row is None:
            raise ValueError(f'Process with ID "{process_id_input}" not found.')
        existing_id = existing_row["id"]
        old_output_item_name = existing_row["output_item_name"] or ""
        old_process_name = existing_row["process_name"] or ""

    # Duplicate Lot Prefix -- across EVERY non-deleted process, active or
    # not (excludes the row being edited).
    lot_prefix_sql = "SELECT 1 FROM erp.process_master WHERE deleted_at IS NULL AND upper(lot_prefix) = %s"
    lot_prefix_params = [lot_prefix]
    if existing_id is not None:
        lot_prefix_sql += " AND id != %s"
        lot_prefix_params.append(existing_id)
    cur.execute(lot_prefix_sql, lot_prefix_params)
    if cur.fetchone():
        raise ValueError(f'Lot Prefix "{lot_prefix}" is already used by another process.')

    # Duplicate Output Item Name -- only among ACTIVE processes, and only
    # enforced when this save itself leaves the process active. An inactive
    # process is exempt: Warehouse Pool buckets are keyed by
    # outputItemName+productTag+color with no Process ID in the key, so two
    # ACTIVE processes sharing one Output Item Name would silently merge
    # each other's pool stock -- deactivate the old one before reusing its
    # name.
    if active:
        name_sql = (
            "SELECT process_name FROM erp.process_master "
            "WHERE deleted_at IS NULL AND active = TRUE AND lower(output_item_name) = lower(%s)"
        )
        name_params = [output_item_name]
        if existing_id is not None:
            name_sql += " AND id != %s"
            name_params.append(existing_id)
        cur.execute(name_sql, name_params)
        conflict = cur.fetchone()
        if conflict:
            other_name = conflict["process_name"]
            raise ValueError(
                f'Output Item Name "{output_item_name}" is already used by another active process '
                f'("{other_name}"). Two active processes can\'t share one Warehouse Pool item — '
                f'pick a different name, or deactivate "{other_name}" first.'
            )

    user_id = get_current_user_id()

    if is_edit:
        master_id = existing_id
        cur.execute(
            """
            UPDATE erp.process_master
            SET process_name = %s, sequence = %s, lot_prefix = %s, is_final_stage = %s, active = %s,
                remarks = %s, output_item_name = %s, process_type = %s, primary_color_axis = %s,
                dispatch_differentiator = %s, updated_by = %s
            WHERE id = %s
            """,
            (
                process_name, sequence, lot_prefix, is_final_stage, active, remarks,
                output_item_name, process_type, primary_color_axis, dispatch_differentiator,
                user_id, master_id,
            ),
        )
        result_process_id = process_id_input
    else:
        cur.execute("SELECT nextval('erp.process_id_seq') AS n")
        result_process_id = f"PRC-{cur.fetchone()['n']}"
        cur.execute(
            """
            INSERT INTO erp.process_master
                (process_id, process_name, sequence, lot_prefix, is_final_stage, active, remarks,
                 output_item_name, process_type, primary_color_axis, dispatch_differentiator, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                result_process_id, process_name, sequence, lot_prefix, is_final_stage, active, remarks,
                output_item_name, process_type, primary_color_axis, dispatch_differentiator, user_id,
            ),
        )
        master_id = cur.fetchone()["id"]

    _save_process_components_for_process(cur, master_id, components)

    process_lookup = _process_lookup_by_id(cur)
    _save_process_color_links_for_process(cur, master_id, result_process_id, color_links, process_lookup)

    if is_edit:
        # Renaming the Output Item Name doesn't retroactively touch
        # Production lots already saved under the old name (it's
        # de-normalized onto each lot at save time), so without this, old
        # completed lots would keep crediting the pool under the stale name
        # while new recipes look up the new name and see zero stock.
        output_item_name_changed = bool(old_output_item_name) and old_output_item_name.lower() != output_item_name.lower()
        if output_item_name_changed:
            _rename_pool_output_item_name_everywhere(cur, old_output_item_name, output_item_name)

        # Contractor Rates keys its rate card on Process Name as a free
        # string, not Process ID.
        if old_process_name and old_process_name.lower() != process_name.lower():
            _rename_process_name_in_contractor_rates(cur, old_process_name, process_name)

        message = "Process updated successfully."
    else:
        message = "Process created successfully."

    # Read this process's own just-written row back so the client can
    # patch it into an already-loaded list in place instead of a full
    # reload.
    fresh_process = next(
        (p for p in _get_all_processes(cur) if p["processId"].lower() == result_process_id.lower()),
        None,
    )

    return build_response(True, {"processId": result_process_id, "process": fresh_process}, message)


@rpc_method("deleteProcess", mutation=True)
@database.transactional
def delete_process(conn, cur, process_id):
    target = str(process_id or "").strip()
    if not target:
        raise ValueError("Process ID is required.")

    if target.lower() in _get_process_ids_in_use(cur, [target]):
        raise ValueError(
            f'Cannot delete process: "{target}" is already referenced by Production lots, '
            "a Product's recipe (BOM), or a Warehouse Pool opening balance."
        )

    cur.execute(
        "SELECT id FROM erp.process_master WHERE lower(process_id) = lower(%s) AND deleted_at IS NULL",
        (target,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError(f'Process "{target}" not found.')

    cur.execute(
        "UPDATE erp.process_master SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )
    # This is a soft delete (deleted_at, not a real DELETE), so the schema's
    # ON DELETE CASCADE never actually fires here -- Process Components and
    # Process Color Links rows stay physically present, made invisible via
    # their parent's deleted_at at read time instead (see
    # get_process_components_data's JOIN and get_process_color_links_data's
    # skip-if-other-side-missing check), same treatment po_lines/bill_lines
    # get from their own soft-deleted headers. Either way, a color link is
    # just a preference, not a real-quantity reference like Production/BOM,
    # so it's never blocked.
    return build_response(True, None, f'Process "{target}" deleted successfully.')


@rpc_method("deleteProcessesBulk", mutation=True)
@database.transactional
def delete_processes_bulk(conn, cur, process_ids):
    requested = [str(p or "").strip() for p in (process_ids or []) if str(p or "").strip()]
    if not requested:
        return build_response(True, None, "No processes selected.")

    in_use_lower = _get_process_ids_in_use(cur, requested)
    in_use = [p for p in requested if p.lower() in in_use_lower]
    deletable = [p for p in requested if p not in in_use]

    user_id = get_current_user_id()
    rows_deleted = 0
    if deletable:
        cur.execute(
            """
            UPDATE erp.process_master SET deleted_at = NOW(), updated_by = %s
            WHERE deleted_at IS NULL AND lower(process_id) = ANY(%s)
            """,
            (user_id, [p.lower() for p in deletable]),
        )
        rows_deleted = cur.rowcount

    message = f"Deleted {len(deletable)} process(es) ({rows_deleted} row(s) removed)."
    if in_use:
        message += (
            f" Skipped {len(in_use)} process(es) still in use by Production, a Product's BOM, "
            f"or a Warehouse Pool opening balance: {', '.join(in_use)}."
        )

    return build_response(True, {"skipped": in_use}, message)


@rpc_method("reorderProcesses", mutation=True)
@database.transactional
def reorder_processes(conn, cur, ordered_process_ids):
    order = [str(p or "").strip() for p in (ordered_process_ids or []) if str(p or "").strip()]
    if not order:
        raise ValueError("No process order provided.")

    cur.execute("SELECT COUNT(*) AS n FROM erp.process_master WHERE deleted_at IS NULL")
    if cur.fetchone()["n"] == 0:
        return build_response(True, None, "No processes to reorder.")

    user_id = get_current_user_id()
    for index, process_id in enumerate(order, start=1):
        cur.execute(
            "UPDATE erp.process_master SET sequence = %s, updated_by = %s WHERE lower(process_id) = lower(%s) AND deleted_at IS NULL",
            (index, user_id, process_id),
        )

    return build_response(True, None, f"Reordered {len(order)} process(es).")


# ─────────────────────────────────────────────────────────────────────────
# Process Components
# ─────────────────────────────────────────────────────────────────────────


def _fetch_process_components(cur, process_id="") -> list:
    """Component rows for one process (or every process when process_id is
    blank), on the CALLER'S cursor.

    Split out of get_process_components_data so callers already inside a
    transaction -- warehouse_service's Pass 1 via get_axis_order_by_process,
    dispatch_service's differentiator resolution -- can read components
    without opening a second pooled connection while holding one. Nesting
    connections that way both pressures the 2-10 connection pool and reads
    a snapshot that can't see the outer transaction's own uncommitted rows.
    """
    target = str(process_id or "").strip().lower()

    sql = """
        SELECT pm.process_id, pc.item_name, pc.size, pc.narration, pc.qty_per_unit, pc.remarks,
               pc.source_type, pc.color_group, pc.color_axis, pc.unit
        FROM erp.process_components pc
        JOIN erp.process_master pm ON pm.id = pc.master_id
        WHERE pm.deleted_at IS NULL
    """
    params: list = []
    if target:
        sql += " AND lower(pm.process_id) = %s"
        params.append(target)
    sql += " ORDER BY pc.id"

    cur.execute(sql, params)
    return [
        {
            "processId": row["process_id"],
            "itemName": row["item_name"],
            "size": row["size"] or "",
            "narration": row["narration"] or "",
            "qtyPerUnit": float(row["qty_per_unit"]),
            "remarks": row["remarks"] or "",
            "sourceType": row["source_type"],
            "colorGroup": row["color_group"] or _COLOR_GROUP_COMMON,
            "colorAxis": row["color_axis"] or "",
            # Blank = "already in the item's Base Unit".
            "unit": row["unit"] or "",
        }
        for row in cur.fetchall()
    ]


@rpc_method("getProcessComponentsData")
def get_process_components_data(process_id=""):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        return build_response(True, _fetch_process_components(cur, process_id))


# ─────────────────────────────────────────────────────────────────────────
# Item <-> Process mapping ("Used in Processes" panel on Item Master)
# ─────────────────────────────────────────────────────────────────────────
#
# The item-side view of the very same Process Components rows the
# Products & Processes tab edits -- there is deliberately no separate
# item->process mapping store: Process Components IS the mapping, this
# just indexes it by item instead of by process, so the two views can
# never drift.
#
# Two identity rules this must not get wrong:
#  1. SOURCE_TYPE 'POOL' rows are skipped entirely. A POOL row's item_name
#     is an upstream process's Output Item Name (a Warehouse Pool
#     identity), NOT an Items Master item.
#  2. COMMON vs color rows are reported separately. Only the COMMON row is
#     the process-wide recipe entry this view can edit; color sub-group
#     rows are per-color overrides shown read-only (editable only on the
#     process side, where the axis UI lives).


def _load_processes_for_item(cur, item_name: str, size: str) -> list:
    """Core of getProcessesForItem, taking an existing cursor so
    save_item_process_mappings can read back its own just-written rows
    within the SAME transaction (a fresh database.get_conn() call would
    open a separate connection that can't see uncommitted writes)."""
    target_name = str(item_name or "").strip().lower()
    target_size = str(size or "").strip().lower()

    processes = _get_all_processes(cur)

    cur.execute(
        """
        SELECT pm.process_id, pc.color_group, pc.color_axis, pc.qty_per_unit, pc.unit, pc.remarks
        FROM erp.process_components pc
        JOIN erp.process_master pm ON pm.id = pc.master_id
        WHERE pm.deleted_at IS NULL
          AND lower(pc.item_name) = %s AND lower(pc.size) = %s
          AND upper(pc.source_type) != 'POOL'
        """,
        (target_name, target_size),
    )
    rows = cur.fetchall()

    common_by_process: dict = {}
    colors_by_process: dict = {}
    for row in rows:
        pid = (row["process_id"] or "").strip().lower()
        if not pid:
            continue
        color_group = (row["color_group"] or "").strip() or _COLOR_GROUP_COMMON
        if color_group.lower() == _COLOR_GROUP_COMMON.lower():
            common_by_process[pid] = row
        else:
            colors_by_process.setdefault(pid, []).append(
                {
                    "colorGroup": color_group,
                    "colorAxis": row["color_axis"] or "",
                    "qtyPerUnit": float(row["qty_per_unit"]),
                    "unit": row["unit"] or "",
                }
            )

    records = []
    for proc in processes:
        pid = (proc["processId"] or "").strip().lower()
        common = common_by_process.get(pid)
        color_variants = sorted(colors_by_process.get(pid, []), key=lambda c: c["colorGroup"].lower())
        records.append(
            {
                "processId": proc["processId"],
                "processName": proc["processName"],
                "sequence": proc["sequence"],
                "active": proc["active"],
                "processType": proc["processType"],
                "inRecipe": common is not None,
                "qtyPerUnit": float(common["qty_per_unit"]) if common else None,
                "unit": (common["unit"] or "").strip() if common else "",
                "remarks": (common["remarks"] or "").strip() if common else "",
                "colorVariants": color_variants,
            }
        )

    records.sort(key=lambda r: (r["sequence"], r["processName"].lower()))
    return records


@rpc_method("getProcessesForItem")
def get_processes_for_item(item_name, size=""):
    target_name = str(item_name or "").strip()
    if not target_name:
        return build_response(False, None, "Item name is required.")

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        records = _load_processes_for_item(cur, target_name, size)
    return build_response(True, records)


def _get_process_id_keys_with_production_lots(cur, process_id_keys: set) -> set:
    """Lower-cased process IDs (from `process_id_keys`) that already have at
    least one Production lot logged against them. Used to warn -- not
    block -- when a mapping save removes an item from a process's recipe:
    past lots keep their own snapshotted Components Consumed, so the
    removal only ever changes FUTURE lots, but the operator should still be
    told the process is live."""
    if not process_id_keys:
        return set()
    cur.execute(
        "SELECT DISTINCT lower(process_id) AS pid FROM erp.production WHERE deleted_at IS NULL AND lower(process_id) = ANY(%s)",
        (list(process_id_keys),),
    )
    return {row["pid"] for row in cur.fetchall()}


@rpc_method("saveItemProcessMappings", mutation=True)
@database.transactional
def save_item_process_mappings(conn, cur, item_name, size="", mappings=None):
    """The write half of Item Master's "Used in Processes" section: adds,
    updates and removes ONE item's process-wide recipe entries across many
    processes in a single pass -- patches individual Process Components
    rows rather than reusing _save_process_components_for_process (which
    delete-and-rewrites a process's ENTIRE component list; driving that
    from the item side would destroy every other item's rows in each
    process it touched).

    Scope is strictly the COMMON, SOURCE_TYPE 'ITEM' row for this item+size
    in each process. Never reads or writes color sub-group rows or
    SOURCE_TYPE 'POOL' rows (see _load_processes_for_item's docstring).
    """
    clean_name = str(item_name or "").strip()
    if not clean_name:
        raise ValueError("Item name is required.")
    clean_size = str(size or "").strip()

    item_id = items_service._find_item(cur, clean_name, clean_size)
    if item_id is None:
        size_suffix = f' ({clean_size})' if clean_size else ""
        raise ValueError(f'"{clean_name}"{size_suffix} is not in the Items Master.')

    if isinstance(mappings, str):
        try:
            mapping_list = json.loads(mappings) if mappings else []
        except ValueError:
            raise ValueError("Invalid process mapping data format.")
    else:
        mapping_list = mappings or []
    if not isinstance(mapping_list, list) or not mapping_list:
        raise ValueError("No process changes were submitted.")

    # ── Validate EVERYTHING before writing anything ──────────────────
    # A half-applied bulk update across N processes is far worse than a
    # rejected one, so every mapping is checked up front.
    process_lookup = _process_lookup_by_id(cur)

    cleaned = []
    seen_keys = set()
    for m in mapping_list:
        m = m or {}
        pid = str(m.get("processId") or "").strip()
        pid_key = pid.lower()
        if not pid:
            raise ValueError("A submitted row is missing its Process ID.")

        proc = process_lookup.get(pid_key)
        if not proc:
            raise ValueError(f'Process "{pid}" no longer exists. Reopen the item and try again.')
        if pid_key in seen_keys:
            raise ValueError(f'Process "{proc["processName"]}" was submitted twice.')
        seen_keys.add(pid_key)

        in_recipe = bool(m.get("inRecipe"))
        qty_per_unit = 0.0
        if in_recipe:
            qty_per_unit = _validate_number(m.get("qtyPerUnit"), 0.0001, 1000000)
            if not qty_per_unit:
                raise ValueError(
                    f'Qty per Unit for "{proc["processName"]}" must be a number greater than 0 '
                    "(untick the process to remove the item)."
                )

        cleaned.append(
            {
                "processId": pid,
                "processIdKey": pid_key,
                "masterId": proc["id"],
                "processName": proc["processName"],
                "inRecipe": in_recipe,
                "qtyPerUnit": qty_per_unit,
                "unit": str(m.get("unit") or "").strip(),
                "remarks": str(m.get("remarks") or "").strip()[:500],
            }
        )

    # ── Index the existing rows for this item, across just the submitted
    # processes ──────────────────────────────────────────────────────
    master_ids = [c["masterId"] for c in cleaned]
    cur.execute(
        """
        SELECT id, master_id, source_type
        FROM erp.process_components
        WHERE lower(item_name) = %s AND lower(size) = %s
          AND upper(color_group) = %s
          AND master_id = ANY(%s)
        """,
        (clean_name.lower(), clean_size.lower(), _COLOR_GROUP_COMMON.upper(), master_ids),
    )
    existing_row_by_master_id: dict = {}
    pool_master_ids: set = set()
    for row in cur.fetchall():
        if (row["source_type"] or "").strip().upper() == "POOL":
            pool_master_ids.add(row["master_id"])
        else:
            existing_row_by_master_id[row["master_id"]] = row["id"]

    # Adding an ITEM row where a POOL row already holds the same
    # name+size+COMMON would produce a process the process-side editor can
    # no longer save: _find_duplicate_component keys on item+size+colorGroup
    # WITHOUT sourceType, so it would reject the pair as a duplicate.
    for m in cleaned:
        if m["inRecipe"] and m["masterId"] not in existing_row_by_master_id and m["masterId"] in pool_master_ids:
            raise ValueError(
                f'"{clean_name}" already exists in "{m["processName"]}" as a Warehouse Pool component. '
                "Add it from the Products & Processes tab instead, so the pool/item choice stays explicit."
            )

    # ── Apply ────────────────────────────────────────────────────────
    added = updated = removed = 0
    rows_to_delete = []
    removed_process_ids = []

    for m in cleaned:
        existing_id = existing_row_by_master_id.get(m["masterId"])
        if m["inRecipe"] and existing_id:
            cur.execute(
                "UPDATE erp.process_components SET qty_per_unit = %s, remarks = %s, unit = %s WHERE id = %s",
                (m["qtyPerUnit"], m["remarks"], m["unit"], existing_id),
            )
            updated += 1
        elif m["inRecipe"] and not existing_id:
            cur.execute(
                """
                INSERT INTO erp.process_components
                    (master_id, item_name, size, narration, qty_per_unit, remarks, source_type, color_group, color_axis, unit, item_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (m["masterId"], clean_name, clean_size, "", m["qtyPerUnit"], m["remarks"], "ITEM", _COLOR_GROUP_COMMON, "", m["unit"], item_id),
            )
            added += 1
        elif not m["inRecipe"] and existing_id:
            rows_to_delete.append(existing_id)
            removed_process_ids.append(m["processId"])
            removed += 1

    if rows_to_delete:
        cur.execute("DELETE FROM erp.process_components WHERE id = ANY(%s)", (rows_to_delete,))

    if added == 0 and updated == 0 and removed == 0:
        fresh = _load_processes_for_item(cur, clean_name, clean_size)
        return build_response(True, {"added": 0, "updated": 0, "removed": 0, "warnings": [], "processes": fresh}, "No changes to save.")

    # Removing an item from a process that has already produced lots is
    # allowed -- those lots keep their own snapshotted consumption -- but
    # the operator should know the recipe they just changed is live.
    warnings = []
    if removed_process_ids:
        live_keys = _get_process_id_keys_with_production_lots(cur, {pid.lower() for pid in removed_process_ids})
        live_names = [m["processName"] for m in cleaned if not m["inRecipe"] and m["processIdKey"] in live_keys and m["processId"] in removed_process_ids]
        if live_names:
            warnings.append(
                f"Removed from {', '.join(live_names)}, which already "
                f"{'has' if len(live_names) == 1 else 'have'} production lots. "
                "Existing lots keep the components they recorded; only new lots change."
            )

    parts = []
    if added:
        parts.append(f"{added} added")
    if updated:
        parts.append(f"{updated} updated")
    if removed:
        parts.append(f"{removed} removed")
    message = f"Process recipes updated ({', '.join(parts)})."

    fresh = _load_processes_for_item(cur, clean_name, clean_size)
    return build_response(
        True,
        {"added": added, "updated": updated, "removed": removed, "warnings": warnings, "processes": fresh},
        message,
    )


# ─────────────────────────────────────────────────────────────────────────
# Process Color Links
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getProcessColorLinksData")
def get_process_color_links_data(process_id):
    target = str(process_id or "").strip()
    if not target:
        return build_response(True, [])

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute("SELECT id, process_id, process_name FROM erp.process_master WHERE deleted_at IS NULL")
        by_db_id = {row["id"]: row for row in cur.fetchall()}
        target_id = next((db_id for db_id, row in by_db_id.items() if (row["process_id"] or "").lower() == target.lower()), None)

        records = []
        if target_id is not None:
            cur.execute(
                """
                SELECT process_a_id, color_a, process_b_id, color_b, axis_a_key, axis_b_key
                FROM erp.process_color_links WHERE process_a_id = %s OR process_b_id = %s
                """,
                (target_id, target_id),
            )
            for link in cur.fetchall():
                # process_color_links has no deleted_at of its own (a
                # preference row with no independent lifecycle, same as
                # process_components) and ON DELETE CASCADE only fires on a
                # hard delete -- delete_process only soft-deletes
                # process_master, so a link whose other side is gone is
                # skipped here rather than relying on the FK to have
                # removed it already (same "invisible via the parent's
                # deleted_at" treatment po_lines/bill_lines get).
                if link["process_a_id"] == target_id:
                    other = by_db_id.get(link["process_b_id"])
                    if other is None:
                        continue
                    records.append(
                        {
                            "otherProcessId": other["process_id"],
                            "otherProcessName": other["process_name"],
                            "myColor": link["color_a"],
                            "theirColor": link["color_b"],
                            "myAxisKey": link["axis_a_key"] or "",
                            "theirAxisKey": link["axis_b_key"] or "",
                        }
                    )
                else:
                    other = by_db_id.get(link["process_a_id"])
                    if other is None:
                        continue
                    records.append(
                        {
                            "otherProcessId": other["process_id"],
                            "otherProcessName": other["process_name"],
                            "myColor": link["color_b"],
                            "theirColor": link["color_a"],
                            "myAxisKey": link["axis_b_key"] or "",
                            "theirAxisKey": link["axis_a_key"] or "",
                        }
                    )

    return build_response(True, records)


# ─────────────────────────────────────────────────────────────────────────
# Process Color Axis computation (Phase 3f)
# ─────────────────────────────────────────────────────────────────────────

_COLOR_COMBO_DELIMITER = config_maps.COLOR_COMBO_DELIMITER


def _add_unique_case_insensitive(ordered_map: dict, value) -> None:
    """Adds `value` into `ordered_map` (used as a case-insensitive,
    insertion-ordered set: key=lower, value=first-seen original casing).
    Two names differing only in casing (typed on different rows/lots)
    must collapse to one entry -- a plain set of raw strings would treat
    them as two, producing duplicate/phantom color checkboxes. Read back
    via ordered_map.values().
    """
    raw = str(value if value is not None else "").strip()
    if not raw:
        return
    key = raw.lower()
    if key not in ordered_map:
        ordered_map[key] = raw


def _is_common_color_group(color_group) -> bool:
    """True when a Process Component row's Color Sub-Group is the COMMON
    sentinel ("applies to every color") rather than a real color name.
    Ports utils.js#isCommonColorGroup (GAS e37529e).

    COMMON is written by the app itself, but the column is a plain,
    user-editable field -- "Common"/"common" must not be mistaken for a
    color sub-group literally named "Common", which would invent a phantom
    color axis and pull that row out of every lot's Common Components
    table. Case-insensitive for exactly this reason; a bare `== _COLOR_
    GROUP_COMMON` (the pre-fix comparison) only matched the one spelling
    the app itself writes.
    """
    return str(color_group if color_group is not None else "").strip().upper() == _COLOR_GROUP_COMMON


def _pool_item_is_color_axis(item_colors) -> bool:
    """Does this POOL-sourced recipe item contribute a color axis? Ports
    module_process.js#_poolItemIsColorAxis (GAS 1288076).

    Normally only when it has 2+ live pool colors: an item that exists in
    exactly one color (e.g. a Fitted Rim that is always Black) is a fixed
    input, not a per-output-color choice, and must not leak into the
    output checklist.

    The exception is a single color that is ITSELF a composite (contains
    COLOR_COMBO_DELIMITER). That color is the accumulated identity of
    every upstream process in the chain, so excluding it does not drop a
    non-choice -- it truncates the chain, silently discarding everything
    earlier stages recorded. A process layer added on top of an upstream
    stage that has so far produced only ONE combination would otherwise
    credit its output under just its own axis's color, losing the
    "/"-joined history the operator expects to keep seeing.
    """
    if not item_colors:
        return False
    if len(item_colors) > 1:
        return True
    (only,) = item_colors.values()
    return _COLOR_COMBO_DELIMITER in str(only or "")


def _get_all_process_color_links(cur) -> list:
    """Every Process Color Link, both sides resolved to their business
    process_id strings (not the internal serial FK) -- the shape
    _merge_linked_axes/_resolve_linked_color's graph algorithm is built
    on, matching every Warehouse Pool row's own processId field. Distinct
    from get_process_color_links_data (the public, per-process-normalized
    RPC view) -- this returns the raw {processAId, colorA, processBId,
    colorB, axisAKey, axisBKey} shape the source's own
    _getAllProcessColorLinks() does.
    """
    cur.execute(
        """
        SELECT pa.process_id AS process_a_id, l.color_a, pb.process_id AS process_b_id, l.color_b,
               l.axis_a_key, l.axis_b_key
        FROM erp.process_color_links l
        JOIN erp.process_master pa ON pa.id = l.process_a_id
        JOIN erp.process_master pb ON pb.id = l.process_b_id
        WHERE pa.deleted_at IS NULL AND pb.deleted_at IS NULL
        """
    )
    return [
        {
            "processAId": row["process_a_id"],
            "colorA": row["color_a"],
            "processBId": row["process_b_id"],
            "colorB": row["color_b"],
            "axisAKey": row["axis_a_key"] or "",
            "axisBKey": row["axis_b_key"] or "",
        }
        for row in cur.fetchall()
    ]


def _get_all_warehouse_pool_rows_for_color_axes(cur) -> list:
    """Minimal projection of erp.warehouse_pool for color-axis computation
    -- a local query instead of importing warehouse_service here, which
    itself imports process_service (for _get_all_processes reuse); avoids
    a circular import, matching this codebase's established "small local
    duplication over cross-import" precedent.
    """
    cur.execute("SELECT output_item_name, process_id, color FROM erp.warehouse_pool")
    return [
        {
            "outputItemName": row["output_item_name"] or "",
            "processId": row["process_id"] or "",
            "color": row["color"] or "",
        }
        for row in cur.fetchall()
    ]


def _axis_link_ref(process_id: str, axis_key: str = "") -> str:
    """Stable node identity for one axis-linking endpoint: an axis
    contributed by exactly one process, optionally disambiguated by an
    axis key. A blank axis_key reduces to the bare process_id -- the
    ORIGINAL Process Color Links identity, before axis_a_key/axis_b_key
    existed -- so every link saved before same-process/tag-axis pairing
    existed (blank axis key on both sides) keeps resolving byte-for-byte
    as before. A non-blank axis_key (e.g. "tag:mudguard color") scopes the
    identity to one specific axis, which is what makes a SAME process_id
    meaningful on both sides of a link (pairing two of one process's own
    axes) instead of colliding with itself. Returns "" when process_id is
    blank (never matches anything).

    Both halves lowercased: this ref is matched between a Process Color
    Links row and a pool/tag axis derived from a different query, so a
    casing difference in either stored Process ID would silently drop the
    link (the axes then cross-multiply instead of pairing) -- same fix as
    GAS e37529e, which lowercased only the axis key before this, not the
    Process ID.
    """
    pid = str(process_id or "").strip().lower()
    if not pid:
        return ""
    key = str(axis_key or "").strip().lower()
    return f"{pid}::{key}" if key else pid


def _resolve_linked_color(from_ref: str, from_color: str, to_ref: str, adjacency: dict):
    """Resolves the color on `to_ref` corresponding to `from_color` on
    `from_ref` (both axis references -- see _axis_link_ref), composing
    multiple Process Color Link edges when the two axes aren't directly
    linked but are connected through an intermediate one (e.g. B-D-A).
    Returns None if no chain of explicit mappings connects them for this
    specific color value.
    """
    visited = {from_ref}
    queue = [(from_ref, from_color)]
    while queue:
        ref, color = queue.pop(0)
        if ref == to_ref:
            return color
        for edge in adjacency.get(ref, []):
            other = edge["otherAxisRef"]
            if other in visited:
                continue
            next_color = edge["map"].get(str(color or "").strip().lower())
            if next_color is None:
                continue
            visited.add(other)
            queue.append((other, next_color))
    return None


def _merge_linked_axes(axes: list, color_links: list) -> list:
    """Merges axes belonging to explicitly-linked axis references (see
    Process Color Links and _axis_link_ref) into single paired axes
    instead of leaving them to be cross-multiplied. Only axes contributed
    by exactly one process are link-eligible (an axis already collapsed
    from 2+ processes by identical-signature matching has no single
    process to key the graph on, and is left untouched). Chained links
    (B-D, D-A) group 3+ axes transitively via BFS with no dedicated N-way
    data structure. Works identically whether the linked axes come from
    different processes (the original cross-process pool-axis case) or
    the very same process (same-process axis pairing, e.g. a tag-based
    Rim Color <-> Mudguard Color) -- _axis_link_ref is the only thing
    either case is keyed on.
    """
    adjacency: dict = {}

    def add_edge(ref_from, color_from, ref_to, color_to) -> None:
        if not ref_from or not ref_to:
            return
        entries = adjacency.setdefault(ref_from, [])
        entry = next((e for e in entries if e["otherAxisRef"] == ref_to), None)
        if entry is None:
            entry = {"otherAxisRef": ref_to, "map": {}}
            entries.append(entry)
        entry["map"][str(color_from or "").strip().lower()] = color_to

    for link in color_links:
        ref_a = _axis_link_ref(link["processAId"], link.get("axisAKey"))
        ref_b = _axis_link_ref(link["processBId"], link.get("axisBKey"))
        add_edge(ref_a, link["colorA"], ref_b, link["colorB"])
        add_edge(ref_b, link["colorB"], ref_a, link["colorA"])

    # Only axes contributed by exactly one process can be placed on the graph.
    axis_index_by_ref: dict = {}
    for idx, axis in enumerate(axes):
        if len(axis["processIds"]) == 1:
            ref = _axis_link_ref(next(iter(axis["processIds"])), axis.get("axisKey"))
            if ref:
                axis_index_by_ref[ref] = idx

    visited: set = set()
    merged_axes = []
    used_axis_idx: set = set()

    for ref in list(axis_index_by_ref.keys()):
        if ref in visited:
            continue

        queue = [ref]
        visited.add(ref)
        component_refs = [ref]
        while queue:
            cur_ref = queue.pop(0)
            for edge in adjacency.get(cur_ref, []):
                other = edge["otherAxisRef"]
                if other in axis_index_by_ref and other not in visited:
                    visited.add(other)
                    queue.append(other)
                    component_refs.append(other)

        if len(component_refs) <= 1:
            continue  # no link partner present in this recipe -- leave axis as-is

        anchor_ref = component_refs[0]
        for r in component_refs:
            if len(axes[axis_index_by_ref[r]]["colors"]) > len(axes[axis_index_by_ref[anchor_ref]]["colors"]):
                anchor_ref = r
        other_refs = [r for r in component_refs if r != anchor_ref]

        merged_colors = []
        for anchor_color in axes[axis_index_by_ref[anchor_ref]]["colors"]:
            parts = [anchor_color]
            unresolved = False
            for other_ref in other_refs:
                resolved = _resolve_linked_color(anchor_ref, anchor_color, other_ref, adjacency)
                if resolved is None:
                    unresolved = True
                    break
                parts.append(resolved)
            if unresolved:
                continue
            merged_colors.append(_COLOR_COMBO_DELIMITER.join(parts))

        # A descriptive label for the merge, built from whichever
        # constituent axes carry one of their own (every tag axis does; a
        # plain pool axis gets one too now via its own itemNames join).
        label_parts = [axes[axis_index_by_ref[r]].get("label") for r in component_refs if axes[axis_index_by_ref[r]].get("label")]

        if merged_colors:
            # A merged axis inherits the earliest recipe position of the
            # axes it absorbed (see _compute_color_axes_for_process), so
            # pairing two axes never moves the pair somewhere else in the
            # composite color string. `.get(...)` rather than [...]:
            # _legacy_color_group_list's own axes-by-signature entries carry
            # no "recipeIndex" at all (that list has no ordering concept),
            # so this stays a no-op (falls through to the math.inf default,
            # which nothing downstream of that caller ever reads).
            merged_recipe_index = math.inf
            for r in component_refs:
                idx = axes[axis_index_by_ref[r]].get("recipeIndex")
                if isinstance(idx, (int, float)) and idx < merged_recipe_index:
                    merged_recipe_index = idx
            merged_axes.append(
                {
                    "colors": merged_colors,
                    "label": ", ".join(label_parts) if label_parts else None,
                    "recipeIndex": merged_recipe_index,
                    "source": "merged",
                    "processIds": set(),
                }
            )
        for r in component_refs:
            used_axis_idx.add(axis_index_by_ref[r])

    result = [axis for idx, axis in enumerate(axes) if idx not in used_axis_idx]
    return result + merged_axes


def _legacy_color_group_list(components: list, pool_rows: list, color_links: list) -> list:
    """The original, byte-for-byte unmodified pre-Color-Axes algorithm --
    pool axes ARE cross-multiplied into composite delimiter-joined
    strings when 2+ exist (unlike _compute_color_axes_for_process, which
    keeps them independent), since the legacy UI never split them into
    separate checklist groups.
    """
    colors: dict = {}
    for c in components:
        if c["colorGroup"] and not _is_common_color_group(c["colorGroup"]):
            _add_unique_case_insensitive(colors, c["colorGroup"])

    ordered_pool_keys = []
    for c in components:
        if c.get("sourceType") == "POOL":
            k = str(c.get("itemName") or "").strip().lower()
            if k and k not in ordered_pool_keys:
                ordered_pool_keys.append(k)

    if ordered_pool_keys:
        pool_item_names = set(ordered_pool_keys)
        colors_by_item: dict = {k: {} for k in ordered_pool_keys}
        process_id_by_item: dict = {}
        for r in pool_rows:
            key = str(r.get("outputItemName") or "").strip().lower()
            if not r.get("color") or key not in pool_item_names:
                continue
            colors_by_item.setdefault(key, {})
            _add_unique_case_insensitive(colors_by_item[key], r["color"])
            if key not in process_id_by_item and r.get("processId"):
                process_id_by_item[key] = r.get("processId")

        axes_by_signature: dict = {}
        for item_key in ordered_pool_keys:
            item_colors = colors_by_item.get(item_key)
            if not _pool_item_is_color_axis(item_colors):
                continue
            sorted_colors = sorted(item_colors.values(), key=lambda x: x.lower())
            signature = "|".join(c.lower() for c in sorted_colors)
            entry = axes_by_signature.setdefault(signature, {"colors": sorted_colors, "processIds": set()})
            pid = process_id_by_item.get(item_key)
            if pid:
                entry["processIds"].add(pid)

        axes = list(axes_by_signature.values())
        if len(axes) > 1 and color_links:
            axes = _merge_linked_axes(axes, color_links)

        if len(axes) == 1:
            for color in axes[0]["colors"]:
                _add_unique_case_insensitive(colors, color)
        elif len(axes) > 1:
            combos = [""]
            for axis in axes:
                next_combos = []
                for prefix in combos:
                    for color in axis["colors"]:
                        next_combos.append(f"{prefix}{_COLOR_COMBO_DELIMITER}{color}" if prefix else color)
                combos = next_combos
            for combo in combos:
                _add_unique_case_insensitive(colors, combo)

    return sorted(colors.values(), key=lambda x: x.lower())


def _compute_color_axes_for_process(process_id: str, components: list, pool_rows: list, color_links: list) -> list:
    """The independent "Color Axes" breakdown for a process -- one entry
    per contributing axis, NEVER cross-multiplied into composite strings.
    Two independent sources feed this: Warehouse Pool axes (auto-detected
    from live pool color history of this recipe's POOL-sourced
    components, labeled by the pool item name(s) driving them) and
    explicitly-tagged axes (a recipe row carrying both a colorGroup AND a
    colorAxis label -- rows with a colorGroup but no colorAxis label are
    left out of this breakdown entirely, only the legacy flat list sees
    them).

    Both sources are merged through ONE _merge_linked_axes pass -- a
    Process Color Link can pair two pool axes (from different upstream
    processes, the original use case), a pool axis with one of THIS
    process's own tag axes, or two of this process's own tag axes with
    each other (same process_id, different axis keys -- see
    _axis_link_ref). With no link touching a given axis, this is a no-op
    and that axis passes through unchanged.

    `process_id` is this process's own ID -- every tag axis belongs to it
    directly (there is no separate "producing process" the way a pool
    axis has one), so it's needed to make a tag axis link-eligible at all.

    Every returned axis's position in the list is THIS process's own
    recipe row order -- the primary axis included, pool and tag axes
    interleaved by whichever recipe row introduced them first. Ports
    module_process.js's 1288076 recipe-order fix: a recipe listing Fitted
    Rim above Painted Frame lists the Rim axis first, and reordering the
    recipe reorders this list, which is what makes
    warehouse_service._compose_lot_color_key's composite segment order
    repeatable rather than dependent on Warehouse Pool row order (itself
    rebuilt on every recalculation -- two lots of the same product could
    otherwise be credited "Blue-White / Black / Grey" and "Blue-White /
    Grey / Black" and have their stock split).
    """
    raw_axes = []

    # Where each axis first appears in THIS process's own recipe. A POOL
    # row's position is also the association with the upstream process
    # that produces it, so recipe row order is exactly "this process's
    # inputs, in the sequence the operator arranged them" -- the same
    # order the Production checklist renders. Ties (an axis with no
    # resolvable recipe row) fall back to the label, so the result is
    # always fully determined rather than input-order dependent.
    recipe_index_by_pool_item: dict = {}
    recipe_index_by_tag_axis: dict = {}
    for idx, c in enumerate(components):
        if c.get("sourceType") == "POOL":
            key = str(c.get("itemName") or "").strip().lower()
            if key and key not in recipe_index_by_pool_item:
                recipe_index_by_pool_item[key] = idx
        axis_label_lower = str(c.get("colorAxis") or "").strip().lower()
        if (
            axis_label_lower
            and c.get("colorGroup")
            and not _is_common_color_group(c["colorGroup"])
            and axis_label_lower not in recipe_index_by_tag_axis
        ):
            recipe_index_by_tag_axis[axis_label_lower] = idx
    max_recipe_index = len(components) + 1

    ordered_pool_keys = list(recipe_index_by_pool_item.keys())

    if ordered_pool_keys:
        pool_item_names = set(ordered_pool_keys)
        colors_by_item: dict = {k: {} for k in ordered_pool_keys}
        process_id_by_item: dict = {}
        item_name_by_key: dict = {}
        for c in components:
            if c.get("sourceType") != "POOL":
                continue
            key = str(c.get("itemName") or "").strip().lower()
            if key and key not in item_name_by_key:
                item_name_by_key[key] = c.get("itemName")

        for r in pool_rows:
            key = str(r.get("outputItemName") or "").strip().lower()
            if not r.get("color") or key not in pool_item_names:
                continue
            colors_by_item.setdefault(key, {})
            _add_unique_case_insensitive(colors_by_item[key], r["color"])
            if key not in process_id_by_item and r.get("processId"):
                process_id_by_item[key] = r.get("processId")

        axes_by_signature: dict = {}
        for item_key in ordered_pool_keys:
            item_colors = colors_by_item.get(item_key)
            if not _pool_item_is_color_axis(item_colors):
                continue
            sorted_colors = sorted(item_colors.values(), key=lambda x: x.lower())
            signature = "|".join(c.lower() for c in sorted_colors)
            entry = axes_by_signature.setdefault(
                signature, {"colors": sorted_colors, "processIds": set(), "itemNames": set(), "itemKeys": set()}
            )
            entry["itemKeys"].add(item_key)
            pid = process_id_by_item.get(item_key)
            if pid:
                entry["processIds"].add(pid)
            item_name = item_name_by_key.get(item_key)
            if item_name:
                entry["itemNames"].add(item_name)

        for axis in axes_by_signature.values():
            # label mirrors the exact text a single, unmerged pool axis
            # would get -- set here, before merge, both so a merged axis
            # can inherit a real label from it instead of a generic
            # ordinal fallback, and so a merged pool axis can still be
            # resolved by its constituent item names.
            item_names = sorted(axis["itemNames"], key=lambda x: x.lower())
            # An axis fed by several recipe rows takes the EARLIEST of
            # them, so it sits where the operator first introduced it.
            recipe_index = min(
                (recipe_index_by_pool_item.get(k, max_recipe_index) for k in axis["itemKeys"]),
                default=max_recipe_index,
            )
            raw_axes.append(
                {
                    "colors": axis["colors"],
                    "processIds": axis["processIds"],
                    "label": ", ".join(item_names) if item_names else None,
                    "recipeIndex": recipe_index,
                    "source": "pool",
                }
            )

    # Keyed by the axis label's lowercase form so "Mudguard Color" and
    # "mudguard color" (typed on different recipe rows) collapse into one
    # real axis instead of two. Each tag axis belongs to THIS process
    # directly and carries its own axis key ("tag:" + label) up front --
    # unlike a pool axis, there's no separate "producing process" to
    # derive an identity from, so without process_id a tag axis could
    # never be link-eligible at all.
    raw_tag_groups: dict = {}
    for c in components:
        if not c["colorGroup"] or _is_common_color_group(c["colorGroup"]):
            continue
        axis_label = str(c.get("colorAxis") or "").strip()
        if not axis_label:
            continue
        axis_key = axis_label.lower()
        group = raw_tag_groups.setdefault(axis_key, {"label": axis_label, "colors": {}})
        _add_unique_case_insensitive(group["colors"], c["colorGroup"])

    for axis_key, group in raw_tag_groups.items():
        label_lower = group["label"].lower()
        raw_axes.append(
            {
                "colors": sorted(group["colors"].values(), key=lambda x: x.lower()),
                "processIds": {process_id} if process_id else set(),
                "axisKey": f"tag:{label_lower}",
                "label": group["label"],
                "recipeIndex": recipe_index_by_tag_axis.get(label_lower, max_recipe_index),
                "source": "tag",
            }
        )

    # One merge pass covers every combination: pool<->pool (the original
    # cross-process case), pool<->tag, and tag<->tag (same process,
    # different axis key) -- an axis with no link touching it passes
    # through completely unchanged.
    merged_axes = _merge_linked_axes(raw_axes, color_links) if len(raw_axes) > 1 and color_links else raw_axes

    # Recipe order is the app's ONE canonical axis order: it drives the
    # checklist the operator sees and the composite color key the lot is
    # credited under (see warehouse_service._compose_lot_color_key /
    # get_axis_order_by_process below), so those two can never disagree.
    ordered_axes = sorted(
        merged_axes,
        key=lambda a: (
            a.get("recipeIndex") if isinstance(a.get("recipeIndex"), (int, float)) else max_recipe_index,
            str(a.get("label") or "").lower(),
        ),
    )

    result = []
    pool_axis_counter = 0
    for axis in ordered_axes:
        if axis.get("source") == "tag":
            result.append({"key": f"tag:{axis['label'].lower()}", "label": axis["label"], "colors": axis["colors"], "source": "tag"})
            continue
        pool_axis_counter += 1
        label = axis.get("label") or f"Color Group {pool_axis_counter}"
        key_prefix = "merged:" if axis.get("source") == "merged" else "pool:"
        result.append({"key": f"{key_prefix}{label.lower()}", "label": label, "colors": axis["colors"], "source": axis.get("source", "pool")})

    return result


def _compute_color_groups_for_process(process_id: str, components: list, pool_rows: list, color_links: list) -> list:
    """A process with 2+ independent color axes still gets the exact
    original _legacy_color_group_list behavior when fewer than 2 axes
    resolve -- colors explicitly tagged on recipe rows plus any single
    pool axis's own colors, unchanged.
    """
    axes = _compute_color_axes_for_process(process_id, components, pool_rows, color_links)
    if len(axes) < 2:
        return _legacy_color_group_list(components, pool_rows, color_links)

    colors: set = set()
    for axis in axes:
        colors.update(axis["colors"])
    return sorted(colors, key=lambda x: x.lower())


def _get_color_master_names(cur) -> list:
    """Every Color Master name, for widening a color-enabled process's
    checklist (see _compute_color_groups_with_overrides_for_process)
    beyond whatever this specific recipe/pool history has actually
    touched. A local query instead of importing tags_service here (which
    itself imports warehouse_service, which imports this module) --
    avoids a circular import, matching this codebase's established
    "small local duplication over cross-import" precedent (see
    _get_all_warehouse_pool_rows_for_color_axes).
    """
    cur.execute("SELECT name FROM erp.color_master WHERE deleted_at IS NULL")
    return [row["name"] for row in cur.fetchall() if row["name"]]


def _compute_color_groups_with_overrides_for_process(
    process_id: str, components: list, pool_rows: list, color_links: list, color_master_names: list = None, overrides: dict = None
) -> list:
    """The validation-time "available color groups" for a process --
    baseColors (_compute_color_groups_for_process) widened to the full
    Color Master once this process is ALREADY color-enabled via its own
    recipe/pool detection, plus INCLUDE overrides, minus EXCLUDE
    overrides. Used by save_production to check a submitted color against
    "is this valid to type/pick", NOT by the checklist-display endpoints
    (see _compute_known_colors_for_process for that, a differently-scoped
    definition using logged colors instead of the whole Color Master).

    An INCLUDE override can turn on color mode for an otherwise-plain
    process (baseColors empty) -- a deliberate escape hatch for "Add
    Combination" to pre-seed a color no recipe/pool/Color Master signal
    would ever produce on its own. EXCLUDE always wins, applied last,
    after the Color Master union.
    """
    base_colors = _compute_color_groups_for_process(process_id, components, pool_rows, color_links)
    included_overrides = list((overrides or {}).get("included", {}).values())
    if not base_colors and not included_overrides:
        return base_colors

    colors: dict = {}
    for c in base_colors:
        _add_unique_case_insensitive(colors, c)
    # Widen to the full Color Master ONLY once this process is ALREADY
    # color-enabled -- "there's a color to show" and "this process is
    # color-enabled" are different questions, and only the second one
    # gates widening.
    if base_colors:
        for c in color_master_names if color_master_names is not None else []:
            _add_unique_case_insensitive(colors, c)
    for c in included_overrides:
        _add_unique_case_insensitive(colors, c)

    excluded = (overrides or {}).get("excluded") or set()
    if excluded:
        for key in list(colors.keys()):
            if key in excluded:
                del colors[key]

    return sorted(colors.values(), key=lambda x: x.lower())


def _get_production_logged_colors_by_process(cur) -> dict:
    """processIdLower -> set of colors this process's own Production
    history has actually logged. Every logged status counts (not just
    Completed) -- even a Pending/Cancelled lot's color choice is real
    evidence the combination is practically relevant, though only a
    Completed lot's colors ever get real Warehouse Pool bucket history,
    which is what ultimately protects a color from removal regardless of
    this list. Distinct from pool-detected colors (see
    _compute_color_axes_for_process), which reflects colors of UPSTREAM
    items this recipe CONSUMES -- this is about colors THIS process's own
    output has actually been logged under.
    """
    result: dict = {}
    table = config_maps.TABLE_NAMES.get("PRODUCTION")
    if not table:
        return result
    cur.execute(f"SELECT process_id, color, color_breakdown FROM {table} WHERE deleted_at IS NULL")
    for row in cur.fetchall():
        process_id = str(row["process_id"] or "").strip()
        if not process_id:
            continue
        colors = result.setdefault(process_id.lower(), set())
        breakdown = row["color_breakdown"] or []
        if breakdown:
            for entry in breakdown:
                c = str((entry or {}).get("color") or "").strip()
                if c:
                    colors.add(c)
        else:
            # Comma-joined display string (see save_production's `color =
            # ", ".join(...)`) -- split back into individual color names,
            # stripping any "(Size)" qualifier suffix it may carry.
            color_cell = str(row["color"] or "").strip()
            if color_cell:
                for part in color_cell.split(","):
                    c = re.sub(r"\s*\([^)]*\)\s*$", "", part).strip()
                    if c:
                        colors.add(c)
    return result


def _get_all_process_color_overrides(cur) -> dict:
    """Every Process Color Overrides row, grouped by process -- read once
    and shared across a single computation (see get_all_process_color_groups)
    rather than re-reading the table per process, same discipline as
    color_links/pool_rows.
    Returns processIdLower -> {"included": {colorLower: color}, "excluded": {colorLower}}.
    """
    cur.execute("SELECT process_id, color, action FROM erp.process_color_overrides")
    result: dict = {}
    for row in cur.fetchall():
        process_id = str(row["process_id"] or "").strip()
        color = str(row["color"] or "").strip()
        action = str(row["action"] or "").strip().upper()
        if not process_id or not color:
            continue
        entry = result.setdefault(process_id.lower(), {"included": {}, "excluded": set()})
        color_lower = color.lower()
        if action == "EXCLUDE":
            entry["excluded"].add(color_lower)
            entry["included"].pop(color_lower, None)
        else:
            entry["included"][color_lower] = color
            entry["excluded"].discard(color_lower)
    return result


def _compute_known_colors_for_process(
    process_id: str, components: list, pool_rows: list, color_links: list, logged_colors: list, overrides: dict = None
) -> dict:
    """Shared core of get_process_color_groups (singular) and
    get_all_process_color_groups (bulk) -- the one definition of "known
    colors" for a process, deliberately scoped to THAT process only,
    never the global Color Master list: recipe-tagged + pool-detected
    colors (baseColors) UNION colors this process's own Production
    history has actually logged UNION INCLUDE overrides, MINUS EXCLUDE
    overrides. This is what stops a color from "reflecting" across two
    unrelated processes just because it exists somewhere in Color Master.
    Returns {"colors": [...], "baseColors": [...]} -- baseColors is
    exposed so callers can derive their own "removable" (NOT in
    baseColors) set.
    """
    base_colors = _compute_color_groups_for_process(process_id, components, pool_rows, color_links)

    color_map: dict = {}
    for c in base_colors:
        _add_unique_case_insensitive(color_map, c)
    for c in logged_colors or []:
        _add_unique_case_insensitive(color_map, c)
    if overrides and overrides.get("included"):
        for c in overrides["included"].values():
            _add_unique_case_insensitive(color_map, c)
    excluded = (overrides or {}).get("excluded") or set()
    if excluded:
        for key in list(color_map.keys()):
            if key in excluded:
                del color_map[key]

    return {"colors": sorted(color_map.values(), key=lambda x: x.lower()), "baseColors": base_colors}


def _default_primary_color_axis_label(process_id: str, components: list, pool_rows: list, color_links: list) -> str:
    """The Primary Color Axis a process uses when its own cell is still
    blank: the FIRST axis in that process's canonical recipe order (see
    _compute_color_axes_for_process). Every process that has at least one
    detectable Color Axis gets one. Ports module_process.js#
    _defaultPrimaryColorAxisLabel.

    A blank cell used to mean "legacy: sum every checked color across
    every axis", which double-counts a multi-axis lot's non-primary rows
    (the exact bug the Color Axes feature exists to fix) unless the
    operator noticed the warning and picked a group by hand. Defaulting
    instead of leaving it blank makes the safe behavior the automatic one;
    the operator can still override it, per lot on the Production form or
    permanently in the Process editor.

    Recipe order is the same order the operator sees the axis groups in on
    the checklist, so the default is always the topmost group rather than
    an arbitrary one.

    A process with NO axes at all -- no colorAxis-tagged recipe rows and
    no multi-color POOL input -- has nothing for "primary" to mean, so this
    returns "" and that process keeps its unchanged single-list behavior.
    """
    if not components:
        return ""
    axes = _compute_color_axes_for_process(process_id or "", components, pool_rows, color_links)
    return str(axes[0].get("label") or "").strip() if axes else ""


def refresh_process_primary_color_axes(cur) -> dict:
    """Fills the Primary Color Axis cell of every process that still has a
    blank one but does have at least one detectable Color Axis (see
    _default_primary_color_axis_label). save_process/save_production
    already resolve the same default on the fly, so this changes no
    behavior -- it just writes the resolved value in one pass, so the
    column reads as filled-in for processes nobody has re-saved or logged
    a lot against yet. Ports module_process.js#
    backfillProcessPrimaryColorAxes.

    Not RPC-exposed -- matches source's own scope (no UI button; run from
    the Apps Script editor there, this port's equivalent being a one-off
    call from a Flask shell/migration).

    Safe to re-run: a process that already has a value is never touched,
    and one with no axes is skipped rather than blanked.

    Returns {"filled": int, "skipped": int, "details": list[str]}.
    """
    all_processes = _get_all_processes(cur)
    if not all_processes:
        return {"filled": 0, "skipped": 0, "details": []}

    # Read the shared inputs ONCE for every process rather than letting each
    # process's _default_primary_color_axis_label call re-read the
    # Warehouse Pool and the Color Links.
    pool_rows = _get_all_warehouse_pool_rows_for_color_axes(cur)
    color_links = _get_all_process_color_links(cur)
    components_by_process: dict = {}
    for component in _fetch_process_components(cur):
        pid = str(component.get("processId") or "").strip().lower()
        if pid:
            components_by_process.setdefault(pid, []).append(component)

    filled = 0
    skipped = 0
    details = []
    for p in all_processes:
        if str(p.get("primaryColorAxis") or "").strip():
            skipped += 1
            continue

        label = _default_primary_color_axis_label(
            p["processId"], components_by_process.get(p["processId"].strip().lower(), []), pool_rows, color_links
        )
        if not label:
            skipped += 1
            continue

        _set_process_primary_color_axis(cur, p["processId"], label)
        filled += 1
        details.append(f'{p["processId"]} ({p["processName"]}) -> "{label}"')

    return {"filled": filled, "skipped": skipped, "details": details}


@rpc_method("getProcessColorGroups")
def get_process_color_groups(process_id):
    components = get_process_components_data(process_id)["data"]
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        pool_rows = _get_all_warehouse_pool_rows_for_color_axes(cur)
        color_links = _get_all_process_color_links(cur)
        overrides = _get_all_process_color_overrides(cur).get(str(process_id or "").strip().lower())
        logged_colors = list(_get_production_logged_colors_by_process(cur).get(str(process_id or "").strip().lower(), []))
    known = _compute_known_colors_for_process(process_id, components, pool_rows, color_links, logged_colors, overrides)
    return build_response(True, known["colors"])


@rpc_method("getProcessColorAxes")
def get_process_color_axes(process_id):
    components = get_process_components_data(process_id)["data"]
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        pool_rows = _get_all_warehouse_pool_rows_for_color_axes(cur)
        color_links = _get_all_process_color_links(cur)
        process = next(
            (p for p in _get_all_processes(cur) if p["processId"].strip().lower() == str(process_id or "").strip().lower()),
            None,
        )

    saved_primary_color_axis = str((process or {}).get("primaryColorAxis") or "").strip()
    axes = _compute_color_axes_for_process(process_id, components, pool_rows, color_links)

    saved_axis = None
    if saved_primary_color_axis:
        saved_axis = next((a for a in axes if a["label"].lower() == saved_primary_color_axis.lower()), None)

    # Every process with an axis reports a primary one, even before anything
    # has been written to its Primary Color Axis cell -- the first axis in
    # recipe order stands in (see _default_primary_color_axis_label), so the
    # Process editor's picker and the Production checklist both open already
    # pointing at it instead of at "none". A saved label that no longer
    # resolves (its axis was renamed or removed) falls back to the same
    # default rather than to no primary at all. Ports module_process.js#
    # getProcessColorAxes (GAS 6a22f0e) -- save_process/save_production
    # already persist this same default going forward, so this mainly
    # covers processes saved before that existed and not yet re-saved or
    # backfilled via refresh_process_primary_color_axes.
    primary_axis = saved_axis or (axes[0] if axes else None)
    primary_color_axis = primary_axis["label"] if primary_axis else ""
    primary_axis_key = primary_axis["key"] if primary_axis else ""

    # Both pickers on the Process form choose from this same `axes` list, so
    # the currently-saved Dispatch Differentiator label rides along for
    # preselection (blank = none configured, or a label that no longer
    # matches any axis after a rename).
    return build_response(
        True,
        {
            "axes": axes,
            "primaryColorAxis": primary_color_axis,
            "primaryAxisKey": primary_axis_key,
            "savedPrimaryColorAxis": saved_primary_color_axis,
            # True when the primary above is the fallback rather than this
            # process's own saved choice -- the Process editor uses it to
            # know it's showing a default the operator has never explicitly
            # confirmed.
            "primaryIsDefault": saved_axis is None and primary_axis is not None,
            "dispatchDifferentiator": str((process or {}).get("dispatchDifferentiator") or "").strip(),
        },
    )


def get_axis_order_by_process(cur) -> dict:
    """{processIdLower: {axisKeyLower: position}} -- each process's own axis
    ordering, taken from its recipe row order via
    _compute_color_axes_for_process. Ported from
    module_process.js#getAxisOrderByProcess.

    This is what makes a lot's composite bucket color repeatable: the
    position an axis holds here is the position its segment takes in the
    credited color string (see warehouse_service._compose_lot_color_key).
    Computed for every process in one pass because Warehouse Pool's Pass 1
    needs it for whichever processes the Completed lots happen to span.

    A process whose axes can't be computed is simply omitted -- its lots
    then fall back to axis-key/color ordering, which is still deterministic.
    """
    all_components = _fetch_process_components(cur)
    components_by_process: dict = {}
    for component in all_components:
        pid = str(component.get("processId") or "").strip()
        if pid:
            components_by_process.setdefault(pid, []).append(component)

    pool_rows = _get_all_warehouse_pool_rows_for_color_axes(cur)
    color_links = _get_all_process_color_links(cur)

    result: dict = {}
    for pid, components in components_by_process.items():
        try:
            axes = _compute_color_axes_for_process(pid, components, pool_rows, color_links) or []
        except Exception:
            continue
        if not axes:
            continue
        result[pid.lower()] = {str(a.get("key") or "").lower(): i for i, a in enumerate(axes)}
    return result


@rpc_method("getAllProcessColorGroups")
def get_all_process_color_groups():
    """Returns every process's color groups in one call, keyed by Process
    ID, as {colors, removable}. `removable` is the subset of `colors`
    excludeWarehousePoolColors would actually accept: NOT configured on
    the process's own recipe/pool detection, AND NOT carrying real
    (non-manual) Production/Dispatch history -- the Warehouse Pool
    breakdown dialog uses it to decide which rows (placeholder or real)
    get an enabled delete action versus a protected/disabled one.
    """
    from . import warehouse_service

    all_components = get_process_components_data()["data"]

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        processes = _get_all_processes(cur)
        pool_rows = _get_all_warehouse_pool_rows_for_color_axes(cur)
        color_links = _get_all_process_color_links(cur)
        overrides_by_process = _get_all_process_color_overrides(cur)
        logged_colors_by_process = _get_production_logged_colors_by_process(cur)
        real_history_by_process = warehouse_service._get_real_history_colors_by_process(cur)

    components_by_process: dict = {}
    for c in all_components:
        components_by_process.setdefault(c["processId"], []).append(c)

    result = {}
    for p in processes:
        components = components_by_process.get(p["processId"], [])
        overrides = overrides_by_process.get(p["processId"].lower())
        logged_colors = list(logged_colors_by_process.get(p["processId"].lower(), []))
        known = _compute_known_colors_for_process(p["processId"], components, pool_rows, color_links, logged_colors, overrides)
        base_lower = {c.lower() for c in known["baseColors"]}
        real_history_lower = real_history_by_process.get(p["processId"].lower(), set())
        result[p["processId"]] = {
            "colors": known["colors"],
            "removable": [c for c in known["colors"] if c.lower() not in base_lower and c.lower() not in real_history_lower],
        }

    return build_response(True, result)


@rpc_method("excludeWarehousePoolColors", mutation=True)
@database.transactional
def exclude_warehouse_pool_colors(conn, cur, process_id, colors):
    """Removes one or more Color/Product-Tag combinations from a process's
    known list -- the Warehouse Pool breakdown dialog's per-row and bulk
    "X" delete actions. Any color actually configured on the process's own
    recipe (protected) or carrying real (non-manual) Production/Dispatch
    history is rejected and reported back individually, never silently
    skipped -- deleting THAT can't be allowed even if we wanted to, since
    _recalculate_warehouse_pool rebuilds the bucket from that same history
    the next time it runs, so "deleting" it would look like it worked and
    then silently reappear.

    A color whose only warehouse_pool activity is manual (Opening Stock /
    an inline Available Qty correction -- both erp.warehouse_pool_opening
    rows, see _get_real_history_colors_by_process) IS removable, though:
    there's no real history to resurrect it, so its Opening rows are
    purged here too and the pool recalculated, rather than leaving a
    stale nonzero bucket sitting in erp.warehouse_pool under an
    now-excluded color.
    """
    from . import warehouse_service

    pid = str(process_id or "").strip()
    if not pid:
        raise ValueError("Process ID is required.")
    color_list = [str(c or "").strip() for c in (colors if isinstance(colors, list) else [colors])]
    color_list = [c for c in color_list if c]
    if not color_list:
        raise ValueError("No colors specified.")

    components = get_process_components_data(pid)["data"]
    pool_rows = _get_all_warehouse_pool_rows_for_color_axes(cur)
    color_links = _get_all_process_color_links(cur)
    base_colors = {c.lower() for c in _compute_color_groups_for_process(pid, components, pool_rows, color_links)}

    pid_lower = pid.lower()
    bucket_has_history = warehouse_service._get_real_history_colors_by_process(cur).get(pid_lower, set())

    removed = []
    blocked = []
    for c in color_list:
        c_lower = c.lower()
        if c_lower in base_colors:
            blocked.append(f"{c} (configured on this process's recipe)")
        elif c_lower in bucket_has_history:
            blocked.append(f"{c} (has real production/consumption history)")
        else:
            removed.append(c)

    user_id = get_current_user_id()
    for c in removed:
        cur.execute(
            """
            INSERT INTO erp.process_color_overrides (process_id, color, action, updated_by)
            VALUES (%s, %s, 'EXCLUDE', %s)
            ON CONFLICT (lower(process_id), lower(color))
            DO UPDATE SET action = 'EXCLUDE', updated_at = NOW(), updated_by = EXCLUDED.updated_by
            """,
            (pid, c, user_id),
        )
        # Clears any manual Opening Stock / correction rows backing this
        # color so the bucket doesn't just get rebuilt right back by the
        # recalculate below -- safe because bucket_has_history already
        # proved there's no real Production/Dispatch history to lose.
        cur.execute(
            "DELETE FROM erp.warehouse_pool_opening WHERE lower(process_id) = %s AND lower(color) = %s",
            (pid_lower, c.lower()),
        )

    if removed:
        warehouse_service._recalculate_warehouse_pool(cur)

    if not blocked:
        message = f"Removed {len(removed)} combination(s)."
    elif removed:
        message = f"Removed {len(removed)} combination(s). {len(blocked)} skipped (can't be removed): {'; '.join(blocked)}."
    else:
        message = f"Nothing removed -- can't be removed: {'; '.join(blocked)}."

    return build_response(bool(removed) or not blocked, {"removed": removed, "blocked": blocked}, message)


@rpc_method("includeWarehousePoolColor", mutation=True)
@database.transactional
def include_warehouse_pool_color(conn, cur, process_id, color):
    """Force-adds one color as a known combination for a process -- the
    Warehouse Pool breakdown dialog's "Add Combination" button. Also how
    a prior exclusion gets undone: re-adding the same color overwrites
    its EXCLUDE row with INCLUDE.
    """
    pid = str(process_id or "").strip()
    c = str(color or "").strip()
    if not pid:
        raise ValueError("Process ID is required.")
    if not c:
        raise ValueError("Color name is required.")

    if not any(p["processId"].strip().lower() == pid.lower() for p in _get_all_processes(cur)):
        raise ValueError(f'Process "{pid}" was not found.')

    cur.execute(
        "SELECT action FROM erp.process_color_overrides WHERE lower(process_id) = %s AND lower(color) = %s",
        (pid.lower(), c.lower()),
    )
    existing = cur.fetchone()
    if existing and existing["action"] == "INCLUDE":
        raise ValueError(f'"{c}" is already a known combination for this process.')

    user_id = get_current_user_id()
    cur.execute(
        """
        INSERT INTO erp.process_color_overrides (process_id, color, action, updated_by)
        VALUES (%s, %s, 'INCLUDE', %s)
        ON CONFLICT (lower(process_id), lower(color))
        DO UPDATE SET action = 'INCLUDE', updated_at = NOW(), updated_by = EXCLUDED.updated_by
        """,
        (pid, c, user_id),
    )

    return build_response(True, {"color": c}, f'"{c}" added as a known combination for this process.')
