"""Inspection: a floor inspector goes through a production lot's checklist --
its live Production Sheet -- ticking each item that is accounted for, asks
an admin to review the lot when something is wrong, and signs the lot off.

What this module may touch
--------------------------
Inspection keeps its own state in erp.lot_inspections and
erp.lot_inspection_checks (migration 053). It reads erp.production and
writes to it in exactly one case, agreed with the owner: a Pending lot
becomes In Progress when its first item is checked. Clearing a lot marks the
INSPECTION cleared and leaves the lot's status where its supervisor put it.
Only "Completed" moves stock (warehouse_service credits the Warehouse Pool
from completed lots alone), and an inspection must never move stock.

That one status write skips the Warehouse Pool rebuild that
production_service.update_production_status always runs. The rebuild reads
completed lots only (warehouse_service._recalculate_warehouse_pool), so a
lot going from Pending to In Progress cannot change its result, and the
rebuild costs about half a second on the live database.

What the checklist is
---------------------
The live Production Sheet, by the rule both apps already draw it with
(production.js _populateProductionSheetData, mobile.js
MApp.ProductionSheet._rowsFor): the lot's saved sheet (custom_components)
when it has one, otherwise its recorded consumption (components_consumed).
When an admin changes a lot's components, production_service drops the
saved sheet, so this always follows the lot. Each row carries:

  key          its identity: item, size and colour, lower-cased. A second
               row with the same three in the same sheet gets "#2", and so
               on, in sheet order.
  fingerprint  what the inspector actually verifies: quantity and
               specification (narration). Change either and a check made
               against the old values stops counting.

Ticks, review, and the stage a lot is at (owner, 2026-10-26)
------------------------------------------------------------
A tick says the item is there as the sheet says. The first version had
Pass / Fail per item instead (25-26 Oct 2026): a tick is stored as "pass",
and a "fail" left over from it reads as not ticked. "Needs admin review" is
one box on the lot, ticked with remarks saying what to look at (status
"flagged"). Both apps show the lot at one stage (stage()):

  Not started        nothing ticked
  Partially checked  some items ticked
  All checked        every item ticked: all accounted for
  Needs review       the review box is ticked
  Inspected          cleared

State retention (merge_checklist)
---------------------------------
A check stores the fingerprint it was made against and a snapshot of the
row. Merging the stored checks with the live sheet gives every row one
state:

  checked   a check exists and its fingerprint matches: stays ticked.
  revised   a check exists but the fingerprint has moved, or there is no
            check and the row differs from the baseline: unticked, badged
            "Revised", with the previous values so the screen can say
            "50 -> 45".
  new       no check, and the row was not on the sheet when inspection
            began (the baseline): unticked, badged "New".
  pending   no check and nothing changed: unticked.

Rows that were checked or on the baseline but are no longer on the sheet
come back separately as `removed`. Stale checks are never deleted on read:
they are the evidence behind "Revised" and its before/after. Re-checking a
row overwrites its check with the current fingerprint.

Clearing and reconciliation (clearInspection)
---------------------------------------------
Anyone who can inspect clears a lot that is All checked, unchanged since it
was checked, and not waiting for a review. An admin may clear any open lot,
one that needs review or is only partially checked included. Submit
re-reads the live sheet inside its own transaction and merges again.
Whatever the clearer would be accepting -- sheet changes, and for an admin
the items nobody ticked -- comes back first as data (success=True,
cleared=False) for the client's dialog, and nothing is written. Only an
admin may accept it. The client echoes the token of the exact list it
showed, and the server clears only if a fresh list produces the same token:
a list that changed again while the dialog was open is shown again, not
accepted unseen. What the admin accepted is kept with the clearance.
"""

from __future__ import annotations

import hashlib
import json

import psycopg2.extras
from flask_login import current_user

import database

from . import items_service
from . import process_service
from .current_user import (
    get_current_user_email,
    get_current_user_id,
    get_current_user_role,
)
from .production_service import _coerce_row_id
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

STATUS_IN_PROGRESS = "in_progress"
STATUS_FLAGGED = "flagged"
STATUS_CLEARED = "cleared"

# How a tick is stored: "pass", the value Pass / Fail used for the same thing,
# so ticks made before the checklist replaced it still count. A "fail" left
# from then reads as not ticked (_load_checks).
CHECKED = "pass"

STAGE_NOT_STARTED = "not_started"
STAGE_PARTIAL = "partial"
STAGE_COMPLETE = "complete"
STAGE_NEEDS_REVIEW = "needs_review"
STAGE_CLEARED = "cleared"

# The lot statuses an inspector works through. Lots outside these still
# appear in getInspectionLots when they already have an inspection, so an
# admin can see one that was completed or cancelled after it was inspected.
LOT_STATUSES_TO_INSPECT = ("Pending", "In Progress")

