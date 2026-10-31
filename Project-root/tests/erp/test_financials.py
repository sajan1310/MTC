"""Rates, costs and money are for Admin and Super Admin (the owner's rule).

Three things have to hold together, and each is pinned here:

  1. the amounts never leave the server for anyone else (rpc.py blanks them),
  2. a blanked form can't overwrite a real price (those saves are Admin-only),
  3. a custom role's page can still read the lists it depends on, because the
     blanking is what makes that safe.

Logged in for real through the same path as test_rpc_permission_gate.py.
"""

from __future__ import annotations

import uuid
from datetime import date

import psycopg2.extras
import pytest

import database
from app.erp import mutations, rpc
from app.erp.registry import RPC_METHODS
from app.erp.services import financials, roles_service
from app.erp.services.financials import (
    FINANCIAL_SAVES,
    is_money_key,
    sees_financials,
    strip_financials,
)


@pytest.fixture(autouse=True)
def the_real_rule(monkeypatch):
    """Undoes conftest's plain_user_sees_money: this file tests the rule."""
    monkeypatch.setattr(
        financials, "FINANCE_ROLES", frozenset({"admin", "super_admin"})
    )


@pytest.fixture
def client_as(erp_app):
    roles_created: list[str] = []
    users_created: list[int] = []

    def _make(role, permissions=None):
        suffix = uuid.uuid4().hex[:8]
        with erp_app.app_context(), database.get_conn() as (_conn, cur):
            if permissions is not None:
                role = roles_service._slugify(f"Money Role {suffix}")
                cur.execute(
                    "INSERT INTO custom_roles (role_key, role_name, permissions) "
                    "VALUES (%s, %s, %s)",
                    (role, f"Money Role {suffix}", psycopg2.extras.Json(permissions)),
                )
                roles_created.append(role)
            cur.execute(
                "INSERT INTO users (name, email, password_hash, role) "
                "VALUES (%s, %s, %s, %s) RETURNING user_id",
                (
                    f"Money User {suffix}",
                    f"money-{suffix}@example.invalid",
                    "not-a-real-hash",
                    role,
                ),
            )
            users_created.append(cur.fetchone()[0])

        client = erp_app.test_client()
        with client.session_transaction() as sess:
            sess["_user_id"] = str(users_created[-1])
            sess["_fresh"] = True
        return client

    yield _make

    with erp_app.app_context(), database.get_conn() as (_conn, cur):
        if users_created:
            cur.execute("DELETE FROM users WHERE user_id = ANY(%s)", (users_created,))
        if roles_created:
            cur.execute(
                "DELETE FROM custom_roles WHERE role_key = ANY(%s)", (roles_created,)
            )


def _call(client, method, *args):
    return client.post(f"/api/erp/rpc/{method}", json={"args": list(args)})


def _mutate(client, method, *args, mutation_id=None):
    return client.post(
        f"/api/erp/rpc/{method}",
        json={"args": list(args)},
        headers={"X-Mutation-Id": mutation_id or str(uuid.uuid4())},
    )


# -- Who ------------------------------------------------------------------


@pytest.mark.parametrize("role", ["admin", "super_admin"])
def test_admins_see_money(role):
    assert sees_financials(role) is True


@pytest.mark.parametrize("role", ["user", "store_room", "", None])
def test_nobody_else_does(role):
    assert sees_financials(role) is False


# -- Which fields ---------------------------------------------------------


@pytest.mark.parametrize(
    "key",
    [
        "rate",
        "price",
        "amount",
        "totalAmount",
        "baseRate",
        "ratePerBaseUnit",
        "ratePerUnit",
        "contractorRate",
        "contractorPayable",
        "extraChargeAmount",
        "chargeAmount",
        "gstAmount",
        "gstRatePct",
        "lineTotal",
        "grandTotal",
        "subtotal",
        "totalCost",
        "lineCost",
        "additionalCosts",
        "logisticsCost",
        "logisticsRate",
        "totalPaid",
        "totalPayable",
        "payable",
        "balanceDue",
        "poRate",
        "billRate",
        "totalValue",
        "openPoValue",
    ],
)
def test_money_fields_are_recognised(key):
    assert is_money_key(key) is True


