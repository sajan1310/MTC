"""Internal ledger audit tests, ported behavior from Apps_Script/module_audit.js.

Not RPC-exposed (matches source's "deliberately NOT wired into the web app
UI" scope) -- compute_internal_ledger_audit_findings()/
run_internal_ledger_audit() are called directly here, inside erp_app's app
context, the same way test_production.py calls bom_service.set_bom_password
directly for its own backend-only setup.

erp_client's underlying database persists across the whole test session (no
per-test truncation -- see conftest.py), so other tests may have created
genuine discrepancies of their own before/after these run. Every assertion
below searches findings by this test's own unique names rather than
asserting on the total count, so it's correct regardless of what else is in
the shared test database.
"""

from __future__ import annotations

import uuid

import database
from app.erp.services import ledger_audit_service


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_over_billed_po_line_detected(erp_app, erp_client):
    vendor = _unique_name("AuditVendor")
    item = _unique_name("AuditItem")

    po = _rpc(
        erp_client,
        "savePO",
        [{"vendor": vendor, "items": [{"name": item, "qty": 5, "unit": "Pcs", "price": 10}]}],
        mutation=True,
    )
    po_number = po.get_json()["data"]["poNumber"]

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("BILL"),
                "billDate": "01/01/2026",
                "items": [{"name": item, "qty": 8, "unit": "Pcs", "price": 10, "po": po_number}],
            }
        ],
        mutation=True,
    )

    with erp_app.app_context():
        result = ledger_audit_service.compute_internal_ledger_audit_findings()

    match = next(f for f in result["findings"] if f["type"] == "over_billed_po_line" and f["poNumber"] == po_number)
    assert match["vendor"] == vendor
    assert match["itemName"] == item
    assert match["orderedQty"] == 5
    assert match["billedQty"] == 8
    assert match["overBy"] == 3
    assert "ordered 5" in ledger_audit_service.describe_audit_finding(match)


def test_return_bill_reference_checks(erp_app, erp_client):
    vendor = _unique_name("ReturnAuditVendor")
    bill_number = _unique_name("BILL")
    billed_item = _unique_name("BilledItem")
    unbilled_item = _unique_name("UnbilledItem")

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": bill_number,
                "billDate": "01/01/2026",
                "items": [{"name": billed_item, "qty": 5, "unit": "Pcs", "price": 10}],
            }
        ],
        mutation=True,
    )

    orphan_return_number = _unique_name("ORPHANRET")
    _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnNumber": orphan_return_number,
                "returnDate": "01/01/2026",
                "billNumber": "NO-SUCH-BILL",
                "items": [{"name": billed_item, "qty": 1, "price": 10}],
            }
        ],
        mutation=True,
    )

    mismatched_return_number = _unique_name("MISMATCHRET")
    _rpc(
        erp_client,
        "saveReturn",
        [
            {
                "vendor": vendor,
                "returnNumber": mismatched_return_number,
                "returnDate": "01/01/2026",
                "billNumber": bill_number,
                "items": [{"name": unbilled_item, "qty": 1, "price": 10}],
            }
        ],
        mutation=True,
    )

    with erp_app.app_context():
        result = ledger_audit_service.compute_internal_ledger_audit_findings()

    orphan = next(
        f for f in result["findings"] if f["type"] == "orphaned_return_bill_ref" and f["returnNumber"] == orphan_return_number
    )
    assert orphan["billNumber"] == "NO-SUCH-BILL"
    assert orphan["vendor"] == vendor

    mismatch = next(
        f for f in result["findings"] if f["type"] == "return_item_not_on_bill" and f["returnNumber"] == mismatched_return_number
    )
    assert mismatch["itemName"] == unbilled_item
    assert mismatch["billNumber"] == bill_number

    # The bill's own actually-billed item must NOT be flagged as a mismatch
    # for either return referencing it.
    assert not any(
        f["type"] == "return_item_not_on_bill" and f["itemName"] == billed_item for f in result["findings"]
    )


def test_over_consumed_item_detected(erp_app, erp_client):
    vendor = _unique_name("ConsumedAuditVendor")
    item = _unique_name("ConsumedItem")

    _rpc(
        erp_client,
        "saveBill",
        [
            {
                "vendor": vendor,
                "billNumber": _unique_name("BILL"),
                "billDate": "01/01/2026",
                "items": [{"name": item, "qty": 5, "unit": "Pcs", "price": 10}],
            }
        ],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveReturn",
        [{"vendor": vendor, "returnDate": "01/01/2026", "items": [{"name": item, "qty": 2, "price": 10, "reason": "Excess"}]}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveWastage",
        [{"date": "01/01/2026", "vendor": vendor, "items": [{"name": item, "qty": 2, "unit": "Pcs", "reason": "Damaged"}]}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveIssueStock",
        [{"date": "01/01/2026", "issuedTo": "Contractor A", "items": [{"name": item, "qty": 2, "unit": "Pcs"}]}],
        mutation=True,
    )

    with erp_app.app_context():
        result = ledger_audit_service.compute_internal_ledger_audit_findings()

    match = next(f for f in result["findings"] if f["type"] == "over_consumed_item" and f["itemName"] == item)
    assert match["totalBilledBaseQty"] == 5
    assert match["totalReturnedBaseQty"] == 2
    assert match["totalWastedBaseQty"] == 2
    assert match["totalIssuedBaseQty"] == 2
    assert match["totalConsumedBaseQty"] == 6
    assert match["overBy"] == 1


def test_run_internal_ledger_audit_writes_summary_row(erp_app):
    with erp_app.app_context():
        result = ledger_audit_service.run_internal_ledger_audit()
    assert result["success"] is True
    assert "findingsCount" in result

    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT status, details FROM erp.ledger_audit_log WHERE action = 'LEDGER_AUDIT_SUMMARY' ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
    assert row is not None
    assert row[0] == "SUCCESS"


def test_run_internal_ledger_audit_skips_when_lock_already_held(erp_app):
    """Simulates a second gunicorn worker's scheduler thread waking up in
    the same hour a different worker is already mid-run: pg_try_advisory_xact_lock
    on a separate, still-open connection/transaction holding the same key
    must make this call skip instead of racing it.
    """
    with database.get_conn() as (_conn, holder_cur):
        holder_cur.execute("SELECT pg_try_advisory_xact_lock(%s)", (ledger_audit_service._AUDIT_LOCK_KEY,))
        assert holder_cur.fetchone()[0] is True  # this connection now holds it

        with erp_app.app_context():
            result = ledger_audit_service.run_internal_ledger_audit()
        assert result == {"success": True, "skipped": True}
    # holder_cur's transaction commits on context exit here, releasing the lock.

    # A subsequent call, with the lock free again, proceeds normally.
    with erp_app.app_context():
        result = ledger_audit_service.run_internal_ledger_audit()
    assert result.get("skipped") is not True