MAX_REMARKS = 2000
MAX_NOTE = 1000

_BUILTIN_ROLE_LABELS = {"user": "User", "admin": "Admin", "super_admin": "Super Admin"}

_LOT_COLUMNS = """
    id, lot_number, production_date, process_id, output_item_name, product_name,
    qty, COALESCE(NULLIF(btrim(status), ''), 'Pending') AS status,
    custom_components, components_consumed, color_breakdown, updated_at
"""


# ── The live Production Sheet, as rows ────────────────────────────────────


def _text(value) -> str:
    return str(value or "").strip()


def _color_key(component: dict) -> str:
    """A component's colour on the sheet: its colour group unless that is
    COMMON (shared by every colour), else the free-text colour an older
    saved sheet carries. desktop _resolveSheetColorKey, mobile _colorKey."""
    group = _text(component.get("colorGroup"))
    if group and not process_service._is_common_color_group(group):
        return group
    return _text(component.get("color"))


def _sheet_qty(component: dict) -> float:
    """requiredQty on a saved sheet row, qty on a recorded-consumption row
    (mobile _rowsFor reads requiredQty whenever the key is present)."""
    raw = (
        component["requiredQty"] if "requiredQty" in component else component.get("qty")
    )
    try:
        return round(float(raw or 0), 4)
    except (TypeError, ValueError):
        return 0.0


def fingerprint(row: dict) -> str:
    """What a check vouches for: the quantity and the specification."""
    return f"{float(row.get('qty') or 0):.4f}|{_text(row.get('narration')).lower()}"


def sheet_rows(custom_components, components_consumed) -> list[dict]:
    """The lot's live Production Sheet, one dict per row, with key and
    fingerprint. A row without an item name is skipped: the sheet's own save
    drops those (production_service.save_production_sheet)."""
    custom = custom_components if isinstance(custom_components, list) else []
    consumed = components_consumed if isinstance(components_consumed, list) else []
    source = custom if len(custom) > 0 else consumed

    rows: list[dict] = []
    seen: dict[str, int] = {}
    for component in source:
        if not isinstance(component, dict):
            continue
        item = _text(component.get("itemName"))
        if not item:
            continue
        size = _text(component.get("size"))
        color = _color_key(component)
        base = "|".join(part.lower() for part in (item, size, color))
        seen[base] = seen.get(base, 0) + 1
        row = {
            "key": base if seen[base] == 1 else f"{base}#{seen[base]}",
            "itemName": item,
            "size": size,
            "color": color,
            "narration": _text(component.get("narration")),
            "qty": _sheet_qty(component),
            "unit": _text(component.get("unit")),
        }
        row["fingerprint"] = fingerprint(row)
        rows.append(row)
    return rows


# ── State retention and diffing (pure; see the module docstring) ─────────


def _previous(snapshot) -> dict | None:
    if not isinstance(snapshot, dict):
        return None
    return {"qty": snapshot.get("qty"), "narration": snapshot.get("narration") or ""}


def merge_checklist(live_rows, checks, baseline) -> tuple[list[dict], list[dict]]:
    """Live sheet rows merged with stored checks.

    `checks` maps item_key -> {result, fingerprint, snapshot}. `baseline` is
    the sheet as it stood when inspection began, or None when no inspection
    exists yet -- then nothing can be "new", because nothing came before.

    Returns (items, removed). Every item gets a `state` (checked / revised /
    new / pending), its `result` when the check still counts, and the
    `previous` values when it was revised.
    """
    checks = checks or {}
    base_by_key = {b.get("key"): b for b in (baseline or []) if isinstance(b, dict)}
    has_baseline = baseline is not None

    items: list[dict] = []
    live_keys: set[str] = set()
    for row in live_rows:
        live_keys.add(row["key"])
        check = checks.get(row["key"])
        base = base_by_key.get(row["key"])
        item = dict(row, state="pending", result=None, previous=None)
        if check is not None and check.get("fingerprint") == row["fingerprint"]:
            # Retained: the check was made against exactly these values.
            item["state"] = "checked"
            item["result"] = check.get("result")
        elif check is not None:
            # Checked once, changed since: the old tick no longer counts.
            item["state"] = "revised"
            item["previous"] = _previous(check.get("snapshot"))
        elif has_baseline and base is None:
            item["state"] = "new"
        elif base is not None and base.get("fingerprint") != row["fingerprint"]:
            item["state"] = "revised"
            item["previous"] = _previous(base)
        items.append(item)

    removed: dict[str, dict] = {}
    for key, check in checks.items():
        if key not in live_keys and isinstance(check.get("snapshot"), dict):
            removed[key] = dict(check["snapshot"], key=key)
    for key, base in base_by_key.items():
        if key and key not in live_keys and key not in removed:
            removed[key] = dict(base, key=key)
    return items, list(removed.values())


