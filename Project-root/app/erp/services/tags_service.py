"""Color/Model/Process Type masters, ported from Apps_Script/module_tags.js.

All three share one generic name+remarks CRUD implementation
(_get_tag_data/_save_tag/_delete_tag), exposed under 9 distinct RPC names --
mirrors the source's own _getTagData/_saveTag/_deleteTag(sheetKey, label, ...)
shape exactly.

extractColorsFromItemMaster and importProcessTypesFromProcessNames both scan
tables that don't exist yet (Items Master, Process Master) -- deferred to the
phases that add them, not stubbed here.
"""

from __future__ import annotations

import psycopg2.extras

import database
from . import rename_utils
from . import warehouse_service
from .current_user import get_current_user_id
from .. import config_maps
from ..envelope import build_response
from ..registry import rpc_method


def _table(sheet_key: str) -> str:
    table = config_maps.TABLE_NAMES.get(sheet_key)
    if not table:
        raise ValueError(f"No table registered for sheet key '{sheet_key}'.")
    return table


def _get_tag_data(sheet_key: str, label: str):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute(
            f"""
            SELECT name, remarks FROM {_table(sheet_key)}
            WHERE deleted_at IS NULL
            ORDER BY lower(name)
            """
        )
        rows = cur.fetchall()
    tags = [{"name": row["name"], "remarks": row["remarks"] or ""} for row in rows]
    return build_response(True, tags)


def _save_tag(conn, cur, sheet_key: str, label: str, form_data):
    form_data = form_data or {}
    table = _table(sheet_key)

    new_name = str(form_data.get("name") or "").strip()
    if not new_name:
        raise ValueError("Name must not be empty.")

    remarks = str(form_data.get("remarks") or "").strip()

    is_edit = bool(form_data.get("originalName"))
    original_name = str(form_data.get("originalName")).strip() if is_edit else new_name

    cur.execute(
        f"SELECT id FROM {table} WHERE lower(name) = lower(%s) AND deleted_at IS NULL",
        (original_name,),
    )
    existing = cur.fetchone()

    if is_edit and existing is None:
        raise ValueError(f"Original {label} entry not found.")
    if not is_edit and existing is not None:
        raise ValueError(f'"{new_name}" already exists in {label}.')

    if is_edit and new_name.lower() != original_name.lower():
        cur.execute(
            f"SELECT id FROM {table} WHERE lower(name) = lower(%s) AND deleted_at IS NULL AND id != %s",
            (new_name, existing["id"]),
        )
        if cur.fetchone():
            raise ValueError(f'Another entry named "{new_name}" already exists in {label}.')

    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            f"UPDATE {table} SET name = %s, remarks = %s, updated_by = %s WHERE id = %s",
            (new_name, remarks, user_id, existing["id"]),
        )
    else:
        cur.execute(
            f"INSERT INTO {table} (name, remarks, updated_by) VALUES (%s, %s, %s)",
            (new_name, remarks, user_id),
        )

    # Cascade a genuine rename -- plain string compare, NOT case-insensitive,
    # matching the source (a casing-only rename must still cascade).
    if is_edit and new_name != original_name:
        if sheet_key == "COLOR_MASTER":
            _rename_color_everywhere(cur, original_name, new_name)
        elif sheet_key == "PROCESS_TYPE_MASTER":
            _rename_process_type_everywhere(cur, original_name, new_name)
        # MODEL_MASTER: no cascade -- Model Master's name isn't stored as a
        # reference anywhere else in the schema (see module_tags.js).

    message = f"{label} entry updated successfully." if is_edit else f"{label} entry added successfully."
    return build_response(True, {"name": new_name}, message)


