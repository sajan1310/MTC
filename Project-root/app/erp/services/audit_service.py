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

Read-only on business data: the checks run in a READ ONLY transaction, and
the only rows this module writes are its own -- erp.audit_runs and
erp.audit_finding_reviews (migration 052).
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from collections import defaultdict
from datetime import date, datetime, time, timedelta

import psycopg2.extras
from flask import current_app

import database
from . import (
    items_service,
    ledger_audit_service,
    process_service,
    stock_service,
    units_service,
    warehouse_service,
)
from .. import config_maps
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

# How long a run may stay RUNNING before it is treated as interrupted (a
# worker recycled mid-run never reaches its own finally).
STALE_RUN_AFTER = timedelta(minutes=15)

_EPS = 1e-6
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
}


# ── Findings ───────────────────────────────────────────────────────────────


def _finding(
    check: str,
    kind: str,
    area: str,
    title: str,
    detail: str,
    *,
    item: str = "",
    size: str = "",
    tag: str = "",
    colour: str = "",
    refs=(),
    qty: float = 0.0,
    when=None,
    evidence: dict | None = None,
) -> dict:
    refs = [str(r) for r in refs if r]
    when_iso = None
    if isinstance(when, datetime):
        when_iso = when.date().isoformat()
    elif isinstance(when, date):
        when_iso = when.isoformat()
    key = "|".join(
        [
            check,
            item.strip().lower(),
            size.strip().lower(),
            tag.strip().lower(),
            colour.strip().lower(),
            refs[0] if refs else "",
        ]
    )
    return {
        "fingerprint": hashlib.sha1(key.encode("utf-8")).hexdigest()[:16],
        # The numbers a review decision was made on: a dismissed finding
        # comes back as soon as these change.
        "valueSig": hashlib.sha1(detail.encode("utf-8")).hexdigest()[:16],
        "check": check,
        "kind": kind,
        "area": area,
        "title": title,
        "detail": detail,
        "item": item,
        "size": size,
        "tag": tag,
        "colour": colour,
        "refs": refs,
        "qty": round(float(qty or 0), 4),
        "when": when_iso,
        "evidence": evidence or {},
    }


def _fmt(q) -> str:
    q = float(q or 0)
    return f"{q:g}" if abs(q - round(q)) > _EPS else str(int(round(q)))


