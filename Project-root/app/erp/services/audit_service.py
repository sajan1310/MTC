"""The Audit report: what went wrong, where, and how much it matters.

Pressed from the Dashboard (admin only), it checks the whole ERP and lists
its findings, highest priority first, for a person to review. Findings the
user picks are copied out as a brief for Claude Code to investigate. The
audit itself never fixes anything.

Two kinds of finding, kept apart on purpose:

- **integrity** -- the code's own figures disagree with each other: the
  stored Warehouse Pool against a fresh calculation, a pool ledger against
  its balance, the Stock page against the replay the Item Ledger is built
  from, a reference to an item or process that no longer exists. Entry
  mistakes cannot cause these. Every one is a code bug.
- **entry** -- the figures are calculated correctly from entries that look
  wrong: a colour driven negative, a lot consuming what had not been made,
  a negative typed over with 0, a Labor Job bill with no lot behind it.
  Each names the lot, bill or count to look at.

`info` findings are expected states the user decided not to treat as
errors -- a finished-goods colour negative because bundles are dispatched
in mixed colours while the product as a whole is fine (2026-10-15), or the
bare colour buckets ambiguous lots leave behind (2026-09-07).

Every module with a ledger or a calculation is covered (_AREAS lists them;
the report's coverage line says which checks ran for each, so a module
with nothing to report reads as checked):

- Warehouse Pool: stored figures, every bucket's real Pool Ledger, negatives,
  hand edits, counts.
- Items Stock: the Stock page against every item's real Item Ledger, the
  movement replay, and a statement rebuilt from every entry (audit_entries);
  negative stock, items that move with no Stock row, counts and completions.
- Production lots, Received bills, Issue Stock, Returns, Wastage: each
  entry's own calculations and whether it reached Stock (audit_entries);
  for lots also colours against quantity, completion times, receipts
  (migration 055), lots left open, duplicates, status toggles; for bills
  also links to POs that fulfil nothing or the wrong thing, and prices
  above the PO.
- Purchase Orders: over-billing (the hourly reconciliation in
  ledger_audit_service), status against pending.
- Contractor ledger: each lot's payable against its rate, lots carrying no
  rate, the ledger list against each account statement, overpayment,
  dispatch logistics cost.
- Dispatch and client orders: amounts, dispatches against their
  PI / Estimate and the pool, the Dispatch Plan, orders pushed to lots.
- Processes and BOM: recipes that cannot work, BOM costing against recipes.
- Inspection: lots completed or changed around their inspection.
- Units: units missing from the master, stored base quantities that no
  longer match today's conversion.
- Masters: names used on documents but missing from their master, and one
  party spelled two ways.
- Dashboard: its month totals, separate SQL, against the ledgers.
- Every ledger's reader: each entry shown once, and its all-time total
  against the lines.

Read-only on business data: the checks run in a READ ONLY transaction, and
the only rows this module writes are its own -- erp.audit_runs and
erp.audit_finding_reviews (migration 052).
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta

import psycopg2.extras
from flask import current_app

import database
from . import (
    audit_entries,
    bill_service,
    bom_service,
    contractors_service,
    dashboard_service,
    dispatch_service,
    inspection_service,
    issue_service,
    items_service,
    ledger_audit_service,
    lot_receipts,
    po_service,
    process_service,
    production_service,
    return_service,
    stock_service,
    units_service,
    warehouse_service,
    wastage_service,
)
from .. import config_maps
from .audit_common import (
    _bill_ref,
    _bill_rows,
    _EPS,
    _finding,
    _fmt,
    _k,
    _label,
    _listed,
    _lot_label,
    _rs,
    _sized,
    _squash,
    MONEY_EPS,
)
from .current_user import get_current_user_id
from ..envelope import build_response
from ..registry import rpc_method

logger = logging.getLogger(__name__)

# ── Thresholds ─────────────────────────────────────────────────────────────
# A hand edit followed this soon by a lot consuming exactly the edited
# figure was made to let that lot through (seen 02/10 and 06/10/2026).
PATCH_WINDOW = timedelta(minutes=10)
# A Labor Job bill is matched to a lot of its process dated this close.
LABOR_LOT_WINDOW_DAYS = 7
# A pool edit on the bill's output this soon after a Labor Job bill is the
# bill being typed into the pool by hand (bill 1210, 12/10/2026).
LABOR_EDIT_WINDOW = timedelta(minutes=30)
# Two lots of one process, same qty and colours, saved this close together.
DUPLICATE_LOT_WINDOW = timedelta(minutes=10)
# Count variances worth listing, and how far back.
COUNT_VARIANCE_MIN_UNITS = 20.0
COUNT_VARIANCE_LOOKBACK_DAYS = 30
COUNT_VARIANCE_MAX_LISTED = 25
# A colour that went negative and recovered: only recent dips are listed.
DIP_LOOKBACK_DAYS = 30
# Processes that send material out to a job-worker when the lot STARTS.
# Their consumption rightly takes effect on the lot's date, so a count
# taken before such a lot was marked Completed is not a problem.
JOB_WORK_PROCESS_TYPES = frozenset(
    {"frame painting", "mudguard paint", "powder coating"}
)
# A lot In Progress this long with nothing received recently has probably
# come back and not been marked: what it makes is missing from the pool.
STALE_LOT_DAYS = 21
# A bill price this much above its PO's price, in the same unit, is charged
# above what was agreed.
RATE_OVER_PO_TOLERANCE = 0.005
# A stored base quantity this far from today's conversion (relative).
BASE_QTY_TOLERANCE = 0.001
# A contractor paid more than earned by at least this many rupees.
OVERPAID_MIN = 1.0
# An inspection flagged for an admin and left this long.
INSPECTION_REVIEW_DAYS = 3
# A Dispatch Plan line still open this long after its date.
PLAN_OVERDUE_DAYS = 7
# A document dated this far from the day it was entered sits in the wrong
# period of every ledger: usually a typed month or year.
ENTRY_DATE_GAP_DAYS = 45

# How long a run may stay RUNNING before it is treated as interrupted (a
# worker recycled mid-run never reaches its own finally).
STALE_RUN_AFTER = timedelta(minutes=15)

# One snapshot for the whole in-transaction part of a run. READ ONLY alone
# stays READ COMMITTED, where each statement sees the latest commit: a lot
# saved between the pool's replay and the read of the stored pool would look
# like a stale pool, and a code bug. Must be the transaction's first statement.
_SNAPSHOT_SQL = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"

# Distinct from ledger_audit_service (918_273_645) and backup_service
# (918_273_646).
_AUDIT_LOCK_KEY = 918_273_647

_KIND_BASE = {"integrity": 1000.0, "entry": 100.0, "info": 0.0}

# The highest band a check can reach. During data settlement counts are
# taken precisely to find variances, so a big one is something to review,
# not to act on today; Items Stock keeps judging lots by their date by
# decision (2026-10-15), so a count taken before completion is a maybe; and
# since migration 051 a status toggle no longer moves the pool by itself.
_BAND_CAP = {
    "large_count_variance": "P3",
    "count_before_completion": "P3",
    "status_toggled": "P3",
    # Old bills naming POs deleted since: save_bill now refuses that link,
    # and the dead PO has no pending figure left to distort.
    "bill_names_missing_po": "P3",
    # An advance is a legitimate overpayment.
    "contractor_overpaid": "P3",
    "lot_stuck_in_progress": "P3",
    # The bill form shows a price above the PO's and keeps the bill's by
    # choice: the PO figure is often just a quote.
    "bill_rate_above_po": "P3",
    # Work paid outside the rate cards is not an error, and a hand-entered
    # figure on a lot is the operator's call; these, a return with no value
    # yet, and goods that may be issued twice are for this week, not today.
    "lot_without_rate": "P2",
    "lot_short_of_recipe": "P2",
    "return_without_value": "P2",
    "return_rate_differs": "P2",
    "bill_rate_spread": "P2",
    "issued_and_used_by_lot": "P2",
    # Nothing says these are the same goods; only that they could be.
    "issued_item_also_used_by_lots": "P3",
    "issued_to_variants": "P3",
    "lot_unlike_its_neighbours": "P3",
    "vendor_mixed_gst": "P3",
    "dispatch_no_logistics_rate": "P3",
    # Still open, not wrong.
    "inspection_open_on_completed_lot": "P3",
    "inspection_review_waiting": "P3",
    "plan_line_overdue": "P3",
}

# The modules the report says it checked, in the order it lists them. Every
# finding's `area` is one of these. The five that move Items Stock come
# straight after it, each under its own name.
_AREAS = (
    ("pool", "Warehouse Pool"),
    ("stock", "Items Stock"),
    ("production", "Production lots"),
    ("bills", "Received bills"),
    ("issues", "Issue Stock"),
    ("returns", "Returns"),
    ("wastage", "Wastage"),
    ("pos", "Purchase Orders"),
    ("contractors", "Contractor ledger"),
    ("dispatch", "Dispatch and client orders"),
    ("processes", "Processes and BOM"),
    ("inspection", "Inspection"),
    ("units", "Units and conversions"),
    ("references", "Masters and references"),
    ("dashboard", "Dashboard"),
)


# ── Shared context ─────────────────────────────────────────────────────────


class _Context:
    """Everything the checks read, loaded once on the audit's cursor."""

    def __init__(self, cur):
        self.cur = cur
        self.processes = process_service._get_all_processes(cur)
        self.process_by_id = {
            p["processId"].strip().lower(): p
            for p in self.processes
            if p.get("processId")
        }
        self.process_by_name = {
            p["processName"].strip().lower(): p
            for p in self.processes
            if p.get("processName")
        }
        self.final_ids = {
            p["processId"].strip().lower() for p in self.processes if p["isFinalStage"]
        }
        self.final_outputs = {
            p["outputItemName"].strip().lower()
            for p in self.processes
            if p["isFinalStage"] and p.get("outputItemName")
        }

        # The pool as it stands, with its ledger lines, and the same replay
        # with no count freezing anything (the history behind each count).
        self.live_events: list = []
        self.buckets = warehouse_service._build_warehouse_pool_buckets(
            cur, events=self.live_events
        )
        self.all_events: list = []
        self.opening_keys: dict = {}
        warehouse_service._build_warehouse_pool_buckets(
            cur,
            events=self.all_events,
            apply_anchors=False,
            opening_keys=self.opening_keys,
        )

        cur.execute(
            """
            SELECT id, lot_number, process_id, production_date, created_at,
                   completed_at, status, qty, color_breakdown, components_consumed,
                   assigned_to, contractor_rate, contractor_payable,
                   extra_charge_type, extra_charge_amount, output_item_name,
                   production_date::timestamptz AS midnight
              FROM erp.production
             WHERE deleted_at IS NULL
            """
        )
        self.lots = cur.fetchall()
        self.lot_by_number = {
            str(r["lot_number"] or "").strip(): r for r in self.lots if r["lot_number"]
        }
        self.receipts_by_lot = lot_receipts.load_receipts(cur)
        self.today = date.today()
        # What the run checked, for the report (audit_entries fills it).
        self.stats: dict = {}
        self._stock_terms = None

    def stock_terms(self):
        """Current Stock's terms, read once for the checks that need them."""
        if self._stock_terms is None:
            self._stock_terms = stock_service._get_stock_terms(self.cur)
        return self._stock_terms

    def is_final_bucket(self, key, bucket) -> bool:
        return (
            bucket["processId"].strip().lower() in self.final_ids
            or key[0] in self.final_outputs
        )


def _bucket_key(name, tag, colour):
    return (
        str(name or "").strip().lower(),
        str(tag or "").strip().lower(),
        str(colour or "").strip().lower(),
    )


def _available(bucket) -> float:
    return bucket["producedQty"] - bucket["consumedQty"]


# ── Integrity checks (a hit is a code bug) ─────────────────────────────────


def _check_pool_cache(ctx: _Context) -> list:
    """erp.warehouse_pool is a cache rebuilt on every save that touches the
    pool. What the screens show must equal a fresh calculation."""
    ctx.cur.execute(
        "SELECT output_item_name, product_tag, color, produced_qty, consumed_qty, "
        "available_qty FROM erp.warehouse_pool WHERE output_item_name <> ''"
    )
    stored = {
        _bucket_key(r["output_item_name"], r["product_tag"], r["color"]): r
        for r in ctx.cur.fetchall()
    }
    fresh = {k: b for k, b in ctx.buckets.items() if b["outputItemName"]}

    by_item: dict = defaultdict(list)
    for key in set(stored) | set(fresh):
        s = stored.get(key)
        b = fresh.get(key)
        shown = float(s["available_qty"]) if s else None
        calc = _available(b) if b else None
        if shown is not None and calc is not None and abs(shown - calc) <= _EPS:
            continue
        if shown is None and calc is not None and abs(calc) <= _EPS:
            continue
        name = (
            (b or {}).get("outputItemName")
            or (s or {}).get("output_item_name")
            or key[0]
        )
        colour = (b or {}).get("color") or (s or {}).get("color") or ""
        by_item[name].append((colour, key[1], shown, calc))

    out = []
    for name, rows in by_item.items():
        rows.sort()
        lines = [
            f"{c or '(no colour)'}{f' [{t}]' if t else ''}: shows "
            f"{'—' if s is None else _fmt(s)}, calculates {'—' if v is None else _fmt(v)}"
            for c, t, s, v in rows
        ]
        out.append(
            _finding(
                "pool_cache_stale",
                "integrity",
                "pool",
                f"Warehouse Pool shows out-of-date figures for {name}",
                f"{len(rows)} colour(s) on screen differ from a fresh calculation: "
                + "; ".join(lines)
                + ". The stored pool is rebuilt on the next lot, dispatch or pool "
                "save; until then it shows the old figures.",
                item=name,
                qty=sum(abs((v or 0) - (s or 0)) for _c, _t, s, v in rows),
                evidence={
                    "colours": [
                        {"colour": c, "tag": t, "shown": s, "calculated": v}
                        for c, t, s, v in rows
                    ]
                },
            )
        )
    return out


def _check_pool_ledger(ctx: _Context) -> list:
    """Each bucket's ledger lines (a Recount line, then every movement the
    count did not absorb) must add up to its Available Qty -- the closing
    balance getWarehousePoolLedger shows."""
    ctx.stats.setdefault("counted", {})["pool"] = sum(
        1 for b in ctx.buckets.values() if b["outputItemName"]
    )
    total: dict = defaultdict(float)
    for e in ctx.live_events:
        total[e["bucketKey"]] += e["inQty"] - e["outQty"]
    by_item: dict = defaultdict(list)
    for key, b in ctx.buckets.items():
        if not b["outputItemName"]:
            continue
        if abs(total.get(key, 0.0) - _available(b)) > 1e-4:
            by_item[b["outputItemName"]].append(
                (b["color"], total.get(key, 0.0), _available(b))
            )
    return [
        _finding(
            "pool_ledger_mismatch",
            "integrity",
            "pool",
            f"Warehouse Pool ledger does not close on the balance for {name}",
            "; ".join(
                f"{c or '(no colour)'}: ledger adds up to {_fmt(t)}, balance is {_fmt(a)}"
                for c, t, a in sorted(rows)
            )
            + ".",
            item=name,
            qty=sum(abs(t - a) for _c, t, a in rows),
        )
        for name, rows in by_item.items()
    ]


def _check_pool_ledger_screens(ctx: _Context) -> list:
    """The Pool Ledger a person opens, for every bucket: the real line builder
    behind getWarehousePoolLedger, drawn from this run's replay, must close on
    the bucket's Available Qty. Where a bucket was counted that is more than
    adding up its movements: the count's variance and the history behind it
    are worked out on the way."""
    anchors = warehouse_service._get_bucket_anchors(ctx.cur)
    live: dict = defaultdict(list)
    for e in ctx.live_events:
        live[e["bucketKey"]].append(e)
    absorbed: dict = defaultdict(list)
    for e in ctx.all_events:
        absorbed[e["bucketKey"]].append(e)
    out = []
    for key, b in ctx.buckets.items():
        if not b["outputItemName"]:
            continue
        lines = warehouse_service.pool_ledger_lines(
            key, anchors.get(key), live[key], absorbed[key]
        )
        closing = lines[0]["balance"] if lines else 0.0
        if abs(closing - _available(b)) <= 1e-4:
            continue
        out.append(
            _finding(
                "pool_ledger_screen_disagrees",
                "integrity",
                "pool",
                f"Pool Ledger of {_label(b['outputItemName'], b['color'], b['productTag'])} "
                "does not close on its balance",
                f"The ledger closes on {_fmt(closing)}; Available Qty is {_fmt(_available(b))}.",
                item=b["outputItemName"],
                tag=b["productTag"],
                colour=b["color"],
                qty=abs(closing - _available(b)),
            )
        )
    return out


def _check_pool_openings(ctx: _Context) -> list:
    """A pool opening or count hangs off the process that makes its bucket. If
    that process is gone, nothing says which stage the stock belongs to."""
    ctx.cur.execute(
        "SELECT id, output_item_name, process_id, color FROM erp.warehouse_pool_opening "
        "WHERE btrim(COALESCE(process_id, '')) <> ''"
    )
    missing: dict = defaultdict(list)
    for r in ctx.cur.fetchall():
        if _k(r["process_id"]) not in ctx.process_by_id:
            missing[(r["output_item_name"], str(r["process_id"]).strip())].append(r)
    return [
        _finding(
            "pool_opening_process_missing",
            "entry",
            "pool",
            f"{name}: {len(rows)} pool entry(ies) belong to process {process_id}, "
            "which no longer exists",
            f"Colours: {_listed(sorted({r['color'] or '(none)' for r in rows}))}. The stock is "
            "still counted, but nothing says which stage it belongs to.",
            item=name,
            refs=[f"Process {process_id}"],
            qty=len(rows),
        )
        for (name, process_id), rows in missing.items()
    ]


def _check_stock_paths(ctx: _Context) -> list:
    """Current Stock is built from SQL aggregates (stock_service.
    _get_stock_terms). The Item Ledger replays the same movements row by row
    (_MOVEMENT_ROWS_SQL and _iter_completed_production_components). The two
    must agree for every item, or the Stock page and the Item Ledger show
    different numbers."""
    cur = ctx.cur
    terms = ctx.stock_terms()
    anchor_at = {k: v[0] for k, v in terms.anchors.items()}

    moved: dict = defaultdict(float)
    cur.execute(stock_service._MOVEMENT_ROWS_SQL.format(line_keys="", adj_keys=""))
    for r in cur.fetchall():
        if not r["name_k"]:
            continue
        key = f"{r['name_k']}|{r['size_k']}"
        a = anchor_at.get(key)
        if a is None or (r["at"] is not None and r["at"] > a):
            moved[key] += float(r["delta"] or 0)

    consumed: dict = defaultdict(float)
    for c in stock_service._iter_completed_production_components(cur):
        key = f"{c['itemName'].strip().lower()}|{c['size'].strip().lower()}"
        a = anchor_at.get(key)
        if a is None or (c["stockAt"] is not None and c["stockAt"] > a):
            consumed[key] += float(c["baseQty"] or 0)

    out = []
    for key in sorted(
        set(terms.moved) | set(moved) | set(terms.consumed) | set(consumed)
    ):
        dm = terms.moved.get(key, 0.0) - moved.get(key, 0.0)
        dc = terms.consumed.get(key, 0.0) - consumed.get(key, 0.0)
        if abs(dm) <= 1e-4 and abs(dc) <= 1e-4:
            continue
        name, _, size = key.partition("|")
        out.append(
            _finding(
                "stock_paths_disagree",
                "integrity",
                "stock",
                f"Stock page and Item Ledger disagree for {name}{(' ' + size) if size else ''}",
                f"Movements: Stock page {_fmt(terms.moved.get(key, 0))}, ledger replay "
                f"{_fmt(moved.get(key, 0))}. Production use: Stock page "
                f"{_fmt(terms.consumed.get(key, 0))}, ledger replay {_fmt(consumed.get(key, 0))}.",
                item=name,
                size=size,
                qty=abs(dm) + abs(dc),
            )
        )
    return out