@pytest.mark.parametrize(
    "key",
    [
        "qty",
        "baseQty",
        "totalQty",
        "receivedQty",
        "pendingQty",
        "balanceQty",
        "availableQty",
        "currentStock",
        "threshold",
        "oldValue",
        "newValue",
        "lotCount",
        "factorToBase",
        "generatedAt",
        "sequence",
        "status",
        "itemName",
    ],
)
def test_quantities_and_names_are_left_alone(key):
    """A floor role's whole job is these; blanking one would be a wrong count."""
    assert is_money_key(key) is False


# -- Blanking -------------------------------------------------------------


def test_nested_amounts_are_blanked_and_quantities_kept():
    data = [
        {
            "billNumber": "B-1",
            "totalAmount": 1500.5,
            "items": [{"itemName": "Axle", "qty": 10, "price": 150.05}],
            "vendors": [{"vendor": "Acme", "rate": 12.5, "ratePerBaseUnit": 1.25}],
        }
    ]

    assert strip_financials(data) == [
        {
            "billNumber": "B-1",
            "totalAmount": 0,
            "items": [{"itemName": "Axle", "qty": 10, "price": 0}],
            "vendors": [{"vendor": "Acme", "rate": 0, "ratePerBaseUnit": 0}],
        }
    ]


def test_blanking_keeps_the_type_so_a_renderer_never_trips():
    """`.toFixed` on a missing key throws in the browser; on a zero it doesn't."""
    data = {
        "price": 9.5,
        "rate": "12.50",
        "additionalCosts": [{"label": "Paint", "amount": 4}],
        "colorCosts": {"Red": 5},
        "amount": None,
    }

    assert strip_financials(data) == {
        "price": 0,
        "rate": "0",
        "additionalCosts": [],
        "colorCosts": {},
        "amount": None,
    }


def test_a_label_with_a_money_word_in_its_name_stays():
    """extraChargeType is what saveProduction compares to keep a lot's charge;
    blanking it would drop the charge on the next edit."""
    data = {"rateType": "Per Piece", "costCentre": "Paint Shop"}
    assert strip_financials(data) == data


@pytest.mark.parametrize(
    "method,key,keep",
    [
        ("getIssueData", "value", 10),
        ("getPOData", "total", 10),
        # A running rupee balance here; a quantity on a lot's receipts.
        ("getContractorAccountLedger", "balance", 10),
    ],
)
def test_a_generic_name_is_money_only_where_it_is_money(method, key, keep):
    assert strip_financials({key: 10}, method) == {key: 0}
    assert strip_financials({key: keep}, "getInspectionLots") == {key: keep}


def test_blanking_leaves_the_original_alone():
    """The envelope may be the one stored for a replayed mutation, which an
    Admin's retry must get back whole."""
    data = {"items": [{"price": 5}]}
    strip_financials(data)
    assert data == {"items": [{"price": 5}]}


# -- Reads, for real ------------------------------------------------------


def test_the_reply_is_blanked_for_a_user_and_whole_for_an_admin(client_as, erp_app):
    with erp_app.app_context(), database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.contractor_service_charges "
            "(contractor_name, service_type, charge_amount) VALUES (%s, %s, %s) "
            "RETURNING id",
            ("Money Check Contractor", "Polish", 42),
        )
        row_id = cur.fetchone()[0]
    try:

        def charge(client):
            rows = _call(client, "getContractorServiceChargesData").get_json()["data"]
            return [r for r in rows if r["rowIdx"] == row_id][0]

        assert charge(client_as("admin"))["chargeAmount"] == 42
        as_user = charge(client_as("user"))
        assert as_user["chargeAmount"] == 0
        assert as_user["contractorName"] == "Money Check Contractor"
    finally:
        with erp_app.app_context(), database.get_conn() as (_conn, cur):
            cur.execute(
                "DELETE FROM erp.contractor_service_charges WHERE id = %s", (row_id,)
            )


# -- Saves ----------------------------------------------------------------


def test_every_financial_save_is_a_real_mutation():
    """A name that doesn't exist here guards nothing, and silently."""
    for method in FINANCIAL_SAVES:
        assert method in RPC_METHODS, method
        assert RPC_METHODS[method].mutation is True, method


@pytest.mark.parametrize("method", sorted(FINANCIAL_SAVES))
def test_a_user_cannot_run_a_save_that_carries_prices(client_as, method):
    response = _mutate(client_as("user"), method, {})
    assert response.status_code == 403
    assert "carries prices" in response.get_json()["message"]


