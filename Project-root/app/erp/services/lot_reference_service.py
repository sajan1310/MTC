"""Lot Reference: while logging a lot, see the earlier lots it relates to and
when they were done, and connect them to it (migration 057).

Which lots are related (the owner's rule, 2026-10-30)
-----------------------------------------------------
Both of these, and nothing else:

  - the same size and the same model as the process being logged, read from
    the Output Item Name exactly as the form's Size and Model dropdowns read
    them (core.js getSizeFromOutputItemName / getModelFromOutputItemName);
  - the sequence just before it. Sequence 4 shows sequence 3 and only that.
    Sequence 1 has nothing before it.

On the 29 Oct 2026 snapshot no lot had ever drawn from the sequence before it
at another size or model (0 of 3,479 rows), so the rule hides no real source.

What a connection means
-----------------------
It is the operator's statement that one lot came from another. The pool cannot
prove it -- stock from different lots mixes in a bucket -- so nothing here
guesses: a lot shows only what someone picked for it (the owner, 2026-10-30).
Connections are optional and information only: the Warehouse Pool, Stock and
the contractor ledger never read erp.production_lot_refs.

What looks used up (the owner, 2026-10-31)
------------------------------------------
Only lots at USED_UP_SEQUENCES. Below them a lot is mixed: one Painting lot
feeds many Fitting lots in many colours, so "used up" means little. Packing is
the last stage today, so in practice this is the Packing form's Fitting lots.

A lot looks used up when either of these is true:

  - the lots connected to it have taken all of it. A connection carries no
    quantity: a lot takes what it draws of the item, from what it was connected
    to, oldest first (454 of 457 Packing lots draw one fitted frame per unit);
  - the Warehouse Pool no longer holds enough of its item for it to still be
    there. Counting back from the newest lot, whatever is older than the pool
    can cover is taken as used.

It takes both. Connections are optional, so on their own a lot packed with no
connection would stay listed for ever; the pool on its own could not tell which
lot a connection used. The pool half assumes the oldest stock goes first.

This only decides what the dropdown shows before anyone types. A wrong
quantity, a bad count or a bug must never stop someone connecting the right lot
(the owner, 2026-10-31), so such a lot stays in the reply, flagged usedUp:
search finds it and replace_lot_refs takes it like any other. Nothing here is
saved and nothing else reads it, so a wrong answer can only change the list.

production_service imports this module for save_production, so this one must
not import production_service.
"""

from __future__ import annotations

import psycopg2.extras

import database
from . import contractors_service
from . import lot_receipts
from . import process_service
from .current_user import get_current_user_id
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

# The most related lots one dropdown lists, newest first. The busiest process
# on the 29 Oct 2026 snapshot had 54.
MAX_RELATED_LOTS = 200

# The stages whose lots can look used up. See the module docstring.
USED_UP_SEQUENCES = (3, 4)

_LOT_COLUMNS = """
    id, lot_number, process_id, output_item_name, status, qty, color, color_breakdown,
    assigned_to, production_date, completed_at, remarks, components_consumed, deleted_at
"""


def _text(value) -> str:
    return str(value or "").strip()


def _model_names(cur) -> list:
    """Model Master names, longest first, so a multi-word model wins over a
    shorter one that is also a substring of it (core.js does the same)."""
    cur.execute("SELECT name FROM erp.model_master WHERE deleted_at IS NULL")
    names = [_text(r["name"]) for r in cur.fetchall() if _text(r["name"])]
    return sorted(names, key=lambda n: (-len(n), n.lower()))


def _get_model_from_output_item_name(text, model_names: list) -> str:
    """Python port of core.js's getModelFromOutputItemName (also duplicated in
    mobile.js). Models come from Model Master, longest first."""
    lower = str(text or "").lower()
    for name in model_names:
        if name.lower() in lower:
            return name
    return config_maps.PROCESS_SIZE_FALLBACK


def _size_and_model(process: dict, model_names: list) -> tuple:
    output_item_name = process["outputItemName"]
    return (
        contractors_service._get_size_from_output_item_name(output_item_name),
        _get_model_from_output_item_name(output_item_name, model_names),
    )


