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

Deferred (see the Phase 3a plan): getProcessColorGroups/getProcessColorAxes/
getAllProcessColorGroups and the pure compute functions behind them (need
Warehouse Pool to be meaningful), _setProcessPrimaryColorAxis (only ever
called from Production), the Production/Warehouse-Pool-Opening portions of
_renamePoolOutputItemNameEverywhere and all of
_renameProcessNameInContractorRates (their target tables don't exist yet --
guarded no-ops below, activate automatically once those modules land).
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
               active, remarks, output_item_name, process_type, primary_color_axis
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
    de-normalized snapshot of it, so the (future) Warehouse Pool stays keyed
    consistently under the new name. Production's OUTPUT_ITEM_NAME/
    COMPONENTS_CONSUMED targets need structured (JSON-aware) rewriting, not
    a generic rename_in_column call -- dedicated logic lands with Production
    itself, same as the color rename cascade's Production comment.
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
    created the row (matches _saveProcessColorLinksForProcess exactly).
    """
    cur.execute("DELETE FROM erp.process_color_links WHERE process_a_id = %s OR process_b_id = %s", (master_id, master_id))

    self_lower = str(process_id or "").strip().lower()
    for link in links or []:
        link = link or {}
        other_process_id = str(link.get("otherProcessId") or "").strip()
        my_color = str(link.get("myColor") or "").strip()
        their_color = str(link.get("theirColor") or "").strip()
        if not (other_process_id and my_color and their_color):
            continue
        if other_process_id.lower() == self_lower:
            continue
        other = process_lookup.get(other_process_id.lower())
        if not other:
            continue

        cur.execute(
            "INSERT INTO erp.process_color_links (process_a_id, color_a, process_b_id, color_b) VALUES (%s, %s, %s, %s)",
            (master_id, my_color, other["id"], their_color),
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

    components = _parse_json_array(form_data.get("components"), "Invalid component data format.")
    color_links = _parse_json_array(form_data.get("colorLinks"), "Invalid color link data format.")

    dup = _find_duplicate_component(components)
    if dup:
        size_suffix = f" ({dup['size']})" if dup["size"] else ""
        group_label = (
            "Common Components"
            if dup["colorGroup"] == _COLOR_GROUP_COMMON
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
                remarks = %s, output_item_name = %s, process_type = %s, primary_color_axis = %s, updated_by = %s
            WHERE id = %s
            """,
            (
                process_name, sequence, lot_prefix, is_final_stage, active, remarks,
                output_item_name, process_type, primary_color_axis, user_id, master_id,
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
                 output_item_name, process_type, primary_color_axis, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                result_process_id, process_name, sequence, lot_prefix, is_final_stage, active, remarks,
                output_item_name, process_type, primary_color_axis, user_id,
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

    return build_response(True, {"processId": result_process_id}, message)


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


@rpc_method("getProcessComponentsData")
def get_process_components_data(process_id=""):
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

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(sql, params)
        rows = cur.fetchall()

    components = [
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
        for row in rows
    ]
    return build_response(True, components)


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
                "SELECT process_a_id, color_a, process_b_id, color_b FROM erp.process_color_links WHERE process_a_id = %s OR process_b_id = %s",
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
                        }
                    )

    return build_response(True, records)