def _photo_key(item) -> tuple:
    return (_text(item.get("itemName")).lower(), _text(item.get("size")).lower())


def attach_photos(cur, items) -> None:
    """Gives each checklist row its Items Master photo's address as
    `photoUrl` ("" when it has none), so the inspector can compare the
    material with a picture of it, and `canSetPhoto` when the row has an
    Items Master item for the inspector to photograph.

    The match is exact, name and size: a rim photographed in 16 inch must
    not stand in for the 20 inch rim the row asks for, because checking the
    size is part of the inspection. A Warehouse Pool row (a painted frame, a
    fitted rim) has no Items Master entry, so no photo and nowhere to put
    one. Only the address is sent; the photo itself loads when shown."""
    names = list({_photo_key(i)[0] for i in items if i.get("itemName")})
    found: dict = {}
    if names:
        cur.execute(
            "SELECT id, lower(item_name) AS n, lower(size) AS s, row_version, "
            "image <> '' AS has_photo "
            "FROM erp.items WHERE deleted_at IS NULL AND lower(item_name) = ANY(%s)",
            (names,),
        )
        found = {(r["n"], r["s"]): r for r in cur.fetchall()}
    for item in items:
        match = found.get(_photo_key(item))
        item["canSetPhoto"] = match is not None
        item["photoUrl"] = (
            items_service.photo_url(match["id"], match["row_version"])
            if match is not None and match["has_photo"]
            else ""
        )


def summarize(items, removed=()) -> dict:
    checked = sum(1 for i in items if i["state"] == "checked")
    return {
        "total": len(items),
        "checked": checked,
        # Pass / Fail's counts, for a phone still on that screen until it
        # reloads: every tick is a pass now, and nothing fails.
        "passed": checked,
        "failed": 0,
        "revised": sum(1 for i in items if i["state"] == "revised"),
        "added": sum(1 for i in items if i["state"] == "new"),
        "removed": len(removed),
        # Every item on the sheet ticked and unchanged: all accounted for.
        "complete": bool(items) and checked == len(items),
    }


def stage(status, summary) -> str:
    """The one word both apps show for where a lot's inspection stands."""
    if status == STATUS_CLEARED:
        return STAGE_CLEARED
    if status == STATUS_FLAGGED:
        return STAGE_NEEDS_REVIEW
    if summary.get("complete"):
        return STAGE_COMPLETE
    if summary.get("checked"):
        return STAGE_PARTIAL
    return STAGE_NOT_STARTED


def _row_label(row: dict) -> dict:
    return {
        "key": row.get("key"),
        "itemName": row.get("itemName") or "",
        "size": row.get("size") or "",
        "color": row.get("color") or "",
        "unit": row.get("unit") or "",
    }


def discrepancies(items, removed) -> list[dict]:
    """The differences between what was inspected and the live sheet, in the
    shape the reconciliation dialog prints: "Spoke 12G: quantity 50 -> 45"."""
    out: list[dict] = []
    for item in items:
        if item["state"] == "revised":
            before = item.get("previous") or {}
            changes = []
            if before.get("qty") is not None and float(before["qty"]) != float(
                item["qty"]
            ):
                changes.append(
                    {
                        "field": "qty",
                        "label": "Quantity",
                        "from": before["qty"],
                        "to": item["qty"],
                    }
                )
            if (
                _text(before.get("narration")).lower()
                != _text(item["narration"]).lower()
            ):
                changes.append(
                    {
                        "field": "narration",
                        "label": "Specification",
                        "from": before.get("narration") or "",
                        "to": item["narration"],
                    }
                )
            out.append(dict(_row_label(item), kind="changed", changes=changes))
        elif item["state"] == "new":
            out.append(
                dict(
                    _row_label(item),
                    kind="added",
                    qty=item["qty"],
                    narration=item["narration"],
                )
            )
    for row in removed:
        out.append(
            dict(
                _row_label(row),
                kind="removed",
                qty=row.get("qty"),
                narration=row.get("narration") or "",
            )
        )
    return out


def discrepancy_token(diff) -> str:
    """Names one exact list of differences, so an acknowledgement can only
    ever apply to the list the admin was shown."""
    blob = json.dumps(diff, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:24]


# ── Reads and identity ────────────────────────────────────────────────────


def _iso(ts) -> str:
    return ts.isoformat() if ts is not None else ""


def _load_lot(cur, row_idx, *, for_update=False) -> dict:
    lot_id = _coerce_row_id(row_idx, "Invalid production lot selected.")
    cur.execute(
        f"SELECT {_LOT_COLUMNS} FROM erp.production WHERE id = %s AND deleted_at IS NULL"
        + (" FOR UPDATE" if for_update else ""),
        (lot_id,),
    )
    lot = cur.fetchone()
    if lot is None:
        raise ValueError("That production lot no longer exists. Refresh the list.")
    return lot