def _check_lot_processes(ctx: _Context) -> list:
    """A lot whose process no longer exists still moves stock, but no
    screen can show which process it belonged to."""
    by_proc: dict = defaultdict(list)
    for r in ctx.lots:
        pid = str(r["process_id"] or "").strip().lower()
        if pid and pid not in ctx.process_by_id:
            by_proc[str(r["process_id"]).strip()].append(r["lot_number"])
    return [
        _finding(
            "lot_process_missing",
            "integrity",
            "references",
            f"{len(lots)} lot(s) belong to process {pid}, which no longer exists",
            "Lots: " + ", ".join(sorted(lots)[:20]) + (" …" if len(lots) > 20 else ""),
            refs=sorted(lots),
            qty=len(lots),
        )
        for pid, lots in by_proc.items()
    ]


def _external_reference_findings() -> list:
    """items_service's reference scan (Check Reference Integrity), folded in:
    every row naming an Items Master item that does not exist. It opens its
    own connection, so it runs outside the audit's transaction."""
    res = items_service.get_item_identity_drift_report()
    rows = (res.get("data") or []) if isinstance(res, dict) else []
    grouped: dict = defaultdict(list)
    for f in rows:
        grouped[(f.get("itemName", ""), f.get("size", ""))].append(f)
    out = []
    for (name, size), fs in grouped.items():
        where = sorted({f"{f.get('sheet')}: {f.get('context')}" for f in fs})
        out.append(
            _finding(
                "item_reference_missing",
                "integrity",
                "stock",
                f"{name}{(' ' + size) if size else ''} is used but missing from Items Master",
                f"{len(fs)} row(s) name it: "
                + "; ".join(where[:10])
                + (" …" if len(where) > 10 else ""),
                item=name,
                size=size,
                refs=where,
                qty=len(fs),
            )
        )
    return out


# ── Entry checks ───────────────────────────────────────────────────────────


def _recent_lines(ctx: _Context, key, n=5) -> list:
    rows = [
        e for e in ctx.live_events if e["bucketKey"] == key and e["type"] != "Recount"
    ]
    rows.sort(key=lambda e: (e["date"] or date.min, e["at"] or datetime.min))
    return [
        {
            "date": e["date"].isoformat() if e["date"] else "",
            "type": e["type"],
            "ref": e["ref"],
            "in": e["inQty"],
            "out": e["outQty"],
        }
        for e in rows[-n:]
    ]


def _check_negative_buckets(ctx: _Context) -> list:
    """Triage every negative colour (see the warehouse-pool-negatives rule):
    a finished-goods colour whose product total is fine is a mixed bundle;
    a colour negative while its item has stock under another colour is
    attribution; a total that is negative too is a real shortfall."""
    product_total: dict = defaultdict(float)
    item_total: dict = defaultdict(float)
    colours_by_item: dict = defaultdict(set)
    for k, b in ctx.buckets.items():
        if not b["outputItemName"]:
            continue
        product_total[(k[0], k[1])] += _available(b)
        item_total[k[0]] += _available(b)
        if k[2]:
            colours_by_item[k[0]].add(k[2])

    # The whole delimiter, spaces included: "B/T GREEN" is one colour with a
    # slash in its name, "B/T GREEN / Black" is two.
    delim = config_maps.COLOR_COMBO_DELIMITER.lower()
    out = []
    for key, b in ctx.buckets.items():
        avail = _available(b)
        if not b["outputItemName"] or avail >= -_EPS:
            continue
        name, tag, colour = b["outputItemName"], b["productTag"], b["color"]
        lines = _recent_lines(ctx, key)
        refs = [ln["ref"] for ln in reversed(lines) if ln["ref"]]
        last_when = lines[-1]["date"] if lines else None
        when = date.fromisoformat(last_when) if last_when else None
        evidence = {"recentLines": lines}

        if ctx.is_final_bucket(key, b):
            total = product_total[(key[0], key[1])]
            if total >= -_EPS:
                out.append(
                    _finding(
                        "negative_colour_mixed_bundle",
                        "info",
                        "pool",
                        f"{_label(name, colour, tag)} is {_fmt(avail)} (mixed bundles)",
                        f"This colour is {_fmt(avail)}, but the product as a whole holds "
                        f"{_fmt(total)}. Dispatch does not record colour, so mixed bundles "
                        "leave single colours negative. Expected; no action needed.",
                        item=name,
                        tag=tag,
                        colour=colour,
                        refs=refs,
                        qty=abs(avail),
                        when=when,
                        evidence=evidence,
                    )
                )
            else:
                out.append(
                    _finding(
                        "negative_product",
                        "entry",
                        "pool",
                        f"{_label(name, '', tag)} is short overall ({_fmt(total)})",
                        f"Colour {colour or '(none)'} is {_fmt(avail)} and the product total is "
                        f"{_fmt(total)}: more was dispatched or used than was recorded as made. "
                        "Look for a missing or uncompleted packing lot, or a dispatch entered twice.",
                        item=name,
                        tag=tag,
                        colour=colour,
                        refs=refs,
                        qty=abs(total),
                        when=when,
                        evidence=evidence,
                    )
                )
            continue

        if (
            colour
            and delim not in colour.lower()
            and any(
                delim in c and colour.lower() in [s.strip() for s in c.split(delim)]
                for c in colours_by_item[key[0]]
            )
        ):
            out.append(
                _finding(
                    "phantom_bare_colour",
                    "info",
                    "pool",
                    f"{_label(name, colour)} is {_fmt(avail)} (bare colour)",
                    "A single-colour bucket next to combined colours of the same item -- left "
                    "by lots whose colour pairing was not recorded (decision 2026-09-07). "
                    "Its stock is filed under the combined colours.",
                    item=name,
                    colour=colour,
                    refs=refs,
                    qty=abs(avail),
                    when=when,
                    evidence=evidence,
                )
            )
            continue

        total = item_total[key[0]]
        if total >= -_EPS:
            out.append(
                _finding(
                    "negative_colour_attribution",
                    "entry",
                    "pool",
                    f"{_label(name, colour, tag)} is {_fmt(avail)}",
                    f"This colour is {_fmt(avail)} while {name} holds {_fmt(total)} across all "
                    "colours: the stock exists under another colour. Check the colour picked on "
                    "the most recent lots listed.",
                    item=name,
                    tag=tag,
                    colour=colour,
                    refs=refs,
                    qty=abs(avail),
                    when=when,
                    evidence=evidence,
                )
            )
        else:
            out.append(
                _finding(
                    "negative_shortfall",
                    "entry",
                    "pool",
                    f"{_label(name, colour, tag)} is {_fmt(avail)} and the item is short overall",
                    f"This colour is {_fmt(avail)} and {name} totals {_fmt(total)}: more was used "
                    "than was recorded as made. Look for a lot not yet marked Completed upstream, "
                    "or a consumption entered twice.",
                    item=name,
                    tag=tag,
                    colour=colour,
                    refs=refs,
                    qty=abs(avail),
                    when=when,
                    evidence=evidence,
                )
            )
    return out


def _check_used_before_made(ctx: _Context, today: date) -> list:
    """A colour that went below zero at the end of a day and has since
    recovered: a lot used it before the lot that makes it was completed --
    packing marked Completed before its fitting (2026-10-02/06). The negative
    has closed, so this is about the habit, not today's figure."""
    by_key: dict = defaultdict(list)
    for e in ctx.live_events:
        if e["type"] != "Recount":
            by_key[e["bucketKey"]].append(e)
    recount_by_key = {
        e["bucketKey"]: e for e in ctx.live_events if e["type"] == "Recount"
    }
    cutoff = today - timedelta(days=DIP_LOOKBACK_DAYS)
    out = []
    for key, rows in by_key.items():
        b = ctx.buckets.get(key)
        if not b or ctx.is_final_bucket(key, b) or _available(b) < -_EPS:
            continue
        rows.sort(key=lambda e: (e["date"] or date.min, e["at"] or datetime.min))
        rc = recount_by_key.get(key)
        bal = (rc["inQty"] - rc["outQty"]) if rc else 0.0
        worst = None
        day_rows: dict = defaultdict(list)
        for e in rows:
            day_rows[e["date"]].append(e)
        for d in sorted(day_rows, key=lambda x: x or date.min):
            for e in day_rows[d]:
                bal += e["inQty"] - e["outQty"]
            if d and d >= cutoff and bal < -_EPS:
                users = [e["ref"] for e in day_rows[d] if e["outQty"] > 0 and e["ref"]]
                if users and (worst is None or bal < worst[1]):
                    worst = (d, bal, users)
        if worst:
            d, bal, users = worst
            out.append(
                _finding(
                    "used_before_made",
                    "entry",
                    "production",
                    f"{_label(b['outputItemName'], b['color'], b['productTag'])} was used before it was made",
                    f"On {d:%d/%m/%Y} this colour closed the day at {_fmt(bal)}: "
                    f"{', '.join(sorted(set(users)))} used more than had been completed. It has "
                    "since recovered. Mark the supplying lot Completed before the lot that uses it.",
                    item=b["outputItemName"],
                    tag=b["productTag"],
                    colour=b["color"],
                    refs=sorted(set(users)),
                    qty=abs(bal),
                    when=d,
                )
            )
    return out


def _check_counts_before_completion(ctx: _Context) -> list:
    """Items Stock judges a lot by its date. An in-house lot dated on or
    before an item's newest count but marked Completed after it is inside
    that count -- right if its parts had already left the shelf, an
    overstatement if they had not. Job-work lots are skipped: their material
    leaves when the lot starts (the decision of 2026-10-15)."""
    cur = ctx.cur
    terms_anchor = stock_service._anchor_map(cur)
    lots_info = {}
    for r in ctx.lots:
        p = ctx.process_by_id.get(str(r["process_id"] or "").strip().lower())
        ptype = str((p or {}).get("processType") or "").strip().lower()
        lots_info[str(r["lot_number"] or "").strip()] = (r, ptype)

    grouped: dict = defaultdict(list)
    for c in stock_service._iter_completed_production_components(cur):
        key = f"{c['itemName'].strip().lower()}|{c['size'].strip().lower()}"
        anchor = terms_anchor.get(key)
        if not anchor:
            continue
        r, ptype = lots_info.get(c["lotNumber"], (None, ""))
        if r is None or ptype in JOB_WORK_PROCESS_TYPES or not r["completed_at"]:
            continue
        created = r["created_at"]
        if created is None or created == datetime.combine(
            r["production_date"], time.min, tzinfo=created.tzinfo
        ):
            continue
        if c["stockAt"] is not None and c["stockAt"] <= anchor[0] < r["completed_at"]:
            grouped[(key, c["itemName"], c["size"], anchor)].append(
                (c["lotNumber"], float(c["baseQty"] or 0), r["completed_at"])
            )

    out = []
    for (key, name, size, anchor), lots in grouped.items():
        qty = sum(q for _l, q, _t in lots)
        out.append(
            _finding(
                "count_before_completion",
                "entry",
                "stock",
                f"{name}{(' ' + size) if size else ''}: counted before {len(lots)} lot(s) were completed",
                f"Counted {_fmt(anchor[1])} at {anchor[0]:%d/%m %H:%M}. "
                + ", ".join(
                    f"{lot} ({_fmt(q)}, completed {t:%d/%m %H:%M})"
                    for lot, q, t in lots
                )
                + f" are dated on or before the count, so their {_fmt(qty)} is treated as already "
                "gone from the count. If those parts were still on the shelf when counted, "
                f"Stock is {_fmt(qty)} too high.",
                item=name,
                size=size,
                refs=[f"Count #{anchor[2]}"] + [lot for lot, _q, _t in lots],
                qty=qty,
                when=anchor[0],
            )
        )
    return out


def _check_pool_hand_edits(ctx: _Context) -> list:
    """Hand edits of the pool that hide a problem rather than record a count:
    a negative typed over with 0, or a figure set to exactly what the next
    lot consumed, minutes before that lot was saved."""
    cur = ctx.cur
    cur.execute(
        """
        SELECT id, output_item_name, product_tag, color, old_value, new_value,
               reason, created_at
          FROM erp.warehouse_pool_adjustments
         WHERE reason NOT LIKE 'Deleted %%'
         ORDER BY created_at, id
        """
    )
    edits = cur.fetchall()

    # Only an edit that is still the colour's newest count still governs
    # today's figure; one a later count replaced no longer matters. An edit
    # and its opening row are written in one transaction, so they share
    # created_at exactly (adjust_warehouse_pool_manually).
    anchors = warehouse_service._get_bucket_anchors(cur)
    cur.execute(
        "SELECT id, output_item_name, product_tag, color, created_at "
        "FROM erp.warehouse_pool_opening WHERE counted_qty IS NOT NULL"
    )
    opening_id = {
        (
            _bucket_key(r["output_item_name"], r["product_tag"], r["color"]),
            r["created_at"],
        ): r["id"]
        for r in cur.fetchall()
    }

    # Lot debits per bucket, with when each lot was saved.
    debit_by_lot_key: dict = defaultdict(float)
    for e in ctx.all_events:
        if e["outQty"] > 0 and e["ref"] in ctx.lot_by_number:
            debit_by_lot_key[(e["ref"], e["bucketKey"])] += e["outQty"]
    lots_by_key: dict = defaultdict(list)
    for (lot, key), q in debit_by_lot_key.items():
        lots_by_key[key].append((ctx.lot_by_number[lot]["created_at"], lot, q))

    out = []
    for a in edits:
        key = _bucket_key(a["output_item_name"], a["product_tag"], a["color"])
        anchor = anchors.get(key)
        if anchor is None or opening_id.get((key, a["created_at"])) != anchor[2]:
            continue
        old, new = float(a["old_value"]), float(a["new_value"])
        name, colour, tag = (
            a["output_item_name"],
            a["color"] or "",
            a["product_tag"] or "",
        )
        t = a["created_at"]
        follow = [
            (lot, q)
            for created, lot, q in lots_by_key.get(key, [])
            if created is not None
            and t < created <= t + PATCH_WINDOW
            and abs(q - new) <= _EPS
        ]
        if follow and abs(new) > _EPS:
            lot, q = follow[0]
            out.append(
                _finding(
                    "edit_to_let_lot_through",
                    "entry",
                    "pool",
                    f"{_label(name, colour, tag)} set to {_fmt(new)} just before {lot} used exactly that",
                    f"At {t:%d/%m %H:%M} the pool was edited from {_fmt(old)} to {_fmt(new)}, and "
                    f"{lot} -- saved within {int(PATCH_WINDOW.total_seconds() // 60)} minutes -- "
                    f"consumed {_fmt(q)} from it. An edit made to let a lot through is stored as a "
                    "count, and swallows anything finished after it. Complete the supplying lot "
                    "instead.",
                    item=name,
                    tag=tag,
                    colour=colour,
                    refs=[f"Pool edit #{a['id']}", lot],
                    qty=abs(new - old),
                    when=t,
                )
            )
        elif old < -_EPS and abs(new) <= _EPS:
            out.append(
                _finding(
                    "negative_set_to_zero",
                    "entry",
                    "pool",
                    f"{_label(name, colour, tag)}: a negative of {_fmt(old)} was set to 0 by hand",
                    f"At {t:%d/%m %H:%M} the pool showed {_fmt(old)} and was set to 0. A negative "
                    "says something was used that was not recorded as made; zeroing it hides "
                    "that and swallows lots finished afterwards. Find the missing lot instead.",
                    item=name,
                    tag=tag,
                    colour=colour,
                    refs=[f"Pool edit #{a['id']}"],
                    qty=abs(old),
                    when=t,
                )
            )
    return out


def _check_status_toggles(ctx: _Context) -> list:
    """A Completed lot switched back to In Progress (or Pending) and then
    Completed again. While it is not Completed the pool leaves it out
    entirely, and a count or edit made in that window locks in the wrong
    figure (FTD026-0018, 14/10/2026). Edit a Completed lot directly."""
    cur = ctx.cur
    cur.execute(
        r"""
        SELECT logged_at, substring(detail FROM 'Lot #([^ ]+) ') AS lot,
               lower(CASE WHEN action = 'updateProductionStatus' THEN args ->> 'new_status'
                          ELSE args -> 'form_data' ->> 'status' END) AS st
          FROM erp.activity_log
         WHERE status = 'success'
           AND action IN ('updateProductionStatus', 'saveProduction')
         ORDER BY logged_at, id
        """
    )
    seq: dict = defaultdict(list)
    for r in cur.fetchall():
        if r["lot"] and r["st"]:
            seq[r["lot"]].append((r["logged_at"], r["st"]))
    out = []
    for lot, rows in seq.items():
        if lot not in ctx.lot_by_number:
            continue
        reopened = None
        times = []
        prev = None
        for at, st in rows:
            if prev == "completed" and st != "completed":
                reopened = at
            if reopened and st == "completed" and prev != "completed":
                times.append((reopened, at))
                reopened = None
            prev = st
        if times:
            first, last = times[0][0], times[-1][1]
            out.append(
                _finding(
                    "status_toggled",
                    "entry",
                    "production",
                    f"{lot} was taken out of Completed and completed again {len(times)} time(s)",
                    "Reopened at "
                    + ", ".join(f"{a:%d/%m %H:%M}" for a, _b in times)
                    + ". While a lot is not Completed the pool leaves it out; a count or edit in "
                    "that window locks in the wrong figure. Edit Completed lots directly.",
                    refs=[lot],
                    qty=float(ctx.lot_by_number[lot]["qty"] or 0),
                    when=last,
                    evidence={"first": first.isoformat(), "last": last.isoformat()},
                )
            )
    return out


def _check_labor_bills(ctx: _Context) -> list:
    """A Labor Job bill pays for work whose goods come back through the
    process's lot. A bill with no lot of that process near its date means
    the goods were never recorded as made -- or were typed into the pool by
    hand (bill 1210, 12/10/2026)."""
    cur = ctx.cur
    cur.execute(
        """
        SELECT h.id, h.bill_number, h.vendor, h.bill_date, h.created_at,
               l.process_name, l.item_name, l.color, l.qty
          FROM erp.bill_lines l JOIN erp.bill_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL AND l.bill_type = 'LABOR'
         ORDER BY h.bill_date, h.id
        """
    )
    lines = cur.fetchall()
    cur.execute(
        "SELECT output_item_name, color, old_value, new_value, created_at "
        "FROM erp.warehouse_pool_adjustments ORDER BY created_at"
    )
    edits = cur.fetchall()
    lots_by_proc: dict = defaultdict(list)
    for r in ctx.lots:
        lots_by_proc[str(r["process_id"] or "").strip().lower()].append(r)

    bills: dict = defaultdict(list)
    for ln in lines:
        bills[(ln["id"], ln["process_name"])].append(ln)

    out = []
    window = timedelta(days=LABOR_LOT_WINDOW_DAYS)
    for (_hid, pname), lns in bills.items():
        h = lns[0]
        p = ctx.process_by_name.get(str(pname or "").strip().lower())
        if p is None:
            continue
        pid = p["processId"].strip().lower()
        near = [
            r
            for r in lots_by_proc.get(pid, [])
            if abs((r["production_date"] - h["bill_date"])) <= window
        ]
        if near:
            continue
        output = p["outputItemName"].strip().lower()
        typed = [
            e
            for e in edits
            if str(e["output_item_name"] or "").strip().lower() == output
            and h["created_at"] is not None
            and h["created_at"]
            <= e["created_at"]
            <= h["created_at"] + LABOR_EDIT_WINDOW
        ]
        qty = sum(float(x["qty"] or 0) for x in lns)
        detail = (
            f"Bill {h['bill_number']} ({h['vendor']}, {h['bill_date']:%d/%m/%Y}) pays for "
            f"{_fmt(qty)} of {p['processName']} ("
            + ", ".join(f"{x['color'] or 'no colour'} {_fmt(x['qty'])}" for x in lns)
            + f"), but no {p['processName']} lot is dated within {LABOR_LOT_WINDOW_DAYS} days. "
        )
        if typed:
            detail += (
                f"The pool for {p['outputItemName']} was edited by hand within "
                f"{int(LABOR_EDIT_WINDOW.total_seconds() // 60)} minutes of the bill ("
                + ", ".join(
                    f"{e['color']}: {_fmt(e['old_value'])}→{_fmt(e['new_value'])}"
                    for e in typed
                )
                + "), so the goods were typed in rather than made by a lot: the raw parts the "
                "lot would have used are still in Stock."
            )
        else:
            detail += "Log the lot (dated the day the goods came back) so the pool and Stock both move."
        out.append(
            _finding(
                "labor_bill_without_lot",
                "entry",
                "production",
                f"Labor bill {h['bill_number']} ({h['vendor']}) has no {p['processName']} lot",
                detail,
                item=p["outputItemName"],
                refs=[f"Bill {h['bill_number']} ({h['vendor']})"],
                qty=qty,
                when=h["bill_date"],
                evidence={"handEdits": len(typed)},
            )
        )
    return out


