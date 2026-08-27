"""Color/Model/Process Type masters, ported from Apps_Script/module_tags.js.

All three share one generic name+remarks CRUD implementation
(_get_tag_data/_save_tag/_delete_tag), exposed under 9 distinct RPC names --
mirrors the source's own _getTagData/_saveTag/_deleteTag(sheetKey, label, ...)
shape exactly.

extractColorsFromItemMaster and importProcessTypesFromProcessNames are ported
below too, now that Items Master and Process Master are both real.
"""

from __future__ import annotations

import re

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

    message = f'"{new_name}" updated in {label}.' if is_edit else f'"{new_name}" added to {label}.'
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


def _delete_tags_bulk(conn, cur, sheet_key: str, label: str, names: list):
    table = _table(sheet_key)
    targets = {str(n or "").strip().lower() for n in (names or []) if str(n or "").strip()}
    if not targets:
        return build_response(True, None, f"No {label} entries selected.")

    cur.execute(
        f"""
        UPDATE {table} SET deleted_at = NOW(), updated_by = %s
        WHERE deleted_at IS NULL AND lower(name) = ANY(%s)
        """,
        (get_current_user_id(), list(targets)),
    )
    rows_deleted = cur.rowcount
    return build_response(True, None, f"Deleted {rows_deleted} {label} entr{'y' if rows_deleted == 1 else 'ies'}.")


# ─────────────────────────────────────────────────────────────────────────
# Rename cascades. Written against every target table up front, guarded via
# config_maps.TABLE_NAMES -- rename_utils skips silently via to_regclass()
# for any table not yet registered, so each target starts working with no
# further changes needed the moment its own phase lands. All targets below
# (PROCESS_COMPONENTS/PROCESS_COLOR_LINKS/PROCESS_MASTER from Phase 3a,
# BOM_LINES from Phase 3c, WAREHOUSE_POOL_OPENING from Phase 3e, Production
# and Warehouse Pool's own recalc from Phase 3g) are real now.
# ─────────────────────────────────────────────────────────────────────────


def _rename_color_token(value, old_lower: str, new: str) -> str:
    """A color cell isn't always a single literal name --
    process_service's color-axis computation can produce (and an
    operator can hand-enter, e.g. a Color Sub-Group's colorGroup or a
    Warehouse Pool Opening entry matching an existing merged bucket) a
    COMPOSITE value joining 2+ independent axes with
    config_maps.COLOR_COMBO_DELIMITER (e.g. "BCP / Blue-White"). A plain
    whole-cell compare only ever matches a single-token cell; this
    renames whichever ONE token matches and rejoins, so a composite cell
    containing the renamed color as just one of its parts still gets
    updated instead of silently going stale. A plain (non-composite)
    value is unaffected -- same exact-match behavior as before.
    """
    s = str(value or "")
    delimiter = config_maps.COLOR_COMBO_DELIMITER
    if delimiter not in s:
        return new if s.strip().lower() == old_lower else s
    token_changed = False
    renamed_tokens = []
    for t in s.split(delimiter):
        if t.strip().lower() == old_lower:
            token_changed = True
            renamed_tokens.append(new)
        else:
            renamed_tokens.append(t)
    return delimiter.join(renamed_tokens) if token_changed else s


def _rename_color_token_in_column(cur, table: str, column: str, old: str, new: str) -> None:
    if not rename_utils._table_exists(cur, table):
        return
    old_lower = old.lower()
    where_extra = " AND deleted_at IS NULL" if rename_utils._has_deleted_at(cur, table) else ""
    cur.execute(f"SELECT id, {column} AS value FROM {table} WHERE {column} IS NOT NULL AND {column} != ''{where_extra}")
    for row in cur.fetchall():
        renamed = _rename_color_token(row["value"], old_lower, new)
        if renamed != row["value"]:
            cur.execute(f"UPDATE {table} SET {column} = %s WHERE id = %s", (renamed, row["id"]))