def _process_names(cur) -> dict[str, str]:
    cur.execute(
        "SELECT process_id, process_name FROM erp.process_master WHERE deleted_at IS NULL"
    )
    return {_text(r["process_id"]).lower(): r["process_name"] for r in cur.fetchall()}


def _process_name(cur, process_id) -> str:
    cur.execute(
        "SELECT process_name FROM erp.process_master "
        "WHERE lower(process_id) = lower(%s) AND deleted_at IS NULL",
        (_text(process_id),),
    )
    row = cur.fetchone()
    return row["process_name"] if row else _text(process_id)


def _load_inspection(cur, production_id, *, for_update=False) -> dict | None:
    cur.execute(
        "SELECT * FROM erp.lot_inspections WHERE production_id = %s"
        + (" FOR UPDATE" if for_update else ""),
        (production_id,),
    )
    return cur.fetchone()


def _load_checks(cur, inspection_id) -> dict[str, dict]:
    """The lot's ticks. A "fail" from the retired Pass / Fail screen is left
    out, so its item reads as not ticked."""
    if inspection_id is None:
        return {}
    cur.execute(
        "SELECT item_key, result, fingerprint, snapshot FROM erp.lot_inspection_checks "
        "WHERE inspection_id = %s AND result = %s",
        (inspection_id, CHECKED),
    )
    return {r["item_key"]: r for r in cur.fetchall()}


def _start_inspection(cur, lot, rows) -> dict:
    """The lot's inspection, created on its first write with today's sheet
    as the baseline. Concurrency-safe: two devices starting at once both end
    up holding the one row."""
    inspection = _load_inspection(cur, lot["id"], for_update=True)
    if inspection is not None:
        return inspection
    user_id = get_current_user_id()
    cur.execute(
        "INSERT INTO erp.lot_inspections (production_id, baseline, created_by, updated_by) "
        "VALUES (%s, %s, %s, %s) ON CONFLICT (production_id) DO NOTHING",
        (lot["id"], psycopg2.extras.Json(rows), user_id, user_id),
    )
    return _load_inspection(cur, lot["id"], for_update=True)


def _identity(cur) -> dict:
    """The signed-in user as the sign-off line shows them: name, and the
    role's display name (a custom role's own name, e.g. "Quality Lead")."""
    role = get_current_user_role()
    label = _BUILTIN_ROLE_LABELS.get(role)
    if label is None and role:
        cur.execute("SELECT role_name FROM custom_roles WHERE role_key = %s", (role,))
        found = cur.fetchone()
        label = found["role_name"] if found else role
    name = _text(getattr(current_user, "name", "")) or get_current_user_email()
    return {
        "id": get_current_user_id(),
        "name": name,
        "role": role,
        "roleLabel": label or "User",
    }


def _is_admin() -> bool:
    return bool(getattr(current_user, "is_admin", False))


def _lot_header(lot, process_name) -> dict:
    return {
        "rowIdx": lot["id"],
        "lotNumber": lot["lot_number"] or "",
        "date": date_utils.to_display_string(lot["production_date"]) or "",
        "dateRaw": date_utils.to_iso_string(lot["production_date"]) or "",
        "processId": lot["process_id"] or "",
        "processName": process_name or lot["process_id"] or "",
        "outputItemName": lot["output_item_name"] or "",
        "productName": lot["product_name"] or "",
        "qty": float(lot["qty"] or 0),
        "status": lot["status"],
        "colors": [
            c.get("color")
            for c in (lot["color_breakdown"] or [])
            if isinstance(c, dict) and c.get("color")
        ],
        "updatedAt": _iso(lot["updated_at"]),
    }


def _changed_since_cleared(inspection, rows) -> bool:
    if not inspection or inspection["status"] != STATUS_CLEARED:
        return False
    signed = {
        r.get("key"): r.get("fingerprint") for r in (inspection["cleared_sheet"] or [])
    }
    return signed != {r["key"]: r["fingerprint"] for r in rows}


def _inspection_payload(inspection, rows) -> dict:
    if inspection is None:
        return {"status": "", "remarks": "", "reviewNote": ""}
    return {
        "status": inspection["status"],
        "remarks": inspection["remarks"] or "",
        "flaggedAt": _iso(inspection["flagged_at"]),
        "flaggedByName": inspection["flagged_by_name"] or "",
        "reviewNote": inspection["review_note"] or "",
        "returnedAt": _iso(inspection["returned_at"]),
        "clearedAt": _iso(inspection["cleared_at"]),
        "clearedByName": inspection["cleared_by_name"] or "",
        "clearedByRole": inspection["cleared_by_role"] or "",
        "acknowledged": inspection["acknowledged"] or [],
        "changedSinceCleared": _changed_since_cleared(inspection, rows),
        "updatedAt": _iso(inspection["updated_at"]),
    }


