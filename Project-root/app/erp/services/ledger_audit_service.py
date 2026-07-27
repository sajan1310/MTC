"""Internal ledger reconciliation audit, ported from Apps_Script/module_audit.js.

Cross-checks the PO, Bill, Return, Wastage, and Issued Stock ledgers
against each other so calculation mistakes (a mis-linked PO, a typo'd
quantity, a return that doesn't match anything ever billed) surface on
their own instead of silently compounding. Read-only, never blocks a
save, never auto-fixes anything -- a human reviews and corrects from the
relevant ledger.

This is deliberately NOT wired into the web app UI (matches source's own
comment) -- no @rpc_method here. It runs unattended on an hourly schedule
(see start_ledger_audit_scheduler(), called once from create_app()) and
writes findings to erp.ledger_audit_log (migration 019) -- this port's
stand-in for source's "Logs sheet" (via logAction()), which was never
carried over anywhere else in this port as a general-purpose facility
(every other mutation instead relies on its own table's updated_at/
updated_by columns) -- scoped to just this one job, not a reintroduction
of that whole concept.

Runs under gunicorn's --workers 4 (see Procfile), so every worker's own
scheduler thread wakes up on the same hourly cadence. run_internal_ledger_audit()
guards the actual work with a transaction-scoped Postgres advisory lock
(pg_try_advisory_xact_lock, auto-released at the enclosing transaction's
commit -- safe with a pooled connection, unlike a session-level lock,
which could stay held after the connection returns to the pool) so only
one worker's wake-up per hour actually runs it; the other three see the
lock held and skip that cycle for free.
"""

from __future__ import annotations

import logging
import os
import threading

import database
from . import bill_service
from . import issue_service
from . import po_service
from . import return_service
from . import wastage_service

logger = logging.getLogger(__name__)

# Arbitrary fixed key identifying this job in Postgres's advisory-lock
# keyspace -- any int64 works as long as it's not reused by another
# feature; this port has no other advisory-lock user yet.
_AUDIT_LOCK_KEY = 918_273_645

_RUN_INTERVAL_SECONDS = 3600  # matches source's ScriptApp .everyHours(1)


def _item_key(name, size) -> str:
    return f"{str(name or '').strip().lower()}|{str(size or '').strip().lower()}"


