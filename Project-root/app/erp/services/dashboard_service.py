"""Dashboard, ported from Apps_Script/module_dashboard.js -- closes out
the port's "real feature" surface (only Audit, a backend-only cron job
with no UI, is left after this).

Read-only aggregator. It owns no table of its own -- no migration except
033_dashboard_date_indexes.sql, which indexes four OTHER modules' date
columns purely so the queries below can seek instead of scan.

Two kinds of number live here, and the split is deliberate:

  1. Aggregates that are a plain date-bounded rollup -- Bills/Returns/
     Wastage "this month vs last month", and the 30-day dispatch trend --
     are SQL, in the _*_TWO_MONTH_SQL / _DISPATCH_TREND_SQL constants,
     all sharing the one connection getDashboardData opens.

  2. Numbers whose derivation is genuinely intricate -- current stock
     (initial + billed - consumed, per item+size), ready-to-dispatch
     (completed final-stage lots less what already shipped), contractor
     balances, production lot status and the WIP pipeline, and the Open PO
     summary -- reuse the already-ported getter that owns that logic
     rather than re-deriving it in SQL here. Re-implementing them would
     mean two copies of some of the subtlest business rules in the system,
     silently drifting apart.

Group (1) used to be group (2): every KPI was derived by calling a
module's full getter and reducing the result in Python, so a dashboard
load pulled the ENTIRE bill, return, wastage and dispatch history into
memory -- O(all history), on an endpoint that auto-refreshes every 5
minutes per open browser tab -- to produce a handful of scalars. Those
four getter calls are gone. The remaining four are bounded by item count
and open-lot count rather than by history, and each is still called as a
full standalone RPC-style function with its own connection, matching the
established pattern elsewhere in this port (e.g.
production_service.get_process_wip_data calling
process_service.get_process_components_data the same way).

The SQL in group (1) must reproduce its source getter's DOCUMENT grouping
exactly -- a "bill" is a vendor+bill-number pair, not a header row -- so
each constant carries a comment naming the getter it mirrors. Deviating
there changes a KPI silently.

_month_window deliberately does NOT replicate a real, unintentional bug in
source's own last-month calculation (`last.setMonth(last.getMonth() - 1)`
incorrectly rolls into the wrong month on the 29th-31st of a month whose
predecessor is shorter -- e.g. March 31 minus one month lands around
March 2-3 in JS, not February). This is clearly accidental, not a design
choice worth preserving bug-for-bug.

There is deliberately NO caching layer in front of any of this. The app
runs 4 gunicorn workers (Procfile), so a process-local cache would let
consecutive refreshes land on different workers and show the user numbers
that jump backwards -- a worse failure than the latency it would save now
that the history scans are gone.

getMobileDashboard is NOT part of the group (1) rewrite: it still loads
full production/dispatch/stock history for three counters and five
activity rows, and is the obvious next target. Left alone here so this
change's blast radius stays on the desktop dashboard it was made for.

getMobileDashboard's userEmail reuses a small
current_user.get_current_user_email() helper (mirrors the existing
get_current_user_id() in the same module) rather than a DB round-trip --
Flask-Login's current_user already carries .email.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import psycopg2.extras

import database
from . import bill_service
from . import contractors_service
from . import dispatch_service
from . import po_service
from . import process_service
from . import production_service
from . import stock_service
from .current_user import get_current_user_email
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

_ACTIVE_PRODUCTION_STATUSES = ("Pending", "In Progress")

_T = config_maps.TABLE_NAMES

# One row per Bill document, exactly as bill_service._load_bill_list groups
# them: keyed on lower/trimmed vendor + bill number (NOT header id -- two
# headers sharing a vendor+number are one bill to that getter), dated from
# the lowest-id header in the group (its "first row ORDER BY h.id, l.id"),
# and valued as the sum of per-line ROUND(qty * price * (1 + gst%), 2).
#
# btrim() trims spaces where the Python str.strip() it replaces trimmed all
# whitespace. Vendor names and bill numbers reach the DB through web form
# input, so a leading tab or newline is not a case that occurs; if one ever
# did, it would group as its own document rather than corrupt a total.
#
# Rounding note: the Python it replaces rounds each line in float and uses
# banker's rounding; Postgres rounds numeric half-away-from-zero. The two
# can differ by one paisa on a line whose exact total lands on a half-paisa
# boundary -- accepted deliberately, since the alternative is shipping the
# whole bill ledger to Python on every dashboard load to save a rounding
# case worth <= Rs 0.01 on a headline KPI.
_BILLS_TWO_MONTH_SQL = f"""
    SELECT (array_agg(h.bill_date ORDER BY h.id))[1] AS doc_date,
           SUM(ROUND(l.qty * l.price * (1 + l.gst_rate_pct / 100.0), 2)) AS amount
    FROM {_T["BILL_HEADERS"]} h
    JOIN {_T["BILL_LINES"]} l ON l.header_id = h.id
    WHERE h.deleted_at IS NULL
      AND h.bill_date >= %s AND h.bill_date < %s
    GROUP BY btrim(lower(h.vendor)) || '|' || btrim(lower(h.bill_number))