def _refuse_if_closed(lot, inspection) -> None:
    if lot["status"].lower() == "cancelled":
        raise ValueError(
            f"Lot #{lot['lot_number']} was cancelled, so there is nothing to inspect."
        )
    if inspection is not None and inspection["status"] == STATUS_CLEARED:
        raise ValueError(f"Lot #{lot['lot_number']} has already been cleared.")


# ── RPC methods ───────────────────────────────────────────────────────────


@rpc_method("getInspectionLots")
def get_inspection_lots():
    """Lots waiting for inspection (Pending / In Progress) and every lot that
    already has an inspection, each with its checklist counts and stage."""
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute(
            f"""
            SELECT {_LOT_COLUMNS}
              FROM erp.production p
             WHERE p.deleted_at IS NULL
               AND (lower(COALESCE(NULLIF(btrim(p.status), ''), 'Pending')) = ANY(%s)
                    OR EXISTS (SELECT 1 FROM erp.lot_inspections i WHERE i.production_id = p.id))
             ORDER BY p.production_date DESC, p.id DESC
            """,
            ([s.lower() for s in LOT_STATUSES_TO_INSPECT],),
        )
        lots = cur.fetchall()
        cur.execute("SELECT * FROM erp.lot_inspections")
        inspections = {r["production_id"]: r for r in cur.fetchall()}
        checks_by_inspection: dict[int, dict[str, dict]] = {}
        if inspections:
            cur.execute(
                "SELECT inspection_id, item_key, result, fingerprint, snapshot "
                "FROM erp.lot_inspection_checks WHERE inspection_id = ANY(%s) AND result = %s",
                ([r["id"] for r in inspections.values()], CHECKED),
            )
            for r in cur.fetchall():
                checks_by_inspection.setdefault(r["inspection_id"], {})[
                    r["item_key"]
                ] = r
        names = _process_names(cur)

    out = []
    for lot in lots:
        rows = sheet_rows(lot["custom_components"], lot["components_consumed"])
        inspection = inspections.get(lot["id"])
        checks = checks_by_inspection.get(inspection["id"], {}) if inspection else {}
        items, removed = merge_checklist(
            rows, checks, inspection["baseline"] if inspection else None
        )
        header = _lot_header(lot, names.get(_text(lot["process_id"]).lower()))
        stamps = [
            s
            for s in (
                lot["updated_at"],
                inspection["updated_at"] if inspection else None,
            )
            if s
        ]
        summary = summarize(items, removed)
        payload = _inspection_payload(inspection, rows)
        header.update(
            itemCount=len(rows),
            lastUpdated=_iso(max(stamps)) if stamps else "",
            inspection=dict(
                payload, summary=summary, stage=stage(payload["status"], summary)
            ),
        )
        out.append(header)
    return build_response(True, out)


@rpc_method("getInspection")
def get_inspection(row_idx):
    """One lot's checklist, with retained checks and Revised/New badges."""
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        lot = _load_lot(cur, row_idx)
        inspection = _load_inspection(cur, lot["id"])
        rows = sheet_rows(lot["custom_components"], lot["components_consumed"])
        checks = _load_checks(cur, inspection["id"] if inspection else None)
        items, removed = merge_checklist(
            rows, checks, inspection["baseline"] if inspection else None
        )
        attach_photos(cur, items)
        header = _lot_header(lot, _process_name(cur, lot["process_id"]))
        identity = _identity(cur)
    summary = summarize(items, removed)
    payload = _inspection_payload(inspection, rows)
    return build_response(
        True,
        {
            "lot": header,
            "inspection": dict(payload, stage=stage(payload["status"], summary)),
            "items": items,
            "removed": removed,
            "summary": summary,
            "inspector": identity,
            # An admin accepts what was not ticked or changed, clears a lot
            # that needs review, and sends one back.
            "canAcknowledge": _is_admin(),
            "canReturn": _is_admin(),
        },
    )


