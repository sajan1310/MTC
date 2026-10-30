"""The audit's verification of every entry that moves Items Stock.

Five kinds of entry move Items Stock: a Received Bill adds to it; a
Production lot, an Issue, a Return and a Wastage note take from it. For each
of them the audit asks two things.

Did it reach Stock correctly? _check_stock_statement rebuilds every item's
Current Stock from those five, line by line, and compares the result with
the Stock page. It works the rules out here on purpose -- which lines count,
when each takes effect, which count governs -- rather than reading
stock_service's SQL, because a second reading of the rules is what makes
the comparison worth anything. A disagreement is a code bug.

Did it land in the right place, and nowhere else? Totals can agree while an
entry sits on the wrong item, PO, bucket or party. So a lot's credit must be
on the bucket its process makes and its debits on the items it used, a
component on the size its recipe names, an issue in the Vendor Ledger of the
party it went to, and every stored id must point at the party or item the
entry names.

Is the entry itself right? Each kind has its own check below: the
calculation stored on a line, a Ledger only line no count holds, a lot that
used less than its recipe, goods issued and also used by a lot, a return with
no value, a price far from what the item usually costs. Those are entries
that look wrong, for a person to judge -- the audit never changes them.

The run's totals (how many of each were checked) go on ctx.stats, for the
report to say what it covered.
"""

from __future__ import annotations

import difflib
import statistics
from collections import defaultdict
from datetime import timedelta

from . import items_service, lot_receipts, process_service, units_service
from .audit_common import (
    _bill_ref,
    _bill_rows,
    _finding,
    _fmt,
    _item_key,
    _k,
    _listed,
    _lot_label,
    _rs,
    _sized,
    _squash,
    MONEY_EPS,
)

# Two bills from one vendor with identical lines this close together.
DUPLICATE_BILL_DAYS = 3
# An item's bill prices this many times apart, per base unit.
RATE_SPREAD_FACTOR = 3.0
# How far a lot may be from its recipe before it counts as different
# (relative): weights are rounded on the sheet.
RECIPE_TOLERANCE = 0.01
# A lot older than its recipe's last change is judged by the lots of the same
# output around it instead: this close in date, at least this many of them,
# on a part this share of them used, using under this share of the usual.
NEIGHBOUR_DAYS = 30
NEIGHBOURS_MIN = 4
NEIGHBOUR_SHARE = 0.9
NEIGHBOUR_SHORT = 0.5
# An issue and a lot of the same item this close together may be the same
# goods.
ISSUE_LOT_WINDOW_DAYS = 14
# Two Issued To names this alike are one party typed two ways.
NAME_SIMILARITY = 0.85
# A return's price this far from its bill's (relative).
RETURN_RATE_TOLERANCE = 0.005

_STOCK_TOLERANCE = 1e-4

# The kinds of entry, in the order the report lists them.
ENTRY_KINDS = (
    ("production", "Production lots"),
    ("bills", "Received bills"),
    ("issues", "Issue Stock"),
    ("returns", "Returns"),
    ("wastage", "Wastage"),
)