def _check_count_variances(ctx: _Context, today: date) -> list:
    """The largest recent differences between a count and the book. A count
    is supposed to agree with the book; a big variance is something that
    happened and was never entered."""
    cur = ctx.cur
    since = today - timedelta(days=COUNT_VARIANCE_LOOKBACK_DAYS)
    rows = []
    cur.execute(
        """
        SELECT id, output_item_name AS item, '' AS size, color, old_value, new_value,
               created_at, 'pool' AS src
          FROM erp.warehouse_pool_adjustments
         WHERE created_at >= %s AND reason NOT LIKE 'Deleted %%'
        UNION ALL
        SELECT id, item_name, coalesce(size, ''), '' AS color, old_value, new_value,
               created_at, 'stock'
          FROM erp.stock_adjustments
         WHERE created_at >= %s AND action IN ('ADJUST', 'RESET')
        """,
        (since, since),
    )
    for r in cur.fetchall():
        var = float(r["new_value"] or 0) - float(r["old_value"] or 0)
        if abs(var) >= COUNT_VARIANCE_MIN_UNITS:
            rows.append((abs(var), var, r))
    rows.sort(key=lambda x: -x[0])
    out = []
    for _a, var, r in rows[:COUNT_VARIANCE_MAX_LISTED]:
        where = "Warehouse Pool" if r["src"] == "pool" else "Stock"
        out.append(
            _finding(
                "large_count_variance",
                "entry",
                r["src"],
                f"{_label(r['item'], r['color'])}{(' ' + r['size']) if r['size'] else ''}: "
                f"count differed from the book by {'+' if var > 0 else ''}{_fmt(var)}",
                f"{where} showed {_fmt(r['old_value'])}; {_fmt(r['new_value'])} was entered at "
                f"{r['created_at']:%d/%m %H:%M}. "
                + (
                    "More on the shelf than recorded: look for a lot or bill not entered."
                    if var > 0
                    else "Less on the shelf than recorded: look for use, wastage or a dispatch not entered."
                ),
                item=r["item"],
                size=r["size"],
                colour=r["color"],
                refs=[
                    f"{'Pool edit' if r['src'] == 'pool' else 'Stock count'} #{r['id']}"
                ],
                qty=abs(var),
                when=r["created_at"],
            )
        )
    return out


def _check_duplicate_lots(ctx: _Context) -> list:
    groups: dict = defaultdict(list)
    for r in ctx.lots:
        sig = (
            str(r["process_id"] or "").strip().lower(),
            r["production_date"],
            float(r["qty"] or 0),
            json.dumps(r["color_breakdown"] or [], sort_keys=True, default=str),
        )
        groups[sig].append(r)
    out = []
    for sig, rows in groups.items():
        if len(rows) < 2:
            continue
        rows.sort(key=lambda r: r["id"])
        for a, b in zip(rows, rows[1:]):
            if (
                a["created_at"]
                and b["created_at"]
                and (b["created_at"] - a["created_at"]) <= DUPLICATE_LOT_WINDOW
            ):
                out.append(
                    _finding(
                        "possible_duplicate_lot",
                        "entry",
                        "production",
                        f"{a['lot_number']} and {b['lot_number']} look like the same lot entered twice",
                        f"Same process, date {sig[1]:%d/%m/%Y}, qty {_fmt(sig[2])} and colours, saved "
                        f"{int((b['created_at'] - a['created_at']).total_seconds() // 60)} minute(s) "
                        "apart. If both are real, ignore this; if not, delete one.",
                        refs=[a["lot_number"], b["lot_number"]],
                        qty=sig[2],
                        when=b["created_at"],
                    )
                )
    return out


def _deleted_units(cur) -> dict:
    """{name: row} for units taken out of the Units master and not put back,
    each with the factor it had when it went."""
    active = units_service.get_units_map(cur)
    cur.execute(
        "SELECT unit_name, family, factor_to_base, deleted_at FROM erp.units "
        "WHERE deleted_at IS NOT NULL ORDER BY deleted_at"
    )
    return {
        _k(r["unit_name"]): r
        for r in cur.fetchall()
        if _k(r["unit_name"]) not in active
    }


def _check_units(ctx: _Context) -> list:
    """A unit missing from the Units master converts as 1 = 1 base unit,
    silently (units_service.lookup_unit). Listed with every conversion in
    use, so a wrong factor -- Pair as 1 Pcs, say -- is visible. A unit that
    was deleted says so: lines saved before that keep its old factor, and
    only what is saved or read since falls back to 1."""
    cur = ctx.cur
    units_map = units_service.get_units_map(cur)
    deleted = _deleted_units(cur)
    cur.execute(
        """
        SELECT lower(btrim(l.unit)) AS u, count(*) AS n, min(h.bill_number) AS example
          FROM erp.bill_lines l JOIN erp.bill_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL AND btrim(coalesce(l.unit, '')) <> ''
         GROUP BY 1
        """
    )
    bill_units = {r["u"]: (r["n"], r["example"]) for r in cur.fetchall()}
    cur.execute(
        """
        SELECT u, sum(n) AS n, min(example) AS example FROM (
            SELECT lower(btrim(l.unit)) AS u, count(*) AS n, min('PO ' || h.po_number) AS example
              FROM erp.po_lines l JOIN erp.po_headers h ON h.id = l.header_id
             WHERE h.deleted_at IS NULL GROUP BY 1
            UNION ALL
            SELECT lower(btrim(l.unit)), count(*), min('Return ' || h.return_number)
              FROM erp.return_lines l JOIN erp.return_headers h ON h.id = l.header_id
             WHERE h.deleted_at IS NULL GROUP BY 1
            UNION ALL
            SELECT lower(btrim(l.unit)), count(*), min('Wastage ' || h.wastage_id)
              FROM erp.wastage_lines l JOIN erp.wastage_headers h ON h.id = l.header_id
             WHERE h.deleted_at IS NULL AND l.source_type <> 'POOL' GROUP BY 1
            UNION ALL
            SELECT lower(btrim(l.unit)), count(*), min('Issue ' || h.issue_id)
              FROM erp.issue_lines l JOIN erp.issue_headers h ON h.id = l.header_id
             WHERE h.deleted_at IS NULL GROUP BY 1
        ) x
        WHERE u <> ''
        GROUP BY 1
        """
    )
    other_units = {r["u"]: (int(r["n"]), r["example"]) for r in cur.fetchall()}
    comp_units: dict = defaultdict(lambda: [0, ""])
    for r in ctx.lots:
        if str(r["status"] or "").lower() != "completed":
            continue
        for c in r["components_consumed"] or []:
            if not isinstance(c, dict):
                continue
            u = str(c.get("unit") or "").strip().lower()
            if u:
                comp_units[u][0] += 1
                comp_units[u][1] = comp_units[u][1] or r["lot_number"]
    cur.execute(
        "SELECT base_unit, purchase_unit FROM erp.items WHERE deleted_at IS NULL"
    )
    item_units: dict = defaultdict(int)
    for r in cur.fetchall():
        for u in {_k(r["base_unit"]), _k(r["purchase_unit"])} - {""}:
            item_units[u] += 1
    out = []
    for u in sorted(
        set(bill_units) | set(other_units) | set(comp_units) | set(item_units)
    ):
        if u in units_map:
            continue
        bill_n, bill_example = bill_units.get(u, (0, ""))
        other_n, other_example = other_units.get(u, (0, ""))
        comp_n, comp_example = comp_units.get(u, (0, ""))
        n = bill_n + other_n + comp_n
        example = bill_example or comp_example or other_example
        where = f"{n} line(s) use it (e.g. {example})" if n else "No line uses it yet"
        items = (
            f" {item_units[u]} item(s) in Items Master name it."
            if item_units[u]
            else ""
        )
        gone = deleted.get(u)
        if gone:
            detail = (
                f"{where}. It was removed from the Units master on "
                f"{gone['deleted_at']:%d/%m/%Y}, when 1 {u} was {_fmt(gone['factor_to_base'])} "
                f"of its family's base unit: lines saved before that keep their factor, and "
                f"whatever is saved or read since counts 1 {u} = 1 base unit.{items}"
            )
        else:
            detail = (
                f"{where}; each was counted as 1 {u} = 1 base unit. Add it to the Units "
                f"master with its real factor.{items}"
            )
        out.append(
            _finding(
                "unit_not_in_master",
                "entry",
                "units",
                f'Unit "{u}" is not in the Units master',
                detail,
                refs=[str(example)],
                qty=n or item_units[u],
            )
        )
    return out


# ── Production lots and receipts ───────────────────────────────────────────


def _check_lot_colours(ctx: _Context) -> list:
    """saveProduction makes a lot's quantity the sum of its counting colours.
    Where the two have come apart, what reads the lot by colour (the
    Warehouse Pool, receipts) and what reads its quantity (its components,
    the contractor's payable) count different amounts of the same lot."""
    out = []
    for r in ctx.lots:
        entries = lot_receipts._counting_entries(r["color_breakdown"])
        if not entries:
            continue
        total = sum(lot_receipts._num(e.get("qty")) for e in entries)
        qty = float(r["qty"] or 0)
        if abs(total - qty) <= 1e-4:
            continue
        lot = _lot_label(r)
        out.append(
            _finding(
                "lot_colours_disagree",
                "entry",
                "production",
                f"{lot}: its colours add up to {_fmt(total)}, the lot says {_fmt(qty)}",
                "Colours that count toward the lot: "
                + ", ".join(
                    f"{e.get('color')} {_fmt(lot_receipts._num(e.get('qty')))}"
                    for e in entries
                )
                + f". The lot's quantity is {_fmt(qty)}. The Warehouse Pool and receipts go by "
                "the colours; the lot's components and the contractor's payable go by its "
                "quantity. Open the lot and check which is right.",
                refs=[lot],
                qty=abs(total - qty),
                when=r["production_date"],
            )
        )
    return out


def _check_lot_completion_time(ctx: _Context) -> list:
    """Since migration 051 a lot records when it was marked Completed, and a
    pool count judges it by that moment. A lot entered since then that is
    Completed with no completion time is judged by its date instead, so a
    count taken earlier that day swallows it. Lots completed before 051 have
    none by design."""
    cur = ctx.cur
    cur.execute(
        "SELECT min(applied_at) AS at FROM erp.migrations_applied "
        "WHERE migration_name = '051_lot_completed_at'"
    )
    row = cur.fetchone()
    since = row["at"] if row else None
    if since is None:
        return []
    lots = sorted(
        _lot_label(r)
        for r in ctx.lots
        if lot_receipts.is_completed(r["status"])
        and r["completed_at"] is None
        and r["created_at"] is not None
        and r["created_at"] > since
    )
    if not lots:
        return []
    return [
        _finding(
            "lot_completed_at_missing",
            "integrity",
            "production",
            f"{len(lots)} Completed lot(s) have no completion time",
            f"{_listed(lots)} were entered after {since:%d/%m/%Y} and are Completed, but no "
            "completion time was recorded. The Warehouse Pool therefore judges them by their "
            "date, and a count taken that day before they were finished swallows them.",
            refs=lots,
            qty=len(lots),
        )
    ]


def _check_receipts(ctx: _Context) -> list:
    """A receipt's quantity is the sum of its lines; each line names one of
    the lot's colours; no colour is received beyond what the lot has of it;
    nothing comes back before the lot's date. saveProductionReceipt and the
    lot form hold all four, so a receipt that breaks one was left behind by
    an edit made somewhere else."""
    receipts_table, lines_table, _production = lot_receipts._tables()
    if not (receipts_table and lines_table):
        return []
    cur = ctx.cur
    cur.execute(
        f"""
        SELECT r.id, r.production_id, r.receipt_date, r.qty,
               COALESCE(SUM(l.qty), 0) AS lines_qty
          FROM {receipts_table} r
          JOIN erp.production p ON p.id = r.production_id AND p.deleted_at IS NULL
          LEFT JOIN {lines_table} l ON l.receipt_id = r.id
         WHERE r.deleted_at IS NULL
         GROUP BY r.id, r.production_id, r.receipt_date, r.qty
        """
    )
    lots_by_id = {r["id"]: r for r in ctx.lots}
    out = []
    for rc in cur.fetchall():
        lot = lots_by_id.get(rc["production_id"])
        if lot is None:
            continue
        label = _lot_label(lot)
        if abs(float(rc["qty"]) - float(rc["lines_qty"])) > 1e-6:
            out.append(
                _finding(
                    "receipt_total_mismatch",
                    "integrity",
                    "production",
                    f"A receipt on {label} does not add up",
                    f"Receipt #{rc['id']} ({rc['receipt_date']:%d/%m/%Y}) says {_fmt(rc['qty'])} "
                    f"came back, but its colour lines add up to {_fmt(rc['lines_qty'])}. The pool "
                    "goes by the lines; the lot's balance and the contractor's payable by the total.",
                    refs=[label, f"Receipt #{rc['id']}"],
                    qty=abs(float(rc["qty"]) - float(rc["lines_qty"])),
                    when=rc["receipt_date"],
                )
            )
        if lot["production_date"] and rc["receipt_date"] < lot["production_date"]:
            out.append(
                _finding(
                    "receipt_before_lot",
                    "entry",
                    "production",
                    f"{label} received goods before its own date",
                    f"Receipt #{rc['id']} is dated {rc['receipt_date']:%d/%m/%Y}; the lot is now "
                    f"dated {lot['production_date']:%d/%m/%Y}, so the lot was re-dated after it "
                    "received. The pool counts the goods from the receipt's date.",
                    refs=[label, f"Receipt #{rc['id']}"],
                    qty=float(rc["qty"]),
                    when=rc["receipt_date"],
                )
            )

    for lot_id, receipts in ctx.receipts_by_lot.items():
        lot = lots_by_id.get(lot_id)
        if lot is None:
            continue
        shape = lot_receipts.LotShape(lot["color_breakdown"], lot["qty"])
        labels = {
            lot_receipts.line_key(ln["color"], ln["size"]): _sized(
                ln["color"] or "(no colour)", ln["size"]
            )
            for rc in receipts
            for ln in rc["lines"]
        }
        problems = []
        excess = 0.0
        for key, got in sorted(lot_receipts.received_amounts(receipts).items()):
            if got <= 0:
                continue
            have = shape.qty_by_key.get(key)
            if have is None:
                problems.append(
                    f"{labels.get(key, key)}: {_fmt(got)} received, not on the lot"
                )
                excess += got
            elif got > have + 1e-6:
                problems.append(
                    f"{labels.get(key, key)}: {_fmt(got)} received of {_fmt(have)}"
                )
                excess += got - have
        if problems:
            label = _lot_label(lot)
            out.append(
                _finding(
                    "receipt_beyond_lot",
                    "integrity",
                    "production",
                    f"{label} has received more than it holds",
                    "; ".join(problems)
                    + ". The lot was changed after these came back, and the extra has no line "
                    "of the lot to belong to: the pool counts it, the lot's balance does not.",
                    refs=[label],
                    qty=excess,
                    when=receipts[-1]["date"],
                )
            )
    return out


def _check_stuck_lots(ctx: _Context) -> list:
    """A lot In Progress for weeks with nothing received lately has usually
    come back without anyone marking it. Until it is, what it made is
    missing from the Warehouse Pool, and the lots that use it run the pool
    negative (the used-before-made pattern)."""
    cutoff = ctx.today - timedelta(days=STALE_LOT_DAYS)
    out = []
    for r in ctx.lots:
        if _k(r["status"]) != "in progress":
            continue
        if not r["production_date"] or r["production_date"] > cutoff:
            continue
        receipts = ctx.receipts_by_lot.get(r["id"]) or []
        last = max((rc["date"] for rc in receipts), default=None)
        if last and last > cutoff:
            continue
        received = sum(rc["qty"] for rc in receipts)
        qty = float(r["qty"] or 0)
        label = _lot_label(r)
        days = (ctx.today - r["production_date"]).days
        so_far = (
            f"{_fmt(received)} received so far, the last on {last:%d/%m/%Y}"
            if receipts
            else "nothing received yet"
        )
        out.append(
            _finding(
                "lot_stuck_in_progress",
                "entry",
                "production",
                f"{label} has been In Progress for {days} days",
                f"Dated {r['production_date']:%d/%m/%Y}, {_fmt(qty)} to make, {so_far}. If the "
                "goods are back, receive them or mark the lot Completed: until then they are "
                "missing from the Warehouse Pool.",
                refs=[label],
                qty=max(qty - received, 0.0),
                when=r["production_date"],
            )
        )
    return out


# ── Contractor ledger ──────────────────────────────────────────────────────


def _check_lot_payables(ctx: _Context) -> list:
    """A lot's payable is (rate + extra charge per unit) x qty, stamped
    together when it is saved (migration 032). A row where they disagree was
    written by a path that changed one figure without the others."""
    ctx.cur.execute("SELECT count(*) AS n FROM erp.contractor_payments")
    ctx.stats.setdefault("counted", {})["contractors"] = ctx.cur.fetchone()["n"] + sum(
        1 for r in ctx.lots if str(r["assigned_to"] or "").strip()
    )
    out = []
    for r in ctx.lots:
        rate = float(r["contractor_rate"] or 0)
        extra = float(r["extra_charge_amount"] or 0)
        qty = float(r["qty"] or 0)
        stored = float(r["contractor_payable"] or 0)
        expect = (rate + extra) * qty
        if abs(stored - expect) <= MONEY_EPS:
            continue
        label = _lot_label(r)
        out.append(
            _finding(
                "lot_payable_formula",
                "integrity",
                "contractors",
                f"{label}: the contractor's payable does not match its rate",
                f"{r['assigned_to'] or 'No contractor'}: ({_rs(rate)} rate + {_rs(extra)} extra) "
                f"x {_fmt(qty)} = {_rs(expect)}, but the lot holds {_rs(stored)}. The Contractor "
                "Ledger pays the held figure.",
                refs=[label],
                qty=abs(stored - expect),
                when=r["production_date"],
            )
        )
    return out


