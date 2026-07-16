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
# further changes needed the moment its own phase lands. PROCESS_COMPONENTS/
# PROCESS_COLOR_LINKS/PROCESS_MASTER (Phase 3a) and BOM_LINES (Phase 3c) are
# real now; WAREHOUSE_POOL_OPENING and Production's COLOR/COLOR_BREAKDOWN
# (structured, not a plain column rename -- see below) still aren't.
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

    # Production's COLOR (comma-joined display string) and COLOR_BREAKDOWN
    # (JSON [{color, qty}, ...]) both need structured rewriting, not a
    # whole-cell string match -- dedicated logic lands with Production
    # itself in Phase 3, not a generic rename_in_column call.

    # Warehouse Pool bucket colors are DERIVED from the sheets renamed above
    # (recalculateWarehousePool()) -- Warehouse Pool doesn't exist until
    # Phase 3 either, so there's nothing to recalculate yet.


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