def compute_internal_ledger_audit_findings() -> dict:
    """Pure (no writes, no logging) reconciliation pass across all 5
    ledgers -- kept separate from run_internal_ledger_audit() so the check
    logic itself stays trivially testable with no DB writes involved.

    Checks performed (each independent):
    1. over_billed_po_line -- a PO line's total billed qty exceeds what was
       ordered. getPOData() surfaces this too (pendingQty goes negative,
       and save_bill appends an inline advisory on the very save that
       causes it), but neither is proactive -- this check catches an
       overage that's already sitting in the ledgers regardless of when
       or how it got there, reading the same item["receivedQty"] directly.
    2. orphaned_return_bill_ref -- a Return names a Bill Number that
       doesn't exist for that vendor (free-text, never validated at entry).
    3. return_item_not_on_bill -- a Return names a real Bill, but has an
       item (name+size) that bill never actually billed.
    4. over_consumed_item -- total Returned + Wasted + Issued base qty for
       an (item, size) exceeds total Billed base qty for that same
       item+size, across every vendor combined. Not vendor-scoped --
       Wastage/Issue both carry an optional vendor field that's usually
       blank, so keying this to vendor would silently miss most real cases.
    """
    bill_response = bill_service.get_bill_data()
    if not bill_response["success"]:
        raise RuntimeError(f"Failed to load Bill data: {bill_response['message']}")
    bills = bill_response["data"] or []

    po_response = po_service.get_po_data()
    if not po_response["success"]:
        raise RuntimeError(f"Failed to load PO data: {po_response['message']}")
    pos = po_response["data"] or []

    return_response = return_service.get_return_data()
    if not return_response["success"]:
        raise RuntimeError(f"Failed to load Return data: {return_response['message']}")
    returns = return_response["data"] or []

    wastage_response = wastage_service.get_wastage_data()
    if not wastage_response["success"]:
        raise RuntimeError(f"Failed to load Wastage data: {wastage_response['message']}")
    wastage_records = wastage_response["data"] or []

    issue_response = issue_service.get_issue_data()
    if not issue_response["success"]:
        raise RuntimeError(f"Failed to load Issued Stock data: {issue_response['message']}")
    issue_records = issue_response["data"] or []

    findings = []

    # -- Check 1: over-billed PO lines ---------------------------------
    for po in pos:
        for item in po["items"]:
            ordered_qty = float(item.get("qty") or 0)
            received_qty = float(item.get("receivedQty") or 0)
            over_by = received_qty - ordered_qty
            if over_by > 0.0001:
                findings.append(
                    {
                        "type": "over_billed_po_line",
                        "poNumber": po["poNumber"],
                        "vendor": po["vendor"],
                        "itemName": item["name"],
                        "size": item["size"],
                        "narration": item.get("narration", ""),
                        "unit": item.get("unit", ""),
                        "orderedQty": ordered_qty,
                        "billedQty": round(received_qty, 4),
                        "overBy": round(over_by, 4),
                    }
                )

    # -- Checks 2 & 3: Return -> Bill reference integrity --------------
    bill_by_key = {}
    for bill in bills:
        key = f"{str(bill['vendor'] or '').strip().lower()}|{str(bill['billNumber'] or '').strip().lower()}"
        bill_by_key[key] = bill

    for ret in returns:
        bill_number = str(ret.get("billNumber") or "").strip()
        if not bill_number:
            continue  # "Original Bill #" is optional -- nothing to check

        key = f"{str(ret['vendor'] or '').strip().lower()}|{bill_number.lower()}"
        bill = bill_by_key.get(key)

        if bill is None:
            findings.append(
                {
                    "type": "orphaned_return_bill_ref",
                    "returnNumber": ret["returnNumber"],
                    "vendor": ret["vendor"],
                    "billNumber": bill_number,
                }
            )
            continue  # nothing to compare items against

        bill_item_keys = {_item_key(i["name"], i["size"]) for i in bill["items"]}

        for item in ret["items"]:
            item_key = _item_key(item["name"], item["size"])
            if item_key not in bill_item_keys:
                findings.append(
                    {
                        "type": "return_item_not_on_bill",
                        "returnNumber": ret["returnNumber"],
                        "vendor": ret["vendor"],
                        "billNumber": bill_number,
                        "itemName": item["name"],
                        "size": item["size"],
                    }
                )

    # -- Check 4: over-consumed items (Return + Wastage + Issue vs Bill)
    billed_base_qty_by_item: dict = {}
    for bill in bills:
        for item in bill["items"]:
            key = _item_key(item["name"], item["size"])
            billed_base_qty_by_item[key] = billed_base_qty_by_item.get(key, 0) + float(item.get("baseQty") or 0)

    consumed_by_item: dict = {}

    def _add_consumption(records, field):
        for rec in records:
            for item in rec["items"]:
                key = _item_key(item["name"], item["size"])
                entry = consumed_by_item.get(key)
                if entry is None:
                    entry = {
                        "name": item["name"],
                        "size": item["size"],
                        "unit": item.get("unit", ""),
                        "returnedBaseQty": 0.0,
                        "wastedBaseQty": 0.0,
                        "issuedBaseQty": 0.0,
                    }
                    consumed_by_item[key] = entry
                entry[field] += float(item.get("baseQty") or 0)

    _add_consumption(returns, "returnedBaseQty")
    _add_consumption(wastage_records, "wastedBaseQty")
    _add_consumption(issue_records, "issuedBaseQty")

    for entry in consumed_by_item.values():
        total_consumed_base_qty = entry["returnedBaseQty"] + entry["wastedBaseQty"] + entry["issuedBaseQty"]
        billed_base_qty = billed_base_qty_by_item.get(_item_key(entry["name"], entry["size"]), 0)
        over_by = total_consumed_base_qty - billed_base_qty
        if over_by > 0.0001:
            findings.append(
                {
                    "type": "over_consumed_item",
                    "itemName": entry["name"],
                    "size": entry["size"],
                    "unit": entry["unit"],
                    "totalBilledBaseQty": round(billed_base_qty, 4),
                    "totalReturnedBaseQty": round(entry["returnedBaseQty"], 4),
                    "totalWastedBaseQty": round(entry["wastedBaseQty"], 4),
                    "totalIssuedBaseQty": round(entry["issuedBaseQty"], 4),
                    "totalConsumedBaseQty": round(total_consumed_base_qty, 4),
                    "overBy": round(over_by, 4),
                }
            )

    counts: dict = {}
    for f in findings:
        counts[f["type"]] = counts.get(f["type"], 0) + 1

    if not findings:
        message = "No discrepancies found -- PO, Bill, Return, Wastage, and Issued Stock ledgers reconcile cleanly."
    else:
        suffix = "y" if len(findings) == 1 else "ies"
        message = f"{len(findings)} discrepanc{suffix} found: " + ", ".join(
            f"{n} {t.replace('_', ' ')}" for t, n in counts.items()
        )

    return {"findings": findings, "message": message}