def _related_processes(process: dict, processes: list, model_names: list) -> dict:
    """{process id, lower-cased: process} for every process the rule relates
    to `process`. See the module docstring for the rule."""
    previous = process["sequence"] - 1
    wanted = _size_and_model(process, model_names)
    return {
        p["processId"].lower(): p
        for p in processes
        if p["sequence"] == previous and _size_and_model(p, model_names) == wanted
    }


def _colors(lot: dict) -> list:
    shape = lot_receipts.LotShape(lot["color_breakdown"], lot["qty"])
    colors = [line["color"] for line in shape.lines if line["color"]]
    return colors or ([_text(lot["color"])] if _text(lot["color"]) else [])


def _done_date(lot: dict, receipts: list) -> tuple:
    """(what the date is, the date). The label says which date it is because
    they are not the same thing: lots are often entered ahead of their date,
    and a lot finished before completed_at existed (051) has no such stamp."""
    if lot_receipts.is_completed(lot["status"]) and lot["completed_at"]:
        return "Completed", lot["completed_at"]
    if receipts:
        return "Last received", receipts[-1]["date"]
    return "Lot date", lot["production_date"]


def _finished_on(lot: dict):
    """The day a lot was finished, or None while it is open. A lot finished
    before completed_at existed goes by its date, as the pool judges it."""
    if not lot_receipts.is_completed(lot["status"]):
        return None
    return date_utils.to_safe_date(lot["completed_at"] or lot["production_date"])


def _lot_summary(lot: dict, receipts: list, process: dict | None) -> dict:
    label, when = _done_date(lot, receipts)
    process = process or {}
    return {
        "rowIdx": lot["id"],
        "lotNumber": _text(lot["lot_number"]),
        "outputItemName": _text(lot["output_item_name"]),
        "processName": process.get("processName", ""),
        "processType": process.get("processType", ""),
        "sequence": process.get("sequence"),
        "status": _text(lot["status"]),
        "qty": float(lot["qty"]),
        "colors": _colors(lot),
        "assignedTo": _text(lot["assigned_to"]),
        "dateLabel": label,
        "date": date_utils.to_display_string(when) or "",
        "dateRaw": date_utils.to_iso_string(when) or "",
        "deleted": lot["deleted_at"] is not None,
        "usedUp": False,
    }


def _process_by_id(processes: list) -> dict:
    return {p["processId"].lower(): p for p in processes}


def _lots_of_processes(cur, process_ids: list) -> list:
    if not process_ids:
        return []
    cur.execute(
        f"""
        SELECT {_LOT_COLUMNS} FROM erp.production
         WHERE deleted_at IS NULL AND lower(process_id) = ANY(%s)
        """,
        (process_ids,),
    )
    return cur.fetchall()


def _received(receipts: list) -> float:
    return sum(r["qty"] for r in receipts)


def _lot_made(lot: dict, receipts: list) -> float:
    """What a lot has to give: all of it, or what a Cancelled lot received
    before its balance was dropped."""
    if _text(lot["status"]).lower() == "cancelled":
        return _received(receipts)
    return float(lot["qty"])


def _pool_draws(lot: dict) -> dict:
    """{item name, lower-cased: what a lot draws of it from the pool}."""
    drawn: dict = {}
    for c in lot["components_consumed"] or []:
        if isinstance(c, dict) and _text(c.get("sourceType")).upper() == "POOL":
            item = _text(c.get("itemName")).lower()
            drawn[item] = drawn.get(item, 0.0) + lot_receipts._num(c.get("qty"))
    return drawn


def _share_taken(lot: dict, receipts: list) -> float:
    """How much of its draw a connected lot takes: all of it, open or not,
    because those frames are spoken for; a Cancelled lot only what it received
    before it was cancelled."""
    if _text(lot["status"]).lower() != "cancelled":
        return 1.0
    qty = float(lot["qty"])
    return _received(receipts) / qty if qty else 0.0