"""

# One row per Return document -- return_service._load_return_list keys on a
# bare return_number (no lower/trim), so this GROUP BY must not add either.
_RETURNS_TWO_MONTH_SQL = f"""
    SELECT (array_agg(h.return_date ORDER BY h.id))[1] AS doc_date,
           SUM(ROUND(l.qty * l.price, 2)) AS amount
    FROM {_T["RETURN_HEADERS"]} h
    JOIN {_T["RETURN_LINES"]} l ON l.header_id = h.id
    WHERE h.deleted_at IS NULL
      AND h.return_date >= %s AND h.return_date < %s
    GROUP BY h.return_number
"""

# One row per Wastage document. "amount" here is a QUANTITY, not money --
# the Wastage KPI trends units wasted, and wastage_service sums raw qty per
# document with no per-line rounding, so neither does this.
_WASTAGE_TWO_MONTH_SQL = f"""
    SELECT (array_agg(h.wastage_date ORDER BY h.id))[1] AS doc_date,
           SUM(l.qty) AS amount
    FROM {_T["WASTAGE_HEADERS"]} h
    JOIN {_T["WASTAGE_LINES"]} l ON l.header_id = h.id
    WHERE h.deleted_at IS NULL
      AND h.wastage_date >= %s AND h.wastage_date < %s
    GROUP BY h.wastage_id
"""

# Dispatched qty per day. getDispatchData is a FLAT per-line record set, so
# summing l.qty per header date is the same total the Python bucketing
# produced -- with no header/line grouping step to replicate.
_DISPATCH_TREND_SQL = f"""
    SELECT h.dispatch_date AS d, SUM(l.qty) AS qty
    FROM {_T["DISPATCH_HEADERS"]} h
    JOIN {_T["DISPATCH_LINES"]} l ON l.header_id = h.id
    WHERE h.deleted_at IS NULL
      AND h.dispatch_date >= %s AND h.dispatch_date <= %s
    GROUP BY h.dispatch_date