def _delete_tag(conn, cur, sheet_key: str, label: str, name):
    table = _table(sheet_key)
    target = str(name or "").strip()
    if not target:
        raise ValueError(f"{label} entry not found.")

    cur.execute(
        f"SELECT id FROM {table} WHERE lower(name) = lower(%s) AND deleted_at IS NULL",
        (target,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError(f"{label} entry not found.")

    cur.execute(
        f"UPDATE {table} SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), row["id"]),
    )
    return build_response(True, None, f'"{name}" deleted from {label}.')


# ─────────────────────────────────────────────────────────────────────────
# Rename cascades. Written against every target table up front, guarded via
# config_maps.TABLE_NAMES -- rename_utils skips silently via to_regclass()
# for any table not yet registered, so each target starts working with no
# further changes needed the moment its own phase lands. All targets below
# (PROCESS_COMPONENTS/PROCESS_COLOR_LINKS/PROCESS_MASTER from Phase 3a,
# BOM_LINES from Phase 3c, WAREHOUSE_POOL_OPENING from Phase 3e, Production
# and Warehouse Pool's own recalc from Phase 3g) are real now.
# ─────────────────────────────────────────────────────────────────────────


def _rename_color_everywhere(cur, old_name: str, new_name: str) -> None:
    old = (old_name or "").strip()
    new = (new_name or "").strip()
    if not old or not new or old == new:
        return

    if table := config_maps.TABLE_NAMES.get("PROCESS_COMPONENTS"):
        rename_utils.rename_in_column(cur, table, config_maps.to_snake_case("colorGroup"), old, new)

    if table := config_maps.TABLE_NAMES.get("BOM_LINES"):
        rename_utils.rename_in_column(cur, table, "color", old, new)

    if table := config_maps.TABLE_NAMES.get("WAREHOUSE_POOL_OPENING"):
        rename_utils.rename_in_column(cur, table, "color", old, new)

    if table := config_maps.TABLE_NAMES.get("PROCESS_COLOR_LINKS"):
        rename_utils.rename_in_either_column(
            cur, table, config_maps.to_snake_case("colorA"), config_maps.to_snake_case("colorB"), old, new
        )

    # Production's COLOR (comma-joined display string, e.g. "Red (Small),
    # Blue") and COLOR_BREAKDOWN (JSON [{color, size, qty, ...}, ...], the
    # authoritative structured data COLOR is derived from) both need
    # structured rewriting, not a whole-cell/whole-column string match --
    # ported from module_tags.js's _renameColorEverywhere verbatim,
    # including its one real quirk: COLOR's per-segment comparison is a
    # WHOLE-SEGMENT match, so a segment with a size suffix ("Red (Small)")
    # never equals the bare old color name and is left unrenamed in that
    # display string. COLOR_BREAKDOWN -- what every other read actually
    # uses (see production_service.py's getProductionData) -- is
    # unaffected by this and always renamed correctly either way.
    if (table := config_maps.TABLE_NAMES.get("PRODUCTION")) and rename_utils._table_exists(cur, table):
        old_lower = old.lower()
        cur.execute(f"SELECT id, color, color_breakdown FROM {table} WHERE deleted_at IS NULL")
        for row in cur.fetchall():
            new_color = row["color"]
            color_changed = False
            if new_color:
                parts = [p.strip() for p in new_color.split(",")]
                renamed_parts = [new if p.lower() == old_lower else p for p in parts]
                rejoined = ", ".join(renamed_parts)
                if rejoined != new_color:
                    new_color = rejoined
                    color_changed = True

            breakdown = row["color_breakdown"]
            breakdown_changed = False
            if breakdown:
                for entry in breakdown:
                    if entry and str(entry.get("color") or "").strip().lower() == old_lower:
                        entry["color"] = new
                        breakdown_changed = True

            if color_changed or breakdown_changed:
                cur.execute(
                    f"UPDATE {table} SET color = %s, color_breakdown = %s WHERE id = %s",
                    (new_color, psycopg2.extras.Json(breakdown) if breakdown is not None else None, row["id"]),
                )

    # Warehouse Pool bucket colors are always DERIVED (rebuilt from scratch
    # by _recalculate_warehouse_pool) from the sheets just renamed above --
    # recalc now so the bucket keys pick up the new name immediately,
    # instead of silently staying on the old name until some unrelated
    # write triggers it.
    if config_maps.TABLE_NAMES.get("WAREHOUSE_POOL"):
        warehouse_service._recalculate_warehouse_pool(cur)


def _rename_process_type_everywhere(cur, old_name: str, new_name: str) -> None:
    old = (old_name or "").strip()
    new = (new_name or "").strip()
    if not old or not new or old == new:
        return

    if table := config_maps.TABLE_NAMES.get("PROCESS_MASTER"):
        rename_utils.rename_in_column(cur, table, config_maps.to_snake_case("processType"), old, new)


# ─────────────────────────────────────────────────────────────────────────
# RPC-exposed wrappers
# ─────────────────────────────────────────────────────────────────────────


@rpc_method("getColors")
def get_colors():
    return _get_tag_data("COLOR_MASTER", "Color Master")


@rpc_method("getModels")
def get_models():
    return _get_tag_data("MODEL_MASTER", "Model Master")


@rpc_method("getProcessTypes")
def get_process_types():
    return _get_tag_data("PROCESS_TYPE_MASTER", "Process Type Master")


@rpc_method("saveColor", mutation=True)
@database.transactional
def save_color(conn, cur, form_data):
    return _save_tag(conn, cur, "COLOR_MASTER", "Color Master", form_data)


@rpc_method("saveModel", mutation=True)
@database.transactional
def save_model(conn, cur, form_data):
    return _save_tag(conn, cur, "MODEL_MASTER", "Model Master", form_data)


@rpc_method("saveProcessType", mutation=True)
@database.transactional
def save_process_type(conn, cur, form_data):
    return _save_tag(conn, cur, "PROCESS_TYPE_MASTER", "Process Type Master", form_data)


@rpc_method("deleteColor", mutation=True)
@database.transactional
def delete_color(conn, cur, name):
    return _delete_tag(conn, cur, "COLOR_MASTER", "Color Master", name)


@rpc_method("deleteModel", mutation=True)
@database.transactional
def delete_model(conn, cur, name):
    return _delete_tag(conn, cur, "MODEL_MASTER", "Model Master", name)


@rpc_method("deleteProcessType", mutation=True)
@database.transactional
def delete_process_type(conn, cur, name):
    return _delete_tag(conn, cur, "PROCESS_TYPE_MASTER", "Process Type Master", name)