def describe_audit_finding(f: dict) -> str:
    """One-line, human-readable rendering of a finding for the Details column."""
    t = f["type"]
    if t == "over_billed_po_line":
        size = f" ({f['size']})" if f["size"] else ""
        return (
            f"PO #{f['poNumber']} ({f['vendor']}): {f['itemName']}{size} -- "
            f"ordered {f['orderedQty']}, billed {f['billedQty']} {f['unit'] or ''} ({f['overBy']} over)"
        )
    if t == "orphaned_return_bill_ref":
        return (
            f"Return #{f['returnNumber']} ({f['vendor']}) names Bill #{f['billNumber']}, "
            "which doesn't exist for this vendor"
        )
    if t == "return_item_not_on_bill":
        size = f" ({f['size']})" if f["size"] else ""
        return f"Return #{f['returnNumber']} ({f['vendor']}) -- {f['itemName']}{size} isn't on Bill #{f['billNumber']}"
    if t == "over_consumed_item":
        size = f" ({f['size']})" if f["size"] else ""
        return (
            f"{f['itemName']}{size} -- returned {f['totalReturnedBaseQty']} + wasted {f['totalWastedBaseQty']} "
            f"+ issued {f['totalIssuedBaseQty']} = {f['totalConsumedBaseQty']} consumed, but only "
            f"{f['totalBilledBaseQty']} ever billed ({f['overBy']} over)"
        )
    return str(f)


def _log(cur, action: str, record_id: str, details: str, status: str) -> None:
    cur.execute(
        "INSERT INTO erp.ledger_audit_log (action, record_id, details, status) VALUES (%s, %s, %s, %s)",
        (action, str(record_id)[:255], details, status),
    )


def run_internal_ledger_audit() -> dict:
    """Backend-only entry point -- bound to the scheduler (see
    start_ledger_audit_scheduler()). Not exposed as an RPC method and not
    called from the web app, matching source's own explicit scope.
    """
    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT pg_try_advisory_xact_lock(%s)", (_AUDIT_LOCK_KEY,))
        if not cur.fetchone()[0]:
            # Another worker/process already grabbed this hour's run.
            return {"success": True, "skipped": True}

        try:
            result = compute_internal_ledger_audit_findings()
        except Exception as exc:  # noqa: BLE001 -- logged below, never raised further
            logger.error("[ledger_audit] Audit run failed: %s", exc)
            _log(cur, "LEDGER_AUDIT_SUMMARY", "ALL", f"Audit run failed: {exc}", "ERROR")
            return {"success": False, "message": f"Failed to run internal ledger audit: {exc}"}

        for f in result["findings"]:
            record_id = f.get("poNumber") or f.get("returnNumber") or (
                f"{f['itemName']} ({f['size']})" if f.get("size") else f.get("itemName", "N/A")
            )
            _log(cur, "LEDGER_AUDIT_FINDING", record_id, f"{f['type']}: {describe_audit_finding(f)}", "WARNING")

        _log(cur, "LEDGER_AUDIT_SUMMARY", "ALL", result["message"], "SUCCESS")

    return {"success": True, "findingsCount": len(result["findings"]), "message": result["message"]}


def _run_audit_safely() -> None:
    try:
        run_internal_ledger_audit()
    except Exception:  # noqa: BLE001 -- must never kill the scheduler thread
        logger.exception("[ledger_audit] Unexpected error in scheduled run")


def _scheduler_loop(stop_event: threading.Event) -> None:
    # Sleeps first -- mirrors an hourly trigger's own cadence (fires on the
    # next hour boundary from install, not immediately), and avoids
    # hammering the DB on every app boot/reload/worker restart.
    while not stop_event.wait(_RUN_INTERVAL_SECONDS):
        _run_audit_safely()


def start_ledger_audit_scheduler(app) -> None:
    """Starts the hourly ledger-audit thread once, called from create_app().

    No-ops during tests (TESTING config) and in the outer Werkzeug reloader
    process (WERKZEUG_RUN_MAIN unset there means "I am the supervisor that
    will be replaced," not the one that actually serves requests) -- neither
    should be running an unattended hourly job.
    """
    if app.config.get("TESTING"):
        return
    if app.debug and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        return

    stop_event = threading.Event()
    thread = threading.Thread(
        target=_scheduler_loop, args=(stop_event,), daemon=True, name="ledger-audit-scheduler"
    )
    thread.start()
    app.logger.info("[ledger_audit] Hourly internal ledger audit scheduler started")