@rpc_method("setInspectionCheck", mutation=True)
@database.transactional
def set_inspection_check(conn, cur, row_idx, item_key, result, item_fingerprint):
    """Tick or untick one sheet row: `result` "checked" (or "pass", which a
    phone on the old screen sends) ticks it, "" unticks it. `item_fingerprint`
    is the row as the inspector's screen showed it: when the sheet has moved
    since, the write is refused so nothing is vouched for that was never seen."""
    lot = _load_lot(cur, row_idx, for_update=True)
    rows = sheet_rows(lot["custom_components"], lot["components_consumed"])
    row = next((r for r in rows if r["key"] == _text(item_key)), None)
    if row is None:
        raise ValueError(
            "That item is no longer on this lot's Production Sheet. Reload the checklist."
        )
    if _text(item_fingerprint) != row["fingerprint"]:
        raise ValueError(
            "That item changed on the Production Sheet after the checklist loaded. Reload it."
        )

    result = _text(result).lower()
    if result == "fail":
        raise ValueError(
            "Pass and Fail were replaced by a checklist. Reload the app to get it."
        )
    if result == "checked":
        result = CHECKED
    if result and result != CHECKED:
        raise ValueError(f'Invalid result "{result}".')

    inspection = _start_inspection(cur, lot, rows)
    _refuse_if_closed(lot, inspection)

    user_id = get_current_user_id()
    if result:
        cur.execute(
            """
            INSERT INTO erp.lot_inspection_checks
                   (inspection_id, item_key, result, fingerprint, snapshot, checked_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (inspection_id, item_key) DO UPDATE
               SET result = EXCLUDED.result, fingerprint = EXCLUDED.fingerprint,
                   snapshot = EXCLUDED.snapshot, checked_at = NOW(), checked_by = EXCLUDED.checked_by
            """,
            (
                inspection["id"],
                row["key"],
                result,
                row["fingerprint"],
                psycopg2.extras.Json(row),
                user_id,
            ),
        )
    else:
        cur.execute(
            "DELETE FROM erp.lot_inspection_checks WHERE inspection_id = %s AND item_key = %s",
            (inspection["id"], row["key"]),
        )
    cur.execute(
        "UPDATE erp.lot_inspections SET updated_by = %s WHERE id = %s",
        (user_id, inspection["id"]),
    )

    # The one write to the lot: checking starts the work. Conditional, so a
    # status the supervisor changed meanwhile is left alone.
    lot_status = lot["status"]
    if result and lot_status.lower() == "pending":
        cur.execute(
            "UPDATE erp.production SET status = 'In Progress', updated_by = %s "
            "WHERE id = %s AND deleted_at IS NULL "
            "AND lower(COALESCE(NULLIF(btrim(status), ''), 'Pending')) = 'pending'",
            (user_id, lot["id"]),
        )
        if cur.rowcount == 1:
            lot_status = "In Progress"

    items, removed = merge_checklist(
        rows, _load_checks(cur, inspection["id"]), inspection["baseline"]
    )
    message = (
        f"Lot #{lot['lot_number']} is now In Progress."
        if lot_status != lot["status"]
        else ""
    )
    # The row as the merge now sees it, so the client never guesses what an
    # untick turns a row back into (pending, or still revised).
    merged = next((i for i in items if i["key"] == row["key"]), None)
    if merged is not None:
        attach_photos(cur, [merged])
    summary = summarize(items, removed)
    return build_response(
        True,
        {
            "key": row["key"],
            "result": result or None,
            "item": merged,
            "lotStatus": lot_status,
            "summary": summary,
            "stage": stage(inspection["status"], summary),
        },
        message,
    )


@rpc_method("setInspectionItemPhoto", mutation=True)
@database.transactional
def set_inspection_item_photo(conn, cur, row_idx, item_key, image):
    """Puts a new photo on the Items Master item behind one checklist row --
    the inspector found it missing, or out of date.

    Only the photo, and only for an item on this lot's live Production
    Sheet: an inspector need not be able to edit Items Master to keep its
    photos current, so this sits under the Inspection permission rather than
    going through saveItem. It is the item's photo everywhere -- Items
    Master, the phone's Items list, every other lot's checklist. The
    inspection itself is untouched, cleared or not."""
    lot = _load_lot(cur, row_idx)
    key = _text(item_key)
    row = next(
        (
            r
            for r in sheet_rows(lot["custom_components"], lot["components_consumed"])
            if r["key"] == key
        ),
        None,
    )
    if row is None:
        raise ValueError(
            "That item is no longer on this lot's Production Sheet. Reload the checklist."
        )
    image = items_service.check_servable_photo(image)
    cur.execute(
        "SELECT id, item_name FROM erp.items WHERE deleted_at IS NULL "
        "AND lower(item_name) = lower(%s) AND lower(size) = lower(%s) FOR UPDATE",
        (row["itemName"], row["size"]),
    )
    item = cur.fetchone()
    if item is None:
        raise ValueError(
            f"{row['itemName']} is not in Items Master, so there is no item to "
            "put a photo on."
        )
    cur.execute(
        "UPDATE erp.items SET image = %s, updated_by = %s WHERE id = %s "
        "RETURNING row_version",
        (image, get_current_user_id(), item["id"]),
    )
    version = cur.fetchone()["row_version"]
    label = " ".join(part for part in (row["itemName"], row["size"]) if part)
    return build_response(
        True,
        {
            "key": key,
            "itemName": row["itemName"],
            "size": row["size"],
            "photoUrl": items_service.photo_url(item["id"], version),
        },
        f"Photo saved for {label}.",
    )