# Each line that moves stock, in base units, with what its moment is worked
# out from. Written out here rather than shared with stock_service: see the
# module docstring. A Labor line or a Ledger only line has affects_stock
# FALSE; a wastage line off the Warehouse Pool is the pool's, not Stock's.
_ENTRY_SQL = (
    (
        "bills",
        """
        SELECT h.id AS doc, l.item_name, COALESCE(l.size, '') AS size, l.base_qty AS qty,
               h.bill_date AS day, h.bill_date::timestamptz AS midnight, h.created_at
          FROM erp.bill_lines l JOIN erp.bill_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL AND l.affects_stock
        """,
    ),
    (
        "returns",
        """
        SELECT h.id AS doc, l.item_name, COALESCE(l.size, '') AS size, l.base_qty AS qty,
               h.return_date AS day, h.return_date::timestamptz AS midnight, h.created_at
          FROM erp.return_lines l JOIN erp.return_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "wastage",
        """
        SELECT h.id AS doc, l.item_name, COALESCE(l.size, '') AS size, l.base_qty AS qty,
               h.wastage_date AS day, h.wastage_date::timestamptz AS midnight, h.created_at
          FROM erp.wastage_lines l JOIN erp.wastage_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL AND l.source_type <> 'POOL'
        """,
    ),
    (
        "issues",
        """
        SELECT h.id AS doc, l.item_name, COALESCE(l.size, '') AS size, l.base_qty AS qty,
               h.issue_date AS day, h.issue_date::timestamptz AS midnight, h.created_at
          FROM erp.issue_lines l JOIN erp.issue_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
)


# ── Shared reads ───────────────────────────────────────────────────────────


def _unit_maps(ctx) -> tuple:
    maps = getattr(ctx, "_unit_maps_cache", None)
    if maps is None:
        maps = (
            items_service.get_item_unit_info_map(ctx.cur),
            units_service.get_units_map(ctx.cur),
        )
        ctx._unit_maps_cache = maps
    return maps


def _to_base(ctx, qty, unit, name, size) -> float:
    """`qty` in the item's Base Unit. Blank means it already is, and a unit
    that cannot be converted stays as entered -- both as Stock reads them."""
    qty = float(qty or 0)
    unit = str(unit or "").strip()
    if not unit:
        return qty
    item_units, units = _unit_maps(ctx)
    info = items_service.lookup_item_unit_info(item_units, name, size)
    try:
        return units_service.convert_qty_to_base_unit(qty, unit, info, units)
    except ValueError:
        return qty


def _stock_rows_of(cur) -> list:
    """The rows the Stock page lists."""
    cur.execute(
        "SELECT item_name, COALESCE(size, '') AS size, initial_stock "
        "FROM erp.stock WHERE deleted_at IS NULL"
    )
    return cur.fetchall()


def _stock_rows(ctx) -> list:
    rows = getattr(ctx, "_stock_rows_cache", None)
    if rows is None:
        rows = _stock_rows_of(ctx.cur)
        ctx._stock_rows_cache = rows
    return rows


def _lot_lines(ctx) -> list:
    """Each ITEM component a lot has used up, in base units: all of a
    Completed lot's, and the received part of one received in part."""
    lines = getattr(ctx, "_lot_lines_cache", None)
    if lines is not None:
        return lines
    lines = []
    for lot in ctx.lots:
        completed = lot_receipts.is_completed(lot["status"])
        receipts = ctx.receipts_by_lot.get(lot["id"])
        if not completed and not receipts:
            continue
        components = lot["components_consumed"]
        if not isinstance(components, list):
            continue
        shape = None
        received = None
        if not completed:
            shape = lot_receipts.LotShape(lot["color_breakdown"], lot["qty"])
            received = lot_receipts.received_amounts(receipts)
        created, day = lot["created_at"], lot["production_date"]
        moment = (
            created
            if created is not None and created.date() == day
            else lot["midnight"]
        )
        for comp in components:
            if not isinstance(comp, dict) or _k(comp.get("sourceType")) == "pool":
                continue
            name = str(comp.get("itemName") or "").strip()
            if not name:
                continue
            size = str(comp.get("size") or "").strip()
            qty = lot_receipts._num(comp.get("qty"))
            if shape is not None:
                qty = shape.component_qty(comp, qty, received)
                if not qty:
                    continue
            lines.append(
                {
                    "lot": lot,
                    "name": name,
                    "size": size,
                    "key": _item_key(name, size),
                    "baseQty": _to_base(ctx, qty, comp.get("unit"), name, size),
                    "moment": moment,
                }
            )
    ctx._lot_lines_cache = lines
    return lines


def _effect_moment(term: str, row):
    """When a line takes effect against a count. A bill counts from when it
    was entered, or the end of its date where no entry time was recorded
    (created_at missing, or its midnight placeholder). Anything else counts
    from its entry time if it was entered on its own date, otherwise from
    the start of its date."""
    created, midnight = row["created_at"], row["midnight"]
    if term == "bills":
        if created is None or created == midnight:
            return midnight + timedelta(days=1) - timedelta(microseconds=1)
        return created
    if created is not None and created.date() == row["day"]:
        return created
    return midnight


# ── Did every entry reach Stock correctly? ─────────────────────────────────


def _check_stock_statement(ctx) -> list:
    """Rebuild each item's stock from its entries: its newest count (or its
    opening stock), then every bill, lot, issue, return, wastage note and
    merge that took effect after that count. The Stock page must show the
    same figure. Also tallies what was checked, for the report."""
    cur = ctx.cur
    cur.execute(
        "SELECT item_name, COALESCE(size, '') AS size, action, old_value, new_value, "
        "created_at FROM erp.stock_adjustments ORDER BY created_at, id"
    )
    counts: dict = {}
    merges: list = []
    for r in cur.fetchall():
        key = _item_key(r["item_name"], r["size"])
        if r["action"] in ("ADJUST", "RESET"):
            counts[key] = r  # ordered, so the newest stays
        elif r["action"] == "MERGE":
            merges.append((key, r))

    def held(key, moment) -> bool:
        """Is this line already inside the item's newest count?"""
        count = counts.get(key)
        return count is not None and (moment is None or moment <= count["created_at"])

    def empty() -> dict:
        return {
            "bills": 0.0,
            "production": 0.0,
            "issues": 0.0,
            "returns": 0.0,
            "wastage": 0.0,
            "merges": 0.0,
        }

    statements: dict = defaultdict(empty)
    seen = {k: {"documents": set(), "lines": 0, "qty": 0.0} for k, _l in ENTRY_KINDS}

    def tally(term, doc, qty):
        seen[term]["documents"].add(doc)
        seen[term]["lines"] += 1
        seen[term]["qty"] += qty

    for term, sql in _ENTRY_SQL:
        cur.execute(sql)
        for r in cur.fetchall():
            if not str(r["item_name"] or "").strip():
                continue
            qty = float(r["qty"] or 0)
            tally(term, r["doc"], qty)
            key = _item_key(r["item_name"], r["size"])
            if not held(key, _effect_moment(term, r)):
                statements[key][term] += qty

    for line in _lot_lines(ctx):
        tally("production", line["lot"]["id"], line["baseQty"])
        if not held(line["key"], line["moment"]):
            statements[line["key"]]["production"] += line["baseQty"]

    for key, r in merges:
        if not held(key, r["created_at"]):
            statements[key]["merges"] += float(r["new_value"] or 0) - float(
                r["old_value"] or 0
            )

    terms = ctx.stock_terms()
    rows = _stock_rows(ctx)
    out = []
    for r in rows:
        key = _item_key(r["item_name"], r["size"])
        s = statements.get(key) or empty()
        count = counts.get(key)
        opening = (
            float(count["new_value"] or 0) if count else float(r["initial_stock"] or 0)
        )
        rebuilt = (
            opening
            + s["bills"]
            + s["merges"]
            - s["production"]
            - s["issues"]
            - s["returns"]
            - s["wastage"]
        )
        page = terms.current(key, r["initial_stock"])
        if abs(rebuilt - page) <= _STOCK_TOLERANCE:
            continue
        start = (
            f"counted {_fmt(opening)} on {count['created_at']:%d/%m/%Y}"
            if count
            else f"opening stock {_fmt(opening)}"
        )
        out.append(
            _finding(
                "stock_statement_mismatch",
                "integrity",
                "stock",
                f"{_sized(r['item_name'], r['size'])}: Stock page {_fmt(page)}, "
                f"rebuilt from its entries {_fmt(rebuilt)}",
                f"From {start}: +{_fmt(s['bills'])} received bills, "
                f"-{_fmt(s['production'])} production lots, -{_fmt(s['issues'])} issued, "
                f"-{_fmt(s['returns'])} returned, -{_fmt(s['wastage'])} wasted, "
                f"{_fmt(s['merges'])} merged = {_fmt(rebuilt)}. The Stock page shows "
                f"{_fmt(page)}.",
                item=r["item_name"],
                size=r["size"],
                qty=abs(rebuilt - page),
                evidence={"opening": opening, **s},
            )
        )

    ctx.stats["entries"] = [
        {
            "area": kind,
            "label": label,
            "documents": len(seen[kind]["documents"]),
            "lines": seen[kind]["lines"],
            "qty": round(seen[kind]["qty"], 4),
        }
        for kind, label in ENTRY_KINDS
    ]
    ctx.stats["statement"] = {"items": len(rows), "disagree": len(out)}
    return out


# ── Received bills ─────────────────────────────────────────────────────────


def _priced(line) -> str:
    return (
        f"{_bill_ref(line)}: {_fmt(line['qty'])} {line['unit']} at {_rs(line['price'])}, "
        f"{_rs(line['base_rate'])} a base unit"
    )


def _check_bill_entries(ctx) -> list:
    """What a bill's own lines should look like. A Ledger only line stays
    out of Stock because a count already holds the goods, so it needs a count
    on or after the bill. A Labor line stays out of Stock altogether. A
    stock line needs a price. And an item's price per base unit should not
    swing several times over between bills: that is usually a wrong unit,
    quantity or price -- and when it is the quantity, Stock is off by the
    same factor."""
    ctx.cur.execute(
        "SELECT item_name, COALESCE(size, '') AS size, created_at "
        "FROM erp.stock_adjustments WHERE action IN ('ADJUST', 'RESET')"
    )
    counted_on: dict = {}
    for r in ctx.cur.fetchall():
        key = _item_key(r["item_name"], r["size"])
        counted_on[key] = max(counted_on.get(key, r["created_at"]), r["created_at"])

    ledger_only: dict = defaultdict(list)
    labor: dict = defaultdict(list)
    unpriced: dict = defaultdict(list)
    rates: dict = defaultdict(list)
    gst_rates: dict = defaultdict(set)
    for r in _bill_rows(ctx):
        key = _item_key(r["item_name"], r["size"])
        gst_rates[r["vendor"]].add(float(r["gst_rate_pct"] or 0))
        if r["bill_type"] == "LABOR":
            if r["affects_stock"]:
                labor[r["header_id"]].append(r)
            continue
        if not r["affects_stock"]:
            newest = counted_on.get(key)
            if newest is None or newest.date() < r["bill_date"]:
                ledger_only[r["header_id"]].append(r)
            continue
        if float(r["price"] or 0) <= 0:
            unpriced[r["header_id"]].append(r)
        elif float(r["base_rate"] or 0) > 0 and float(r["qty"] or 0) > 0:
            rates[key].append(r)

    out = []
    mixed = sorted(vendor for vendor, seen in gst_rates.items() if len(seen) > 1)
    if mixed:
        out.append(
            _finding(
                "vendor_mixed_gst",
                "entry",
                "bills",
                f"{len(mixed)} vendor(s) have bills at more than one GST rate",
                f"{_listed(mixed)}. A bill at the wrong rate has the wrong total. Right if "
                "those bills really differ; check any at 0% from a vendor who usually charges "
                "GST.",
                refs=[f"Vendor {vendor}" for vendor in mixed],
                qty=len(mixed),
            )
        )
    for rows in ledger_only.values():
        b = rows[0]
        lines = [
            f"{_sized(x['item_name'], x['size'])}: {_fmt(x['base_qty'])}" for x in rows
        ]
        out.append(
            _finding(
                "bill_ledger_only_uncounted",
                "entry",
                "bills",
                f"{_bill_ref(b)}: {len(rows)} Ledger only line(s) no count holds",
                f"{_listed(lines)}. Ledger only keeps a line out of Items Stock because a "
                f"count already holds the goods, but these have no count on or after "
                f"{b['bill_date']:%d/%m/%Y}, so the goods are in no stock figure.",
                refs=[_bill_ref(b)],
                qty=sum(float(x["base_qty"] or 0) for x in rows),
                when=b["bill_date"],
            )
        )
    for rows in labor.values():
        b = rows[0]
        out.append(
            _finding(
                "labor_line_in_stock",
                "info",
                "bills",
                f"{_bill_ref(b)}: Labor lines are counted in Items Stock",
                f"{_fmt(sum(float(x['base_qty'] or 0) for x in rows))} units of "
                f"{_listed(sorted({x['item_name'] for x in rows}))} went into Items Stock from "
                "this Labor Job bill. New Labor bills stay out of Stock; this one was left "
                "counting on purpose (decision 2026-10-14). No action needed.",
                refs=[_bill_ref(b)],
                qty=sum(float(x["base_qty"] or 0) for x in rows),
                when=b["bill_date"],
            )
        )
    for rows in unpriced.values():
        b = rows[0]
        lines = [
            f"{_sized(x['item_name'], x['size'])}: {_fmt(x['qty'])} {x['unit']}"
            for x in rows
        ]
        out.append(
            _finding(
                "bill_line_no_price",
                "entry",
                "bills",
                f"{_bill_ref(b)}: {len(rows)} stock line(s) have no price",
                f"{_listed(lines)}. The goods are in Stock at Rs 0, so the bill's value is "
                "short by whatever they cost.",
                refs=[_bill_ref(b)],
                qty=len(rows),
                when=b["bill_date"],
            )
        )
    for rows in rates.values():
        if len(rows) < 2:
            continue
        ordered = sorted(rows, key=lambda x: float(x["base_rate"]))
        low, high = ordered[0], ordered[-1]
        lo, hi = float(low["base_rate"]), float(high["base_rate"])
        if hi / lo < RATE_SPREAD_FACTOR:
            continue
        usual = statistics.median(float(x["base_rate"]) for x in rows)
        away = [
            x
            for x in rows
            if float(x["base_rate"]) < usual / RATE_SPREAD_FACTOR
            or float(x["base_rate"]) > usual * RATE_SPREAD_FACTOR
        ]
        out.append(
            _finding(
                "bill_rate_spread",
                "entry",
                "bills",
                f"{_sized(low['item_name'], low['size'])}: bill prices differ "
                f"{_fmt(round(hi / lo, 1))} times over",
                f"Lowest {_priced(low)}. Highest {_priced(high)}. The middle of "
                f"{len(rows)} line(s) is {_rs(usual)}. A wrong unit, quantity or price shows "
                "up this way; if it is the quantity, Items Stock is off by the same factor.",
                item=low["item_name"],
                size=low["size"],
                refs=[_bill_ref(low), _bill_ref(high)],
                qty=max(len(away), 1),
                when=max(x["bill_date"] for x in (away or rows)),
                evidence={"low": lo, "high": hi, "usual": usual},
            )
        )
    return out


def _check_line_values(ctx) -> list:
    """A line's value is the same however it is written: qty x price in the
    unit entered, base_qty x base_rate in the item's base unit. save_bill,
    save_po and save_return store both, so a line where they differ had one
    half changed without the other."""
    sources = (
        (
            "bills",
            """
            SELECT 'Bill ' || h.bill_number || ' (' || h.vendor || ')' AS ref,
                   h.bill_date AS day, l.item_name, COALESCE(l.size, '') AS size,
                   l.qty, l.price, l.base_qty, l.base_rate
              FROM erp.bill_lines l JOIN erp.bill_headers h ON h.id = l.header_id
             WHERE h.deleted_at IS NULL
            """,
        ),
        (
            "pos",
            """
            SELECT 'PO ' || h.po_number AS ref, h.po_date AS day, l.item_name,
                   COALESCE(l.size, '') AS size, l.qty, l.price, l.base_qty, l.base_rate
              FROM erp.po_lines l JOIN erp.po_headers h ON h.id = l.header_id
             WHERE h.deleted_at IS NULL
            """,
        ),
        (
            "returns",
            """
            SELECT 'Return ' || h.return_number AS ref, h.return_date AS day, l.item_name,
                   COALESCE(l.size, '') AS size, l.qty, l.price, l.base_qty, l.base_rate
              FROM erp.return_lines l JOIN erp.return_headers h ON h.id = l.header_id
             WHERE h.deleted_at IS NULL
            """,
        ),
    )
    out = []
    for area, sql in sources:
        ctx.cur.execute(sql)
        for r in ctx.cur.fetchall():
            entered = float(r["qty"] or 0) * float(r["price"] or 0)
            based = float(r["base_qty"] or 0) * float(r["base_rate"] or 0)
            if abs(entered - based) <= max(5 * MONEY_EPS, 1e-4 * abs(entered)):
                continue
            out.append(
                _finding(
                    "line_value_mismatch",
                    "integrity",
                    area,
                    f"{r['ref']}: {_sized(r['item_name'], r['size'])} is worth two amounts",
                    f"{_fmt(r['qty'])} x {_rs(r['price'])} = {_rs(entered)} as entered, but "
                    f"{_fmt(r['base_qty'])} x {_rs(r['base_rate'])} = {_rs(based)} in base units.",
                    item=r["item_name"],
                    size=r["size"],
                    refs=[r["ref"]],
                    qty=abs(entered - based),
                    when=r["day"],
                )
            )
    return out


def _check_duplicate_bills(ctx) -> list:
    """Two bills from one vendor, a few days apart, with identical lines:
    usually one bill entered twice under two numbers, which doubles its
    stock and its value."""
    bills: dict = {}
    for r in _bill_rows(ctx):
        b = bills.setdefault(
            r["header_id"],
            {
                "ref": _bill_ref(r),
                "vendor": _k(r["vendor"]),
                "date": r["bill_date"],
                "number": _k(r["bill_number"]),
                "amount": 0.0,
                "lines": [],
                "units": 0.0,
            },
        )
        b["amount"] += round(
            float(r["qty"] or 0)
            * float(r["price"] or 0)
            * (1 + float(r["gst_rate_pct"] or 0) / 100),
            2,
        )
        b["lines"].append(
            (
                _k(r["item_name"]),
                _k(r["size"]),
                float(r["qty"] or 0),
                float(r["price"] or 0),
            )
        )
        b["units"] += float(r["base_qty"] or 0)
    by_vendor: dict = defaultdict(list)
    for b in bills.values():
        if b["amount"] > MONEY_EPS:
            b["lines"].sort()
            by_vendor[b["vendor"]].append(b)
    out = []
    window = timedelta(days=DUPLICATE_BILL_DAYS)
    for rows in by_vendor.values():
        rows.sort(key=lambda b: b["date"])
        for i, a in enumerate(rows):
            for b in rows[i + 1 :]:
                if b["date"] - a["date"] > window:
                    break
                if a["number"] != b["number"] and a["lines"] == b["lines"]:
                    out.append(
                        _finding(
                            "possible_duplicate_bill",
                            "entry",
                            "bills",
                            f"{a['ref']} and {b['ref']} look like one bill entered twice",
                            f"Same vendor and the same {len(a['lines'])} line(s), "
                            f"{_rs(a['amount'])} each, dated {a['date']:%d/%m/%Y} and "
                            f"{b['date']:%d/%m/%Y}. If both are real, ignore this; if not, "
                            "the stock and the value are counted twice.",
                            refs=[a["ref"], b["ref"]],
                            qty=b["units"],
                            when=b["date"],
                        )
                    )
    return out


# ── Production lots ────────────────────────────────────────────────────────


def _check_lot_entries(ctx) -> list:
    """What a Completed lot used, against what it should have.

    Its ITEM components against its process's recipe x its quantity. Only
    the colour-agnostic part of a recipe is compared, and only for lots
    entered after the recipe last changed: an older lot was right by the
    recipe it was saved with, and is counted as not judged. A shortfall
    another item on the lot covers is a substitution, not a shortfall.

    Each component against where it should come from: a process output
    from the Warehouse Pool, a raw item from Items Stock. And the pool must
    have credited at least the lot's quantity (more is right: a colour group
    recorded on the same units is credited too)."""
    cur = ctx.cur
    cur.execute(
        """
        SELECT m.process_id, m.process_name, m.updated_at AS recipe_at, c.item_name,
               COALESCE(c.size, '') AS size, c.qty_per_unit, c.source_type,
               c.color_group, c.unit
          FROM erp.process_components c
          JOIN erp.process_master m ON m.id = c.master_id
         WHERE m.deleted_at IS NULL
        """
    )
    recipes: dict = defaultdict(list)
    for r in cur.fetchall():
        recipes[_k(r["process_id"])].append(r)

    used_by_lot: dict = defaultdict(lambda: defaultdict(float))
    for line in _lot_lines(ctx):
        used_by_lot[line["lot"]["id"]][line["key"]] += line["baseQty"]

    outputs = {_k(p.get("outputItemName")) for p in ctx.processes}

    def made_by(lot) -> str:
        """The bucket a lot's output belongs in. A final-stage lot may keep
        its own name (a variant is dispatched under it); earlier stages go
        on the process's output, whatever the lot calls them, because that
        is what the next stage draws on."""
        own = _k(lot["output_item_name"])
        process_id = _k(lot["process_id"])
        output = _k((ctx.process_by_id.get(process_id) or {}).get("outputItemName"))
        return (own or output) if process_id in ctx.final_ids else (output or own)

    credited: dict = defaultdict(float)
    misplaced: dict = defaultdict(lambda: defaultdict(float))
    debited: dict = defaultdict(float)
    for e in ctx.all_events:
        if e["type"] == "Production Credit":
            credited[e["ref"]] += e["inQty"]
            lot = ctx.lot_by_number.get(e["ref"])
            if lot is not None and e["bucketKey"][0] != made_by(lot):
                misplaced[e["ref"]][e["bucketKey"][0]] += e["inQty"]
        elif e["type"] in ("Production Consumption", "Colour-agnostic Consumption"):
            debited[(e["ref"], e["bucketKey"][0])] += e["outQty"] - e["inQty"]

    # Per unit of lot, each lot's colour-agnostic parts, for lots too old to
    # be judged by today's recipe. Colour-specific parts differ from lot to
    # lot by design, so they say nothing here.
    common_use: dict = {}
    part_names: dict = {}
    for lot in ctx.lots:
        qty = float(lot["qty"] or 0)
        if not lot_receipts.is_completed(lot["status"]) or qty <= 0:
            continue
        use: dict = defaultdict(float)
        for comp in lot["components_consumed"] or []:
            if (
                not isinstance(comp, dict)
                or _k(comp.get("sourceType")) == "pool"
                or not process_service._is_common_color_group(comp.get("colorGroup"))
            ):
                continue
            name, size = comp.get("itemName"), comp.get("size")
            key = _item_key(name, size)
            part_names[key] = (str(name or "").strip(), str(size or "").strip())
            use[key] += (
                _to_base(ctx, comp.get("qty"), comp.get("unit"), name, size) / qty
            )
        common_use[lot["id"]] = use
    older = []

    judged = not_judged = 0
    short: dict = defaultdict(
        lambda: {"name": "", "size": "", "lots": [], "units": 0.0, "when": None}
    )
    other_size: dict = defaultdict(
        lambda: {"name": "", "lots": [], "sizes": set(), "want": "", "when": None}
    )
    processes: dict = defaultdict(set)
    wrong_source: dict = defaultdict(list)
    uncredited = []
    pool_debits = []
    for lot in ctx.lots:
        if not lot_receipts.is_completed(lot["status"]):
            continue
        label = _lot_label(lot)
        qty = float(lot["qty"] or 0)

        pool_use: dict = defaultdict(float)
        for comp in lot["components_consumed"] or []:
            if not isinstance(comp, dict):
                continue
            name = str(comp.get("itemName") or "").strip()
            pool = _k(comp.get("sourceType")) == "pool"
            if name and pool != (_k(name) in outputs):
                wrong_source[label].append((name, pool))
            if name and pool:
                # In the unit the pool debits: Pass 2 converts, with no size.
                pool_use[name] += _to_base(
                    ctx, comp.get("qty"), comp.get("unit"), name, ""
                )
        for name, want_qty in pool_use.items():
            got = debited.get((label, _k(name)), 0.0)
            if abs(got - want_qty) > _STOCK_TOLERANCE:
                pool_debits.append((lot, label, name, want_qty, got))

        if qty > 0 and credited.get(label, 0.0) < qty - _STOCK_TOLERANCE:
            uncredited.append((lot, label, qty, credited.get(label, 0.0)))

        rows = recipes.get(_k(lot["process_id"]))
        if qty <= 0:
            continue
        if not rows:
            # No recipe to judge it by: the lots around it are all there is.
            not_judged += 1
            older.append(lot)
            continue
        recipe_at = rows[0]["recipe_at"]
        if recipe_at is not None and (
            lot["created_at"] is None or lot["created_at"] < recipe_at
        ):
            not_judged += 1
            older.append(lot)
            continue
        judged += 1

        used = used_by_lot.get(lot["id"]) or {}
        want: dict = defaultdict(float)
        names: dict = {}
        for r in rows:
            key = _item_key(r["item_name"], r["size"])
            names[key] = r
            if _k(
                r["source_type"]
            ) != "pool" and process_service._is_common_color_group(r["color_group"]):
                want[key] += _to_base(
                    ctx,
                    float(r["qty_per_unit"] or 0) * qty,
                    r["unit"],
                    r["item_name"],
                    r["size"],
                )
        gaps = []
        for key, expect in want.items():
            got = used.get(key, 0.0)
            if got < expect - max(MONEY_EPS, RECIPE_TOLERANCE * abs(expect)):
                gaps.append((key, expect - got))
        if not gaps:
            continue
        # The same item in another size is not a substitute: it is this
        # lot's stock landing on the wrong size.
        extras = {key: q for key, q in used.items() if key not in names}
        wrong_size = {}
        for key, _gap in gaps:
            item = key.partition("|")[0]
            sizes = [x for x in extras if x.partition("|")[0] == item]
            if sizes:
                wrong_size[key] = sizes
        for key, sizes in wrong_size.items():
            o = other_size[key]
            o["name"], o["want"] = names[key]["item_name"], names[key]["size"]
            o["lots"].append(label)
            o["sizes"].update(x.partition("|")[2] for x in sizes)
            o["when"] = max(o["when"] or lot["production_date"], lot["production_date"])
            for x in sizes:
                extras.pop(x, None)
        gaps = [(key, gap) for key, gap in gaps if key not in wrong_size]
        if not gaps or sum(extras.values()) >= sum(g for _k2, g in gaps) - MONEY_EPS:
            continue
        for key, gap in gaps:
            s = short[key]
            s["name"], s["size"] = names[key]["item_name"], names[key]["size"]
            s["lots"].append(label)
            s["units"] += gap
            s["when"] = max(s["when"] or lot["production_date"], lot["production_date"])
            processes[key].add(rows[0]["process_name"])

    same_output: dict = defaultdict(list)
    for lot in ctx.lots:
        if lot["id"] in common_use:
            same_output[(_k(lot["process_id"]), _k(lot["output_item_name"]))].append(
                lot
            )
    by_neighbours = 0
    unlike: dict = defaultdict(list)
    for lot in older:
        near = [
            other
            for other in same_output[
                (_k(lot["process_id"]), _k(lot["output_item_name"]))
            ]
            if other["id"] != lot["id"]
            and abs((other["production_date"] - lot["production_date"]).days)
            <= NEIGHBOUR_DAYS
        ]
        if len(near) < NEIGHBOURS_MIN:
            continue
        by_neighbours += 1
        seen: dict = defaultdict(int)
        for other in near:
            for key in common_use[other["id"]]:
                seen[key] += 1
        for key, count in seen.items():
            if count < NEIGHBOUR_SHARE * len(near):
                continue
            usual = statistics.median(
                common_use[other["id"]].get(key, 0.0) for other in near
            )
            got = common_use[lot["id"]].get(key, 0.0)
            if usual > 0 and got < usual * NEIGHBOUR_SHORT:
                unlike[key].append((lot, usual, got))

    ctx.stats["recipe"] = {
        "judged": judged,
        "byNeighbours": by_neighbours,
        "notJudged": not_judged - by_neighbours,
    }

    out = []
    for key, rows in unlike.items():
        name, size = part_names[key]
        rows.sort(key=lambda row: row[0]["production_date"])
        lots = [_lot_label(lot) for lot, _usual, _got in rows]
        out.append(
            _finding(
                "lot_unlike_its_neighbours",
                "entry",
                "production",
                f"{_sized(name, size)}: {len(lots)} older lot(s) used far less than the "
                "lots around them",
                _listed(
                    f"{_lot_label(lot)} used {_fmt(round(got, 3))} a unit where lots of the "
                    f"same output around it used {_fmt(round(usual, 3))}"
                    for lot, usual, got in rows
                )
                + ". Too old to judge by today's recipe, so these are judged by their "
                "neighbours. Items Stock still holds the difference if the part was really "
                "used.",
                item=name,
                size=size,
                refs=lots,
                qty=sum(
                    (usual - got) * float(lot["qty"] or 0) for lot, usual, got in rows
                ),
                when=rows[-1][0]["production_date"],
            )
        )
    for key, s in short.items():
        lots = sorted(s["lots"])
        out.append(
            _finding(
                "lot_short_of_recipe",
                "entry",
                "production",
                f"{_sized(s['name'], s['size'])}: {len(lots)} lot(s) used "
                f"{_fmt(round(s['units'], 3))} less than the recipe",
                f"{_listed(lots)} ({_listed(sorted(processes[key]))}) were entered after "
                "the recipe last changed and used less of it, or none, with nothing on the lot "
                f"in its place. Items Stock still holds those {_fmt(round(s['units'], 3))}. "
                "Right only if the lots really did not use them.",
                item=s["name"],
                size=s["size"],
                refs=lots,
                qty=s["units"],
                when=s["when"],
            )
        )
    for key, o in other_size.items():
        lots = sorted(o["lots"])
        out.append(
            _finding(
                "lot_used_other_size",
                "entry",
                "production",
                f"{o['name']}: {len(lots)} lot(s) used another size than the recipe's",
                f"The recipe calls for size {o['want'] or '(none)'}; {_listed(lots)} used "
                f"{_listed(sorted(o['sizes']))} instead. The stock came off the size used, so one "
                "size reads too high and the other too low if that was not what went in.",
                item=o["name"],
                size=o["want"],
                refs=lots,
                qty=len(lots),
                when=o["when"],
            )
        )
    for label, comps in wrong_source.items():
        lines = [
            f"{name} is drawn from "
            + (
                "the Warehouse Pool, which nothing makes it into"
                if pool
                else "Items Stock"
            )
            + ("" if pool else ", though a process makes it")
            for name, pool in comps
        ]
        out.append(
            _finding(
                "lot_component_source",
                "entry",
                "production",
                f"{label}: {len(comps)} component(s) come from the wrong place",
                f"{_listed(lines)}. The wrong stock moves: a process's output belongs to the "
                "Warehouse Pool, a raw item to Items Stock.",
                refs=[label],
                qty=len(comps),
            )
        )
    for lot, label, qty, got in uncredited:
        out.append(
            _finding(
                "lot_not_credited",
                "integrity",
                "production",
                f"{label} made {_fmt(qty)}, the Warehouse Pool credited {_fmt(got)}",
                "A Completed lot's whole quantity goes into the Warehouse Pool. The rest of "
                "these goods are in no pool figure.",
                refs=[label],
                qty=qty - got,
                when=lot["production_date"],
            )
        )
    for label, items in misplaced.items():
        lot = ctx.lot_by_number[label]
        out.append(
            _finding(
                "lot_credit_misplaced",
                "integrity",
                "production",
                f"{label}'s output landed on another item",
                f"It belongs on {made_by(lot)}, but the Warehouse Pool credited "
                + _listed(f"{name} ({_fmt(q)})" for name, q in sorted(items.items()))
                + ".",
                refs=[label],
                qty=sum(items.values()),
                when=lot["production_date"],
            )
        )
    for lot, label, name, want_qty, got in pool_debits:
        out.append(
            _finding(
                "lot_pool_debit_mismatch",
                "integrity",
                "production",
                f"{label} used {_fmt(want_qty)} of {name}, the Warehouse Pool took off {_fmt(got)}",
                "Every pool component of a Completed lot comes off that item's buckets, once.",
                item=name,
                refs=[label],
                qty=abs(want_qty - got),
                when=lot["production_date"],
            )
        )
    return out


# ── Issue Stock ────────────────────────────────────────────────────────────


def _same_party(a: str, b: str) -> bool:
    if a == b:
        return True
    if min(len(a), len(b)) >= 5 and (a.startswith(b) or b.startswith(a)):
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= NAME_SIMILARITY


def _check_issue_entries(ctx) -> list:
    """An issue takes goods off Items Stock when they leave the store. If
    they go to the floor or a job-worker for a lot that also lists them as a
    component, Stock takes the same goods off twice: when they were issued
    and when the lot was Completed. Issued To is typed by hand, so the same
    party typed several ways is also listed."""
    ctx.cur.execute(
        """
        SELECT h.issue_id, h.issue_date, h.issued_to, h.vendor, l.item_name,
               COALESCE(l.size, '') AS size, l.base_qty
          FROM erp.issue_lines l JOIN erp.issue_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
         ORDER BY h.issue_date, h.id, l.id
        """
    )
    issues = ctx.cur.fetchall()

    lots_of: dict = defaultdict(lambda: defaultdict(float))
    for line in _lot_lines(ctx):
        if lot_receipts.is_completed(line["lot"]["status"]):
            lots_of[line["key"]][
                (line["lot"]["production_date"], _lot_label(line["lot"]))
            ] += line["baseQty"]

    window = ISSUE_LOT_WINDOW_DAYS
    by_item: dict = {}
    for i in issues:
        key = _item_key(i["item_name"], i["size"])
        near = {
            lot: q
            for lot, q in (lots_of.get(key) or {}).items()
            if abs((lot[0] - i["issue_date"]).days) <= window
        }
        if not near:
            continue
        issued = float(i["base_qty"] or 0)
        same_day = sum(q for lot, q in near.items() if lot[0] == i["issue_date"])
        match = [lot for lot, q in near.items() if abs(q - issued) <= _STOCK_TOLERANCE]
        exact = bool(match) or abs(same_day - issued) <= _STOCK_TOLERANCE
        entry = by_item.setdefault(
            key,
            {
                "name": i["item_name"],
                "size": i["size"],
                "lines": [],
                "exact": [],
                "lots": set(),
                "issued": 0.0,
                "doubled": 0.0,
                "when": i["issue_date"],
            },
        )
        text = (
            f"{_fmt(issued)} issued to {i['issued_to']} on {i['issue_date']:%d/%m/%Y} "
            f"({i['issue_id']})"
        )
        entry["lines"].append(text)
        entry["issued"] += issued
        entry["when"] = max(entry["when"], i["issue_date"])
        entry["lots"].update(lot[1] for lot in near)
        if exact:
            lots = [lot[1] for lot in match] or [
                lot[1] for lot in near if lot[0] == i["issue_date"]
            ]
            entry["doubled"] += issued
            entry["exact"].append(
                f"{text}, and {_listed(sorted(lots))} used exactly that"
            )

    out = []
    for e in by_item.values():
        lots = sorted(e["lots"])
        if e["exact"]:
            out.append(
                _finding(
                    "issued_and_used_by_lot",
                    "entry",
                    "issues",
                    f"{_sized(e['name'], e['size'])}: {_fmt(e['doubled'])} may have come off "
                    "Stock twice",
                    f"{_listed(e['exact'])}. Items Stock took both off. If they are the same "
                    "goods, it is too low by the quantity issued.",
                    item=e["name"],
                    size=e["size"],
                    refs=lots,
                    qty=e["doubled"],
                    when=e["when"],
                )
            )
        else:
            out.append(
                _finding(
                    "issued_item_also_used_by_lots",
                    "entry",
                    "issues",
                    f"{_sized(e['name'], e['size'])} is both issued and used by lots",
                    f"{_listed(e['lines'])}. {len(lots)} lot(s) within "
                    f"{ISSUE_LOT_WINDOW_DAYS} days also list it as a component, and each "
                    "takes it off Items Stock. Ignore this if the issued goods went "
                    "somewhere else.",
                    item=e["name"],
                    size=e["size"],
                    refs=lots,
                    qty=e["issued"],
                    when=e["when"],
                )
            )

    documents: dict = defaultdict(set)
    for i in issues:
        name = str(i["issued_to"] or "").strip()
        if name:
            documents[name].add(i["issue_id"])
    spellings = {name: len(ids) for name, ids in documents.items()}

    # An issue shows in a Vendor Ledger through the vendor it stored, which
    # save_issue_stock finds only for the exact name (case aside).
    ctx.cur.execute("SELECT vendor_name FROM erp.vendors WHERE deleted_at IS NULL")
    vendors = {_squash(r["vendor_name"]): r["vendor_name"] for r in ctx.cur.fetchall()}
    astray: dict = defaultdict(set)
    for i in issues:
        vendor = vendors.get(_squash(i["issued_to"]))
        if vendor and _k(i["vendor"]) != _k(vendor):
            astray[(str(i["issued_to"]).strip(), vendor)].add(i["issue_id"])
    for (name, vendor), ids in sorted(astray.items()):
        ids = sorted(ids)
        out.append(
            _finding(
                "issue_not_in_vendor_ledger",
                "entry",
                "issues",
                f"{len(ids)} issue(s) to {name} are missing from {vendor}'s Vendor Ledger",
                f"{_listed(ids)}: Issued To is spelled {name}, the vendor {vendor}, so the issue "
                "is on Items Stock but not in the vendor's ledger.",
                refs=[f"Vendor {vendor}"] + [f"Issue {n}" for n in ids],
                qty=len(ids),
            )
        )

    clusters: list = []
    for name in sorted(spellings, key=lambda n: -spellings[n]):
        squashed = _squash(name)
        for cluster in clusters:
            if any(_same_party(squashed, s) for s, _n in cluster):
                cluster.append((squashed, name))
                break
        else:
            clusters.append([(squashed, name)])
    for cluster in clusters:
        if len(cluster) < 2:
            continue
        names = [n for _s, n in cluster]
        out.append(
            _finding(
                "issued_to_variants",
                "entry",
                "issues",
                f"Issue Stock names one party {len(names)} ways: {names[0]}",
                "Issued To: "
                + ", ".join(f"{n} ({spellings[n]} issue(s))" for n in names)
                + ". Anything added up by party is split between them.",
                refs=[f"Issued to {n}" for n in names],
                qty=len(names),
            )
        )
    return out


# ── Returns ────────────────────────────────────────────────────────────────


def _check_return_entries(ctx) -> list:
    """A return sends back goods that were billed. More of an item than the
    bill it names ever billed is a quantity typed wrong or the wrong bill; a
    price unlike that bill's misstates what the vendor owes back; no price
    at all records it as Rs 0; and with no bill named, the vendor should at
    least have billed the item. (An item the named bill never billed is the
    ledger reconciliation's return_item_not_on_bill.)"""
    billed: dict = defaultdict(float)
    bill_rates: dict = defaultdict(list)
    vendor_rates: dict = defaultdict(list)
    bill_dates: dict = {}
    for r in _bill_rows(ctx):
        vendor, item = _k(r["vendor"]), _item_key(r["item_name"], r["size"])
        billed[(vendor, _k(r["bill_number"]), item)] += float(r["base_qty"] or 0)
        bill_dates[(vendor, _k(r["bill_number"]))] = r["bill_date"]
        rate = float(r["base_rate"] or 0)
        if rate > 0:
            bill_rates[(vendor, _k(r["bill_number"]), item)].append(rate)
            vendor_rates[(vendor, item)].append(rate)

    ctx.cur.execute(
        """
        SELECT h.id, h.return_number, h.vendor, h.bill_number, h.return_date,
               l.item_name, COALESCE(l.size, '') AS size, l.qty, l.unit, l.price,
               l.base_qty, l.base_rate
          FROM erp.return_lines l JOIN erp.return_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
         ORDER BY h.return_date, h.id, l.id
        """
    )
    returned: dict = defaultdict(lambda: [0.0, set(), None, None])
    no_value: dict = defaultdict(list)
    rate_differs: dict = defaultdict(list)
    never_billed: dict = defaultdict(list)
    before_bill: dict = {}
    for r in ctx.cur.fetchall():
        vendor, item = _k(r["vendor"]), _item_key(r["item_name"], r["size"])
        bill = _k(r["bill_number"])
        qty = float(r["base_qty"] or 0)
        if float(r["price"] or 0) <= 0:
            no_value[r["id"]].append(r)
        bill_day = bill_dates.get((vendor, bill))
        if bill_day and r["return_date"] < bill_day:
            before_bill[r["id"]] = (r, bill_day)
        if bill:
            key = (vendor, bill, item)
            entry = returned[key]
            entry[0] += qty
            entry[1].add(str(r["return_number"]))
            entry[2] = r
            entry[3] = max(entry[3] or r["return_date"], r["return_date"])
            rates = bill_rates.get(key)
            rate = float(r["base_rate"] or 0)
            if (
                rates
                and rate > 0
                and not (
                    min(rates) * (1 - RETURN_RATE_TOLERANCE)
                    <= rate
                    <= max(rates) * (1 + RETURN_RATE_TOLERANCE)
                )
            ):
                rate_differs[r["id"]].append((r, min(rates)))
        elif (vendor, item) not in vendor_rates:
            never_billed[r["id"]].append(r)

    out = []
    for key, (qty, numbers, r, when) in returned.items():
        got = billed.get(key, 0.0)
        if got <= 0 or qty <= got + _STOCK_TOLERANCE:
            continue
        out.append(
            _finding(
                "return_exceeds_bill",
                "entry",
                "returns",
                f"More {_sized(r['item_name'], r['size'])} returned than bill "
                f"{r['bill_number']} billed",
                f"Return(s) {_listed(sorted(numbers))} send back {_fmt(qty)} base units against "
                f"bill {r['bill_number']} ({r['vendor']}), which billed {_fmt(got)}. Items Stock "
                f"took the whole {_fmt(qty)} off.",
                item=r["item_name"],
                size=r["size"],
                refs=[f"Bill {r['bill_number']} ({r['vendor']})"]
                + [f"Return {n}" for n in sorted(numbers)],
                qty=qty - got,
                when=when,
            )
        )
    for rows in no_value.values():
        r = rows[0]
        value = 0.0
        for x in rows:
            rates = vendor_rates.get(
                (_k(x["vendor"]), _item_key(x["item_name"], x["size"]))
            )
            if rates:
                value += float(x["base_qty"] or 0) * statistics.mean(rates)
        lines = [
            f"{_sized(x['item_name'], x['size'])}: {_fmt(x['qty'])} {x['unit']}"
            for x in rows
        ]
        worth = (
            f" At this vendor's bill prices that is about {_rs(value)}."
            if value
            else ""
        )
        out.append(
            _finding(
                "return_without_value",
                "entry",
                "returns",
                f"Return {r['return_number']} ({r['vendor']}): {len(rows)} line(s) have no price",
                f"{_listed(lines)}. The goods came off Items Stock, but what the vendor owes "
                f"back for them is recorded as Rs 0.{worth}",
                refs=[f"Return {r['return_number']}"],
                qty=value or len(rows),
                when=r["return_date"],
            )
        )
    for rows in rate_differs.values():
        r = rows[0][0]
        lines = [
            f"{_sized(x['item_name'], x['size'])}: {_rs(x['base_rate'])} a base unit against "
            f"{_rs(rate)} on the bill"
            for x, rate in rows
        ]
        out.append(
            _finding(
                "return_rate_differs",
                "entry",
                "returns",
                f"Return {r['return_number']} ({r['vendor']}) is priced unlike bill "
                f"{r['bill_number']}",
                f"{_listed(lines)}. What the vendor owes back is misstated by the difference.",
                refs=[f"Return {r['return_number']}", f"Bill {r['bill_number']}"],
                qty=sum(
                    abs(float(x["base_rate"] or 0) - rate) * float(x["base_qty"] or 0)
                    for x, rate in rows
                ),
                when=r["return_date"],
            )
        )
    for r, bill_day in before_bill.values():
        out.append(
            _finding(
                "return_before_bill",
                "entry",
                "returns",
                f"Return {r['return_number']} is dated before bill {r['bill_number']}",
                f"Returned {r['return_date']:%d/%m/%Y}, billed {bill_day:%d/%m/%Y}. Goods cannot "
                "go back before they were billed: one of the dates, or the bill named, is wrong.",
                refs=[f"Return {r['return_number']}", f"Bill {r['bill_number']}"],
                qty=1,
                when=r["return_date"],
            )
        )
    for rows in never_billed.values():
        r = rows[0]
        lines = [
            f"{_sized(x['item_name'], x['size'])}: {_fmt(x['qty'])} {x['unit']}"
            for x in rows
        ]
        out.append(
            _finding(
                "return_item_never_billed",
                "entry",
                "returns",
                f"Return {r['return_number']}: {r['vendor']} never billed these items",
                f"{_listed(lines)}. The return names no bill, and no bill from {r['vendor']} "
                "has them. Check the vendor or the item picked.",
                refs=[f"Return {r['return_number']}"],
                qty=len(rows),
                when=r["return_date"],
            )
        )
    return out


# ── Wastage ────────────────────────────────────────────────────────────────


def _names_a_lot(ctx, text) -> bool:
    """Is this a lot number, with or without its LOT- prefix?"""
    name = _k(text)
    if not name:
        return False
    lots = getattr(ctx, "_lot_numbers_cache", None)
    if lots is None:
        lots = {_k(number) for number in ctx.lot_by_number}
        ctx._lot_numbers_cache = lots
    return name in lots or f"lot-{name}" in lots


def _check_wastage_entries(ctx) -> list:
    """A wastage line comes off one of two places. From the Warehouse Pool
    it must reach the pool: every such line has to appear in the pool's own
    replay. From Items Stock it must name something Stock holds: a process's
    output written off Items Stock takes it from the wrong place, and
    leaves the pool holding goods that are gone. A note has no field for the
    lot it came from, so a lot number typed into Vendor is listed together:
    it is a reference, not a party."""
    cur = ctx.cur
    cur.execute(
        """
        SELECT h.wastage_id, h.wastage_date, h.vendor, l.item_name,
               COALESCE(l.size, '') AS size,
               l.qty, l.base_qty, l.source_type, l.product_tag, l.color
          FROM erp.wastage_lines l JOIN erp.wastage_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
         ORDER BY h.wastage_date, h.id, l.id
        """
    )
    rows = cur.fetchall()
    cur.execute("SELECT item_name FROM erp.items WHERE deleted_at IS NULL")
    in_master = {_k(r["item_name"]) for r in cur.fetchall()}
    outputs = {_k(p.get("outputItemName")) for p in ctx.processes}

    # By note, item and tag, not colour: Pass 2b finds a composite bucket
    # whatever order its segments are spelled in, so the colour on the line
    # need not be the bucket's own spelling.
    reached: dict = defaultdict(float)
    for e in ctx.all_events:
        if e["type"] == "Wastage":
            key = (str(e["ref"]), e["bucketKey"][0], e["bucketKey"][1])
            reached[key] += e["outQty"] - e["inQty"]

    taken: dict = defaultdict(lambda: [0.0, None])
    wrong_source: dict = defaultdict(list)
    lots_as_vendor: dict = {}
    for r in rows:
        if _names_a_lot(ctx, r["vendor"]):
            lots_as_vendor[r["wastage_id"]] = r
        name = _k(r["item_name"])
        if _k(r["source_type"]) == "pool":
            key = (str(r["wastage_id"]), name, _k(r["product_tag"]))
            taken[key][0] += float(r["base_qty"] or 0) or float(r["qty"] or 0)
            taken[key][1] = r
        elif name in outputs and name not in in_master:
            wrong_source[r["wastage_id"]].append(r)

    out = []
    for key, (qty, r) in taken.items():
        got = reached.get(key, 0.0)
        if abs(got - qty) <= _STOCK_TOLERANCE:
            continue
        out.append(
            _finding(
                "wastage_not_in_pool",
                "integrity",
                "wastage",
                f"Wastage {r['wastage_id']}: {r['item_name']} did not reach the Warehouse Pool",
                f"{_fmt(qty)} written off {r['color'] or '(no colour)'}, but the pool took off "
                f"{_fmt(got)}.",
                item=r["item_name"],
                colour=r["color"] or "",
                refs=[f"Wastage {r['wastage_id']}"],
                qty=abs(got - qty),
                when=r["wastage_date"],
            )
        )
    if lots_as_vendor:
        rows = sorted(lots_as_vendor.values(), key=lambda r: r["wastage_date"])
        out.append(
            _finding(
                "wastage_lot_in_vendor",
                "entry",
                "wastage",
                f"{len(rows)} wastage note(s) have a lot number as their vendor",
                _listed(f"{r['wastage_id']}: {r['vendor']}" for r in rows)
                + ". The lot number is a useful note, but it is not a vendor, and no ledger "
                "ties the wastage to that lot.",
                refs=[f"Wastage {r['wastage_id']}" for r in rows],
                qty=len(rows),
                when=rows[-1]["wastage_date"],
            )
        )
    for wastage_id, lines in wrong_source.items():
        r = lines[0]
        out.append(
            _finding(
                "wastage_wrong_source",
                "entry",
                "wastage",
                f"Wastage {wastage_id}: processed goods written off Items Stock",
                f"{_listed(sorted({x['item_name'] for x in lines}))} is made by a process and "
                "lives in the Warehouse Pool, but this note takes it off Items Stock, so the "
                "pool still shows it.",
                refs=[f"Wastage {wastage_id}"],
                qty=sum(float(x["base_qty"] or 0) for x in lines),
                when=r["wastage_date"],
            )
        )
    return out


# ── Stored ids against the names on the entry ──────────────────────────────


_PARTY_IDS = (
    (
        "bills",
        "SELECT 'Bill ' || h.bill_number AS ref, h.vendor AS name, m.vendor_name AS id_name, "
        "m.deleted_at IS NOT NULL AS gone FROM erp.bill_headers h "
        "JOIN erp.vendors m ON m.id = h.vendor_id WHERE h.deleted_at IS NULL",
    ),
    (
        "pos",
        "SELECT 'PO ' || h.po_number AS ref, h.vendor AS name, m.vendor_name AS id_name, "
        "m.deleted_at IS NOT NULL AS gone FROM erp.po_headers h "
        "JOIN erp.vendors m ON m.id = h.vendor_id WHERE h.deleted_at IS NULL",
    ),
    (
        "returns",
        "SELECT 'Return ' || h.return_number AS ref, h.vendor AS name, m.vendor_name AS id_name, "
        "m.deleted_at IS NOT NULL AS gone FROM erp.return_headers h "
        "JOIN erp.vendors m ON m.id = h.vendor_id WHERE h.deleted_at IS NULL",
    ),
    (
        "contractors",
        "SELECT h.lot_number AS ref, h.assigned_to AS name, m.contractor_name AS id_name, "
        "m.deleted_at IS NOT NULL AS gone FROM erp.production h "
        "JOIN erp.contractors m ON m.id = h.contractor_id WHERE h.deleted_at IS NULL",
    ),
    (
        "contractors",
        "SELECT 'Payment #' || h.id AS ref, h.contractor_name AS name, "
        "m.contractor_name AS id_name, m.deleted_at IS NOT NULL AS gone "
        "FROM erp.contractor_payments h JOIN erp.contractors m ON m.id = h.contractor_id",
    ),
    (
        "contractors",
        "SELECT 'Dispatch ' || h.dispatch_number AS ref, h.logistics_contractor AS name, "
        "m.contractor_name AS id_name, m.deleted_at IS NOT NULL AS gone "
        "FROM erp.dispatch_headers h JOIN erp.contractors m ON m.id = h.contractor_id "
        "WHERE h.deleted_at IS NULL",
    ),
)

_LINE_TABLES = (
    ("bills", "erp.bill_lines", "erp.bill_headers", "'Bill ' || h.bill_number"),
    ("pos", "erp.po_lines", "erp.po_headers", "'PO ' || h.po_number"),
    (
        "returns",
        "erp.return_lines",
        "erp.return_headers",
        "'Return ' || h.return_number",
    ),
    (
        "wastage",
        "erp.wastage_lines",
        "erp.wastage_headers",
        "'Wastage ' || h.wastage_id",
    ),
    ("issues", "erp.issue_lines", "erp.issue_headers", "'Issue ' || h.issue_id"),
)


def _check_recorded_ids(ctx) -> list:
    """An entry names its party or item, and stores that record's id beside
    the name. Every ledger goes by the name, so the two must point at one
    record, or the entry sits under one record for the screens and another
    for anything reading the id. An id left on a record merged away is
    listed as information: no figure reads it."""
    cur = ctx.cur
    conflicts = []
    merged: dict = defaultdict(list)

    def judge(area, ref, shown, id_shown, gone):
        if _k(shown) == _k(id_shown):
            return
        if gone:
            merged[area].append(ref)
        else:
            conflicts.append((area, ref, shown, id_shown))

    for area, sql in _PARTY_IDS:
        cur.execute(sql)
        for r in cur.fetchall():
            judge(area, r["ref"], r["name"], r["id_name"], r["gone"])
    for area, lines, headers, ref in _LINE_TABLES:
        cur.execute(
            f"""
            SELECT {ref} AS ref, l.item_name, COALESCE(l.size, '') AS size,
                   m.item_name AS id_name, COALESCE(m.size, '') AS id_size,
                   m.deleted_at IS NOT NULL AS gone
              FROM {lines} l
              JOIN {headers} h ON h.id = l.header_id
              JOIN erp.items m ON m.id = l.item_id
             WHERE h.deleted_at IS NULL
            """
        )
        for r in cur.fetchall():
            judge(
                area,
                r["ref"],
                _sized(r["item_name"], r["size"]),
                _sized(r["id_name"], r["id_size"]),
                r["gone"],
            )

    out = [
        _finding(
            "entry_points_at_other_record",
            "integrity",
            area,
            f"{ref} names {shown}, but its stored id is {id_shown}",
            "Both are live records. Every ledger shows this entry under the name, and anything "
            "reading the id finds it under the other one.",
            refs=[ref],
            qty=1,
        )
        for area, ref, shown, id_shown in conflicts
    ]
    for area, refs in merged.items():
        refs = sorted(set(refs))
        out.append(
            _finding(
                "entry_points_at_merged_record",
                "info",
                area,
                f"{len(refs)} document(s) keep the id of a record merged away",
                f"{_listed(refs)}: the name was updated when the record was merged, its stored "
                "id was not. Every ledger goes by the name, so no figure moved.",
                refs=refs,
                qty=len(refs),
            )
        )
    return out


# ── Entries made twice ─────────────────────────────────────────────────────


_DUPLICATE_SOURCES = (
    (
        "Issue",
        "issues",
        """
        SELECT h.id, h.issue_id AS number, h.issue_date AS day, h.issued_to AS party,
               l.item_name, COALESCE(l.size, '') AS size, l.qty
          FROM erp.issue_lines l JOIN erp.issue_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "Wastage",
        "wastage",
        """
        SELECT h.id, h.wastage_id AS number, h.wastage_date AS day, '' AS party,
               l.item_name, COALESCE(l.size, '') AS size, l.qty
          FROM erp.wastage_lines l JOIN erp.wastage_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "Return",
        "returns",
        """
        SELECT h.id, h.return_number AS number, h.return_date AS day, h.vendor AS party,
               l.item_name, COALESCE(l.size, '') AS size, l.qty
          FROM erp.return_lines l JOIN erp.return_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "PO",
        "pos",
        """
        SELECT h.id, h.po_number AS number, h.po_date AS day, h.vendor AS party,
               l.item_name, COALESCE(l.size, '') AS size, l.qty
          FROM erp.po_lines l JOIN erp.po_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "Dispatch",
        "dispatch",
        """
        SELECT h.id, h.dispatch_number AS number, h.dispatch_date AS day,
               h.client_name AS party, l.product_id AS item_name, '' AS size, l.qty
          FROM erp.dispatch_lines l JOIN erp.dispatch_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "Payment",
        "contractors",
        """
        SELECT id, id::text AS number, payment_date AS day, contractor_name AS party,
               'payment' AS item_name, '' AS size, amount AS qty
          FROM erp.contractor_payments
        """,
    ),
)


def _check_duplicate_entries(ctx) -> list:
    """Two documents of one kind, on one date, for one party, with identical
    lines: the same entry saved twice, which takes the goods off twice.
    (Lots and bills have their own checks.)"""
    out = []
    for kind, area, sql in _DUPLICATE_SOURCES:
        ctx.cur.execute(sql)
        docs: dict = {}
        for r in ctx.cur.fetchall():
            d = docs.setdefault(
                r["id"],
                {
                    "number": r["number"],
                    "day": r["day"],
                    "party": r["party"],
                    "lines": [],
                },
            )
            d["lines"].append((_k(r["item_name"]), _k(r["size"]), float(r["qty"] or 0)))
        groups: dict = defaultdict(list)
        for d in docs.values():
            groups[(d["day"], _k(d["party"]), tuple(sorted(d["lines"])))].append(d)
        for (day, _party, lines), rows in groups.items():
            if len(rows) < 2:
                continue
            numbers = sorted(str(d["number"]) for d in rows)
            who = f" for {rows[0]['party']}" if rows[0]["party"] else ""
            out.append(
                _finding(
                    "possible_duplicate_entry",
                    "entry",
                    area,
                    f"{kind} {' and '.join(numbers[:2])} look like one entry saved twice",
                    f"{_listed(numbers)}: same date ({day:%d/%m/%Y}){who} and the same "
                    f"{len(lines)} line(s). If not both real, it is counted twice in its "
                    "ledger.",
                    refs=[f"{kind} {n}" for n in numbers],
                    qty=sum(q for _n, _s, q in lines),
                    when=day,
                )
            )
    return out
