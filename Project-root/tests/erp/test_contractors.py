"""Contractors / Contractor Rates / Contractor Service Charges / Contractor
Payments RPC tests, ported behavior from Apps_Script/module_contractors.js
plus the two-layer Contractor Rates redesign (Layer 1: contractor + process
type + size; Layer 2: contractor + service type, an optional per-unit
extra charge added to the Layer 1 rate before multiplying by qty).

Also proves two "validating moment" cascades: a Process Type Master rename
reaching contractor_rates.process_type (tags_service._rename_process_type_everywhere)
and a Contractor rename reaching bom_additional_costs.contractor_name
(this round's own cascade reaching Phase 3c's pre-registered
BOM_ADDITIONAL_COSTS target).
"""

from __future__ import annotations

import uuid

from app.erp.services import bom_service


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _save_process(client, **overrides):
    payload = {
        "processName": _unique_name("Process"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique_name("Output"),
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    payload.update(overrides)
    resp = _rpc(client, "saveProcess", [payload], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return payload, body["data"]["processId"]


def _get_bom_token(erp_app, erp_client) -> str:
    with erp_app.app_context():
        bom_service.set_bom_password("test-only-bom-password")
    resp = _rpc(erp_client, "verifyBOMAccess", ["test-only-bom-password"])
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body["data"]["token"]


def test_get_contractors_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getContractorsData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_contractor_creates_and_lists_it(erp_client):
    name = _unique_name("Acme Contracting")
    resp = _rpc(
        erp_client,
        "saveContractor",
        [{"contractorName": name, "contact": "9876543210", "address": "1 Main St", "gstPan": "ABCDE1234F", "remarks": "test"}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["name"] == name

    listed = _rpc(erp_client, "getContractorsData").get_json()["data"]
    match = next(c for c in listed if c["contractorName"] == name)
    assert match["contact"] == "9876543210"
    assert match["gstPan"] == "ABCDE1234F"


def test_save_contractor_rejects_case_insensitive_duplicate(erp_client):
    name = _unique_name("Bolt Labor")
    first = _rpc(erp_client, "saveContractor", [{"contractorName": name}], mutation=True)
    assert first.get_json()["success"] is True

    dupe = _rpc(erp_client, "saveContractor", [{"contractorName": name.upper()}], mutation=True)
    body = dupe.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_save_contractor_rename_via_original_name(erp_client):
    original = _unique_name("Original Contractor")
    renamed = _unique_name("Renamed Contractor")

    _rpc(erp_client, "saveContractor", [{"contractorName": original}], mutation=True)

    edit = _rpc(
        erp_client,
        "saveContractor",
        [{"contractorName": renamed, "originalContractorName": original}],
        mutation=True,
    )
    body = edit.get_json()
    assert body["success"] is True
    assert body["data"]["name"] == renamed

    listed = _rpc(erp_client, "getContractorsData").get_json()["data"]
    names = [c["contractorName"] for c in listed]
    assert renamed in names
    assert original not in names


def test_delete_contractor_success_and_not_found(erp_client):
    name = _unique_name("Deletable Contractor")
    _rpc(erp_client, "saveContractor", [{"contractorName": name}], mutation=True)

    deleted = _rpc(erp_client, "deleteContractor", [name], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorsData").get_json()["data"]
    assert name not in [c["contractorName"] for c in listed]

    missing = _rpc(erp_client, "deleteContractor", [name], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_contractor_blocked_by_recorded_payment(erp_client):
    name = _unique_name("PaidContractor")
    _rpc(erp_client, "saveContractor", [{"contractorName": name}], mutation=True)
    _rpc(
        erp_client,
        "recordContractorPayment",
        [{"contractorName": name, "amount": 500, "date": "01/01/2026"}],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteContractor", [name], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "recorded payments" in body["message"]


def test_delete_contractors_bulk(erp_client):
    a = _unique_name("BulkContractorA")
    b = _unique_name("BulkContractorB")
    _rpc(erp_client, "saveContractor", [{"contractorName": a}], mutation=True)
    _rpc(erp_client, "saveContractor", [{"contractorName": b}], mutation=True)

    resp = _rpc(erp_client, "deleteContractorsBulk", [[a, b]], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorsData").get_json()["data"]
    names = [c["contractorName"] for c in listed]
    assert a not in names
    assert b not in names


def test_save_contractor_rate_upserts_by_triple(erp_client):
    contractor = _unique_name("RateContractor")
    process_type = _unique_name("RateType")

    first = _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processType": process_type, "size": "14 inch", "ratePerUnit": 10}],
        mutation=True,
    )
    assert first.get_json()["success"] is True

    second = _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processType": process_type, "size": "14 inch", "ratePerUnit": 25}],
        mutation=True,
    )
    assert second.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorRatesData", [contractor]).get_json()["data"]
    matches = [
        r for r in listed
        if r["contractorName"] == contractor and r["processType"] == process_type and r["size"] == "14 inch"
    ]
    assert len(matches) == 1
    assert matches[0]["ratePerUnit"] == 25


def test_save_contractor_rate_auto_creates_contractor(erp_client):
    contractor = _unique_name("FreshRateContractor")
    process_type = _unique_name("FreshRateType")

    resp = _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processType": process_type, "size": "16 inch", "ratePerUnit": 5}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorsData").get_json()["data"]
    match = next(c for c in listed if c["contractorName"] == contractor)
    assert match["remarks"] == "Auto-created from rate card entry"


def test_save_contractor_rate_requires_type_and_size(erp_client):
    resp = _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": _unique_name("IncompleteRateContractor"), "ratePerUnit": 5}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "required" in body["message"].lower()


def test_delete_contractor_rate_not_found_and_success(erp_client):
    missing = _rpc(erp_client, "deleteContractorRate", ["NoSuchContractor", "NoSuchType", "General"], mutation=True)
    assert missing.get_json()["success"] is False

    contractor = _unique_name("RateDeleteContractor")
    process_type = _unique_name("RateDeleteType")
    _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processType": process_type, "size": "General", "ratePerUnit": 8}],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteContractorRate", [contractor, process_type, "General"], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorRatesData", [contractor]).get_json()["data"]
    assert listed == []


def test_delete_contractor_rates_bulk_removes_selected_only(erp_client):
    contractor = _unique_name("BulkRateContractor")
    type_a = _unique_name("BulkRateTypeA")
    type_b = _unique_name("BulkRateTypeB")
    type_keep = _unique_name("BulkRateTypeKeep")
    for t in (type_a, type_b, type_keep):
        _rpc(
            erp_client, "saveContractorRate",
            [{"contractorName": contractor, "processType": t, "size": "General", "ratePerUnit": 5}], mutation=True,
        )

    resp = _rpc(
        erp_client, "deleteContractorRatesBulk",
        [[
            {"contractorName": contractor, "processType": type_a, "size": "General"},
            {"contractorName": contractor, "processType": type_b, "size": "General"},
        ]],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert "2" in body["message"]

    remaining = [r["processType"] for r in _rpc(erp_client, "getContractorRatesData", [contractor]).get_json()["data"]]
    assert type_a not in remaining
    assert type_b not in remaining
    assert type_keep in remaining


def test_delete_contractor_rates_bulk_no_selection_is_a_success_noop(erp_client):
    resp = _rpc(erp_client, "deleteContractorRatesBulk", [[]], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "No rates selected" in body["message"]


def test_get_contractor_rate_for_process_type_returns_zero_for_no_match(erp_client):
    resp = _rpc(erp_client, "getContractorRateForProcessType", ["NoSuchContractor", "NoSuchType", "General"])
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["ratePerUnit"] == 0


# ─────────────────────────────────────────────────────────────────────────
# Contractor Extra Charges (Layer 2)
# ─────────────────────────────────────────────────────────────────────────


def test_save_contractor_service_charge_upserts_by_pair(erp_client):
    contractor = _unique_name("ChargeContractor")
    service_type = _unique_name("MountingService")

    first = _rpc(
        erp_client,
        "saveContractorServiceCharge",
        [{"contractorName": contractor, "serviceType": service_type, "chargeAmount": 30}],
        mutation=True,
    )
    assert first.get_json()["success"] is True

    second = _rpc(
        erp_client,
        "saveContractorServiceCharge",
        [{"contractorName": contractor, "serviceType": service_type, "chargeAmount": 45}],
        mutation=True,
    )
    assert second.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorServiceChargesData", [contractor]).get_json()["data"]
    matches = [c for c in listed if c["serviceType"] == service_type]
    assert len(matches) == 1
    assert matches[0]["chargeAmount"] == 45


def test_get_contractor_service_charges_for_contractor_is_scoped(erp_client):
    contractor_a = _unique_name("ScopedChargeContractorA")
    contractor_b = _unique_name("ScopedChargeContractorB")
    _rpc(
        erp_client, "saveContractorServiceCharge",
        [{"contractorName": contractor_a, "serviceType": "Mounting Tyre/Tube", "chargeAmount": 20}], mutation=True,
    )
    _rpc(
        erp_client, "saveContractorServiceCharge",
        [{"contractorName": contractor_b, "serviceType": "Balancing", "chargeAmount": 15}], mutation=True,
    )

    listed = _rpc(erp_client, "getContractorServiceChargesForContractor", [contractor_a]).get_json()["data"]
    assert [c["serviceType"] for c in listed] == ["Mounting Tyre/Tube"]


def test_delete_contractor_service_charge_not_found_and_success(erp_client):
    missing = _rpc(erp_client, "deleteContractorServiceCharge", ["NoSuchContractor", "NoSuchService"], mutation=True)
    assert missing.get_json()["success"] is False

    contractor = _unique_name("DeleteChargeContractor")
    service_type = _unique_name("DeleteChargeService")
    _rpc(
        erp_client, "saveContractorServiceCharge",
        [{"contractorName": contractor, "serviceType": service_type, "chargeAmount": 10}], mutation=True,
    )

    resp = _rpc(erp_client, "deleteContractorServiceCharge", [contractor, service_type], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorServiceChargesData", [contractor]).get_json()["data"]
    assert listed == []


def test_delete_contractor_service_charges_bulk_removes_selected_only(erp_client):
    contractor = _unique_name("BulkChargeContractor")
    service_a = _unique_name("BulkChargeServiceA")
    service_b = _unique_name("BulkChargeServiceB")
    service_keep = _unique_name("BulkChargeServiceKeep")
    for s in (service_a, service_b, service_keep):
        _rpc(
            erp_client, "saveContractorServiceCharge",
            [{"contractorName": contractor, "serviceType": s, "chargeAmount": 5}], mutation=True,
        )

    resp = _rpc(
        erp_client, "deleteContractorServiceChargesBulk",
        [[
            {"contractorName": contractor, "serviceType": service_a},
            {"contractorName": contractor, "serviceType": service_b},
        ]],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True
    assert "2" in body["message"]

    remaining = [c["serviceType"] for c in _rpc(erp_client, "getContractorServiceChargesData", [contractor]).get_json()["data"]]
    assert service_a not in remaining
    assert service_b not in remaining
    assert service_keep in remaining


def test_record_contractor_payment_validates_amount(erp_client):
    contractor = _unique_name("PaymentValidationContractor")
    resp = _rpc(
        erp_client,
        "recordContractorPayment",
        [{"contractorName": contractor, "amount": 0, "date": "01/01/2026"}],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "greater than zero" in body["message"]


def test_record_contractor_payment_auto_creates_contractor_and_defaults_date(erp_client):
    contractor = _unique_name("FreshPaymentContractor")
    resp = _rpc(
        erp_client,
        "recordContractorPayment",
        [{"contractorName": contractor, "amount": 250, "modeReference": "UPI - txn123"}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorsData").get_json()["data"]
    assert any(c["contractorName"] == contractor for c in listed)

    payments = _rpc(erp_client, "getContractorPaymentsData", [contractor]).get_json()["data"]
    assert len(payments) == 1
    assert payments[0]["amount"] == 250
    assert payments[0]["modeReference"] == "UPI - txn123"
    assert payments[0]["dateRaw"]  # defaulted to today, non-empty


def test_delete_contractor_payment_optimistic_check(erp_client):
    contractor = _unique_name("DeletePaymentContractor")
    _rpc(
        erp_client,
        "recordContractorPayment",
        [{"contractorName": contractor, "amount": 100, "date": "01/01/2026"}],
        mutation=True,
    )
    payment = _rpc(erp_client, "getContractorPaymentsData", [contractor]).get_json()["data"][0]
    row_idx = payment["rowIdx"]

    mismatch = _rpc(erp_client, "deleteContractorPayment", [row_idx, contractor, 999], mutation=True)
    body = mismatch.get_json()
    assert body["success"] is False
    assert "Data mismatch" in body["message"]

    match = _rpc(erp_client, "deleteContractorPayment", [row_idx, contractor, 100], mutation=True)
    assert match.get_json()["success"] is True

    remaining = _rpc(erp_client, "getContractorPaymentsData", [contractor]).get_json()["data"]
    assert remaining == []


def test_delete_contractor_payment_without_expected_values_skips_check(erp_client):
    contractor = _unique_name("SkipCheckPaymentContractor")
    _rpc(
        erp_client,
        "recordContractorPayment",
        [{"contractorName": contractor, "amount": 75, "date": "01/01/2026"}],
        mutation=True,
    )
    payment = _rpc(erp_client, "getContractorPaymentsData", [contractor]).get_json()["data"][0]

    resp = _rpc(erp_client, "deleteContractorPayment", [payment["rowIdx"]], mutation=True)
    assert resp.get_json()["success"] is True


def test_delete_contractor_payments_bulk_removes_selected_only(erp_client):
    contractor = _unique_name("BulkPaymentContractor")
    for amount in (100, 200, 300):
        _rpc(
            erp_client, "recordContractorPayment",
            [{"contractorName": contractor, "amount": amount, "date": "01/01/2026"}], mutation=True,
        )
    payments = _rpc(erp_client, "getContractorPaymentsData", [contractor]).get_json()["data"]
    assert len(payments) == 3
    to_delete = [p["rowIdx"] for p in payments if p["amount"] in (100, 200)]

    resp = _rpc(erp_client, "deleteContractorPaymentsBulk", [to_delete], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "2" in body["message"]

    remaining = _rpc(erp_client, "getContractorPaymentsData", [contractor]).get_json()["data"]
    assert len(remaining) == 1
    assert remaining[0]["amount"] == 300


def test_delete_contractor_payments_bulk_no_selection_is_a_success_noop(erp_client):
    resp = _rpc(erp_client, "deleteContractorPaymentsBulk", [[]], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "No payment records selected" in body["message"]


def test_get_contractor_ledger_data_includes_negative_payable_correction_lot(erp_client):
    """Production allows negative qty for corrections; a real rate against a
    negative qty is a legitimate negative payable that must still be summed
    in, not dropped by a stale `payable <= 0` guard.
    """
    contractor = _unique_name("NegativePayableContractor")
    process_type = _unique_name("NegativePayableType")
    _payload, process_id = _save_process(erp_client, processType=process_type)

    # _save_process's default outputItemName carries no recognized size
    # substring, so contractors_service._get_size_from_output_item_name
    # resolves it to the 'General' fallback -- the rate must be keyed there.
    _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processType": process_type, "size": "General", "ratePerUnit": 10}],
        mutation=True,
    )

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": contractor,
                "qty": -5,
                "status": "Completed",
                "componentsConsumed": [{"itemName": _unique_name("CorrectionItem"), "qty": 1, "sourceType": "ITEM"}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    listed = _rpc(erp_client, "getContractorLedgerData").get_json()["data"]
    match = next(c for c in listed if c["contractorName"] == contractor)
    assert match["lotCount"] == 1
    assert match["totalPayable"] == -50  # rate 10 * qty -5
    assert match["balanceDue"] == -50

    account = _rpc(erp_client, "getContractorAccountLedger", [contractor]).get_json()["data"]
    assert account["totalPayable"] == -50
    assert account["balanceDue"] == -50
    payable_entries = [e for e in account["entries"] if e["amount"] == -50]
    assert len(payable_entries) == 1


def test_get_contractor_ledger_data_payments_only_contractor(erp_client):
    contractor = _unique_name("LedgerPaymentsOnlyContractor")
    _rpc(
        erp_client,
        "recordContractorPayment",
        [{"contractorName": contractor, "amount": 300, "date": "01/01/2026"}],
        mutation=True,
    )

    listed = _rpc(erp_client, "getContractorLedgerData").get_json()["data"]
    match = next(c for c in listed if c["contractorName"] == contractor)
    assert match["totalPayable"] == 0
    assert match["totalPaid"] == 300
    assert match["balanceDue"] == -300
    assert match["lotCount"] == 0


def test_get_contractor_account_ledger_shape(erp_client):
    contractor = _unique_name("AccountLedgerContractor")
    _rpc(
        erp_client,
        "recordContractorPayment",
        [{"contractorName": contractor, "amount": 150, "date": "01/01/2026", "modeReference": "Cash"}],
        mutation=True,
    )

    resp = _rpc(erp_client, "getContractorAccountLedger", [contractor])
    body = resp.get_json()
    assert body["success"] is True
    data = body["data"]
    assert data["totalPayable"] == 0
    assert data["totalPaid"] == 150
    assert data["balanceDue"] == -150
    assert len(data["entries"]) == 1
    entry = data["entries"][0]
    assert entry["type"] == "Payment"
    assert entry["amount"] == -150
    assert entry["balance"] == -150
    assert entry["ref"] == "Cash"


def test_get_contractor_account_ledger_requires_name(erp_client):
    resp = _rpc(erp_client, "getContractorAccountLedger", [""])
    body = resp.get_json()
    assert body["success"] is False
    assert "required" in body["message"].lower()


def test_process_type_rename_cascades_into_contractor_rates(erp_client):
    old_type = _unique_name("OldCascadeType")
    new_type = _unique_name("NewCascadeType")

    created = _rpc(erp_client, "saveProcessType", [{"name": old_type}], mutation=True)
    assert created.get_json()["success"] is True

    contractor = _unique_name("ProcessTypeCascadeContractor")
    _rpc(
        erp_client,
        "saveContractorRate",
        [{"contractorName": contractor, "processType": old_type, "size": "General", "ratePerUnit": 12}],
        mutation=True,
    )

    rename = _rpc(erp_client, "saveProcessType", [{"name": new_type, "originalName": old_type}], mutation=True)
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorRatesData", [contractor]).get_json()["data"]
    assert listed[0]["processType"] == new_type


def test_delete_contractor_removes_service_charges(erp_client):
    contractor = _unique_name("DeleteChargeCascadeContractor")
    _rpc(
        erp_client, "saveContractorServiceCharge",
        [{"contractorName": contractor, "serviceType": "Mounting", "chargeAmount": 10}], mutation=True,
    )

    deleted = _rpc(erp_client, "deleteContractor", [contractor], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorServiceChargesData", [contractor]).get_json()["data"]
    assert listed == []


def test_contractor_rename_cascades_into_service_charges(erp_client):
    old_contractor = _unique_name("OldChargeCascadeContractor")
    new_contractor = _unique_name("NewChargeCascadeContractor")
    _rpc(erp_client, "saveContractor", [{"contractorName": old_contractor}], mutation=True)
    _rpc(
        erp_client, "saveContractorServiceCharge",
        [{"contractorName": old_contractor, "serviceType": "Mounting", "chargeAmount": 10}], mutation=True,
    )

    rename = _rpc(
        erp_client, "saveContractor",
        [{"contractorName": new_contractor, "originalContractorName": old_contractor}], mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getContractorServiceChargesData", [new_contractor]).get_json()["data"]
    assert len(listed) == 1
    assert listed[0]["contractorName"] == new_contractor


def test_contractor_rename_cascades_into_bom_additional_costs(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)

    old_contractor = _unique_name("OldBomCostContractor")
    new_contractor = _unique_name("NewBomCostContractor")
    _rpc(erp_client, "saveContractor", [{"contractorName": old_contractor}], mutation=True)

    item = _unique_name("ContractorCascadeBomItem")
    create = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("ContractorCascadeProduct"),
                "components": [{"itemName": item, "qtyPerProduct": 1}],
                "additionalCosts": [{"description": "Labor", "rate": 20, "contractorName": old_contractor}],
            },
            token,
        ],
        mutation=True,
    )
    product_id = create.get_json()["data"]["productId"]

    rename = _rpc(
        erp_client,
        "saveContractor",
        [{"contractorName": new_contractor, "originalContractorName": old_contractor}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    match = next(p for p in listed if p["productId"] == product_id)
    assert match["additionalCosts"][0]["contractorName"] == new_contractor
