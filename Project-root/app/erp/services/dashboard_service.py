"""Dashboard, ported from Apps_Script/module_dashboard.js -- closes out
the port's "real feature" surface (only Audit, a backend-only cron job
with no UI, is left after this).

Pure read-only aggregator: every number is derived by calling
already-ported getters (Stock/Production/Dispatch/Warehouse Pool/
Contractors/Return/Wastage/Bill/PO/Process), never touching a table
directly except for the Open PO summary, which reuses
po_service._load_po_list/bill_service._aggregate_billed_base_qty_by_po/
_build_po_line_key directly against a fresh cursor -- mirrors source's
own reuse of module_bill.js's aggregation instead of re-deriving PO
status logic. This module owns no table of its own -- no migration.

getDashboardData/getMobileDashboard both call each constituent getter as
a full standalone, already-ported RPC-style function (its own DB
connection) rather than threading one shared cursor through every
sub-computation -- matches the established pattern elsewhere in this
port (e.g. production_service.get_process_wip_data calling
process_service.get_process_components_data the same way), and is the
natural fit for a module that only ever reads.

_summarize_by_two_months deliberately does NOT replicate a real,
unintentional bug in source's own last-month calculation
(`last.setMonth(last.getMonth() - 1)` incorrectly rolls into the wrong
month on the 29th-31st of a month whose predecessor is shorter -- e.g.
March 31 minus one month lands around March 2-3 in JS, not February).
This is clearly accidental, not a deliberate design choice worth
preserving bug-for-bug -- Python's `now.replace(day=1) - timedelta(days=1)`
gives the correct previous calendar month unconditionally, at no extra
cost.

getMobileDashboard's userEmail reuses a new small
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
from . import return_service
from . import stock_service
from . import wastage_service
from .current_user import get_current_user_email
from .. import config_maps
from .. import date_utils
from ..envelope import build_response
from ..registry import rpc_method

_ACTIVE_PRODUCTION_STATUSES = ("Pending", "In Progress")


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


def _summarize_by_two_months(records: list, date_field: str, amount_field: str = None) -> dict:
    now = date.today()
    this_month_key = f"{now.year}-{now.month:02d}"
    last_month_date = now.replace(day=1) - timedelta(days=1)
    last_month_key = f"{last_month_date.year}-{last_month_date.month:02d}"

    this_count = this_value = last_count = last_value = 0
    for rec in records or []:
        raw = rec.get(date_field)
        if not raw:
            continue
        raw_str = str(raw)
        if raw_str.startswith(this_month_key):
            this_count += 1
            if amount_field:
                this_value += rec.get(amount_field) or 0
        elif raw_str.startswith(last_month_key):
            last_count += 1
            if amount_field:
                last_value += rec.get(amount_field) or 0

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

        def add_to_group(size, qty, bucket=bucket, model_name=model_name):
            title = " ".join(x for x in [model_name, str(size or "").strip()] if x) or "Unspecified"
            entry = bucket.setdefault(title, {"qty": 0.0, "lotCount": 0})
            entry["qty"] += qty
            entry["lotCount"] += 1

        if breakdown:
            for cb in breakdown:
                add_to_group(cb.get("size"), float(cb.get("qty") or 0))
        else:
            add_to_group("", float(lot.get("qty") or 0))

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


def _get_dispatch_trend(dispatch_records: list) -> list:
    days = 30
    qty_by_date: dict = {}
    for d in dispatch_records:
        if not d.get("dateRaw"):
            continue
        date_key = d["dateRaw"][:10]
        qty_by_date[date_key] = qty_by_date.get(date_key, 0) + d["qty"]

    trend = []
    today = date.today()
    for i in range(days - 1, -1, -1):
        d = today - timedelta(days=i)
        date_key = d.isoformat()
        trend.append({"date": date_key, "qty": _round2(qty_by_date.get(date_key, 0))})
    return trend


@rpc_method("getDashboardData")
def get_dashboard_data():
    stock_records = stock_service.get_stock_data()["data"]
    production_lots = production_service.get_production_data()["data"]
    dispatch_records = dispatch_service.get_dispatch_data()["data"]
    ready_records = dispatch_service.get_ready_to_dispatch_data()["data"]
    contractor_ledger = contractors_service.get_contractor_ledger_data()["data"]
    return_records = return_service.get_return_data()["data"]
    wastage_records = wastage_service.get_wastage_data()["data"]
    bill_records = bill_service.get_bill_data()["data"]

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

    active_production_lots = [l for l in production_lots if l["status"] in _ACTIVE_PRODUCTION_STATUSES]
    pending_production_count = len(active_production_lots)
    oldest_active_lot_date_raw = None
    for l in active_production_lots:
        if not l.get("dateRaw"):
            continue
        if oldest_active_lot_date_raw is None or l["dateRaw"] < oldest_active_lot_date_raw:
            oldest_active_lot_date_raw = l["dateRaw"]
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

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (_conn, cur):
        open_po_summary = _get_open_po_summary(cur)

    bills_months = _summarize_by_two_months(bill_records, "billDateRaw", "totalAmount")
    returns_months = _summarize_by_two_months(return_records, "returnDateRaw", "totalAmount")
    wastage_months = _summarize_by_two_months(wastage_records, "dateRaw", "totalQty")
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
            "dispatchTrend": _get_dispatch_trend(dispatch_records),
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

    pending_production_count = sum(1 for l in production_lots if l["status"] in _ACTIVE_PRODUCTION_STATUSES)
    todays_dispatch_count = sum(1 for d in dispatch_records if d.get("dateRaw") and d["dateRaw"][:10] == today_key)
    low_stock_count = sum(1 for s in stock_records if s["isLowStock"])

    activity = []
    for l in production_lots:
        if not l.get("dateRaw"):
            continue
        activity.append(
            {
                "type": "production",
                "title": l.get("lotNumber") or l.get("processId"),
                "subtitle": f'{l["qty"]} unit(s) · {l["status"]}',
                "dateRaw": l["dateRaw"],
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