def _check_lots_without_rate(ctx: _Context) -> list:
    """Completed (or partly received) lots of a contractor who is paid by
    rate card, carrying no rate at all: the work earns nothing in the
    Contractor Ledger. A contractor with no rate cards anywhere is paid some
    other way (in-house, or through Labor Job bills) and is left alone."""
    cur = ctx.cur
    cur.execute(
        "SELECT contractor_name, process_type, size, rate_per_unit FROM erp.contractor_rates"
    )
    rates = {}
    paid_by_card = set()
    for row in cur.fetchall():
        c = _k(row["contractor_name"])
        rates[(c, _k(row["process_type"]), _k(row["size"]))] = float(
            row["rate_per_unit"] or 0
        )
        paid_by_card.add(c)

    groups: dict = defaultdict(list)
    no_extra: dict = defaultdict(list)
    for r in ctx.lots:
        contractor = str(r["assigned_to"] or "").strip()
        charge = str(r["extra_charge_type"] or "").strip()
        if contractor and charge and not float(r["extra_charge_amount"] or 0):
            no_extra[(contractor, charge)].append(_lot_label(r))
        if not contractor or _k(contractor) not in paid_by_card:
            continue
        if float(r["contractor_rate"] or 0) or float(r["extra_charge_amount"] or 0):
            continue
        completed = lot_receipts.is_completed(r["status"])
        received = sum(rc["qty"] for rc in ctx.receipts_by_lot.get(r["id"]) or [])
        if not completed and not received:
            continue
        p = ctx.process_by_id.get(_k(r["process_id"]))
        if p is None:
            continue
        ptype = str(p.get("processType") or "").strip()
        size = contractors_service._get_size_from_output_item_name(
            p.get("outputItemName")
        )
        owed = float(r["qty"] or 0) if completed else received
        groups[(contractor, ptype, size)].append((r, owed))

    out = []
    for (contractor, charge), lots in sorted(no_extra.items()):
        out.append(
            _finding(
                "lot_extra_charge_missing",
                "entry",
                "contractors",
                f"{contractor}: {len(lots)} lot(s) name {charge} with no charge",
                f"{_listed(sorted(lots))}. The extra charge is on the lot, but {contractor} has "
                "no amount for it, so it adds nothing to the payable.",
                refs=[f"Contractor {contractor}"] + sorted(lots),
                qty=len(lots),
            )
        )
    for (contractor, ptype, size), rows in sorted(groups.items()):
        units = sum(q for _r, q in rows)
        lots = sorted(_lot_label(r) for r, _q in rows)
        now = rates.get((_k(contractor), _k(ptype), _k(size)))
        what = f"{len(lots)} {ptype or 'untyped'} lot(s) ({_fmt(units)} units)"
        if not ptype:
            why = "Their process has no Process Type, so no rate card can ever apply to them."
            qty = units
        elif now:
            why = (
                f"The rate card now pays {_rs(now)} a unit for {ptype} at size {size}; these lots "
                f"were saved before it existed, so about {_rs(now * units)} is missing from "
                f"{contractor}'s balance. A lot holding no rate takes the card's when it is next "
                "saved."
            )
            qty = now * units
        else:
            why = (
                f"{contractor} has rate cards for other work but none for {ptype} at size {size}, "
                "so this work earns nothing in the Contractor Ledger. Ignore this if it is paid "
                "some other way."
            )
            qty = units
        out.append(
            _finding(
                "lot_without_rate",
                "entry",
                "contractors",
                f"{contractor}: {what} carry no rate",
                f"{why} Lots: {_listed(lots)}.",
                refs=[f"Contractor {contractor}"] + lots,
                qty=qty,
                when=max(r["production_date"] for r, _q in rows),
                evidence={"processType": ptype, "size": size, "rateNow": now},
            )
        )
    return out


def _contractor_ledger_gaps(names=None) -> tuple:
    summary = contractors_service.get_contractor_ledger_data()["data"] or []
    gaps = {}
    for c in summary:
        name = c["contractorName"]
        if names is not None and _k(name) not in names:
            continue
        acct = contractors_service.get_contractor_account_ledger(name)["data"]
        if (
            abs(c["totalPayable"] - acct["totalPayable"]) > MONEY_EPS
            or abs(c["totalPaid"] - acct["totalPaid"]) > MONEY_EPS
        ):
            gaps[_k(name)] = (c, acct)
    return summary, gaps


def _external_contractor_findings() -> list:
    """The Contractor Ledger list and each contractor's account statement
    are two separate calculations of the same money; they must agree to the
    paisa. Opens its own connections, so it runs outside the transaction."""
    summary, gaps = _contractor_ledger_gaps()
    if gaps:
        # A save landing between the two reads looks like a disagreement:
        # only one that is still there on a second look is reported.
        _again, gaps = _contractor_ledger_gaps(set(gaps))
    out = []
    for _key, (c, acct) in sorted(gaps.items()):
        name = c["contractorName"]
        out.append(
            _finding(
                "contractor_ledger_paths_disagree",
                "integrity",
                "contractors",
                f"Contractor Ledger and {name}'s account statement disagree",
                f"The Contractor Ledger list shows {_rs(c['totalPayable'])} earned and "
                f"{_rs(c['totalPaid'])} paid; {name}'s account statement adds up to "
                f"{_rs(acct['totalPayable'])} earned and {_rs(acct['totalPaid'])} paid.",
                refs=[f"Contractor {name}"],
                qty=abs(c["totalPayable"] - acct["totalPayable"])
                + abs(c["totalPaid"] - acct["totalPaid"]),
            )
        )
    for c in summary:
        if c["balanceDue"] < -OVERPAID_MIN:
            name = c["contractorName"]
            out.append(
                _finding(
                    "contractor_overpaid",
                    "entry",
                    "contractors",
                    f"{name} has been paid {_rs(-c['balanceDue'])} more than earned",
                    f"Earned {_rs(c['totalPayable'])} for {c['lotCount']} lot(s) and dispatches, "
                    f"paid {_rs(c['totalPaid'])}. Right if it was an advance; otherwise look for a "
                    "payment entered twice or lots that carry no rate.",
                    refs=[f"Contractor {name}"],
                    qty=-c["balanceDue"],
                )
            )
    return out


# ── Bills against their POs ─────────────────────────────────────────────────


def _check_bill_po_links(ctx: _Context) -> list:
    """A bill line names the PO it fulfils, and the PO Ledger's pending
    figures are built from those links (bill_service._BILLED_BY_PO_SQL:
    PO + item + size + narration, falling back to the PO's only line for
    that item + size). A link that matches no PO line fulfils nothing; one
    to another vendor's PO, or billed after the PO was cancelled, fulfils
    the wrong thing; a price above the PO's is a charge nobody agreed to."""
    cur = ctx.cur
    cur.execute(
        """
        SELECT h.po_number, h.po_date, h.vendor, h.closed_as, h.closed_at, h.deleted_at,
               l.item_name, COALESCE(l.size, '') AS size,
               COALESCE(l.narration, '') AS narration, l.unit, l.price
          FROM erp.po_headers h
          LEFT JOIN erp.po_lines l ON l.header_id = h.id
        """
    )
    live: dict = {}
    deleted = set()
    for r in cur.fetchall():
        po = _k(r["po_number"])
        if r["deleted_at"] is not None:
            deleted.add(po)
            continue
        entry = live.setdefault(
            po,
            {
                "number": r["po_number"],
                "date": r["po_date"],
                "vendor": r["vendor"],
                "closedAs": r["closed_as"] or "",
                "closedAt": r["closed_at"],
                "lines": {},
            },
        )
        if r["item_name"] is not None:
            entry["lines"].setdefault(
                (_k(r["item_name"]), _k(r["size"])), {}
            ).setdefault(_k(r["narration"]), r)

    missing: dict = defaultdict(lambda: defaultdict(set))
    missing_lines: dict = defaultdict(int)
    missing_when: dict = {}
    unmatched: dict = defaultdict(list)
    wrong_vendor: dict = defaultdict(list)
    after_cancel: dict = defaultdict(list)
    over_rate: dict = defaultdict(list)
    before_po: dict = {}
    for b in _bill_rows(ctx):
        po_raw = str(b["po_number"] or "").strip()
        if not po_raw or po_raw.upper() == "DIRECT":
            continue
        po = live.get(po_raw.lower())
        if po is None:
            state = "deleted" if po_raw.lower() in deleted else "never existed"
            missing[b["vendor"]][f"PO {po_raw} ({state})"].add(str(b["bill_number"]))
            missing_lines[b["vendor"]] += 1
            missing_when[b["vendor"]] = max(
                missing_when.get(b["vendor"], b["bill_date"]), b["bill_date"]
            )
            continue
        group = (b["header_id"], po["number"])
        if po["date"] and b["bill_date"] < po["date"]:
            before_po[group] = (b, po)
        if _k(po["vendor"]) != _k(b["vendor"]):
            wrong_vendor[group].append((b, po))
            continue
        by_nar = po["lines"].get((_k(b["item_name"]), _k(b["size"])))
        matched = None
        if by_nar:
            matched = by_nar.get(_k(b["narration"]))
            if matched is None and len(by_nar) == 1:
                matched = next(iter(by_nar.values()))
        if matched is None:
            unmatched[group].append((b, bool(by_nar)))
            continue
        if (
            _k(po["closedAs"]) == "cancelled"
            and po["closedAt"] is not None
            and b["created_at"] is not None
            and b["created_at"] > po["closedAt"]
        ):
            after_cancel[group].append((b, po))
        bill_price, po_price = float(b["price"] or 0), float(matched["price"] or 0)
        if (
            _k(b["unit"]) == _k(matched["unit"])
            and po_price > 0
            and bill_price > po_price * (1 + RATE_OVER_PO_TOLERANCE)
            and (bill_price - po_price) * float(b["qty"] or 0) >= 1
        ):
            over_rate[po["number"]].append((b, po_price))

    out = []
    for vendor, pos in sorted(missing.items()):
        names = [
            f"{po} on bill {', '.join(sorted(bills))}"
            for po, bills in sorted(pos.items())
        ]
        out.append(
            _finding(
                "bill_names_missing_po",
                "entry",
                "bills",
                f"{vendor}: {missing_lines[vendor]} bill line(s) name POs that are not there",
                f"{_listed(names)}. Those lines fulfil no order. Saving such a bill again is "
                "refused until each line is marked Direct or linked to a live PO.",
                refs=[f"Vendor {vendor}"] + sorted(pos),
                qty=missing_lines[vendor],
                when=missing_when[vendor],
            )
        )
    for b, po in before_po.values():
        out.append(
            _finding(
                "bill_before_po",
                "entry",
                "bills",
                f"{_bill_ref(b)} is dated before PO {po['number']}",
                f"Billed {b['bill_date']:%d/%m/%Y}, ordered {po['date']:%d/%m/%Y}. Goods cannot be "
                "billed against an order not yet placed: a date, or the PO linked, is wrong.",
                refs=[_bill_ref(b), f"PO {po['number']}"],
                qty=1,
                when=b["bill_date"],
            )
        )
    for (_hid, po_number), rows in unmatched.items():
        b = rows[0][0]
        units = sum(float(x["base_qty"] or 0) for x, _on in rows)
        items = [
            f"{_sized(x['item_name'], x['size'])}"
            + (
                f' (narration "{x["narration"]}" matches none of the PO\'s lines for it)'
                if on_po
                else ""
            )
            for x, on_po in rows
        ]
        out.append(
            _finding(
                "bill_po_line_unmatched",
                "entry",
                "bills",
                f"{_bill_ref(b)} names PO {po_number} for items that PO does not order",
                f"{_listed(items)}. These {_fmt(units)} base units fulfil no line of PO "
                f"{po_number}: if it ordered them under another name, size or narration, it "
                "still shows them as owed.",
                item=b["item_name"] if len(rows) == 1 else "",
                size=b["size"] if len(rows) == 1 else "",
                refs=[_bill_ref(b), f"PO {po_number}"],
                qty=units,
                when=b["bill_date"],
            )
        )
    for (_hid, po_number), rows in wrong_vendor.items():
        b, po = rows[0]
        out.append(
            _finding(
                "bill_po_vendor_mismatch",
                "integrity",
                "bills",
                f"{_bill_ref(b)} fulfils PO {po_number}, placed with {po['vendor']}",
                f"{len(rows)} line(s) of a bill from {b['vendor']} count toward a PO placed with "
                f"{po['vendor']}. Saving a bill refuses such a link, so it came from somewhere "
                "else (a vendor rename, an import).",
                refs=[_bill_ref(b), f"PO {po_number}"],
                qty=sum(float(x["base_qty"] or 0) for x, _p in rows),
                when=b["bill_date"],
            )
        )
    for (_hid, po_number), rows in after_cancel.items():
        b, po = rows[0]
        out.append(
            _finding(
                "bill_after_po_cancelled",
                "entry",
                "bills",
                f"{_bill_ref(b)} was entered against PO {po_number} after it was cancelled",
                f"PO {po_number} was cancelled on {po['closedAt']:%d/%m/%Y}; this bill was entered "
                f"after that, against {len(rows)} of its line(s). Either the PO should be reopened "
                "or the lines are Direct.",
                refs=[_bill_ref(b), f"PO {po_number}"],
                qty=sum(float(x["base_qty"] or 0) for x, _p in rows),
                when=b["bill_date"],
            )
        )
    for po_number, rows in over_rate.items():
        b = rows[0][0]
        over = sum((float(x["price"]) - p) * float(x["qty"] or 0) for x, p in rows)
        bills = sorted({_bill_ref(x) for x, _p in rows})
        prices: dict = {}
        for x, p in rows:
            key = (_sized(x["item_name"], x["size"]), x["unit"], p, float(x["price"]))
            prices[key] = prices.get(key, 0.0) + float(x["qty"] or 0)
        lines = [
            f"{item}: {_rs(billed)} a {unit} against {_rs(agreed)} on the PO, x {_fmt(q)}"
            for (item, unit, agreed, billed), q in prices.items()
        ]
        out.append(
            _finding(
                "bill_rate_above_po",
                "entry",
                "bills",
                f"{b['vendor']} billed {_rs(over)} above PO {po_number}'s prices",
                f"{_listed(lines)}. {_rs(over)} above the PO's prices before GST, on "
                f"{_listed(bills)}. Ignore this if the price was renegotiated.",
                item=b["item_name"] if len(prices) == 1 else "",
                size=b["size"] if len(prices) == 1 else "",
                refs=[f"PO {po_number}"] + bills,
                qty=over,
                when=max(x["bill_date"] for x, _p in rows),
            )
        )
    return out


# ── Units and conversions ──────────────────────────────────────────────────