def _taken_by_connections(cur, lots: list, made: dict, skip_id=None) -> dict:
    """{lot id: what the lots connected to it have taken}. `skip_id` is the lot
    being edited: what it takes is on the form, where it can still change."""
    by_id = {lot["id"]: lot for lot in lots}
    cur.execute(
        """
        SELECT production_id, ref_production_id FROM erp.production_lot_refs
         WHERE ref_production_id = ANY(%s)
        """,
        (list(by_id),),
    )
    sources: dict = {}
    for row in cur.fetchall():
        if row["production_id"] != skip_id:
            sources.setdefault(row["production_id"], []).append(
                by_id[row["ref_production_id"]]
            )
    if not sources:
        return {}

    cur.execute(
        """
        SELECT id, qty, status, components_consumed FROM erp.production
         WHERE id = ANY(%s) AND deleted_at IS NULL
         ORDER BY production_date, id
        """,
        (list(sources),),
    )
    takers = cur.fetchall()
    receipts = lot_receipts.load_receipts(cur, [lot["id"] for lot in takers])

    taken: dict = {}
    for taker in takers:
        share = _share_taken(taker, receipts.get(taker["id"]) or [])
        drawn = _pool_draws(taker)
        wanted: dict = {}
        ordered = sorted(
            sources[taker["id"]], key=lambda s: (s["production_date"], s["id"])
        )
        for source in ordered:
            item = _text(source["output_item_name"]).lower()
            if item not in wanted:
                # A lot that records no draw of the item takes one per unit.
                wanted[item] = drawn.get(item, float(taker["qty"])) * share
            take = min(wanted[item], made[source["id"]] - taken.get(source["id"], 0.0))
            if take > 0:
                taken[source["id"]] = taken.get(source["id"], 0.0) + take
                wanted[item] -= take
    return taken


def _pool_on_hand(cur, items: list) -> dict:
    """{item name, lower-cased: what the Warehouse Pool holds}. Only buckets
    above zero count: a colour gone negative is a question about that colour
    (warehouse_service), not fewer of the others on the shelf, and listing a
    lot too many is harmless where hiding one is not."""
    cur.execute(
        """
        SELECT lower(trim(output_item_name)) AS item,
               SUM(GREATEST(available_qty, 0)) AS qty
          FROM erp.warehouse_pool
         WHERE counts_toward_total
           AND COALESCE(trim(product_tag), '') = ''
           AND lower(trim(output_item_name)) = ANY(%s)
         GROUP BY 1
        """,
        (items,),
    )
    return {row["item"]: float(row["qty"]) for row in cur.fetchall()}


def _mark_used_up(cur, lots, summaries, receipts, skip_id=None) -> None:
    """Sets usedUp on `summaries`, which are newest first. See the module
    docstring for the rule."""
    lot_by_id = {lot["id"]: lot for lot in lots}
    made = {lot["id"]: _lot_made(lot, receipts.get(lot["id"]) or []) for lot in lots}
    taken = _taken_by_connections(cur, lots, made, skip_id)
    on_hand = _pool_on_hand(
        cur, sorted({s["outputItemName"].lower() for s in summaries})
    )

    for summary in summaries:
        lot = lot_by_id[summary["rowIdx"]]
        item = summary["outputItemName"].lower()
        took = taken.get(lot["id"], 0.0)
        left = made[lot["id"]] - took
        if left <= lot_receipts._QTY_TOLERANCE:
            summary["usedUp"] = True
        elif lot_receipts.is_open(lot["status"]):
            # Still being made: what has come back is in the pool and the rest
            # isn't yet, so the pool can't say it has gone.
            arrived = _received(receipts.get(lot["id"]) or [])
            on_hand[item] = on_hand.get(item, 0.0) - max(arrived - took, 0.0)
        elif on_hand.get(item, 0.0) <= lot_receipts._QTY_TOLERANCE:
            summary["usedUp"] = True
        else:
            on_hand[item] -= left


def _related_lots(cur, process, processes, model_names, *, exclude=None, limit=None):
    """Summaries of the lots related to `process`, newest first, with what
    looks used up after the rest. `exclude` is the lot these are being listed
    for, when it already exists: it is left out, and so is anything done after
    it was finished, because a lot cannot have come from one made later.
    Nothing looks used up to a finished lot: what is left now says nothing
    about what was there when it was made."""
    related = _related_processes(process, processes, model_names)
    lots = _lots_of_processes(cur, list(related))
    receipts = lot_receipts.load_receipts(cur, [lot["id"] for lot in lots])

    summaries = []
    for lot in lots:
        lot_receipt_rows = receipts.get(lot["id"]) or []
        if _text(lot["status"]).lower() == "cancelled" and not lot_receipt_rows:
            continue
        if exclude is not None and lot["id"] == exclude["id"]:
            continue
        summaries.append(
            _lot_summary(
                lot, lot_receipt_rows, related.get(_text(lot["process_id"]).lower())
            )
        )

    finished = _finished_on(exclude) if exclude is not None else None
    if finished is not None:
        cutoff = date_utils.to_iso_string(finished)
        summaries = [s for s in summaries if s["dateRaw"] <= cutoff]

    summaries.sort(key=lambda s: (s["dateRaw"], s["rowIdx"]), reverse=True)
    if summaries and finished is None and process["sequence"] - 1 in USED_UP_SEQUENCES:
        skip_id = exclude["id"] if exclude is not None else None
        _mark_used_up(cur, lots, summaries, receipts, skip_id)
        # Stable: newest first within each, and the limit cuts these first.
        summaries.sort(key=lambda s: s["usedUp"])
    return summaries[:limit] if limit else summaries