@rpc_method("saveInspectionRemarks", mutation=True)
@database.transactional
def save_inspection_remarks(conn, cur, row_idx, remarks, flag_for_admin=False):
    """Save the inspector's remarks; with flag_for_admin, also ask an admin
    to review the lot. What the Pass / Fail screen calls: a phone still on it
    until it reloads keeps working. The checklist screen calls
    setInspectionReview, which can also take a request back."""
    lot = _load_lot(cur, row_idx, for_update=True)
    remarks = _text(remarks)[:MAX_REMARKS]
    if flag_for_admin and not remarks:
        raise ValueError(
            "Write what needs to change before flagging the lot for an admin."
        )

    rows = sheet_rows(lot["custom_components"], lot["components_consumed"])
    inspection = _start_inspection(cur, lot, rows)
    _refuse_if_closed(lot, inspection)

    user_id = get_current_user_id()
    if flag_for_admin:
        identity = _identity(cur)
        cur.execute(
            "UPDATE erp.lot_inspections SET remarks = %s, status = %s, flagged_at = NOW(), "
            "flagged_by = %s, flagged_by_name = %s, updated_by = %s WHERE id = %s",
            (
                remarks,
                STATUS_FLAGGED,
                user_id,
                identity["name"],
                user_id,
                inspection["id"],
            ),
        )
        status, message = (
            STATUS_FLAGGED,
            f"Remarks saved. Lot #{lot['lot_number']} is flagged for an admin.",
        )
    else:
        cur.execute(
            "UPDATE erp.lot_inspections SET remarks = %s, updated_by = %s WHERE id = %s",
            (remarks, user_id, inspection["id"]),
        )
        status, message = inspection["status"], "Remarks saved."
    return build_response(True, {"status": status, "remarks": remarks}, message)


@rpc_method("setInspectionReview", mutation=True)
@database.transactional
def set_inspection_review(conn, cur, row_idx, needs_review, remarks=""):
    """Tick or untick "Needs admin review", saving the remarks with it.

    Ticking asks an admin to look at the lot, and needs remarks saying what
    to look at; the admin can then clear the lot however much of it is
    ticked, or send it back. Unticking takes the request back. The checklist
    is left as it is either way."""
    lot = _load_lot(cur, row_idx, for_update=True)
    remarks = _text(remarks)[:MAX_REMARKS]
    needs_review = bool(needs_review)
    if needs_review and not remarks:
        raise ValueError(
            "Write what the admin should look at before asking for a review."
        )

    rows = sheet_rows(lot["custom_components"], lot["components_consumed"])
    inspection = _start_inspection(cur, lot, rows)
    _refuse_if_closed(lot, inspection)

    user_id = get_current_user_id()
    was_flagged = inspection["status"] == STATUS_FLAGGED
    flagged_by_name = inspection["flagged_by_name"] or ""
    if needs_review and not was_flagged:
        flagged_by_name = _identity(cur)["name"]
        cur.execute(
            "UPDATE erp.lot_inspections SET remarks = %s, status = %s, flagged_at = NOW(), "
            "flagged_by = %s, flagged_by_name = %s, updated_by = %s WHERE id = %s",
            (
                remarks,
                STATUS_FLAGGED,
                user_id,
                flagged_by_name,
                user_id,
                inspection["id"],
            ),
        )
        status = STATUS_FLAGGED
        message = f"Saved. Lot #{lot['lot_number']} is waiting for an admin's review."
    else:
        withdrawn = was_flagged and not needs_review
        status = STATUS_IN_PROGRESS if withdrawn else inspection["status"]
        cur.execute(
            "UPDATE erp.lot_inspections SET remarks = %s, status = %s, updated_by = %s "
            "WHERE id = %s",
            (remarks, status, user_id, inspection["id"]),
        )
        message = "Review request taken back." if withdrawn else "Remarks saved."

    items, removed = merge_checklist(
        rows, _load_checks(cur, inspection["id"]), inspection["baseline"]
    )
    summary = summarize(items, removed)
    return build_response(
        True,
        {
            "status": status,
            "remarks": remarks,
            "flaggedByName": flagged_by_name,
            "summary": summary,
            "stage": stage(status, summary),
        },
        message,
    )