def _rename_color_token_in_either_column(cur, table: str, column_a: str, column_b: str, old: str, new: str) -> None:
    if not rename_utils._table_exists(cur, table):
        return
    old_lower = old.lower()
    where_extra = " AND deleted_at IS NULL" if rename_utils._has_deleted_at(cur, table) else ""
    cur.execute(
        f"SELECT id, {column_a} AS a, {column_b} AS b FROM {table} "
        f"WHERE ({column_a} IS NOT NULL AND {column_a} != '') OR ({column_b} IS NOT NULL AND {column_b} != ''){where_extra}"
    )
    for row in cur.fetchall():
        renamed_a = _rename_color_token(row["a"], old_lower, new)
        renamed_b = _rename_color_token(row["b"], old_lower, new)
        if renamed_a != row["a"] or renamed_b != row["b"]:
            cur.execute(f"UPDATE {table} SET {column_a} = %s, {column_b} = %s WHERE id = %s", (renamed_a, renamed_b, row["id"]))


def _rename_color_token_in_json_entries(entries, keys: tuple, old_lower: str, new: str) -> bool:
    """Renames a color token inside every dict of a JSONB array column,
    across each of `keys`. Mutates `entries` in place; returns True when
    anything actually changed, so the caller can skip a no-op UPDATE.

    Same _rename_color_token per value as the flat columns use, so a
    composite ("BCP / Blue-White") has just its matching token replaced
    rather than needing a whole-value exact match.
    """
    changed = False
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        for key in keys:
            value = entry.get(key)
            if not value or not isinstance(value, str):
                continue
            renamed = _rename_color_token(value, old_lower, new)
            if renamed != value:
                entry[key] = renamed
                changed = True
    return changed