def load_lot_refs(cur, lot_ids=None) -> dict:
    """{lot id: [{"rowIdx", "lotNumber", "deleted"}, ...]}: what each lot was
    connected to, for the tags on the Production Log. A lot deleted since
    stays, shown as deleted, as it does on the form."""
    params: tuple = ()
    lot_filter = ""
    if lot_ids is not None:
        lot_filter = "WHERE r.production_id = ANY(%s)"
        params = (list(lot_ids),)
    cur.execute(
        f"""
        SELECT r.production_id, p.id, p.lot_number, p.deleted_at
          FROM erp.production_lot_refs r
          JOIN erp.production p ON p.id = r.ref_production_id
          {lot_filter}
         ORDER BY r.created_at, r.ref_production_id
        """,
        params,
    )
    refs: dict = {}
    for row in cur.fetchall():
        refs.setdefault(row["production_id"], []).append(
            {
                "rowIdx": row["id"],
                "lotNumber": _text(row["lot_number"]),
                "deleted": row["deleted_at"] is not None,
            }
        )
    return refs


def _saved_references(cur, lot_id: int, process_by_id: dict) -> list:
    """The lots this one was connected to, a lot deleted since included."""
    cur.execute(
        f"""
        SELECT {_LOT_COLUMNS} FROM erp.production
         WHERE id IN (SELECT ref_production_id FROM erp.production_lot_refs
                       WHERE production_id = %s)
        """,
        (lot_id,),
    )
    lots = cur.fetchall()
    receipts = lot_receipts.load_receipts(cur, [lot["id"] for lot in lots])
    summaries = [
        _lot_summary(
            lot,
            receipts.get(lot["id"]) or [],
            process_by_id.get(_text(lot["process_id"]).lower()),
        )
        for lot in lots
    ]
    summaries.sort(key=lambda s: (s["dateRaw"], s["rowIdx"]), reverse=True)
    return summaries


def _load_lot(cur, row_idx, message: str) -> dict:
    try:
        lot_id = int(row_idx)
    except (TypeError, ValueError):
        raise ValueError(message)
    cur.execute(
        f"SELECT {_LOT_COLUMNS} FROM erp.production WHERE id = %s AND deleted_at IS NULL",
        (lot_id,),
    )
    lot = cur.fetchone()
    if lot is None:
        raise ValueError(message)
    return lot


@rpc_method("getRelatedLots")
def get_related_lots(process_id, row_idx=None):
    """What the Lot Reference field shows for a process: its related lots, and
    when `row_idx` is the lot being edited, what that lot is connected to."""
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        processes = process_service._get_all_processes(cur)
        process = _process_by_id(processes).get(_text(process_id).lower())
        if process is None:
            raise ValueError("Choose a process first.")
        model_names = _model_names(cur)
        size, model = _size_and_model(process, model_names)
        exclude = (
            _load_lot(cur, row_idx, "That production lot no longer exists.")
            if row_idx
            else None
        )
        lots = _related_lots(
            cur,
            process,
            processes,
            model_names,
            exclude=exclude,
            limit=MAX_RELATED_LOTS,
        )
        references = (
            _saved_references(cur, exclude["id"], _process_by_id(processes))
            if exclude is not None
            else []
        )
    return build_response(
        True,
        {
            # Sequence 1 has nothing before it: the form hides the field.
            "applicable": process["sequence"] > 1,
            "sequence": process["sequence"] - 1,
            "size": size,
            "model": model,
            "lots": lots,
            "references": references,
        },
    )