@rpc_method("returnInspection", mutation=True, roles=frozenset({"admin"}))
@database.transactional
def return_inspection(conn, cur, row_idx, note=""):
    """An admin sends a flagged lot back for re-inspection, usually after
    changing it. The checklist then shows what changed as Revised / New."""
    lot = _load_lot(cur, row_idx, for_update=True)
    inspection = _load_inspection(cur, lot["id"], for_update=True)
    if inspection is None or inspection["status"] != STATUS_FLAGGED:
        raise ValueError(f"Lot #{lot['lot_number']} is not waiting for an admin.")
    user_id = get_current_user_id()
    cur.execute(
        "UPDATE erp.lot_inspections SET status = %s, review_note = %s, returned_at = NOW(), "
        "returned_by = %s, updated_by = %s WHERE id = %s",
        (
            STATUS_IN_PROGRESS,
            _text(note)[:MAX_NOTE],
            user_id,
            user_id,
            inspection["id"],
        ),
    )
    return build_response(
        True,
        {"status": STATUS_IN_PROGRESS},
        f"Lot #{lot['lot_number']} sent back for re-inspection.",
    )


@rpc_method("clearInspection", mutation=True)
@database.transactional
def clear_inspection(conn, cur, row_idx, acknowledge_token=None):
    """Reconcile against the live Production Sheet, then sign the lot off.

    Anyone who can inspect clears a lot whose every item is ticked, when the
    sheet still matches what was ticked and nobody asked for a review. An
    admin clears any open lot. Whatever the clearer would be accepting --
    sheet changes, and for an admin the items nobody ticked -- comes back
    first as {cleared: False, discrepancies, token} and nothing is written;
    an admin calls again with that token to accept exactly that list.
    Returns {cleared: True, ...} on success.
    """
    lot = _load_lot(cur, row_idx, for_update=True)
    inspection = _load_inspection(cur, lot["id"], for_update=True)
    if inspection is None:
        raise ValueError("Check this lot's items before clearing it.")
    _refuse_if_closed(lot, inspection)
    admin = _is_admin()
    if inspection["status"] == STATUS_FLAGGED and not admin:
        raise ValueError(
            "This lot is waiting for an admin's review. An admin can clear it."
        )

    rows = sheet_rows(lot["custom_components"], lot["components_consumed"])
    if not rows:
        raise ValueError("This lot has nothing on its Production Sheet to inspect.")
    items, removed = merge_checklist(
        rows, _load_checks(cur, inspection["id"]), inspection["baseline"]
    )

    # What clearing now would accept. Revised and new rows are already in
    # the sheet's differences; the rest of the unticked ones only an admin
    # may clear without.
    pending = discrepancies(items, removed)
    unticked = [i for i in items if i["state"] == "pending"]
    if admin:
        pending += [
            dict(
                _row_label(i), kind="unchecked", qty=i["qty"], narration=i["narration"]
            )
            for i in unticked
        ]
    elif unticked and not pending:
        raise ValueError(
            f"Check every item before clearing the lot ({len(unticked)} left), "
            "or tick Needs admin review."
        )

    acknowledged = None
    if pending:
        token = discrepancy_token(pending)
        if not acknowledge_token or _text(acknowledge_token) != token:
            if acknowledge_token and not admin:
                raise ValueError(
                    "Only an admin can accept Production Sheet changes without re-inspecting."
                )
            if acknowledge_token:
                message = "The list changed while you were deciding. Review it again."
            elif any(p["kind"] != "unchecked" for p in pending):
                message = "The live Production Sheet differs from what was checked."
            else:
                message = f"{len(pending)} item(s) not ticked."
            return build_response(
                True,
                {
                    "cleared": False,
                    "discrepancies": pending,
                    "token": token,
                    "changedAgain": bool(acknowledge_token),
                    "canAcknowledge": admin,
                },
                message,
            )
        if not admin:
            raise ValueError(
                "Only an admin can accept Production Sheet changes without re-inspecting."
            )
        acknowledged = pending

    identity = _identity(cur)
    cur.execute(
        """
        UPDATE erp.lot_inspections
           SET status = %s, cleared_at = NOW(), cleared_by = %s, cleared_by_name = %s,
               cleared_by_role = %s, cleared_sheet = %s, acknowledged = %s, updated_by = %s
         WHERE id = %s
        """,
        (
            STATUS_CLEARED,
            identity["id"],
            identity["name"],
            identity["roleLabel"],
            psycopg2.extras.Json(rows),
            psycopg2.extras.Json(acknowledged) if acknowledged else None,
            identity["id"],
            inspection["id"],
        ),
    )
    process_name = _process_name(cur, lot["process_id"])
    return build_response(
        True,
        {
            "cleared": True,
            "lotNumber": lot["lot_number"],
            "processName": process_name,
            "inspector": identity,
            "acknowledged": acknowledged or [],
        },
        f"Thank you, {identity['name']}. Your lot has been cleared for {process_name}.",
    )