def test_editor_on_the_page_does_not_change_that(client_as):
    response = _mutate(client_as(None, {"billLedger": "editor"}), "saveBill", {})
    assert response.status_code == 403
    assert "carries prices" in response.get_json()["message"]


def test_an_admin_is_not_stopped_by_this_gate(client_as):
    """Rejected by the service on its own terms, so a 200 and not a 403."""
    response = _mutate(client_as("admin"), "saveBill", {})
    assert response.status_code == 200
    assert response.get_json()["success"] is False


def test_a_refused_save_never_claims_its_mutation_id(client_as):
    mutation_id = str(uuid.uuid4())
    _mutate(client_as("user"), "saveBill", {}, mutation_id=mutation_id)
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT 1 FROM erp.rpc_mutations WHERE mutation_id = %s", (mutation_id,)
        )
        assert cur.fetchone() is None


# -- Replies that take another route --------------------------------------


def test_a_replayed_save_is_blanked_too(client_as, erp_app):
    """A retried X-Mutation-Id answers from the stored envelope and never runs
    the method, so this path needs the rule as much as the normal one. The
    stored copy stays whole: the id may be an Admin's own retry."""
    mutation_id = str(uuid.uuid4())
    envelope = {"success": True, "data": {"itemName": "Axle", "qty": 4, "price": 150}}
    with erp_app.app_context():
        assert mutations.claim(mutation_id, "updateThreshold") is None
        mutations.complete(mutation_id, envelope)

    as_user = _mutate(client_as("user"), "updateThreshold", mutation_id=mutation_id)
    assert as_user.get_json()["data"] == {"itemName": "Axle", "qty": 4, "price": 0}

    as_admin = _mutate(client_as("admin"), "updateThreshold", mutation_id=mutation_id)
    assert as_admin.get_json()["data"]["price"] == 150


def test_a_reply_outside_the_usual_envelope_passes_through(client_as):
    """getNextOrderNumber answers with a bare string, not an envelope."""
    reply = _call(client_as("user"), "getNextOrderNumber")
    assert reply.status_code == 200
    assert reply.get_json().startswith("ORD-")


def test_a_value_with_no_blank_form_is_left_as_it_is():
    when = date(2026, 10, 31)
    assert strip_financials({"rate": when}) == {"rate": when}


def test_a_refusal_is_still_a_refusal_when_it_cannot_be_logged(client_as, monkeypatch):
    def broken(**_kwargs):
        raise RuntimeError("activity log unavailable")

    client = client_as("user")
    monkeypatch.setattr(rpc.activity_service, "record", broken)

    response = _mutate(client, "saveBill", {})
    assert response.status_code == 403
    assert "carries prices" in response.get_json()["message"]


# -- Lookups --------------------------------------------------------------


def test_lookups_are_real_reads_only():
    """rpc.py never lets a lookup through as a write, and an admin-only method
    or user administration must never be listed as one."""
    assert set(roles_service.LOOKUPS_BY_TAB) == {
        tab for tab, _label in roles_service.ASSIGNABLE_TABS
    }
    for tab, methods in roles_service.LOOKUPS_BY_TAB.items():
        for method in methods:
            spec = RPC_METHODS[method]
            assert spec.mutation is False, f"{tab}: {method}"
            assert spec.roles is None, f"{tab}: {method}"
            assert roles_service.TAB_BY_SERVICE_MODULE.get(spec.module) != "usersTab", (
                f"{tab}: {method}"
            )


def test_a_page_can_read_the_lists_it_depends_on(client_as):
    client = client_as(None, {"productionTab": "viewer"})
    for method in ("getItemsData", "getProcessData", "getContractorsData"):
        assert _call(client, method).status_code == 200, method


def test_a_list_its_page_does_not_use_stays_refused(client_as):
    client = client_as(None, {"productionTab": "editor"})
    for method in ("getBillData", "getContractorPaymentsData", "getVendorsData"):
        assert _call(client, method).status_code == 403, method


def test_a_lookup_is_never_a_way_to_write(client_as):
    """Items Master stays unwritable for a role that only reads the item list."""
    response = _mutate(client_as(None, {"productionTab": "editor"}), "deleteItem", 1)
    assert response.status_code == 403


def test_a_role_with_no_pages_gets_no_lookups(client_as):
    assert _call(client_as(None, {}), "getItemsData").status_code == 403


def test_a_role_deleted_under_a_session_gets_no_lookups(client_as):
    assert _call(client_as("role-gone"), "getItemsData").status_code == 403