@rpc_method("getLotDetail")
def get_lot_detail(row_idx):
    """One lot, read-only, for the side window: everything that says what it
    was and when it was done, and the lots someone connected to it. No rates
    or payable -- the side window is for checking a lot, not its money."""
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        lot = _load_lot(cur, row_idx, "That production lot no longer exists.")
        processes = process_service._get_all_processes(cur)
        process_by_id = _process_by_id(processes)
        process = process_by_id.get(_text(lot["process_id"]).lower())
        receipts = lot_receipts.load_receipts(cur, [lot["id"]]).get(lot["id"]) or []
        references = _saved_references(cur, lot["id"], process_by_id)

    shape = lot_receipts.LotShape(lot["color_breakdown"], lot["qty"])
    received = lot_receipts.received_amounts(receipts)
    return build_response(
        True,
        {
            "lot": {
                **_lot_summary(lot, receipts, process),
                "lotDate": date_utils.to_display_string(lot["production_date"]) or "",
                "completedOn": date_utils.to_display_string(lot["completed_at"]) or "",
                "receivedQty": sum(r["qty"] for r in receipts),
                "balanceQty": sum(shape.balance(received).values())
                if lot_receipts.is_open(lot["status"])
                else 0.0,
                "remarks": _text(lot["remarks"]),
                "materials": [
                    {
                        "itemName": _text(c.get("itemName")),
                        "size": _text(c.get("size")),
                        "color": _text(c.get("poolColor") or c.get("colorGroup")),
                        "qty": float(c.get("qty") or 0),
                        "unit": _text(c.get("unit")),
                        "sourceType": _text(c.get("sourceType")).upper(),
                    }
                    for c in (lot["components_consumed"] or [])
                    if isinstance(c, dict) and _text(c.get("itemName"))
                ],
            },
            "receipts": [
                {
                    "date": date_utils.to_display_string(r["date"]) or "",
                    "qty": r["qty"],
                    "byName": r["byName"],
                }
                for r in reversed(receipts)
            ],
            "references": references,
        },
    )


def replace_lot_refs(cur, lot_id: int, raw) -> str:
    """Saves what `lot_id` is connected to, from save_production. `raw` is the
    form's lotRefs: a JSON list of lot ids.

    No field means leave the lot's connections alone. An offline save queued
    before this feature, a cached older client, and an edit whose references
    failed to load all arrive without one, and none of them meant "remove".
    An empty list does mean that.

    A connection is optional and information only, so it never stops a lot
    being saved. Returns a note for the save message when it left a lot out,
    which is a lot deleted while an offline save waited to sync; a connection
    already saved to a lot deleted later is kept and shown as deleted."""
    if raw is None or raw == "":
        return ""
    parsed = process_service._parse_json_array(
        raw, "Invalid lot reference data format."
    )

    wanted: list = []
    for value in parsed:
        try:
            ref_id = int(value)
        except (TypeError, ValueError):
            continue
        if ref_id != lot_id and ref_id not in wanted:
            wanted.append(ref_id)

    cur.execute(
        "SELECT ref_production_id FROM erp.production_lot_refs WHERE production_id = %s",
        (lot_id,),
    )
    saved = {row["ref_production_id"] for row in cur.fetchall()}

    new = [ref_id for ref_id in wanted if ref_id not in saved]
    cur.execute(
        "SELECT id FROM erp.production WHERE id = ANY(%s) AND deleted_at IS NULL",
        (new,),
    )
    live = {row["id"] for row in cur.fetchall()}
    to_add = [ref_id for ref_id in new if ref_id in live]

    cur.execute(
        """
        DELETE FROM erp.production_lot_refs
         WHERE production_id = %s AND NOT (ref_production_id = ANY(%s))
        """,
        (lot_id, wanted),
    )
    if to_add:
        user_id = get_current_user_id()
        cur.executemany(
            """
            INSERT INTO erp.production_lot_refs
                (production_id, ref_production_id, created_by)
            VALUES (%s, %s, %s)
            ON CONFLICT DO NOTHING
            """,
            [(lot_id, ref_id, user_id) for ref_id in to_add],
        )

    dropped = len(new) - len(to_add)
    if not dropped:
        return ""
    return (
        "1 connected lot no longer exists and was left out."
        if dropped == 1
        else f"{dropped} connected lots no longer exist and were left out."
    )