def _label(item: str, colour: str = "", tag: str = "") -> str:
    parts = [item]
    if tag:
        parts.append(f"tag {tag}")
    if colour:
        parts.append(colour)
    return " · ".join(p for p in parts if p)


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
                   completed_at, status, qty, color_breakdown, components_consumed
              FROM erp.production
             WHERE deleted_at IS NULL
            """
        )
        self.lots = cur.fetchall()
        self.lot_by_number = {
            str(r["lot_number"] or "").strip(): r for r in self.lots if r["lot_number"]
        }

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


def _check_stock_paths(ctx: _Context) -> list:
    """Current Stock is built from SQL aggregates (stock_service.
    _get_stock_terms). The Item Ledger replays the same movements row by row
    (_MOVEMENT_ROWS_SQL and _iter_completed_production_components). The two
    must agree for every item, or the Stock page and the Item Ledger show
    different numbers."""
    cur = ctx.cur
    terms = stock_service._get_stock_terms(cur)
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
    try:
        res = items_service.get_item_identity_drift_report()
    except Exception:  # noqa: BLE001 -- one check failing must not sink the run
        logger.exception("[audit] reference scan failed")
        return []
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
                "references",
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


def _check_units(ctx: _Context) -> list:
    """A unit missing from the Units master converts as 1 = 1 base unit,
    silently (units_service.lookup_unit). Listed with every conversion in
    use, so a wrong factor -- Pair as 1 Pcs, say -- is visible."""
    cur = ctx.cur
    units_map = units_service.get_units_map(cur)
    cur.execute(
        """
        SELECT lower(btrim(l.unit)) AS u, count(*) AS n, min(h.bill_number) AS example
          FROM erp.bill_lines l JOIN erp.bill_headers h ON h.id = l.header_id
         WHERE h.deleted_at IS NULL AND l.affects_stock AND btrim(coalesce(l.unit, '')) <> ''
         GROUP BY 1
        """
    )
    bill_units = {r["u"]: (r["n"], r["example"]) for r in cur.fetchall()}
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
    out = []
    for u in sorted(set(bill_units) | set(comp_units)):
        if u in units_map:
            continue
        bill_n, bill_example = bill_units.get(u, (0, ""))
        comp_n, comp_example = comp_units.get(u, (0, ""))
        n = bill_n + comp_n
        example = bill_example or comp_example
        out.append(
            _finding(
                "unit_not_in_master",
                "entry",
                "units",
                f'Unit "{u}" is not in the Units master',
                f"{n} line(s) use it (e.g. {example}); each was counted as 1 {u} = 1 base unit. "
                "Add it to the Units master with its real factor.",
                refs=[str(example)],
                qty=n,
            )
        )
    return out


def _external_ledger_findings() -> list:
    """The hourly ledger reconciliation (ledger_audit_service), folded in.
    Opens its own connections, so it runs outside the audit's transaction."""
    try:
        res = ledger_audit_service.compute_internal_ledger_audit_findings()
    except Exception:  # noqa: BLE001
        logger.exception("[audit] ledger reconciliation failed")
        return []
    out = []
    for f in res.get("findings") or []:
        t = f.get("type", "")
        refs = [
            f"PO {f['poNumber']}" if f.get("poNumber") else "",
            f"Return {f['returnNumber']}" if f.get("returnNumber") else "",
            f"Bill {f['billNumber']}" if f.get("billNumber") else "",
        ]
        out.append(
            _finding(
                t,
                "entry",
                "purchases",
                ledger_audit_service.describe_audit_finding(f).split(" -- ")[0],
                ledger_audit_service.describe_audit_finding(f),
                item=f.get("itemName", ""),
                size=f.get("size", ""),
                refs=refs,
                qty=abs(float(f.get("overBy") or 0)),
            )
        )
    return out


_CORE_CHECKS = (
    _check_pool_cache,
    _check_pool_ledger,
    _check_stock_paths,
    _check_lot_processes,
    _check_negative_buckets,
    _check_counts_before_completion,
    _check_pool_hand_edits,
    _check_status_toggles,
    _check_labor_bills,
    _check_duplicate_lots,
    _check_units,
)
_DATED_CHECKS = (_check_used_before_made, _check_count_variances)


def compute_findings(cur, today: date | None = None) -> tuple[list, list]:
    """Every check that reads through `cur`. Returns (findings, errors):
    a check that raises is reported, never allowed to sink the run."""
    today = today or date.today()
    ctx = _Context(cur)
    findings, errors = [], []
    for check in _CORE_CHECKS + _DATED_CHECKS:
        try:
            if check in _DATED_CHECKS:
                findings.extend(check(ctx, today))
            else:
                findings.extend(check(ctx))
        except Exception as exc:  # noqa: BLE001
            logger.exception("[audit] %s failed", check.__name__)
            errors.append({"check": check.__name__, "error": str(exc)})
            # A failed statement aborts the transaction; start a clean one so
            # the remaining checks can still read.
            cur.connection.rollback()
            cur.execute("SET TRANSACTION READ ONLY")
    return findings, errors


# ── Priority ───────────────────────────────────────────────────────────────


def prioritise(findings: list, today: date | None = None) -> list:
    """Score and band every finding, highest first. Reproducible: the same
    findings always rank the same way, with or without Claude.

    integrity > entry > info; then size (units affected); then recency
    (still fixable); then spread (the same lot or bill behind other findings).
    """
    today = today or date.today()
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


def summarise(findings: list, errors: list) -> dict:
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
    }


# ── Runs ───────────────────────────────────────────────────────────────────


def _execute_run(run_id: int) -> None:
    """Compute, prioritise and store one run. Always ends DONE or FAILED."""
    try:
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            conn,
            cur,
        ):
            cur.execute("SET TRANSACTION READ ONLY")
            findings, errors = compute_findings(cur)
            conn.rollback()  # nothing was written; end the read-only transaction
        findings.extend(_external_reference_findings())
        findings.extend(_external_ledger_findings())
        findings = prioritise(findings)
        summary = summarise(findings, errors)
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
