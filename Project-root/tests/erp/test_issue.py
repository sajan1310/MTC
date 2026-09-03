"""Issued Stock Log RPC tests, ported behavior from Apps_Script/module_issue.js."""

from __future__ import annotations

import re
import time
import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _settle():
    """issueId is a second-precision timestamp (ISS-YYYYMMDD-HHMMSS) with no
    override field and, matching the source exactly, no uniqueness
    constraint -- see wastage_service's module docstring (issue_service
    shares the same rationale). Without this, two saves landing in the same
    wall-clock second (trivially possible between two adjacent tests, not
    just within one) silently merge under one getIssueData group, exactly
    as production would. Called before any test's first real save to
    decouple it from whatever the previous test did.
    """
    time.sleep(1.05)


def test_get_issue_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getIssueData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_issue_stock_rejects_zero_items(erp_client):
    resp = _rpc(
        erp_client,
        "saveIssueStock",
        [{"date": "01/01/2026", "issuedTo": "Contractor A", "items": []}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "zero items" in body["message"]


def test_save_issue_stock_requires_issued_to(erp_client):
    resp = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "01/01/2026",
                "issuedTo": "",
                "items": [{"name": "X", "qty": 1, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "Issued To" in body["message"]


def test_save_issue_stock_requires_date(erp_client):
    resp = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "not a date",
                "issuedTo": "Contractor A",
                "items": [{"name": "X", "qty": 1, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "date" in body["message"].lower()


def test_save_issue_stock_rejects_zero_qty(erp_client):
    resp = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "01/01/2026",
                "issuedTo": "Contractor A",
                "items": [{"name": "X", "qty": 0, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is False


def test_save_issue_stock_computes_base_qty_rate_and_value(erp_client):
    _settle()
    item = _unique_name("IssueItem")
    issued_to = _unique_name("Contractor")

    resp = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "15/03/2026",
                "issuedTo": issued_to,
                "reference": "LOT-42",
                "remarks": "For frame welding",
                "items": [
                    {"name": item, "size": "M", "qty": 5, "unit": "Pcs", "rate": 10}
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    issue_id = body["data"]["issueId"]
    assert re.match(r"^ISS-\d{8}-\d{6}$", issue_id)

    listed = _rpc(erp_client, "getIssueData").get_json()["data"]
    match = next(r for r in listed if r["issueId"] == issue_id)
    assert match["dateRaw"] == "2026-03-15"
    assert match["issuedTo"] == issued_to
    assert match["reference"] == "LOT-42"
    assert match["vendor"] == ""  # issuedTo doesn't match any known vendor
    assert match["totalQty"] == 5
    assert match["totalValue"] == 50
    assert match["items"][0]["baseQty"] == 5
    assert match["items"][0]["rate"] == 10
    assert match["items"][0]["value"] == 50


def test_save_issue_stock_matches_issued_to_against_vendor_master(erp_client):
    _settle()
    vendor = _unique_name("MatchedVendor")
    _rpc(erp_client, "saveVendor", [{"vendorName": vendor}], mutation=True)

    item = _unique_name("VendorMatchIssueItem")
    resp = _rpc(
        erp_client,
        "saveIssueStock",
        # Case-insensitive match, canonical stored name is snapshotted.
        [
            {
                "date": "01/01/2026",
                "issuedTo": vendor.upper(),
                "items": [{"name": item, "qty": 1, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    issue_id = resp.get_json()["data"]["issueId"]

    listed = _rpc(erp_client, "getIssueData").get_json()["data"]
    match = next(r for r in listed if r["issueId"] == issue_id)
    assert match["issuedTo"] == vendor.upper()
    assert match["vendor"] == vendor


def test_save_issue_stock_drops_blank_name_item_from_mixed_batch(erp_client):
    _settle()
    valid_item = _unique_name("ValidIssueItem")
    resp = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "01/01/2026",
                "issuedTo": "Contractor A",
                "items": [
                    {"name": valid_item, "qty": 2, "unit": "Pcs"},
                    {"name": "", "qty": 1, "unit": "Pcs"},
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    issue_id = body["data"]["issueId"]

    listed = _rpc(erp_client, "getIssueData").get_json()["data"]
    match = next(r for r in listed if r["issueId"] == issue_id)
    assert len(match["items"]) == 1
    assert match["items"][0]["name"] == valid_item


def test_delete_issue_bulk(erp_client):
    _settle()
    a_item = _unique_name("BulkIssueA")
    b_item = _unique_name("BulkIssueB")

    save_a = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "01/01/2026",
                "issuedTo": "Contractor A",
                "items": [{"name": a_item, "qty": 1, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    a_id = save_a.get_json()["data"]["issueId"]

    # Second internal save -- needs its own settle to differ from a_id too.
    _settle()

    save_b = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "01/01/2026",
                "issuedTo": "Contractor A",
                "items": [{"name": b_item, "qty": 1, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    b_id = save_b.get_json()["data"]["issueId"]
    assert a_id != b_id

    resp = _rpc(erp_client, "deleteIssueBulk", [[a_id, b_id]], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getIssueData").get_json()["data"]
    ids = [r["issueId"] for r in listed]
    assert a_id not in ids
    assert b_id not in ids


def test_save_issue_stock_edits_existing_record_in_place(erp_client):
    """Editing is a PWA-only addition -- module_issue.js has no edit path.
    issueId must not change on edit; header fields and item lines do.
    """
    _settle()
    original_item = _unique_name("EditIssueOriginal")
    updated_item = _unique_name("EditIssueUpdated")

    created = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "01/01/2026",
                "issuedTo": "Contractor A",
                "reference": "Lot #1",
                "items": [{"name": original_item, "qty": 2, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    body = created.get_json()
    assert body["success"] is True
    issue_id = body["data"]["issueId"]

    edited = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "existingIssueId": issue_id,
                "date": "02/01/2026",
                "issuedTo": "Contractor B",
                "reference": "Lot #2",
                "remarks": "Corrected",
                "items": [{"name": updated_item, "qty": 5, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    edited_body = edited.get_json()
    assert edited_body["success"] is True
    assert edited_body["data"]["issueId"] == issue_id
    assert "updated" in edited_body["message"].lower()

    listed = _rpc(erp_client, "getIssueData").get_json()["data"]
    matches = [r for r in listed if r["issueId"] == issue_id]
    assert len(matches) == 1
    match = matches[0]
    assert match["issuedTo"] == "Contractor B"
    assert match["reference"] == "Lot #2"
    assert match["remarks"] == "Corrected"
    assert len(match["items"]) == 1
    assert match["items"][0]["name"] == updated_item
    assert match["items"][0]["qty"] == 5


def test_save_issue_stock_edit_rejects_unknown_issue_id(erp_client):
    resp = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "existingIssueId": "ISS-00000000-000000",
                "date": "01/01/2026",
                "issuedTo": "Contractor A",
                "items": [{"name": "X", "qty": 1, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "not found" in body["message"].lower()


def test_item_rename_cascades_into_issue_lines(erp_client):
    _settle()
    old_item = _unique_name("OldIssueItem")
    new_item = _unique_name("NewIssueItem")
    _rpc(
        erp_client, "saveItem", [{"itemName": old_item, "itemSize": "S"}], mutation=True
    )

    save = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "01/01/2026",
                "issuedTo": "Contractor A",
                "items": [{"name": old_item, "size": "S", "qty": 1, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )
    issue_id = save.get_json()["data"]["issueId"]

    rename = _rpc(
        erp_client,
        "saveItem",
        [
            {
                "itemName": new_item,
                "itemSize": "S",
                "originalName": old_item,
                "originalSize": "S",
            }
        ],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getIssueData").get_json()["data"]
    match = next(r for r in listed if r["issueId"] == issue_id)
    assert match["items"][0]["name"] == new_item


def test_unit_rename_cascades_into_issue_lines(erp_client):
    _settle()
    old_unit = _unique_name("OldIssueUnit")
    new_unit = _unique_name("NewIssueUnit")
    _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": old_unit, "family": "Count", "factorToBase": 1}],
        mutation=True,
    )

    item = _unique_name("UnitCascadeIssueItem")
    save = _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "01/01/2026",
                "issuedTo": "Contractor A",
                "items": [{"name": item, "qty": 1, "unit": old_unit}],
            }
        ],
        mutation=True,
    )
    issue_id = save.get_json()["data"]["issueId"]

    rename = _rpc(
        erp_client,
        "saveUnit",
        [
            {
                "unitName": new_unit,
                "family": "Count",
                "factorToBase": 1,
                "originalUnitName": old_unit,
            }
        ],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getIssueData").get_json()["data"]
    match = next(r for r in listed if r["issueId"] == issue_id)
    assert match["items"][0]["unit"] == new_unit


def test_issue_subtracts_from_current_stock(erp_client):
    _settle()
    name = _unique_name("IssueStockItem")
    resp = _rpc(
        erp_client,
        "saveItem",
        [{"itemName": name, "itemInitialStock": 10}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    _rpc(
        erp_client,
        "saveIssueStock",
        [
            {
                "date": "01/01/2026",
                "issuedTo": "Contractor A",
                "items": [{"name": name, "qty": 4, "unit": "Pcs"}],
            }
        ],
        mutation=True,
    )

    listed = _rpc(erp_client, "getStockData").get_json()["data"]
    match = next(r for r in listed if r["name"] == name)
    assert match["currentStock"] == 6  # 10 initial - 4 issued