"""

_DISPATCH_TREND_DAYS = 30


def _round2(n: float) -> float:
    return round(n, 2)


def _get_open_po_summary(cur) -> dict:
    billed_map = bill_service._aggregate_billed_base_qty_by_po(cur)
    pos = po_service._load_po_list(cur, billed_map)

    open_count = 0
    open_value = 0.0
    for po in pos:
        has_open_line = False
        for item in po["items"]:
            key = bill_service._build_po_line_key(po["poNumber"], item["name"], item["size"], item["narration"])
            billed_base_qty = billed_map.get(key, 0)
            remaining_base_qty = item["baseQty"] - billed_base_qty
            if remaining_base_qty > 0.0001:
                has_open_line = True
                open_value += remaining_base_qty * item["baseRate"]
        if has_open_line:
            open_count += 1

    return {"count": open_count, "value": _round2(open_value)}


def _month_window() -> tuple:
    """(last_month_start, this_month_start, next_month_start).

    Every two-month KPI queries the half-open range
    [last_month_start, next_month_start), then splits the rows it gets back
    on this_month_start. Deliberately does NOT replicate a real, unintentional
    bug in the Apps Script source's own last-month calculation
    (`last.setMonth(last.getMonth() - 1)` rolls into the wrong month on the
    29th-31st of a month whose predecessor is shorter): stepping back one day
    from the 1st lands on the previous calendar month unconditionally.
    """
    this_start = date.today().replace(day=1)
    last_start = (this_start - timedelta(days=1)).replace(day=1)
    next_start = (this_start + timedelta(days=32)).replace(day=1)
    return last_start, this_start, next_start


def _summarize_two_months(cur, sql: str) -> dict:
    """Run a two-month rollup query and split its rows into this/last month.

    `sql` takes (window_start, window_end) and returns one row per ledger
    DOCUMENT with columns `doc_date` and `amount` -- see the three
    _*_TWO_MONTH_SQL constants, each of which reproduces its own ledger
    getter's document grouping. Splitting the two months in Python rather
    than with a second GROUP BY keeps those queries readable and costs
    nothing: the result is already narrowed to two months of documents.

    This replaces a version that pulled every bill/return/wastage record
    ever written through that module's full getter and bucketed the lot in
    Python -- an O(all history) scan per dashboard load, for two months of
    numbers.
    """
    last_start, this_start, next_start = _month_window()
    cur.execute(sql, (last_start, next_start))

    this_count = last_count = 0
    this_value = last_value = 0.0
    for row in cur.fetchall():
        amount = float(row["amount"] or 0)
        if row["doc_date"] >= this_start:
            this_count += 1
            this_value += amount
        else:
            last_count += 1
            last_value += amount

    return {
        "thisMonth": {"count": this_count, "value": _round2(this_value)},
        "lastMonth": {"count": last_count, "value": _round2(last_value)},
    }


def _get_pipeline_data(production_lots: list) -> list:
    processes = process_service.get_process_data(True)["data"]

    groups_by_process: dict = {}

    for lot in production_lots or []:
        if lot.get("status") not in _ACTIVE_PRODUCTION_STATUSES:
            continue
        process_key = str(lot.get("processId") or "").strip().lower()
        if not process_key:
            continue

        bucket = groups_by_process.setdefault(process_key, {})
        model_name = str(lot.get("productName") or "").strip()
        breakdown = lot.get("colorBreakdown") or []

        # Title parts, in narrowing order: what is being made, in which
        # colour, in which size.
        #
        # `color` was previously dropped, and that is why almost every stage
        # in the WIP pipeline rendered a single group labelled "Unspecified".
        # Two facts combine to produce it: productName is written ONLY for a
        # final-stage process (production_service._save, `... if
        # is_final_stage else ""`), so every intermediate stage -- fitting,
        # painting, packing -- stores an empty one; and `size` is optional on
        # a colour breakdown entry while `color` is mandatory (save_production
        # rejects a breakdown whose entries have no colour, and silently drops
        # any entry that does). So for an intermediate colour-tracked lot both
        # of the parts this used to read were empty and the one part that was
        # always populated went unused -- collapsing a real per-colour split
        # into one "Unspecified" bucket that merely restated the stage total.
        #
        # "Unspecified" still appears, correctly, for a lot with no breakdown
        # at all on a non-final stage: nothing about that lot is tagged.
        def add_to_group(color, size, qty, bucket=bucket, model_name=model_name):
            parts = [model_name, str(color or "").strip(), str(size or "").strip()]
            title = " ".join(x for x in parts if x) or "Unspecified"
            entry = bucket.setdefault(title, {"qty": 0.0, "lotCount": 0})
            entry["qty"] += qty
            entry["lotCount"] += 1

        if breakdown:
            for cb in breakdown:
                add_to_group(cb.get("color"), cb.get("size"), float(cb.get("qty") or 0))
        else:
            add_to_group("", "", float(lot.get("qty") or 0))

    result = []
    for p in processes:
        bucket = groups_by_process.get(p["processId"].strip().lower(), {})
        groups = sorted(
            (
                {"title": title, "qty": _round2(entry["qty"]), "lotCount": entry["lotCount"]}
                for title, entry in bucket.items()
            ),
            key=lambda g: g["qty"],
            reverse=True,
        )
        total_lot_count = sum(g["lotCount"] for g in groups)
        if total_lot_count == 0:
            continue
        result.append(
            {
                "processId": p["processId"],
                "processName": p["processName"],
                "sequence": p["sequence"],
                "totalQty": _round2(sum(g["qty"] for g in groups)),
                "totalLotCount": total_lot_count,
                "groups": groups,
            }
        )

    result.sort(key=lambda p: p["sequence"])
    return result


def _get_production_status_breakdown(production_lots: list) -> list:
    counts: dict = {}
    for lot in production_lots:
        status = lot.get("status") or "Pending"
        counts[status] = counts.get(status, 0) + 1
    return [{"status": status, "count": count} for status, count in counts.items()]


def _get_dispatch_trend(cur) -> list:
    """Dispatched qty for each of the last 30 days, oldest first.

    Asks Postgres for just that window instead of summing the entire
    dispatch history in Python; days with no dispatch still get an explicit
    0 row, so the client always renders a fixed-width 30-point series.
    """
    today = date.today()
    start = today - timedelta(days=_DISPATCH_TREND_DAYS - 1)

    cur.execute(_DISPATCH_TREND_SQL, (start, today))
    qty_by_date = {row["d"]: float(row["qty"] or 0) for row in cur.fetchall()}

    trend = []
    for i in range(_DISPATCH_TREND_DAYS):
        day = start + timedelta(days=i)
        trend.append({"date": day.isoformat(), "qty": _round2(qty_by_date.get(day, 0))})
    return trend


@rpc_method("getDashboardData")
def get_dashboard_data():
    # Four getters that used to be called here -- getBillData, getReturnData,
    # getWastageData and getDispatchData -- are gone: each returned its
    # module's ENTIRE history so this function could derive a two-month
    # rollup or a 30-day trend from it. Those four are now date-bounded SQL
    # aggregates sharing the single connection opened below. The four that
    # remain derive genuinely intricate per-row state (current stock from
    # billed/consumed maps, ready-to-dispatch from completed final-stage
    # lots less dispatched, contractor balances, lot status/pipeline) and
    # are reused rather than re-implemented in SQL.
    stock_records = stock_service.get_stock_data()["data"]
    production_lots = production_service.get_production_data()["data"]
    ready_records = dispatch_service.get_ready_to_dispatch_data()["data"]
    contractor_ledger = contractors_service.get_contractor_ledger_data()["data"]

    low_stock_full = sorted(
        (
            {
                "name": item["name"],
                "size": item["size"],
                "currentStock": item["currentStock"],
                "threshold": item["threshold"],
                "deficit": _round2(item["threshold"] - item["currentStock"]),
            }
            for item in stock_records
            if item["isLowStock"]
        ),
        key=lambda i: i["deficit"],
        reverse=True,
    )
    low_stock_items = low_stock_full[:10]
    low_stock_total_deficit = _round2(sum(max(i["deficit"], 0) for i in low_stock_full))

    active_production_lots = [lot for lot in production_lots if lot["status"] in _ACTIVE_PRODUCTION_STATUSES]
    pending_production_count = len(active_production_lots)
    oldest_active_lot_date_raw = None
    for lot in active_production_lots:
        if not lot.get("dateRaw"):
            continue
        if oldest_active_lot_date_raw is None or lot["dateRaw"] < oldest_active_lot_date_raw:
            oldest_active_lot_date_raw = lot["dateRaw"]
    oldest_pending_production_days = None
    if oldest_active_lot_date_raw:
        oldest_date = date_utils.to_safe_date(oldest_active_lot_date_raw)
        if oldest_date:
            oldest_pending_production_days = max(0, (date.today() - oldest_date).days)

    ready_to_dispatch_units = sum(max(r["readyQty"], 0) for r in ready_records)
    ready_to_dispatch_full = sorted(
        (
            {"productId": r["productId"], "productName": r["productName"], "readyQty": _round2(r["readyQty"])}
            for r in ready_records
            if r["readyQty"] > 0.0001
        ),
        key=lambda r: r["readyQty"],
        reverse=True,
    )
    ready_to_dispatch_items = ready_to_dispatch_full[:10]

    contractor_payables_full = sorted(
        (
            {"contractorName": c["contractorName"], "balanceDue": _round2(c["balanceDue"])}
            for c in contractor_ledger
            if c["balanceDue"] > 0.0001
        ),
        key=lambda c: c["balanceDue"],
        reverse=True,
    )
    contractor_payables_due = contractor_payables_full[:10]

    # One connection for every aggregate that can be expressed as SQL.
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        open_po_summary = _get_open_po_summary(cur)
        bills_months = _summarize_two_months(cur, _BILLS_TWO_MONTH_SQL)
        returns_months = _summarize_two_months(cur, _RETURNS_TWO_MONTH_SQL)
        wastage_months = _summarize_two_months(cur, _WASTAGE_TWO_MONTH_SQL)
        dispatch_trend = _get_dispatch_trend(cur)

    total_contractor_payable_due = sum(max(c["balanceDue"], 0) for c in contractor_ledger)

    return build_response(
        True,
        {
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "kpis": {
                "openPoCount": open_po_summary["count"],
                "openPoValue": open_po_summary["value"],
                "billsThisMonthCount": bills_months["thisMonth"]["count"],
                "billsThisMonthValue": bills_months["thisMonth"]["value"],
                "billsLastMonthCount": bills_months["lastMonth"]["count"],
                "billsLastMonthValue": bills_months["lastMonth"]["value"],
                "returnsThisMonthCount": returns_months["thisMonth"]["count"],
                "returnsThisMonthValue": returns_months["thisMonth"]["value"],
                "returnsLastMonthCount": returns_months["lastMonth"]["count"],
                "returnsLastMonthValue": returns_months["lastMonth"]["value"],
                "wastageThisMonthCount": wastage_months["thisMonth"]["count"],
                "wastageThisMonthQty": wastage_months["thisMonth"]["value"],
                "wastageLastMonthCount": wastage_months["lastMonth"]["count"],
                "wastageLastMonthQty": wastage_months["lastMonth"]["value"],
                "lowStockCount": len(low_stock_full),
                "lowStockTotalDeficit": low_stock_total_deficit,
                "pendingProductionCount": pending_production_count,
                "oldestPendingProductionDays": oldest_pending_production_days,
                "readyToDispatchUnits": _round2(ready_to_dispatch_units),
                "readyToDispatchProductCount": len(ready_to_dispatch_full),
                "contractorPayablesDue": _round2(total_contractor_payable_due),
                "contractorPayablesCount": len(contractor_payables_full),
            },
            "pipeline": _get_pipeline_data(production_lots),
            "productionStatusBreakdown": _get_production_status_breakdown(production_lots),
            "dispatchTrend": dispatch_trend,
            "lowStockItems": low_stock_items,
            "lowStockTotalCount": len(low_stock_full),
            "contractorPayables": contractor_payables_due,
            "contractorPayablesTotalCount": len(contractor_payables_full),
            "readyToDispatchItems": ready_to_dispatch_items,
            "readyToDispatchTotalCount": len(ready_to_dispatch_full),
        },
    )


@rpc_method("getMobileDashboard")
def get_mobile_dashboard():
    production_lots = production_service.get_production_data()["data"]
    dispatch_records = dispatch_service.get_dispatch_data()["data"]
    stock_records = stock_service.get_stock_data()["data"]

    today_key = date.today().isoformat()

    pending_production_count = sum(1 for lot in production_lots if lot["status"] in _ACTIVE_PRODUCTION_STATUSES)
    todays_dispatch_count = sum(1 for d in dispatch_records if d.get("dateRaw") and d["dateRaw"][:10] == today_key)
    low_stock_count = sum(1 for s in stock_records if s["isLowStock"])

    activity = []
    for lot in production_lots:
        if not lot.get("dateRaw"):
            continue
        activity.append(
            {
                "type": "production",
                "title": lot.get("lotNumber") or lot.get("processId"),
                "subtitle": f'{lot["qty"]} unit(s) · {lot["status"]}',
                "dateRaw": lot["dateRaw"],
            }
        )
    for d in dispatch_records:
        if not d.get("dateRaw"):
            continue
        activity.append(
            {
                "type": "dispatch",
                "title": d["dispatchNumber"],
                "subtitle": f'{d.get("clientName") or "Direct supply"} · {d["qty"]} unit(s)',
                "dateRaw": d["dateRaw"],
            }
        )
    activity.sort(key=lambda a: a["dateRaw"], reverse=True)

    return build_response(
        True,
        {
            "pendingProductionCount": pending_production_count,
            "todaysDispatchCount": todays_dispatch_count,
            "lowStockCount": low_stock_count,
            "recentActivity": activity[:5],
            "appVersion": config_maps.APP_VERSION,
            "userEmail": get_current_user_email(),
        },
    )