_BASE_QTY_SOURCES = (
    (
        "Bill",
        "bills",
        """
        SELECT 'Bill ' || h.bill_number || ' (' || h.vendor || ')' AS ref, h.bill_date AS d,
               l.item_name, COALESCE(l.size, '') AS size, l.qty, l.unit, l.base_qty
          FROM erp.bill_lines l JOIN erp.bill_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL AND l.bill_type IS DISTINCT FROM 'LABOR'
        """,
    ),
    (
        "PO",
        "pos",
        """
        SELECT 'PO ' || h.po_number AS ref, h.po_date AS d,
               l.item_name, COALESCE(l.size, '') AS size, l.qty, l.unit, l.base_qty
          FROM erp.po_lines l JOIN erp.po_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "Return",
        "returns",
        """
        SELECT 'Return ' || h.return_number AS ref, h.return_date AS d,
               l.item_name, COALESCE(l.size, '') AS size, l.qty, l.unit, l.base_qty
          FROM erp.return_lines l JOIN erp.return_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "Wastage",
        "wastage",
        """
        SELECT 'Wastage ' || h.wastage_id AS ref, h.wastage_date AS d,
               l.item_name, COALESCE(l.size, '') AS size, l.qty, l.unit, l.base_qty
          FROM erp.wastage_lines l JOIN erp.wastage_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL AND l.source_type <> 'POOL'
        """,
    ),
    (
        "Issue",
        "issues",
        """
        SELECT 'Issue ' || h.issue_id AS ref, h.issue_date AS d,
               l.item_name, COALESCE(l.size, '') AS size, l.qty, l.unit, l.base_qty
          FROM erp.issue_lines l JOIN erp.issue_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
)


def _new_group() -> dict:
    return {"refs": [], "stored": 0.0, "now": 0.0, "when": None}


def _grouped(g: dict, ref, day, stored: float, now: float) -> None:
    g["refs"].append(ref)
    g["stored"] += stored
    g["now"] += now
    g["when"] = max(g["when"] or day, day)


def _check_stored_base_qty(ctx: _Context) -> list:
    """Bills, returns, wastage and issues move Items Stock by the base
    quantity stored on each line when it was saved, and PO pending figures
    are built the same way. Converted again with today's Units and Items
    Master, each line should give the same figure. Where it does not:

    - the master changed after the line was saved, or the unit could not be
      converted then (a Gross missing from Units, a PO raised before its item
      existed): stored_base_qty_stale, off by the factor;
    - the unit has since been DELETED from the Units master. A line saved
      before that holds the factor it had, which is not a mistake in itself
      -- but today's fallback of 1 is not a true conversion either, and
      saving the document again would quietly apply it. A line saved after
      the deletion has the fallback stored, where the unit used to mean
      more. Both are deleted_unit_lines, with the old factor named."""
    cur = ctx.cur
    item_units = items_service.get_item_unit_info_map(cur)
    units_map = units_service.get_units_map(cur)
    deleted = _deleted_units(cur)
    # The master as it last stood: today's units, and the deleted ones back.
    ever = dict(units_map)
    for name, r in deleted.items():
        ever[name] = {
            "unitName": r["unit_name"],
            "family": r["family"],
            "factorToBase": float(r["factor_to_base"] or 1),
        }

    stale: dict = defaultdict(_new_group)
    from_deleted: dict = defaultdict(_new_group)
    stuck: dict = defaultdict(lambda: {"refs": [], "qty": 0.0, "when": None})
    for doc, area, sql in _BASE_QTY_SOURCES:
        cur.execute(sql)
        for r in cur.fetchall():
            qty = float(r["qty"] or 0)
            if abs(qty) <= _EPS or not str(r["item_name"] or "").strip():
                continue
            info = items_service.lookup_item_unit_info(
                item_units, r["item_name"], r["size"]
            )
            unit = str(r["unit"] or "").strip()
            stored = float(r["base_qty"] or 0)
            if doc == "PO" and stored <= 0:
                # po_service._effective_base_qty: a legacy line is 1:1.
                stored = qty
            base = info["baseUnit"]
            try:
                now = units_service.convert_qty_to_base_unit(qty, unit, info, units_map)
            except ValueError:
                g = stuck[(doc, area, r["item_name"], r["size"], unit, base)]
                g["refs"].append(r["ref"])
                g["qty"] += qty
                g["when"] = max(g["when"] or r["d"], r["d"])
                continue
            tol = max(1e-6, BASE_QTY_TOLERANCE * abs(now))
            then = now
            gone = deleted.get(_k(unit)) or deleted.get(_k(base))
            if gone:
                try:
                    then = units_service.convert_qty_to_base_unit(qty, unit, info, ever)
                except ValueError:
                    then = now
            if abs(stored - now) <= tol and abs(then - now) <= tol:
                continue
            key = (
                doc,
                area,
                r["item_name"],
                r["size"],
                unit,
                base,
                round(stored / qty, 6),
                round(now / qty, 6),
                round(then / qty, 6),
            )
            # Blamed on the deletion only where the stored figure is what the
            # old factor or the fallback gives; anything else is plain stale.
            if (
                gone
                and abs(then - now) > tol
                and min(abs(stored - then), abs(stored - now)) <= tol
            ):
                _grouped(from_deleted[key], r["ref"], r["d"], stored, now)
                from_deleted[key]["gone"] = gone
            else:
                _grouped(stale[key], r["ref"], r["d"], stored, now)

    def counts_on(doc):
        return (
            "The PO Ledger's pending figures count"
            if doc == "PO"
            else "Items Stock counts"
        )

    out = []
    for (doc, area, name, size, unit, base, was, is_now, _then), g in stale.items():
        refs = sorted(set(g["refs"]))
        out.append(
            _finding(
                "stored_base_qty_stale",
                "entry",
                area,
                f"{_sized(name, size)}: {len(g['refs'])} {doc} line(s) in {unit or 'no unit'} "
                f"saved at {_fmt(was)} {base} each, today {_fmt(is_now)}",
                f"Saved as {_fmt(was)} {base} per {unit or 'unit'}; today's Units and Items "
                f"Master make it {_fmt(is_now)}. {counts_on(doc)} the saved figure: "
                f"{_fmt(g['stored'])} {base} where today's conversion gives {_fmt(g['now'])}. "
                f"On: {_listed(refs)}.",
                item=name,
                size=size,
                refs=refs,
                qty=abs(g["stored"] - g["now"]),
                when=g["when"],
                evidence={
                    "unit": unit,
                    "baseUnit": base,
                    "saved": was,
                    "today": is_now,
                },
            )
        )
    for (
        doc,
        area,
        name,
        size,
        unit,
        base,
        was,
        is_now,
        then,
    ), g in from_deleted.items():
        refs = sorted(set(g["refs"]))
        when_gone = f"{g['gone']['deleted_at']:%d/%m/%Y}"
        if abs(was - then) <= max(1e-6, BASE_QTY_TOLERANCE * abs(then)):
            text = (
                f"Saved at {_fmt(was)} {base} per {unit}, the factor it had until it was "
                f"removed from the Units master on {when_gone}. {counts_on(doc)} "
                f"{_fmt(g['stored'])} {base}; saved again today, these lines would convert at "
                f"{_fmt(is_now)} and give {_fmt(g['now'])}."
            )
            gap = abs(g["stored"] - g["now"])
        else:
            lines_qty = g["stored"] / was if was else 0.0
            text = (
                f"Saved at {_fmt(was)} {base} per {unit}, because it had been removed from the "
                f"Units master on {when_gone}, when it was {_fmt(then)}. {counts_on(doc)} "
                f"{_fmt(g['stored'])} {base}; at the old factor it would be "
                f"{_fmt(then * lines_qty)}."
            )
            gap = abs(then - was) * lines_qty
        out.append(
            _finding(
                "deleted_unit_lines",
                "entry",
                area,
                f"{_sized(name, size)}: {len(g['refs'])} {doc} line(s) in {unit}, a unit "
                "deleted from the Units master",
                f"{text} On: {_listed(refs)}.",
                item=name,
                size=size,
                refs=refs,
                qty=gap,
                when=g["when"],
                evidence={"unit": unit, "baseUnit": base, "saved": was, "old": then},
            )
        )
    for (doc, area, name, size, unit, base), g in stuck.items():
        refs = sorted(set(g["refs"]))
        out.append(
            _finding(
                "unit_unconvertible",
                "entry",
                area,
                f"{_sized(name, size)}: {unit} can't be converted to {base}",
                f"{len(g['refs'])} {doc} line(s) enter it in {unit}, which is not the same kind of "
                f"unit as {base}, and the item has no weight per {base}. Each {unit} was counted "
                f"as 1 {base}. Set the weight on the item in Items Master. On: {_listed(refs)}.",
                item=name,
                size=size,
                refs=refs,
                qty=g["qty"],
                when=g["when"],
            )
        )
    return out


# ── Items Stock ────────────────────────────────────────────────────────────


def _check_negative_stock(ctx: _Context) -> list:
    """An item whose Current Stock is below zero: more left the shelf
    (production, issues, returns, wastage) than was received or counted.
    Unlike the old over-consumption check, this starts from the item's count
    or opening stock and includes production, so it is the Stock page's own
    figure."""
    terms = ctx.stock_terms()
    out = []
    for r in audit_entries._stock_rows(ctx):
        key = stock_service._stock_key(r["item_name"], r["size"])
        current = terms.current(key, r["initial_stock"])
        if current >= -1e-6:
            continue
        anchor = terms.anchors.get(key)
        start = (
            f"counted {_fmt(anchor[1])} on {anchor[0]:%d/%m/%Y}"
            if anchor
            else f"opening stock {_fmt(r['initial_stock'])}"
        )
        moved = terms.moved.get(key, 0.0)
        used = terms.consumed.get(key, 0.0)
        out.append(
            _finding(
                "negative_item_stock",
                "entry",
                "stock",
                f"{_sized(r['item_name'], r['size'])} is {_fmt(current)} in Items Stock",
                f"From {start}: {'+' if moved >= 0 else ''}{_fmt(moved)} from bills, returns, "
                f"wastage and issues, and {_fmt(-used)} used by production lots. More left the "
                "shelf than was received or counted: look for a bill not entered, a lot whose "
                "components are wrong, or an issue entered twice.",
                item=r["item_name"],
                size=r["size"],
                refs=[f"Count #{anchor[2]}"] if anchor else [],
                qty=abs(current),
                when=anchor[0] if anchor else None,
            )
        )
    return out


def _check_stock_rows(ctx: _Context) -> list:
    """The Stock page lists erp.stock rows. An item that moves -- billed,
    used by a lot, counted -- with no live row there has stock nobody sees."""
    terms = ctx.stock_terms()
    keys = {
        stock_service._stock_key(r["item_name"], r["size"])
        for r in audit_entries._stock_rows(ctx)
    }
    out = []
    for key in sorted((set(terms.moved) | set(terms.consumed)) - keys):
        moved, used = terms.moved.get(key, 0.0), terms.consumed.get(key, 0.0)
        if abs(moved) <= 1e-6 and abs(used) <= 1e-6:
            continue
        name, _, size = key.partition("|")
        out.append(
            _finding(
                "stock_row_missing",
                "entry",
                "stock",
                f"{_sized(name, size)} moves but is not on the Stock page",
                f"Bills, returns, wastage and issues net {_fmt(moved)} and production used "
                f"{_fmt(used)} of it, but Items Stock has no row for it, so no screen shows its "
                "stock. Add it to Items Stock, or correct the name on the documents.",
                item=name,
                size=size,
                qty=abs(moved) + abs(used),
            )
        )
    return out


# ── Dispatch and client orders ─────────────────────────────────────────────


def _check_dispatch(ctx: _Context) -> list:
    """A dispatch line's Amount is Qty x Rate and its Logistics Cost is Qty
    x the bill's logistics rate, both stored when it is saved. A dispatch
    against a PI / Estimate must name a live one, of the same client, with
    that product on it, and not ship more of it than ordered. All of a
    dispatch must come off the Warehouse Pool, a Dispatch Plan line marked
    fulfilled must name a real dispatch, and one still open long after its
    date was never sent. An order line pushed to production has a lot."""
    cur = ctx.cur
    cur.execute(
        """
        SELECT h.dispatch_number, h.dispatch_date, h.order_number, h.client_name,
               h.logistics_contractor, h.logistics_rate,
               l.product_id, l.product_name, l.qty, l.rate, l.amount, l.logistics_cost
          FROM erp.dispatch_lines l JOIN erp.dispatch_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
         ORDER BY h.dispatch_date, h.id, l.id
        """
    )
    lines = cur.fetchall()
    cur.execute(
        """
        SELECT oh.order_number, oh.client_name, oh.status, ol.product_id, ol.qty
          FROM erp.client_orders_lines ol
          JOIN erp.client_orders_headers oh ON oh.id = ol.header_id
         WHERE oh.deleted_at IS NULL
        """
    )
    orders: dict = {}
    for r in cur.fetchall():
        o = orders.setdefault(
            _k(r["order_number"]),
            {
                "number": r["order_number"],
                "client": r["client_name"],
                "status": r["status"],
                "qty": defaultdict(float),
            },
        )
        o["qty"][_k(r["product_id"])] += float(r["qty"] or 0)

    bad_amount: dict = defaultdict(list)
    bad_logistics: dict = defaultdict(list)
    no_contractor: dict = defaultdict(list)
    no_rate: dict = defaultdict(set)
    order_problems: dict = defaultdict(list)
    shipped: dict = defaultdict(lambda: [0.0, set(), None])
    for d in lines:
        number = f"Dispatch {d['dispatch_number']}"
        qty = float(d["qty"] or 0)
        if abs(float(d["amount"] or 0) - qty * float(d["rate"] or 0)) > MONEY_EPS:
            bad_amount[number].append(d)
        cost = float(d["logistics_cost"] or 0)
        if abs(cost - qty * float(d["logistics_rate"] or 0)) > MONEY_EPS:
            bad_logistics[number].append(d)
        contractor = str(d["logistics_contractor"] or "").strip()
        if cost > MONEY_EPS and not contractor:
            no_contractor[number].append(d)
        if contractor and not float(d["logistics_rate"] or 0):
            no_rate[contractor].add(str(d["dispatch_number"]))
        order_raw = str(d["order_number"] or "").strip()
        if not order_raw:
            continue
        o = orders.get(order_raw.lower())
        if o is None:
            order_problems[number].append(f"PI / Estimate {order_raw} is not there")
            continue
        if _k(o["client"]) != _k(d["client_name"]):
            order_problems[number].append(
                f"{order_raw} belongs to {o['client']}, the dispatch to {d['client_name']}"
            )
        if _k(o["status"]) == "cancelled":
            order_problems[number].append(f"{order_raw} is Cancelled")
        if _k(d["product_id"]) not in o["qty"]:
            order_problems[number].append(f"{d['product_name']} is not on {order_raw}")
            continue
        s = shipped[(order_raw.lower(), _k(d["product_id"]))]
        s[0] += qty
        s[1].add(d["dispatch_number"])
        s[2] = d

    out = []
    for number, rows in bad_amount.items():
        out.append(
            _finding(
                "dispatch_amount_formula",
                "integrity",
                "dispatch",
                f"{number}: an Amount is not Qty x Rate",
                "; ".join(
                    f"{d['product_name']}: {_fmt(d['qty'])} x {_rs(d['rate'])} held as {_rs(d['amount'])}"
                    for d in rows
                )
                + ".",
                refs=[number],
                qty=sum(
                    abs(
                        float(d["amount"] or 0)
                        - float(d["qty"] or 0) * float(d["rate"] or 0)
                    )
                    for d in rows
                ),
                when=rows[0]["dispatch_date"],
            )
        )
    for number, rows in bad_logistics.items():
        out.append(
            _finding(
                "dispatch_logistics_formula",
                "integrity",
                "contractors",
                f"{number}: a Logistics Cost is not Qty x the logistics rate",
                "; ".join(
                    f"{d['product_name']}: {_fmt(d['qty'])} x {_rs(d['logistics_rate'])} held as "
                    f"{_rs(d['logistics_cost'])}"
                    for d in rows
                )
                + ". The Contractor Ledger pays the held figure.",
                refs=[number],
                qty=sum(
                    abs(
                        float(d["logistics_cost"] or 0)
                        - float(d["qty"] or 0) * float(d["logistics_rate"] or 0)
                    )
                    for d in rows
                ),
                when=rows[0]["dispatch_date"],
            )
        )
    for number, rows in no_contractor.items():
        cost = sum(float(d["logistics_cost"] or 0) for d in rows)
        out.append(
            _finding(
                "logistics_cost_without_contractor",
                "entry",
                "contractors",
                f"{number} carries {_rs(cost)} of logistics cost with no contractor",
                "The cost is on the dispatch, but with no Logistics Contractor it is owed to "
                "nobody and never reaches the Contractor Ledger.",
                refs=[number],
                qty=cost,
                when=rows[0]["dispatch_date"],
            )
        )
    for contractor, numbers in sorted(no_rate.items()):
        out.append(
            _finding(
                "dispatch_no_logistics_rate",
                "entry",
                "contractors",
                f"{contractor}: {len(numbers)} dispatch(es) carry no logistics rate",
                f"{_listed(sorted(numbers))} name {contractor} for logistics, but no rate "
                "applied, so the cost is Rs 0 and nothing reaches the Contractor Ledger. "
                "Ignore this if the transport is not paid per unit.",
                refs=[f"Contractor {contractor}"]
                + [f"Dispatch {n}" for n in sorted(numbers)],
                qty=len(numbers),
            )
        )
    for number, problems in order_problems.items():
        out.append(
            _finding(
                "dispatch_order_mismatch",
                "entry",
                "dispatch",
                f"{number} does not fit the PI / Estimate it names",
                "; ".join(sorted(set(problems))) + ".",
                refs=[number],
                qty=len(problems),
            )
        )
    for (order_k, product_k), (qty, numbers, d) in shipped.items():
        ordered = orders[order_k]["qty"][product_k]
        if qty <= ordered + 1e-4:
            continue
        out.append(
            _finding(
                "dispatch_over_order",
                "entry",
                "dispatch",
                f"More {d['product_name']} dispatched than {d['order_number']} ordered",
                f"{_fmt(qty)} dispatched on {_listed(sorted(numbers))} against {_fmt(ordered)} "
                f"ordered. The order was probably reduced after it was dispatched against.",
                refs=[f"PI / Estimate {d['order_number']}"]
                + [f"Dispatch {n}" for n in sorted(numbers)],
                qty=qty - ordered,
                when=d["dispatch_date"],
            )
        )

    # Ready to Dispatch is the pool's finished goods, however it is grouped.
    ready: dict = defaultdict(float)
    for entry in dispatch_service._compute_ready_to_dispatch_map(cur).values():
        ready[entry["baseKey"]] += (
            entry["producedQty"] - entry["dispatchedQty"] - entry["wastedQty"]
        )
    cur.execute(
        "SELECT output_item_name, product_tag, process_id, available_qty "
        "FROM erp.warehouse_pool WHERE counts_toward_total"
    )
    held: dict = defaultdict(float)
    names: dict = {}
    for r in cur.fetchall():
        tag, process = _k(r["product_tag"]), _k(r["process_id"])
        final = process in ctx.final_ids
        if (tag and process and not final) or (not tag and not final):
            continue
        base = tag or f"__output__{_k(r['output_item_name'])}"
        held[base] += float(r["available_qty"] or 0)
        names[base] = r["output_item_name"]
    for base in sorted(set(ready) | set(held)):
        if abs(ready.get(base, 0.0) - held.get(base, 0.0)) <= 1e-4:
            continue
        out.append(
            _finding(
                "ready_vs_pool",
                "integrity",
                "dispatch",
                f"Ready to Dispatch shows {_fmt(ready.get(base, 0.0))} of "
                f"{names.get(base, base)}, the pool holds {_fmt(held.get(base, 0.0))}",
                "Ready to Dispatch is the pool's finished goods, and must add up to them.",
                item=names.get(base, base),
                qty=abs(ready.get(base, 0.0) - held.get(base, 0.0)),
            )
        )

    reached: dict = defaultdict(float)
    for e in ctx.all_events:
        if e["type"] == "Dispatch":
            reached[str(e["ref"])] += e["outQty"] - e["inQty"]
    sent: dict = defaultdict(lambda: [0.0, None])
    for d in lines:
        entry = sent[str(d["dispatch_number"])]
        entry[0] += float(d["qty"] or 0)
        entry[1] = d["dispatch_date"]
    for number, (qty, day) in sent.items():
        got = reached.get(number, 0.0)
        if abs(got - qty) <= 1e-4:
            continue
        out.append(
            _finding(
                "dispatch_not_in_pool",
                "integrity",
                "dispatch",
                f"Dispatch {number}: {_fmt(qty)} sent, the Warehouse Pool took off {_fmt(got)}",
                "Every unit dispatched comes off the pool's colour buckets. The rest of this "
                "dispatch still shows as stock.",
                refs=[f"Dispatch {number}"],
                qty=abs(qty - got),
                when=day,
            )
        )

    cur.execute(
        "SELECT plan_date, client_name, product_name, qty, fulfilled_dispatch_number "
        "FROM erp.dispatch_plan_lines"
    )
    live = {_k(d["dispatch_number"]) for d in lines}
    cutoff = ctx.today - timedelta(days=PLAN_OVERDUE_DAYS)
    overdue: dict = defaultdict(list)
    plan_missing: dict = defaultdict(list)
    for r in cur.fetchall():
        number = str(r["fulfilled_dispatch_number"] or "").strip()
        if number:
            if _k(number) not in live:
                plan_missing[number].append(r)
        elif r["plan_date"] and r["plan_date"] < cutoff:
            overdue[r["plan_date"]].append(r)
    for number, rows in plan_missing.items():
        out.append(
            _finding(
                "plan_line_dispatch_missing",
                "entry",
                "dispatch",
                f"Dispatch Plan says {len(rows)} line(s) went out on {number}, which is not there",
                _listed(
                    f"{r['product_name']} {_fmt(r['qty'])} for {r['client_name']}"
                    for r in rows
                )
                + ". The dispatch was deleted after the plan was fulfilled, so these units are "
                "neither planned nor dispatched.",
                refs=[f"Dispatch {number}"],
                qty=sum(float(r["qty"] or 0) for r in rows),
            )
        )
    for day, rows in overdue.items():
        out.append(
            _finding(
                "plan_line_overdue",
                "entry",
                "dispatch",
                f"{len(rows)} Dispatch Plan line(s) for {day:%d/%m/%Y} were never sent",
                _listed(
                    f"{r['product_name']} {_fmt(r['qty'])} for {r['client_name']}"
                    for r in rows
                )
                + ". They still hold those units back from what can be planned. Send them or "
                "take them off the plan.",
                refs=[f"Dispatch Plan {day:%d/%m/%Y}"],
                qty=sum(float(r["qty"] or 0) for r in rows),
                when=day,
            )
        )

    cur.execute(
        """
        SELECT oh.order_number, oh.client_name, ol.product_id, ol.product_name, ol.qty
          FROM erp.client_orders_lines ol
          JOIN erp.client_orders_headers oh ON oh.id = ol.header_id
         WHERE oh.deleted_at IS NULL AND lower(btrim(ol.production_pushed)) = 'yes'
        """
    )
    pushed = cur.fetchall()
    if pushed:
        cur.execute(
            "SELECT order_number, product_id FROM erp.production "
            "WHERE deleted_at IS NULL AND order_number IS NOT NULL"
        )
        lots = {(_k(r["order_number"]), _k(r["product_id"])) for r in cur.fetchall()}
        for r in pushed:
            if (_k(r["order_number"]), _k(r["product_id"])) in lots:
                continue
            out.append(
                _finding(
                    "order_pushed_lot_missing",
                    "entry",
                    "dispatch",
                    f"{r['order_number']}: {r['product_name']} was sent to production, "
                    "but no lot exists",
                    f"{_fmt(r['qty'])} for {r['client_name']} is marked as pushed to production, "
                    "so saving the order will not push it again, and its lot is gone.",
                    refs=[f"PI / Estimate {r['order_number']}"],
                    qty=float(r["qty"] or 0),
                )
            )
    return out


# ── Purchase Orders ────────────────────────────────────────────────────────


def _check_po_status(ctx: _Context) -> list:
    """A PO's status and its pending figures are two readings of its bills
    and must say the same thing. A PO closed as Completed by hand with
    nothing ever billed should have been Cancelled: every report reads it as
    received. And a line billed past what it ordered, while another open PO
    from that vendor still waits for the same item, is bills landing on the
    wrong PO: the one reads over-billed and the other reads still owed."""
    cur = ctx.cur
    pos = po_service._load_po_list(
        cur, bill_service._aggregate_billed_base_qty_by_po(cur)
    )
    completed = config_maps.PO_STATUS["COMPLETED"]
    cancelled = config_maps.PO_STATUS["CANCELLED"]
    waiting: dict = defaultdict(list)
    for po in pos:
        if po.get("closedAs"):
            continue
        for i in po["items"]:
            if i["pendingQty"] > 0.0001:
                key = (_k(po["vendor"]), _k(i["name"]), _k(i["size"]))
                waiting[key].append((po["poNumber"], i["pendingQty"], i.get("unit")))
    out = []
    for po in pos:
        for i in po["items"]:
            if i["pendingQty"] >= -0.0001:
                continue
            key = (_k(po["vendor"]), _k(i["name"]), _k(i["size"]))
            others = [x for x in waiting.get(key, []) if x[0] != po["poNumber"]]
            if not others:
                continue
            over = -i["pendingQty"]
            out.append(
                _finding(
                    "bill_on_wrong_po",
                    "entry",
                    "pos",
                    f"PO {po['poNumber']}: {_sized(i['name'], i['size'])} is {_fmt(over)} over, "
                    f"while PO {others[0][0]} still waits for it",
                    f"{po['vendor']}: ordered {_fmt(i['qty'])} {i.get('unit') or ''}, billed "
                    f"{_fmt(i['receivedQty'])}. Still open for the same item: "
                    + _listed(f"PO {n} ({_fmt(q)} {u or ''})" for n, q, u in others)
                    + ". The later bills probably belong on that PO, which goes on reading as "
                    "owed.",
                    item=i["name"],
                    size=i["size"],
                    refs=[f"PO {po['poNumber']}"] + [f"PO {n}" for n, _q, _u in others],
                    qty=over,
                )
            )
    ctx.stats.setdefault("counted", {})["pos"] = len(pos)
    for po in pos:
        number, status = po["poNumber"], po["status"]
        pending = [i for i in po["items"] if i["pendingQty"] > 0.0001]
        says_open = status not in (completed, cancelled)
        if says_open != bool(pending):
            out.append(
                _finding(
                    "po_status_disagrees",
                    "integrity",
                    "pos",
                    f"PO {number} says {status} but has "
                    + (
                        f"{len(pending)} line(s) pending"
                        if pending
                        else "nothing pending"
                    ),
                    f"{po['vendor']}: the status and the pending figures come from the same "
                    "bills and must agree.",
                    refs=[f"PO {number}"],
                    qty=sum(i["pendingQty"] for i in pending) or 1,
                )
            )
        billed = any(float(i.get("receivedQty") or 0) > 0.0001 for i in po["items"])
        if po.get("closedAs") == completed and not billed:
            out.append(
                _finding(
                    "po_completed_nothing_billed",
                    "entry",
                    "pos",
                    f"PO {number} was set Completed with nothing billed",
                    f"{po['vendor']}: no bill was ever entered against it, so nothing was "
                    "received. If it is never coming, it is Cancelled.",
                    refs=[f"PO {number}"],
                    qty=len(po["items"]),
                )
            )
    return out


# ── Processes and BOM ──────────────────────────────────────────────────────


def _check_processes(ctx: _Context) -> list:
    """Recipes that cannot work. An active process drawing a pool item no
    active process makes runs that pool negative with every lot; a component
    with no quantity is never consumed; a process with no Process Type can
    never pick up a contractor's rate; and processes that consume each
    other's output cannot be sequenced at all."""
    cur = ctx.cur
    cur.execute(
        """
        SELECT m.process_id, m.process_name, m.output_item_name, m.process_type,
               c.item_name, c.qty_per_unit, c.source_type
          FROM erp.process_master m
          LEFT JOIN erp.process_components c ON c.master_id = m.id
         WHERE m.deleted_at IS NULL AND m.active
         ORDER BY m.id, c.id
        """
    )
    rows = cur.fetchall()
    made = {_k(r["output_item_name"]) for r in rows} - {""}
    processes: dict = {}
    for r in rows:
        p = processes.setdefault(
            r["process_id"],
            {
                "name": r["process_name"],
                "output": _k(r["output_item_name"]),
                "type": _k(r["process_type"]),
                "pool": set(),
                "unmade": [],
                "noQty": [],
            },
        )
        if not str(r["item_name"] or "").strip():
            continue
        if _k(r["source_type"]) == "pool":
            p["pool"].add(_k(r["item_name"]))
            if _k(r["item_name"]) not in made:
                p["unmade"].append(r["item_name"])
        if float(r["qty_per_unit"] or 0) <= 0:
            p["noQty"].append(r["item_name"])

    out = []
    for pid, p in processes.items():
        name = p["name"]
        if p["unmade"]:
            out.append(
                _finding(
                    "process_component_unmade",
                    "entry",
                    "processes",
                    f"{name} draws on something no process makes",
                    f"{_listed(p['unmade'])}: from the Warehouse Pool, but no active process "
                    "outputs it, so every lot runs that pool negative.",
                    refs=[f"Process {pid}"],
                    qty=len(p["unmade"]),
                )
            )
        if p["noQty"]:
            out.append(
                _finding(
                    "process_component_no_qty",
                    "entry",
                    "processes",
                    f"{name}: {len(p['noQty'])} recipe line(s) have no quantity",
                    f"{_listed(p['noQty'])}: lots of this process consume none of it.",
                    refs=[f"Process {pid}"],
                    qty=len(p["noQty"]),
                )
            )
        if not p["type"]:
            out.append(
                _finding(
                    "process_no_type",
                    "entry",
                    "processes",
                    f"{name} has no Process Type",
                    "A contractor's rate is looked up by Process Type, so its lots can never "
                    "earn one.",
                    refs=[f"Process {pid}"],
                    qty=1,
                )
            )

    maker = {p["output"]: pid for pid, p in processes.items() if p["output"]}

    def loop_from(start) -> list:
        """The chain of processes leading from `start` back to it, if any."""
        trail = [start]
        seen = {start}

        def walk(pid):
            for item in sorted(processes[pid]["pool"]):
                nxt = maker.get(item)
                if nxt == start:
                    return True
                if nxt is not None and nxt not in seen:
                    seen.add(nxt)
                    trail.append(nxt)
                    if walk(nxt):
                        return True
                    trail.pop()
            return False

        return trail if walk(start) else []

    reported = set()
    for pid in processes:
        trail = loop_from(pid)
        if trail and frozenset(trail) not in reported:
            reported.add(frozenset(trail))
            names = [processes[x]["name"] for x in trail]
            out.append(
                _finding(
                    "process_cycle",
                    "entry",
                    "processes",
                    f"{names[0]} depends on its own output",
                    " uses ".join(names + [names[0]])
                    + ". None of them can be made first.",
                    refs=[f"Process {x}" for x in trail],
                    qty=len(trail),
                )
            )
    return out


def _external_bom_findings() -> list:
    """BOM costing against the process recipe it prices
    (getBomProcessComponentsDrift). Opens its own connections."""
    res = bom_service.get_bom_process_components_drift()
    by_product: dict = defaultdict(list)
    for d in res.get("data") or []:
        by_product[(d["productId"], d["productName"])].append(d)
    out = []
    for (product_id, name), rows in by_product.items():
        lines = [
            f"{_sized(d['itemName'], d['size'])}: {_fmt(d['bomQtyPerProduct'])} in the BOM, "
            f"{_fmt(d['recipeQtyPerUnit'])} in the recipe"
            for d in rows
        ]
        out.append(
            _finding(
                "bom_recipe_drift",
                "entry",
                "processes",
                f"{name}: the BOM and its recipe disagree on {len(rows)} item(s)",
                f"{_listed(lines)}. Stock follows the recipe, so the BOM's costing is off.",
                refs=[f"Product {product_id}"],
                qty=len(rows),
            )
        )
    return out


# ── Inspection ─────────────────────────────────────────────────────────────


def _check_inspections(ctx: _Context) -> list:
    """An inspection signs off a lot's sheet. A sheet changed after it was
    cleared is no longer what was inspected; a lot marked Completed with its
    inspection still open went past it; and a lot flagged for an admin should
    not wait for long. Inspection never moves stock, so none of these touch a
    figure."""
    cur = ctx.cur
    cur.execute(
        """
        SELECT i.status, i.flagged_at, i.cleared_at, i.cleared_sheet, i.remarks,
               p.lot_number, p.id, p.status AS lot_status, p.custom_components,
               p.components_consumed
          FROM erp.lot_inspections i
          JOIN erp.production p ON p.id = i.production_id AND p.deleted_at IS NULL
        """
    )
    cutoff = ctx.today - timedelta(days=INSPECTION_REVIEW_DAYS)
    out = []
    for r in cur.fetchall():
        label = _lot_label(r)
        rows = inspection_service.sheet_rows(
            r["custom_components"], r["components_consumed"]
        )
        if r["status"] == inspection_service.STATUS_CLEARED:
            if inspection_service._changed_since_cleared(r, rows):
                out.append(
                    _finding(
                        "inspection_changed_after_clearing",
                        "entry",
                        "inspection",
                        f"{label} changed after its inspection was cleared",
                        f"Cleared on {r['cleared_at']:%d/%m/%Y}, but the sheet is not what was "
                        "signed: an item or quantity was edited since. Inspect it again.",
                        refs=[label],
                        qty=1,
                        when=r["cleared_at"],
                    )
                )
            continue
        if lot_receipts.is_completed(r["lot_status"]):
            out.append(
                _finding(
                    "inspection_open_on_completed_lot",
                    "entry",
                    "inspection",
                    f"{label} is Completed with its inspection unfinished",
                    "The lot was marked Completed while its inspection was still open, so "
                    "nobody signed off what went into it.",
                    refs=[label],
                    qty=1,
                )
            )
        if (
            r["status"] == inspection_service.STATUS_FLAGGED
            and r["flagged_at"]
            and r["flagged_at"].date() < cutoff
        ):
            out.append(
                _finding(
                    "inspection_review_waiting",
                    "entry",
                    "inspection",
                    f"{label} has waited for an admin since {r['flagged_at']:%d/%m/%Y}",
                    f"Flagged for review: {r['remarks'] or 'no remarks'}.",
                    refs=[label],
                    qty=1,
                    when=r["flagged_at"],
                )
            )
    return out


# ── Dashboard ──────────────────────────────────────────────────────────────


def _dashboard_gaps() -> list:
    """Where the Dashboard's month totals differ from the ledgers'."""
    kpis = dashboard_service.get_dashboard_data()["data"]["kpis"]
    last_start, this_start, next_start = dashboard_service._month_window()
    sources = (
        (
            "bills",
            "Bills",
            bill_service.get_bill_data,
            "billDateRaw",
            "totalAmount",
            "Value",
        ),
        (
            "returns",
            "Returns",
            return_service.get_return_data,
            "returnDateRaw",
            "totalAmount",
            "Value",
        ),
        (
            "wastage",
            "Wastage",
            wastage_service.get_wastage_data,
            "dateRaw",
            "totalQty",
            "Qty",
        ),
    )
    gaps = []
    for prefix, label, read, date_key, value_key, measure in sources:
        months = {
            "This": {"count": 0, "value": 0.0, "lines": 0},
            "Last": {"count": 0, "value": 0.0, "lines": 0},
        }
        for doc in read()["data"] or []:
            raw = str(doc.get(date_key) or "")[:10]
            if not raw:
                continue
            day = date.fromisoformat(raw)
            month = (
                "This"
                if this_start <= day < next_start
                else "Last"
                if last_start <= day < this_start
                else None
            )
            if month is None:
                continue
            months[month]["count"] += 1
            months[month]["value"] += float(doc.get(value_key) or 0)
            months[month]["lines"] += len(doc.get("items") or [])
        for month, ledger in months.items():
            shown_count = kpis[f"{prefix}{month}MonthCount"]
            shown_value = kpis[f"{prefix}{month}Month{measure}"]
            # The Dashboard rounds each line in SQL and the ledger in Python
            # (dashboard_service's rounding note): a paisa a line is accepted.
            tolerance = MONEY_EPS * max(ledger["lines"], 1) + MONEY_EPS
            if (
                shown_count != ledger["count"]
                or abs(shown_value - ledger["value"]) > tolerance
            ):
                gaps.append((label, month, shown_count, shown_value, ledger))
    return gaps


def _external_dashboard_findings() -> list:
    """The Dashboard's month totals are separate SQL over the same ledgers
    (dashboard_service.py's _*_TWO_MONTH_SQL), so they can drift from what
    the ledgers add up to. Everything else on it comes from the module's own
    reader. Opens its own connections, so it runs outside the transaction."""
    gaps = _dashboard_gaps()
    if gaps:
        # A save landing between the two reads looks like a disagreement.
        gaps = _dashboard_gaps()
    return [
        _finding(
            "dashboard_vs_ledger",
            "integrity",
            "dashboard",
            f"Dashboard {label} for {month.lower()} month do not match the ledger",
            f"The Dashboard shows {shown_count} document(s), {_fmt(shown_value)}. The ledger adds "
            f"up to {ledger['count']} document(s), {_fmt(ledger['value'])}.",
            refs=[f"Dashboard {label}"],
            qty=abs(shown_value - ledger["value"]) or 1,
        )
        for label, month, shown_count, shown_value, ledger in gaps
    ]


# ── Masters and references ─────────────────────────────────────────────────


_PARTY_MASTERS = (
    ("Vendor", "erp.vendors", "vendor_name"),
    ("Contractor", "erp.contractors", "contractor_name"),
    ("Client", "erp.clients", "client_name"),
)

# Where each kind of party is named on a document. A name missing from its
# master cannot be picked again, has no rate cards or contact, and splits
# its ledgers from the party it was meant to be.
_PARTY_USES = (
    (
        "Vendor",
        "bill",
        "SELECT vendor AS name FROM erp.bill_headers WHERE deleted_at IS NULL",
    ),
    ("Vendor", "PO", "SELECT vendor FROM erp.po_headers WHERE deleted_at IS NULL"),
    (
        "Vendor",
        "return",
        "SELECT vendor FROM erp.return_headers WHERE deleted_at IS NULL",
    ),
    (
        "Vendor",
        "wastage note",
        "SELECT vendor FROM erp.wastage_headers WHERE deleted_at IS NULL",
    ),
    (
        "Vendor",
        "issue",
        "SELECT vendor FROM erp.issue_headers WHERE deleted_at IS NULL",
    ),
    ("Vendor", "Items Master vendor link", "SELECT vendor FROM erp.item_vendors"),
    (
        "Contractor",
        "lot",
        "SELECT assigned_to FROM erp.production WHERE deleted_at IS NULL",
    ),
    ("Contractor", "payment", "SELECT contractor_name FROM erp.contractor_payments"),
    ("Contractor", "rate card", "SELECT contractor_name FROM erp.contractor_rates"),
    (
        "Contractor",
        "service charge",
        "SELECT contractor_name FROM erp.contractor_service_charges",
    ),
    (
        "Contractor",
        "dispatch",
        "SELECT logistics_contractor FROM erp.dispatch_headers WHERE deleted_at IS NULL",
    ),
    (
        "Client",
        "dispatch",
        "SELECT client_name FROM erp.dispatch_headers WHERE deleted_at IS NULL",
    ),
    (
        "Client",
        "PI / Estimate",
        "SELECT client_name FROM erp.client_orders_headers WHERE deleted_at IS NULL",
    ),
    ("Client", "Dispatch Plan line", "SELECT client_name FROM erp.dispatch_plan_lines"),
)


def _check_masters(ctx: _Context) -> list:
    cur = ctx.cur
    out = []
    known: dict = {}
    ctx.stats.setdefault("counted", {})["references"] = 0
    for kind, table, col in _PARTY_MASTERS:
        cur.execute(f"SELECT {col} AS name FROM {table} WHERE deleted_at IS NULL")
        names = [r["name"] for r in cur.fetchall() if str(r["name"] or "").strip()]
        known[kind] = {_k(n) for n in names}
        groups: dict = defaultdict(set)
        for n in names:
            groups[_squash(n)].add(n.strip())
        for spellings in groups.values():
            if len(spellings) < 2:
                continue
            spellings = sorted(spellings)
            out.append(
                _finding(
                    "master_name_variants",
                    "entry",
                    "references",
                    f"{kind}s {' and '.join(spellings)} look like one {kind.lower()}",
                    f"The {kind}s master has {len(spellings)} spellings of one name: "
                    f"{', '.join(spellings)}. Documents entered under each are kept apart in every "
                    "ledger.",
                    refs=[f"{kind} {s}" for s in spellings],
                    qty=len(spellings),
                )
            )
    cur.execute(
        "SELECT item_name, COALESCE(size, '') AS size FROM erp.items WHERE deleted_at IS NULL"
    )
    items: dict = defaultdict(set)
    for r in cur.fetchall():
        items[(_squash(r["item_name"]), _squash(r["size"]))].add(
            _sized(r["item_name"].strip(), r["size"].strip())
        )
    for spellings in items.values():
        if len(spellings) < 2:
            continue
        spellings = sorted(spellings)
        out.append(
            _finding(
                "master_name_variants",
                "entry",
                "references",
                f"Items {' and '.join(spellings)} look like one item",
                f"Items Master has {len(spellings)} spellings of one item: {', '.join(spellings)}. "
                "Each keeps its own stock. Merge them from Items Master.",
                refs=[f"Item {s}" for s in spellings],
                qty=len(spellings),
            )
        )

    unknown: dict = defaultdict(lambda: defaultdict(int))
    for kind, where, sql in _PARTY_USES:
        cur.execute(sql)
        for r in cur.fetchall():
            name = str(next(iter(r.values())) or "").strip()
            if name:
                ctx.stats["counted"]["references"] += 1
            # A lot number typed into a wastage note's Vendor is not a party
            # (audit_entries' wastage_lot_in_vendor lists those).
            if where == "wastage note" and audit_entries._names_a_lot(ctx, name):
                continue
            if name and _k(name) not in known[kind]:
                unknown[(kind, name)][where] += 1
    for (kind, name), uses in sorted(unknown.items()):
        out.append(
            _finding(
                "party_not_in_master",
                "entry",
                "references",
                f"{kind} {name} is used but missing from the {kind}s master",
                "Named on "
                + ", ".join(f"{n} {where}(s)" for where, n in sorted(uses.items()))
                + f". It cannot be picked on a new document, and anything kept on the {kind.lower()} "
                "(rates, contact) is missing. Add it to the master, or rename the documents to the "
                f"{kind.lower()} it should be.",
                refs=[f"{kind} {name}"],
                qty=sum(uses.values()),
            )
        )
    return out


# ── Dates ──────────────────────────────────────────────────────────────────


_FUTURE_SOURCES = (
    (
        "Bill",
        "bills",
        "SELECT 'Bill ' || bill_number || ' (' || vendor || ')' AS ref, bill_date AS d "
        "FROM erp.bill_headers WHERE deleted_at IS NULL AND bill_date > %s",
    ),
    (
        "PO",
        "pos",
        "SELECT 'PO ' || po_number AS ref, po_date AS d FROM erp.po_headers "
        "WHERE deleted_at IS NULL AND po_date > %s",
    ),
    (
        "Return",
        "returns",
        "SELECT 'Return ' || return_number AS ref, return_date AS d FROM erp.return_headers "
        "WHERE deleted_at IS NULL AND return_date > %s",
    ),
    (
        "Wastage",
        "wastage",
        "SELECT 'Wastage ' || wastage_id AS ref, wastage_date AS d FROM erp.wastage_headers "
        "WHERE deleted_at IS NULL AND wastage_date > %s",
    ),
    (
        "Issue",
        "issues",
        "SELECT 'Issue ' || issue_id AS ref, issue_date AS d FROM erp.issue_headers "
        "WHERE deleted_at IS NULL AND issue_date > %s",
    ),
    (
        "Dispatch",
        "dispatch",
        "SELECT 'Dispatch ' || dispatch_number AS ref, dispatch_date AS d "
        "FROM erp.dispatch_headers WHERE deleted_at IS NULL AND dispatch_date > %s",
    ),
    (
        "Contractor payment",
        "contractors",
        "SELECT 'Payment #' || id || ' (' || contractor_name || ')' AS ref, payment_date AS d "
        "FROM erp.contractor_payments WHERE payment_date > %s",
    ),
    (
        "Completed lot",
        "production",
        "SELECT lot_number AS ref, production_date AS d FROM erp.production "
        "WHERE deleted_at IS NULL AND lower(status) = 'completed' AND production_date > %s",
    ),
)


_ENTRY_DATE_SOURCES = (
    (
        "Bill",
        "bills",
        "SELECT 'Bill ' || bill_number || ' (' || vendor || ')' AS ref, bill_date AS d, "
        "created_at FROM erp.bill_headers WHERE deleted_at IS NULL "
        "AND created_at <> bill_date::timestamptz "
        "AND abs(created_at::date - bill_date) > %s",
    ),
    (
        "Return",
        "returns",
        "SELECT 'Return ' || return_number AS ref, return_date AS d, created_at "
        "FROM erp.return_headers WHERE deleted_at IS NULL "
        "AND created_at <> return_date::timestamptz "
        "AND abs(created_at::date - return_date) > %s",
    ),
    (
        "Wastage",
        "wastage",
        "SELECT 'Wastage ' || wastage_id AS ref, wastage_date AS d, created_at "
        "FROM erp.wastage_headers WHERE deleted_at IS NULL "
        "AND created_at <> wastage_date::timestamptz "
        "AND abs(created_at::date - wastage_date) > %s",
    ),
    (
        "Issue",
        "issues",
        "SELECT 'Issue ' || issue_id AS ref, issue_date AS d, created_at "
        "FROM erp.issue_headers WHERE deleted_at IS NULL "
        "AND created_at <> issue_date::timestamptz "
        "AND abs(created_at::date - issue_date) > %s",
    ),
    (
        "Lot",
        "production",
        "SELECT lot_number AS ref, production_date AS d, created_at "
        "FROM erp.production WHERE deleted_at IS NULL "
        "AND created_at <> production_date::timestamptz "
        "AND abs(created_at::date - production_date) > %s",
    ),
)


def _check_future_dates(ctx: _Context) -> list:
    """A document dated after today has already moved its ledger -- stock,
    the pool, a payable -- for something that has not happened yet, and a
    count taken before that date cannot absorb it. Usually a typed year or
    month. (A Pending lot dated ahead is a plan, and is left alone.) One
    dated far from the day it was entered sits in the wrong period the same
    way, whichever side of today it falls."""
    out = []
    for doc, area, sql in _ENTRY_DATE_SOURCES:
        ctx.cur.execute(sql, (ENTRY_DATE_GAP_DAYS,))
        rows = ctx.cur.fetchall()
        if not rows:
            continue
        rows.sort(key=lambda r: r["d"])
        out.append(
            _finding(
                "dated_far_from_entry",
                "entry",
                area,
                f"{len(rows)} {doc}(s) dated far from the day they were entered",
                _listed(
                    f"{r['ref']} dated {r['d']:%d/%m/%Y}, entered {r['created_at']:%d/%m/%Y}"
                    for r in rows
                )
                + f". More than {ENTRY_DATE_GAP_DAYS} days apart, so it sits in the wrong period "
                "of its ledger if the date was mistyped.",
                refs=[r["ref"] for r in rows],
                qty=len(rows),
                when=rows[-1]["d"],
            )
        )
    for doc, area, sql in _FUTURE_SOURCES:
        ctx.cur.execute(sql, (ctx.today,))
        rows = ctx.cur.fetchall()
        if not rows:
            continue
        rows.sort(key=lambda r: r["d"])
        out.append(
            _finding(
                "future_dated",
                "entry",
                area,
                f"{len(rows)} {doc}(s) dated after today",
                _listed(f"{r['ref']} on {r['d']:%d/%m/%Y}" for r in rows)
                + ". They already count in their ledgers. Check the date typed.",
                refs=[r["ref"] for r in rows],
                qty=len(rows),
                when=rows[-1]["d"],
            )
        )
    return out


def _external_ledger_findings() -> list:
    """The hourly ledger reconciliation (ledger_audit_service), folded in.
    Opens its own connections, so it runs outside the audit's transaction.

    Its over_consumed_item is left out: it measures returns + wastage +
    issues against what was ever billed, ignoring opening stock, counts and
    production, so an item that came in as opening stock reads as
    over-consumed by everything ever issued. negative_item_stock asks the
    same question of the Stock page's own figure."""
    res = ledger_audit_service.compute_internal_ledger_audit_findings()
    out = []
    for f in res.get("findings") or []:
        t = f.get("type", "")
        if t == "over_consumed_item":
            continue
        refs = [
            f"PO {f['poNumber']}" if f.get("poNumber") else "",
            f"Return {f['returnNumber']}" if f.get("returnNumber") else "",
            f"Bill {f['billNumber']}" if f.get("billNumber") else "",
        ]
        out.append(
            _finding(
                t,
                "entry",
                "pos" if t == "over_billed_po_line" else "returns",
                ledger_audit_service.describe_audit_finding(f).split(" -- ")[0],
                ledger_audit_service.describe_audit_finding(f),
                item=f.get("itemName", ""),
                size=f.get("size", ""),
                refs=refs,
                qty=abs(float(f.get("overBy") or 0)),
            )
        )
    return out


# The ledgers a person reads, with what each must hold. `items` names the
# list of lines on a document, a flat ledger (one record a line) having none;
# the column after the document's number names its total, where it has one.
_LEDGER_READERS = (
    (
        "bills",
        "Bill Ledger",
        bill_service.get_bill_data,
        "items",
        "billNumber",
        "totalAmount",
        """
        SELECT count(DISTINCT lower(btrim(h.vendor)) || '|' || lower(btrim(h.bill_number))) AS docs,
               count(*) AS lines, COALESCE(sum(l.qty), 0) AS qty,
               COALESCE(sum(ROUND(l.qty * l.price * (1 + l.gst_rate_pct / 100.0), 2)), 0) AS value
          FROM erp.bill_lines l JOIN erp.bill_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "pos",
        "PO Ledger",
        po_service.get_po_data,
        "items",
        "poNumber",
        "grandTotal",
        """
        SELECT count(DISTINCT h.id) AS docs, count(*) AS lines, COALESCE(sum(l.qty), 0) AS qty,
               COALESCE(sum(l.qty * l.price), 0) AS value
          FROM erp.po_lines l JOIN erp.po_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "returns",
        "Returns Ledger",
        return_service.get_return_data,
        "items",
        "returnNumber",
        "totalAmount",
        """
        SELECT count(DISTINCT h.id) AS docs, count(*) AS lines, COALESCE(sum(l.qty), 0) AS qty,
               COALESCE(sum(ROUND(l.qty * l.price, 2)), 0) AS value
          FROM erp.return_lines l JOIN erp.return_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "wastage",
        "Wastage Ledger",
        wastage_service.get_wastage_data,
        "items",
        "wastageId",
        None,
        """
        SELECT count(DISTINCT h.id) AS docs, count(*) AS lines, COALESCE(sum(l.qty), 0) AS qty
          FROM erp.wastage_lines l JOIN erp.wastage_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "issues",
        "Issue Stock",
        issue_service.get_issue_data,
        "items",
        "issueId",
        None,
        """
        SELECT count(DISTINCT h.id) AS docs, count(*) AS lines, COALESCE(sum(l.qty), 0) AS qty
          FROM erp.issue_lines l JOIN erp.issue_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "dispatch",
        "Dispatch Ledger",
        dispatch_service.get_dispatch_data,
        None,
        "dispatchNumber",
        None,
        """
        SELECT count(DISTINCT h.id) AS docs, count(*) AS lines, COALESCE(sum(l.qty), 0) AS qty
          FROM erp.dispatch_lines l JOIN erp.dispatch_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL
        """,
    ),
    (
        "production",
        "Production Log",
        production_service.get_production_data,
        None,
        "lotNumber",
        None,
        """
        SELECT count(*) AS docs, count(*) AS lines, COALESCE(sum(qty), 0) AS qty
          FROM erp.production WHERE deleted_at IS NULL
        """,
    ),
)


def _ledger_gaps() -> tuple:
    """(gaps, counts): what each ledger's own reader returns against what
    its tables hold."""
    gaps = []
    counts = {}
    for area, label, read, items_key, doc_key, value_key, sql in _LEDGER_READERS:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            _conn,
            cur,
        ):
            cur.execute(sql)
            held = cur.fetchone()
        rows = read()["data"] or []
        if items_key:
            docs = len(rows)
            lines = [line for row in rows for line in row.get(items_key) or []]
        else:
            docs = len({_k(row.get(doc_key)) for row in rows})
            lines = rows
        qty = sum(float(line.get("qty") or 0) for line in lines)
        counts[area] = {"documents": int(held["docs"]), "lines": int(held["lines"])}
        value = sum(float(row.get(value_key) or 0) for row in rows) if value_key else 0
        # Python rounds each line its own way (dashboard_service's rounding
        # note): a paisa a line is accepted.
        value_off = (
            abs(value - float(held["value"])) > MONEY_EPS * max(held["lines"], 1)
            if value_key
            else False
        )
        if (
            docs != held["docs"]
            or len(lines) != held["lines"]
            or abs(qty - float(held["qty"])) > 1e-4
            or value_off
        ):
            gaps.append((area, label, docs, len(lines), qty, value, held))
    return gaps, counts


def _external_ledger_readers(stats: dict) -> list:
    """Each ledger a person reads is a reader over its tables, grouping
    lines into documents. Every line must come out exactly once: a line
    dropped by a join, or two documents folded into one by a shared number,
    is an entry that landed nowhere, or on another document. Opens its own
    connections, so it runs outside the transaction."""
    gaps, counts = _ledger_gaps()
    if gaps:
        # A save landing between the two reads looks like a disagreement.
        gaps, counts = _ledger_gaps()
    stats.setdefault("counted", {}).update(counts)
    return [
        _finding(
            "ledger_reader_mismatch",
            "integrity",
            area,
            f"{label} does not show every entry exactly once",
            f"The ledger shows {docs} document(s), {lines} line(s), quantity {_fmt(qty)}"
            + (f", value {_rs(value)}" if "value" in held else "")
            + f". Its tables hold {held['docs']} document(s), {held['lines']} line(s), "
            f"quantity {_fmt(held['qty'])}"
            + (f", value {_rs(held['value'])}" if "value" in held else "")
            + ".",
            refs=[label],
            qty=abs(lines - held["lines"]) + abs(docs - held["docs"]) or 1,
        )
        for area, label, docs, lines, qty, value, held in gaps
    ]


def _external_item_ledgers(stats: dict) -> list:
    """Every Item Ledger, read as a person reads it: the real builder for
    every item, its reconciliation balanced for every size, and its top
    balance -- the figure a reader takes as the stock -- equal to the Stock
    page. A ledger read one at a time walks every lot; this reads production
    and Current Stock's terms once and hands them in, so all of them take
    seconds. Opens its own connections, so it runs outside the transaction."""
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        production: dict = defaultdict(list)
        for comp in stock_service._iter_completed_production_components(cur):
            production[_k(comp["itemName"])].append(comp)
        terms = stock_service._get_stock_terms(cur)
        names = sorted(
            {r["item_name"].strip() for r in audit_entries._stock_rows_of(cur)}
        )

    def problems_in(name, shared=True) -> list:
        data = items_service.build_item_ledger(
            name, production if shared else None, terms if shared else None
        )["data"]
        top: dict = {}
        for entry in data["entries"]:  # newest first
            if entry.get("balance") is not None:
                top.setdefault(_k(entry.get("size")), entry["balance"])
        found = []
        for rec in data["reconciliation"]:
            size = rec["size"]
            closing = top.get(_k(size))
            if not rec["balanced"]:
                found.append(
                    (
                        size,
                        "its rows add up to",
                        rec["computedStock"],
                        rec["currentStock"],
                    )
                )
            elif closing is not None and abs(closing - rec["currentStock"]) > 1e-4:
                found.append((size, "its top balance is", closing, rec["currentStock"]))
        return found

    out = []
    for name in names:
        found = problems_in(name)
        if found:
            # A save landing after the shared read looks like a disagreement,
            # so the second look reads everything afresh.
            found = problems_in(name, shared=False)
        for size, what, shown, current in found:
            out.append(
                _finding(
                    "item_ledger_disagrees",
                    "integrity",
                    "stock",
                    f"Item Ledger of {_sized(name, size)} does not close on the Stock page",
                    f"{what} {_fmt(shown)}; the Stock page shows {_fmt(current)}.",
                    item=name,
                    size=size,
                    qty=abs(shown - current),
                )
            )
    stats["itemLedgers"] = len(names)
    return out


# Every check that reads through the audit's own cursor: the module(s) the
# report credits it to, the check, and whether it takes `today`.
_ENTRY_AREAS = ("production", "bills", "issues", "returns", "wastage")
_CHECKS = (
    (("pool",), _check_pool_cache, False),
    (("pool",), _check_pool_ledger, False),
    (("pool",), _check_pool_ledger_screens, False),
    (("pool",), _check_pool_openings, False),
    (("pool",), _check_negative_buckets, False),
    (("pool",), _check_pool_hand_edits, False),
    (("pool", "stock"), _check_count_variances, True),
    (("stock",), _check_stock_paths, False),
    (("stock", *_ENTRY_AREAS), audit_entries._check_stock_statement, False),
    (("stock",), _check_negative_stock, False),
    (("stock",), _check_stock_rows, False),
    (("stock",), _check_counts_before_completion, False),
    (("production",), audit_entries._check_lot_entries, False),
    (("production",), _check_used_before_made, True),
    (("production",), _check_status_toggles, False),
    (("production",), _check_labor_bills, False),
    (("production",), _check_duplicate_lots, False),
    (("production",), _check_lot_colours, False),
    (("production",), _check_lot_completion_time, False),
    (("production",), _check_receipts, False),
    (("production",), _check_stuck_lots, False),
    (
        ("references", "bills", "pos", "returns", "wastage", "issues", "contractors"),
        audit_entries._check_recorded_ids,
        False,
    ),
    (("bills",), audit_entries._check_bill_entries, False),
    (("bills",), audit_entries._check_duplicate_bills, False),
    (("bills",), _check_bill_po_links, False),
    (("bills", "pos", "returns"), audit_entries._check_line_values, False),
    (("issues",), audit_entries._check_issue_entries, False),
    (("returns",), audit_entries._check_return_entries, False),
    (("wastage",), audit_entries._check_wastage_entries, False),
    (("issues", "wastage", "returns"), audit_entries._check_duplicate_entries, False),
    (("pos",), _check_po_status, False),
    (("contractors",), _check_lot_payables, False),
    (("contractors",), _check_lots_without_rate, False),
    (("dispatch", "contractors"), _check_dispatch, False),
    (("processes",), _check_processes, False),
    (("inspection",), _check_inspections, False),
    (("units",), _check_units, False),
    (
        ("units", "bills", "pos", "returns", "wastage", "issues"),
        _check_stored_base_qty,
        False,
    ),
    (("references",), _check_lot_processes, False),
    (("references",), _check_masters, False),
    (
        (
            "production",
            "bills",
            "pos",
            "returns",
            "wastage",
            "issues",
            "dispatch",
            "contractors",
        ),
        _check_future_dates,
        False,
    ),
)

# Checks that open their own connections (they reuse a module's own RPC
# reader), run after the audit's transaction has ended. The last column:
# whether it adds to the run's stats.
_EXTERNAL_CHECKS = (
    (("stock",), _external_reference_findings, False),
    (("stock",), _external_item_ledgers, True),
    (("pos", "returns"), _external_ledger_findings, False),
    (("contractors",), _external_contractor_findings, False),
    (("processes",), _external_bom_findings, False),
    (("dashboard",), _external_dashboard_findings, False),
    (
        ("bills", "pos", "returns", "wastage", "issues", "dispatch", "production"),
        _external_ledger_readers,
        True,
    ),
)

# What a discrepancy says is missing: the calculation that never happened
# ("calculation") or the rule that would have stopped or caught it ("logic").
# One line for each kind of finding, read by the report and by Claude Code.
# Each states what the code does today, so check it when the code changes.
# A finding not listed here has nothing missing behind it: a code bug
# (integrity), or a state the owner chose.
_MISSING = {
    "lot_without_rate": (
        "calculation",
        "No payable is worked out for a lot whose contractor has no rate for that work, "
        "and saving the lot gives no warning.",
    ),
    "return_without_value": (
        "calculation",
        "A return can be saved with no price, so what the vendor owes back is never worked out.",
    ),
    "bill_line_no_price": (
        "calculation",
        "A stock line can be saved at Rs 0, so the bill's value leaves it out.",
    ),
    "unit_not_in_master": (
        "calculation",
        "A unit the Units master does not hold is never converted: it reads as 1 base unit, "
        "with no warning.",
    ),
    "deleted_unit_lines": (
        "calculation",
        "A deleted unit has no conversion any more. deleteUnit has refused units in use since "
        "09/10/2026; the units deleted before that left these lines behind.",
    ),
    "unit_unconvertible": (
        "calculation",
        "A weight cannot become pieces without a weight per piece, and the line is saved 1:1 "
        "instead of being stopped.",
    ),
    "stored_base_qty_stale": (
        "calculation",
        "A line's base quantity is worked out once, when it is saved. A unit in use can no "
        "longer change its factor, nor an item with entries its Base Unit, so these lines "
        "date from before that.",
    ),
    "bill_ledger_only_uncounted": (
        "logic",
        "Ledger only is accepted as the form sends it: the server does not check that a count "
        "holds the goods.",
    ),
    "lot_short_of_recipe": (
        "logic",
        "A lot's components are saved as entered: nothing compares them with the recipe.",
    ),
    "lot_used_other_size": (
        "logic",
        "A lot's components are saved as entered: nothing compares them with the recipe.",
    ),
    "lot_colours_disagree": (
        "logic",
        "A lot's quantity comes from its primary colours, and each colour's counting flag from "
        "the form; saving does not compare the two.",
    ),
    "labor_bill_without_lot": (
        "logic",
        "A Labor Job bill has no link to the lot that made its goods.",
    ),
    "issued_and_used_by_lot": (
        "logic",
        "An issue has no link to the lot it went to, so the same goods can come off Stock "
        "as an issue and again as a lot's component.",
    ),
    "issued_item_also_used_by_lots": (
        "logic",
        "An issue has no link to the lot it went to, so the same goods can come off Stock "
        "as an issue and again as a lot's component.",
    ),
    "issue_not_in_vendor_ledger": (
        "logic",
        "Issued To is typed by hand, and an issue reaches a Vendor Ledger only when it spells "
        "the vendor exactly.",
    ),
    "issued_to_variants": (
        "logic",
        "Issued To is typed by hand, not picked from a list of parties.",
    ),
    "negative_item_stock": (
        "logic",
        "Nothing checks what is on the shelf when goods are issued, used, returned or wasted.",
    ),
    "over_billed_po_line": (
        "logic",
        "A bill past a PO's quantity is only warned about when saved; the excess stays on that PO.",
    ),
    "bill_on_wrong_po": (
        "logic",
        "A bill past a PO's quantity is only warned about when saved; the excess stays on that PO.",
    ),
    "bill_rate_above_po": (
        "logic",
        "The bill form shows a price above the PO's and keeps it by choice, but the choice is "
        "not recorded, so an agreed change and an overcharge look alike.",
    ),
    "bill_rate_spread": (
        "logic",
        "Saving a bill does not compare its price with what the item usually costs.",
    ),
    "possible_duplicate_bill": (
        "logic",
        "Saving a bill refuses the same vendor and number; the same lines under a new number "
        "go through.",
    ),
    "possible_duplicate_lot": (
        "logic",
        "Nothing checks for the same entry typed in twice.",
    ),
    "possible_duplicate_entry": (
        "logic",
        "Nothing checks for the same entry typed in twice.",
    ),
    "future_dated": (
        "logic",
        "Only a production receipt refuses a date in the future; every other entry accepts one.",
    ),
    "dated_far_from_entry": (
        "logic",
        "Nothing queries a date far from the day it is typed.",
    ),
    "party_not_in_master": (
        "logic",
        "A lot's contractor and a dispatch's client are saved as typed, even when the name is "
        "not in its master.",
    ),
    "contractor_overpaid": (
        "logic",
        "A payment is not compared with what the contractor has earned.",
    ),
    "orphaned_return_bill_ref": (
        "logic",
        "A return's bill number is free text, not checked against the bill when saved.",
    ),
    "return_item_not_on_bill": (
        "logic",
        "A return's bill number is free text, not checked against the bill when saved.",
    ),
    "return_exceeds_bill": (
        "logic",
        "A return's bill number is free text, not checked against the bill when saved.",
    ),
    "return_before_bill": (
        "logic",
        "A return's bill number is free text, not checked against the bill when saved.",
    ),
    "return_item_never_billed": (
        "logic",
        "A return does not have to name a bill, and is not checked against what the vendor billed.",
    ),
    "return_rate_differs": (
        "logic",
        "A return's price is typed by hand, not taken from the bill it names.",
    ),
    "inspection_open_on_completed_lot": (
        "logic",
        "Marking a lot Completed does not look at its inspection.",
    ),
    "lot_unlike_its_neighbours": (
        "logic",
        "A lot's components are saved as entered: nothing compares them with the recipe.",
    ),
    "lot_extra_charge_missing": (
        "calculation",
        "An extra charge the contractor has no amount for adds Rs 0, with no warning.",
    ),
    "dispatch_no_logistics_rate": (
        "calculation",
        "A logistics contractor with no rate earns Rs 0 on a dispatch, and saving it gives no "
        "warning.",
    ),
    "vendor_mixed_gst": (
        "logic",
        "GST is typed on each bill line: nothing ties it to the vendor or the item.",
    ),
    "wastage_lot_in_vendor": (
        "logic",
        "A wastage note has no field for the lot it came from, so the lot number gets typed "
        "into Vendor and nothing ties the two together.",
    ),
}

# The ledgers the report proves entries landed in, the module whose findings
# belong to each, and where an entry in it must land.
_LEDGERS = (
    ("bills", "Bill Ledger", "its item, its PO line and its vendor"),
    ("stock", "Item Ledger", "the item and size it names"),
    ("pool", "Warehouse Pool", "the bucket its item, tag and colour name"),
    (
        "production",
        "Production lots",
        "its pool bucket, the items it used, its contractor",
    ),
    ("issues", "Issue Stock", "its item and the party it went to"),
    ("wastage", "Wastage Ledger", "Items Stock or the pool bucket it names"),
    ("returns", "Returns Ledger", "its item, its vendor and its bill"),
    ("pos", "PO Ledger", "the PO line each bill was entered against"),
    ("references", "Party ledgers", "the vendor, client or contractor it names"),
    (
        "dispatch",
        "Dispatch Ledger",
        "the Warehouse Pool, its client and its PI / Estimate",
    ),
    ("contractors", "Contractor Ledger", "the contractor it names"),
)

_LEDGER_NOUN = {
    "pool": "buckets",
    "bills": "bills",
    "pos": "POs",
    "returns": "returns",
    "wastage": "notes",
    "issues": "issues",
    "dispatch": "dispatches",
}

# Findings that mean an entry is not where it belongs: on the wrong record,
# on none, or there twice.
_LANDING_CHECKS = frozenset(
    {
        "bill_names_missing_po",
        "bill_on_wrong_po",
        "bill_po_line_unmatched",
        "bill_po_vendor_mismatch",
        "bill_after_po_cancelled",
        "bill_ledger_only_uncounted",
        "contractor_ledger_paths_disagree",
        "dispatch_not_in_pool",
        "dispatch_order_mismatch",
        "dispatch_over_order",
        "entry_points_at_other_record",
        "issue_not_in_vendor_ledger",
        "issued_and_used_by_lot",
        "item_reference_missing",
        "ledger_reader_mismatch",
        "logistics_cost_without_contractor",
        "lot_component_source",
        "lot_credit_misplaced",
        "lot_not_credited",
        "lot_pool_debit_mismatch",
        "lot_used_other_size",
        "master_name_variants",
        "negative_colour_attribution",
        "order_pushed_lot_missing",
        "orphaned_return_bill_ref",
        "over_billed_po_line",
        "party_not_in_master",
        "plan_line_dispatch_missing",
        "possible_duplicate_bill",
        "possible_duplicate_entry",
        "possible_duplicate_lot",
        "receipt_beyond_lot",
        "return_exceeds_bill",
        "return_item_never_billed",
        "return_item_not_on_bill",
        "stock_paths_disagree",
        "stock_row_missing",
        "stock_statement_mismatch",
        "wastage_not_in_pool",
        "wastage_wrong_source",
    }
)


def compute_findings(
    cur, today: date | None = None, stats: dict | None = None
) -> tuple[list, list]:
    """Every check that reads through `cur`. Returns (findings, errors):
    a check that raises is reported, never allowed to sink the run. `stats`,
    when given, receives what the run checked (the report's totals)."""
    today = today or date.today()
    ctx = _Context(cur)
    ctx.today = today
    findings, errors = [], []
    for _areas, check, dated in _CHECKS:
        try:
            findings.extend(check(ctx, today) if dated else check(ctx))
        except Exception as exc:  # noqa: BLE001
            logger.exception("[audit] %s failed", check.__name__)
            errors.append({"check": check.__name__, "error": str(exc)})
            # A failed statement aborts the transaction; start a clean one so
            # the remaining checks can still read.
            cur.connection.rollback()
            cur.execute(_SNAPSHOT_SQL)
    if stats is not None:
        stats.update(ctx.stats)
    return findings, errors


def compute_external_findings(stats: dict | None = None) -> tuple[list, list]:
    """The checks that open their own connections, each kept from sinking
    the others the same way."""
    stats = stats if stats is not None else {}
    findings, errors = [], []
    for _areas, check, adds_stats in _EXTERNAL_CHECKS:
        try:
            findings.extend(check(stats) if adds_stats else check())
        except Exception as exc:  # noqa: BLE001
            logger.exception("[audit] %s failed", check.__name__)
            errors.append({"check": check.__name__, "error": str(exc)})
    return findings, errors


# ── Priority ───────────────────────────────────────────────────────────────


def _separate_fingerprints(findings: list) -> None:
    """A fingerprint must name one finding: ticking, dismissing or copying
    one acts on that one alone. Two can share check, item and first ref (one
    contractor's lots of two processes, two receipts on a lot), so those are
    told apart by what they say. The rest keep the fingerprint they had, and
    with it their review."""
    shared = Counter(f["fingerprint"] for f in findings)
    for f in findings:
        if shared[f["fingerprint"]] > 1:
            text = f"{f['fingerprint']}|{f['title']}|{f['detail']}"
            f["fingerprint"] = hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def _drop_superseded(findings: list) -> None:
    """An over-billed PO line that bill_on_wrong_po explains is one problem,
    not two: only the finding that says where the bills belong is kept."""
    explained = {
        (f["refs"][0], f["item"], f["size"])
        for f in findings
        if f["check"] == "bill_on_wrong_po" and f["refs"]
    }
    findings[:] = [
        f
        for f in findings
        if not (
            f["check"] == "over_billed_po_line"
            and f["refs"]
            and (f["refs"][0], f["item"], f["size"]) in explained
        )
    ]


def prioritise(findings: list, today: date | None = None) -> list:
    """Score and band every finding, highest first. Reproducible: the same
    findings always rank the same way, with or without Claude.

    integrity > entry > info; then size (units affected); then recency
    (still fixable); then spread (the same lot or bill behind other findings).
    """
    today = today or date.today()
    _drop_superseded(findings)
    _separate_fingerprints(findings)
    for f in findings:
        missing = _MISSING.get(f["check"])
        f["missing"] = {"type": missing[0], "text": missing[1]} if missing else None
    ref_count: dict = defaultdict(int)
    for f in findings:
        for r in set(f["refs"]):
            ref_count[r] += 1
    for f in findings:
        score = _KIND_BASE[f["kind"]]
        score += min(abs(f["qty"]), 500.0) / 5.0
        if f["when"]:
            age = (today - date.fromisoformat(f["when"])).days
            score += 60 if age <= 7 else 30 if age <= 30 else 0
        score += min(sum(ref_count[r] - 1 for r in set(f["refs"])) * 10, 40)
        f["score"] = round(score, 1)
        if f["kind"] == "integrity":
            f["priority"] = "P1"
        elif f["kind"] == "info":
            f["priority"] = "P3"
        else:
            f["priority"] = "P1" if score >= 220 else "P2" if score >= 150 else "P3"
        cap = _BAND_CAP.get(f["check"])
        if cap and f["priority"] < cap:
            f["priority"] = cap
    findings.sort(key=lambda f: (f["priority"], -f["score"], f["check"], f["title"]))
    return findings


def summarise(findings: list, errors: list, stats: dict | None = None) -> dict:
    stats = stats or {}
    by_band = defaultdict(int)
    by_kind = defaultdict(int)
    by_area = defaultdict(int)
    for f in findings:
        by_band[f["priority"]] += 1
        by_kind[f["kind"]] += 1
        by_area[f["area"]] += 1
    return {
        "total": len(findings),
        "integrityOk": by_kind["integrity"] == 0 and not errors,
        "byBand": dict(by_band),
        "byKind": dict(by_kind),
        "byArea": dict(by_area),
        "checkErrors": errors,
        "coverage": _coverage(findings, errors),
        # What was verified: each kind of stock entry, every item's stock
        # rebuilt from them, and the lots a recipe could be judged against.
        "stockEntries": stats.get("entries") or [],
        "stockStatement": stats.get("statement"),
        "recipeCheck": stats.get("recipe"),
        "ledgers": _ledger_table(findings, stats),
        "missing": _missing_list(findings),
    }


def _ledger_table(findings: list, stats: dict) -> list:
    """Each ledger: how much of it was traced, where its entries must land,
    and how many did not, or carry a wrong figure."""
    misplaced: dict = defaultdict(int)
    wrong: dict = defaultdict(int)
    for f in findings:
        if f["check"] in _LANDING_CHECKS:
            misplaced[f["area"]] += 1
        elif f["kind"] == "integrity":
            wrong[f["area"]] += 1
    counted = stats.get("counted") or {}
    statement = stats.get("statement") or {}
    consumed = next(
        (e for e in stats.get("entries") or [] if e["area"] == "production"), None
    )
    out = []
    for area, label, lands in _LEDGERS:
        seen = counted.get(area)
        if area == "stock":
            checked = f"{statement.get('items', 0):,} items rebuilt from their entries"
            if stats.get("itemLedgers"):
                checked += f", {stats['itemLedgers']:,} ledgers read"
        elif area == "production" and seen:
            used = f", {consumed['lines']:,} components used" if consumed else ""
            checked = f"{seen['documents']:,} lots{used}"
        elif isinstance(seen, dict):
            checked = (
                f"{seen['lines']:,} lines on {seen['documents']:,} {_LEDGER_NOUN[area]}"
            )
        elif seen is not None:
            checked = f"{seen:,} {_LEDGER_NOUN.get(area, 'entries')}"
        else:
            checked = ""
        out.append(
            {
                "area": area,
                "label": label,
                "lands": lands,
                "checked": checked,
                "misplaced": misplaced[area],
                "wrongFigures": wrong[area],
            }
        )
    return out


def _missing_list(findings: list) -> list:
    """What is missing behind the findings, one line each, the most findings
    first: the calculations, then the logic."""
    grouped: dict = {}
    for f in findings:
        missing = f.get("missing")
        if not missing:
            continue
        g = grouped.setdefault(
            missing["text"],
            {
                "type": missing["type"],
                "text": missing["text"],
                "findings": 0,
                "checks": set(),
            },
        )
        g["findings"] += 1
        g["checks"].add(f["check"])
    rows = sorted(
        grouped.values(),
        key=lambda g: (g["type"] != "calculation", -g["findings"], g["text"]),
    )
    for g in rows:
        g["checks"] = sorted(g["checks"])
    return rows


def _coverage(findings: list, errors: list) -> list:
    """Each module the audit looked at: how many checks covered it, what
    they found, and how many could not run -- so a module with nothing to
    report reads as checked, not as forgotten."""
    checks: dict = defaultdict(int)
    areas_of: dict = {}
    for areas, check, _flag in _CHECKS + _EXTERNAL_CHECKS:
        areas_of[check.__name__] = areas
        for a in areas:
            checks[a] += 1
    failed: dict = defaultdict(int)
    for e in errors:
        for a in areas_of.get(e.get("check"), ()):
            failed[a] += 1
    found: dict = defaultdict(lambda: defaultdict(int))
    for f in findings:
        found[f["area"]][f["kind"]] += 1
    return [
        {
            "area": area,
            "label": label,
            "checks": checks[area],
            "failed": failed[area],
            "findings": sum(found[area].values()),
            "integrity": found[area]["integrity"],
            "entry": found[area]["entry"],
            "info": found[area]["info"],
        }
        for area, label in _AREAS
    ]


# ── Runs ───────────────────────────────────────────────────────────────────


def _execute_run(run_id: int) -> None:
    """Compute, prioritise and store one run. Always ends DONE or FAILED."""
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute(_SNAPSHOT_SQL)
            stats: dict = {}
            findings, errors = compute_findings(cur, stats=stats)
            conn.rollback()  # nothing was written; end the read-only transaction
        external, external_errors = compute_external_findings(stats)
        findings.extend(external)
        errors.extend(external_errors)
        findings = prioritise(findings)
        summary = summarise(findings, errors, stats)
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "UPDATE erp.audit_runs SET status = 'DONE', finished_at = NOW(), "
                "findings = %s, summary = %s WHERE id = %s",
                (json.dumps(findings, default=str), json.dumps(summary), run_id),
            )
    except Exception as exc:  # noqa: BLE001
        logger.exception("[audit] run %s failed", run_id)
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "UPDATE erp.audit_runs SET status = 'FAILED', finished_at = NOW(), "
                "error = %s WHERE id = %s",
                (str(exc)[:2000], run_id),
            )


def _run_worker(app, run_id: int) -> None:
    ctx = app.app_context() if app is not None else None
    if ctx is not None:
        ctx.push()
    try:
        _execute_run(run_id)
    finally:
        if ctx is not None:
            ctx.pop()


def _expire_stale_runs(cur) -> None:
    cur.execute(
        "UPDATE erp.audit_runs SET status = 'FAILED', finished_at = NOW(), "
        "error = 'Interrupted (the server restarted while it was running).' "
        "WHERE status = 'RUNNING' AND started_at < NOW() - %s",
        (STALE_RUN_AFTER,),
    )


def start_run(trigger: str = "button", user_id=None, app=None) -> dict:
    """Start a run in the background, or return the one already running."""
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute("SELECT pg_try_advisory_xact_lock(%s) AS ok", (_AUDIT_LOCK_KEY,))
        locked = cur.fetchone()["ok"]
        _expire_stale_runs(cur)
        cur.execute(
            "SELECT id FROM erp.audit_runs WHERE status = 'RUNNING' ORDER BY id DESC LIMIT 1"
        )
        running = cur.fetchone()
        if running or not locked:
            return {"runId": running["id"] if running else None, "alreadyRunning": True}
        cur.execute(
            "INSERT INTO erp.audit_runs (trigger, created_by) VALUES (%s, %s) RETURNING id",
            (trigger, user_id),
        )
        run_id = cur.fetchone()["id"]
    _spawn(_run_worker, app, run_id)
    return {"runId": run_id, "alreadyRunning": False}


def _spawn(target, *args) -> None:
    """Run `target` on a background thread. A separate function so tests can
    run an audit inline instead of patching the threading module."""
    threading.Thread(target=target, args=args, daemon=True, name="audit-run").start()


def _load_reviews(cur) -> dict:
    cur.execute(
        "SELECT fingerprint, status, value_sig, note FROM erp.audit_finding_reviews"
    )
    return {r["fingerprint"]: r for r in cur.fetchall()}


def _with_reviews(findings: list, reviews: dict) -> list:
    for f in findings:
        r = reviews.get(f["fingerprint"])
        # A decision holds only for the numbers it was made on.
        if r and r["value_sig"] == f["valueSig"]:
            f["review"] = r["status"]
            f["reviewNote"] = r["note"]
        else:
            f["review"] = "open"
            f["reviewNote"] = ""
    return findings


def _run_row(cur, run_id=None):
    if run_id:
        cur.execute("SELECT * FROM erp.audit_runs WHERE id = %s", (int(run_id),))
    else:
        cur.execute(
            "SELECT * FROM erp.audit_runs WHERE status = 'DONE' ORDER BY id DESC LIMIT 1"
        )
    return cur.fetchone()


def _run_meta(row) -> dict:
    return {
        "runId": row["id"],
        "status": row["status"],
        "trigger": row["trigger"],
        "startedAt": row["started_at"].isoformat() if row["started_at"] else None,
        "finishedAt": row["finished_at"].isoformat() if row["finished_at"] else None,
        "error": row["error"],
    }


def build_brief(run: dict, findings: list) -> str:
    """Markdown for Claude Code: everything needed to find each finding
    again in a backup taken after this run."""
    started = run.get("startedAt") or ""
    lines = [
        f"# ERP audit findings — run #{run['runId']} ({started[:16].replace('T', ' ')})",
        "",
        f"State: the first backup taken after {started[:16].replace('T', ' ')} contains the data "
        "these findings were computed from (erp.audit_runs id "
        f"{run['runId']} holds the full run).",
        "",
    ]
    for f in findings:
        lines += [
            f"## [{f['priority']}] {f['title']}",
            "",
            f"- Check: `{f['check']}` ({f['kind']}, {f['area']}), fingerprint `{f['fingerprint']}`",
        ]
        if f["item"]:
            lines.append(
                f"- Item: {f['item']}"
                + (f" · size {f['size']}" if f["size"] else "")
                + (f" · tag {f['tag']}" if f["tag"] else "")
                + (f" · colour {f['colour']}" if f["colour"] else "")
            )
        if f["refs"]:
            lines.append("- Refs: " + ", ".join(f["refs"]))
        if f["when"]:
            lines.append(f"- When: {f['when']}")
        lines.append(f"- Qty: {_fmt(f['qty'])}")
        if f.get("missing"):
            lines.append(f"- Missing {f['missing']['type']}: {f['missing']['text']}")
        lines += ["", f["detail"], ""]
        if f.get("evidence"):
            lines += [
                "```json",
                json.dumps(f["evidence"], indent=2, default=str),
                "```",
                "",
            ]
    return "\n".join(lines)


# ── RPCs ───────────────────────────────────────────────────────────────────

_ADMIN = frozenset({"admin"})
_REVIEW_STATUSES = frozenset({"open", "reviewed", "dismissed", "sent_to_claude"})


@rpc_method("runAudit", mutation=True, roles=_ADMIN)
def rpc_run_audit():
    try:
        app = current_app._get_current_object()
    except RuntimeError:
        app = None
    res = start_run("button", get_current_user_id(), app)
    msg = (
        "An audit is already running. Watching that one."
        if res["alreadyRunning"]
        else "Audit started."
    )
    return build_response(True, res, msg)


@rpc_method("getAuditStatus", roles=_ADMIN)
def rpc_get_audit_status(run_id):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        _expire_stale_runs(cur)
        row = _run_row(cur, run_id)
    if row is None:
        return build_response(False, None, "Audit run not found.")
    meta = _run_meta(row)
    meta["summary"] = row["summary"]
    return build_response(True, meta)


@rpc_method("getAuditReport", roles=_ADMIN)
def rpc_get_audit_report(run_id=None):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        row = _run_row(cur, run_id)
        if row is None:
            return build_response(True, None, "No audit has been run yet.")
        findings = _with_reviews(list(row["findings"] or []), _load_reviews(cur))
    data = _run_meta(row)
    data["summary"] = row["summary"]
    data["findings"] = findings
    return build_response(True, data)


@rpc_method("setAuditFindingStatus", mutation=True, roles=_ADMIN)
def rpc_set_audit_finding_status(items, status, note=""):
    status = str(status or "").strip()
    if status not in _REVIEW_STATUSES:
        raise ValueError(f'Invalid review status "{status}".')
    items = [i for i in (items or []) if isinstance(i, dict) and i.get("fingerprint")]
    if not items:
        raise ValueError("No findings selected.")
    user_id = get_current_user_id()
    with database.get_conn() as (_conn, cur):
        for i in items:
            cur.execute(
                """
                INSERT INTO erp.audit_finding_reviews
                    (fingerprint, status, value_sig, note, updated_by, updated_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (fingerprint) DO UPDATE
                   SET status = EXCLUDED.status, value_sig = EXCLUDED.value_sig,
                       note = EXCLUDED.note, updated_by = EXCLUDED.updated_by,
                       updated_at = NOW()
                """,
                (
                    str(i["fingerprint"])[:40],
                    status,
                    str(i.get("valueSig") or "")[:64],
                    str(note or ""),
                    user_id,
                ),
            )
    return build_response(
        True, {"updated": len(items)}, f"{len(items)} finding(s) marked {status}."
    )


@rpc_method("getAuditBrief", roles=_ADMIN)
def rpc_get_audit_brief(run_id, fingerprints):
    wanted = [str(f) for f in (fingerprints or [])]
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        row = _run_row(cur, run_id)
    if row is None:
        return build_response(False, None, "Audit run not found.")
    by_fp = {f["fingerprint"]: f for f in row["findings"] or []}
    chosen = [by_fp[fp] for fp in wanted if fp in by_fp]
    if not chosen:
        return build_response(
            False, None, "None of the selected findings are in this run."
        )
    return build_response(True, {"markdown": build_brief(_run_meta(row), chosen)})