def _rename_color_everywhere(cur, old_name: str, new_name: str) -> None:
    old = (old_name or "").strip()
    new = (new_name or "").strip()
    if not old or not new or old == new:
        return

    if table := config_maps.TABLE_NAMES.get("PROCESS_COMPONENTS"):
        _rename_color_token_in_column(cur, table, config_maps.to_snake_case("colorGroup"), old, new)

    if table := config_maps.TABLE_NAMES.get("BOM_LINES"):
        _rename_color_token_in_column(cur, table, "color", old, new)

    if table := config_maps.TABLE_NAMES.get("WAREHOUSE_POOL_OPENING"):
        _rename_color_token_in_column(cur, table, "color", old, new)

    if table := config_maps.TABLE_NAMES.get("PROCESS_COLOR_LINKS"):
        _rename_color_token_in_either_column(
            cur, table, config_maps.to_snake_case("colorA"), config_maps.to_snake_case("colorB"), old, new
        )

    # Production's COLOR (comma-joined display string, one segment per
    # colorBreakdown entry -- see save_production's `", ".join(...)`) and
    # COLOR_BREAKDOWN (JSON [{color, size, qty, ...}, ...], the
    # authoritative structured data COLOR is derived from) both need
    # structured rewriting, not a whole-cell/whole-column string match.
    # Each comma-split entry (and each color_breakdown entry's own color)
    # is renamed via _rename_color_token, not a whole-segment exact
    # match -- a plain per-entry exact match would miss a renamed color
    # that's only one axis of a composite entry like "BCP / Blue-White".
    if (table := config_maps.TABLE_NAMES.get("PRODUCTION")) and rename_utils._table_exists(cur, table):
        old_lower = old.lower()
        # components_consumed and custom_components are renamed alongside
        # the two flat columns, in the same pass. They were missed until
        # now, and the omission was not cosmetic: _recalculate_warehouse_
        # pool runs at the end of this function and reads every completed
        # lot's components_consumed for its Pass 2 debit, keying each
        # bucket off that component's own colorGroup. Renaming color and
        # color_breakdown but not components_consumed therefore left the
        # CREDIT under the new name and the DEBIT under the old one --
        # opening a debit-only bucket that goes straight to negative,
        # exactly the class of defect 40d5140 fixed four of. The next
        # edit-save of such a lot then silently dropped those components
        # at save_production's own filter, since their colorGroup no
        # longer matched any of the (renamed) color_breakdown colors.
        #
        # custom_components is a Production Sheet's own customized
        # component list, whose `color` is what the printed sheet groups
        # by (production.js#_resolveSheetColorKey) -- stale there means a
        # sheet printing a color the master no longer has.
        cur.execute(
            f"SELECT id, color, color_breakdown, components_consumed, custom_components "
            f"FROM {table} WHERE deleted_at IS NULL"
        )
        for row in cur.fetchall():
            new_color = row["color"]
            color_changed = False
            if new_color:
                parts = [p.strip() for p in new_color.split(",")]
                renamed_parts = [_rename_color_token(p, old_lower, new) for p in parts]
                rejoined = ", ".join(renamed_parts)
                if rejoined != new_color:
                    new_color = rejoined
                    color_changed = True

            breakdown = row["color_breakdown"]
            breakdown_changed = False
            if breakdown:
                for entry in breakdown:
                    if not entry or not entry.get("color"):
                        continue
                    renamed = _rename_color_token(entry["color"], old_lower, new)
                    if renamed != entry["color"]:
                        entry["color"] = renamed
                        breakdown_changed = True

            consumed = row["components_consumed"]
            # `color` alongside `colorGroup`: the Common Components table
            # already writes a component's own color there, and the
            # per-color pool-bucket work builds on the same field.
            consumed_changed = _rename_color_token_in_json_entries(
                consumed, ("colorGroup", "color"), old_lower, new
            )

            custom = row["custom_components"]
            custom_changed = _rename_color_token_in_json_entries(custom, ("color",), old_lower, new)

            if color_changed or breakdown_changed or consumed_changed or custom_changed:
                cur.execute(
                    f"UPDATE {table} SET color = %s, color_breakdown = %s, "
                    f"components_consumed = %s, custom_components = %s WHERE id = %s",
                    (
                        new_color,
                        psycopg2.extras.Json(breakdown) if breakdown is not None else None,
                        psycopg2.extras.Json(consumed) if consumed is not None else None,
                        psycopg2.extras.Json(custom) if custom is not None else None,
                        row["id"],
                    ),
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

    # Contractor Rates (Layer 1) keys its rate card on Process Type as a
    # free string, not a Process Type Master ID -- see
    # contractors_service._get_contractor_rate.
    if table := config_maps.TABLE_NAMES.get("CONTRACTOR_RATES"):
        rename_utils.rename_in_column(cur, table, "process_type", old, new)


def ensure_color_master_entries(cur, color_names: list) -> list:
    """Auto-registers any brand-new color name into Color Master (called
    from production_service.save_production when the operator types a
    custom sub-group color via "+ Add Custom Sub-Group"), so it's
    available everywhere else Color Master feeds a picker instead of
    staying invisible outside that one process's own logged history.
    Already-known names are a safe no-op (case-insensitive dedup); never
    lets a registration hiccup block the Production save that triggered
    it -- the lot's own colorBreakdown already has the color regardless
    of whether Color Master picks it up too.
    """
    names = [str(c or "").strip() for c in (color_names or [])]
    names = [n for n in names if n]
    if not names:
        return []

    try:
        cur.execute("SELECT name FROM erp.color_master WHERE deleted_at IS NULL")
        existing_lower = {row["name"].strip().lower() for row in cur.fetchall() if row["name"]}

        seen_lower: set = set()
        to_add = []
        for name in names:
            lower = name.lower()
            if lower in existing_lower or lower in seen_lower:
                continue
            seen_lower.add(lower)
            to_add.append(name)

        for name in to_add:
            cur.execute("INSERT INTO erp.color_master (name, remarks) VALUES (%s, %s)", (name, ""))

        return to_add
    except Exception:
        return []


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


@rpc_method("deleteColorsBulk", mutation=True)
@database.transactional
def delete_colors_bulk(conn, cur, names):
    return _delete_tags_bulk(conn, cur, "COLOR_MASTER", "Color Master", names)


@rpc_method("deleteModelsBulk", mutation=True)
@database.transactional
def delete_models_bulk(conn, cur, names):
    return _delete_tags_bulk(conn, cur, "MODEL_MASTER", "Model Master", names)


@rpc_method("deleteProcessTypesBulk", mutation=True)
@database.transactional
def delete_process_types_bulk(conn, cur, names):
    return _delete_tags_bulk(conn, cur, "PROCESS_TYPE_MASTER", "Process Type Master", names)


# ─────────────────────────────────────────────────────────────────────────
# Cross-master scans (frontend's App.Color.autoExtract /
# App.ProcessType.importFromProcessNames)
# ─────────────────────────────────────────────────────────────────────────

# Matches a run of 2+ hyphen-joined tokens, e.g. "Red-White" -- any
# non-space, non-hyphen character is allowed in a token (color names
# aren't guaranteed to be letters-only) but only 2-part combos are
# resolved below (no source spec exists for how a 3+ part chain like
# "Red-White-Blue" should be handled).
_HYPHEN_COMBO_RE = re.compile(r"[^\s-]+(?:-[^\s-]+)+")


@rpc_method("extractColorsFromItemMaster")
def extract_colors_from_item_master():
    """Scans Item Name/Narration/Specification for hyphen-joined pairs of
    *already-registered* Color Master names (e.g. "Red-White") that aren't
    themselves a Color Master entry yet -- matches App.Color.autoExtract's
    own doc comment exactly. Read-only: the frontend confirms and calls
    saveColor itself for each accepted suggestion.
    """
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        cur.execute("SELECT name FROM erp.color_master WHERE deleted_at IS NULL")
        colors_by_lower = {(row["name"] or "").strip().lower(): (row["name"] or "").strip() for row in cur.fetchall()}
        colors_by_lower.pop("", None)

        cur.execute("SELECT item_name, narration, specification FROM erp.items WHERE deleted_at IS NULL")
        item_rows = cur.fetchall()

    new_combos: dict = {}
    for row in item_rows:
        text = " ".join(str(row.get(field) or "") for field in ("item_name", "narration", "specification"))
        for token in _HYPHEN_COMBO_RE.findall(text):
            parts = token.split("-")
            if len(parts) != 2:
                continue
            canonical = [colors_by_lower.get(p.strip().lower()) for p in parts]
            if not all(canonical):
                continue  # every segment must already be a known color
            combo = "-".join(canonical)
            combo_lower = combo.lower()
            if combo_lower in colors_by_lower or combo_lower in new_combos:
                continue
            new_combos[combo_lower] = combo

    new_colors = sorted(new_combos.values())
    scanned_count = len(item_rows)
    message = (
        f"Scanned {scanned_count} item(s) — found {len(new_colors)} new color combination(s)."
        if new_colors
        else f"Scanned {scanned_count} item(s) — no new color combinations found."
    )
    return build_response(True, {"newColors": new_colors, "scannedCount": scanned_count}, message)


@rpc_method("importProcessTypesFromProcessNames", mutation=True)
@database.transactional
def import_process_types_from_process_names(conn, cur):
    """Re-matches every Process Master row's Process Type against Process
    Type Master's names (whichever is a substring of the Process Name),
    overwriting the current value -- clearing it to "General" if nothing
    matches. No new Process Type Master entries are created. Matches
    App.ProcessType.importFromProcessNames's confirm-dialog copy exactly.
    """
    cur.execute("SELECT name FROM erp.process_type_master WHERE deleted_at IS NULL")
    type_names = [(row["name"] or "").strip() for row in cur.fetchall() if (row["name"] or "").strip()]

    cur.execute("SELECT id, process_name, process_type FROM erp.process_master WHERE deleted_at IS NULL")
    process_rows = cur.fetchall()

    updated = 0
    for row in process_rows:
        process_name_lower = (row["process_name"] or "").lower()
        matches = [t for t in type_names if t.lower() in process_name_lower]
        if matches:
            longest = max(len(t) for t in matches)
            new_type = sorted(t for t in matches if len(t) == longest)[0]
        else:
            new_type = "General"

        if new_type != (row["process_type"] or ""):
            cur.execute("UPDATE erp.process_master SET process_type = %s WHERE id = %s", (new_type, row["id"]))
            updated += 1

    message = f"Updated Process Type on {updated} of {len(process_rows)} process(es)."
    return build_response(True, {"updated": updated, "total": len(process_rows)}, message)
