"""What each role's shell shows (see app/erp/pages.py).

The two shells render real pages here, logged in for real, because the thing
under test is what ends up in the HTML: a page a custom role can't open should
not be offered at all, and the Dashboard's figures are for Admin and Super
Admin. The server's own gate is pinned in test_rpc_permission_gate.py; none of
this replaces it.
"""

from __future__ import annotations

import json
import re
import uuid

import psycopg2.extras
import pytest

import database
from app.erp.pages import DASHBOARD_FIGURE_ROLES
from app.erp.services import roles_service

SIDEBAR_TABS = [
    "poLedger",
    "billLedger",
    "returnLedger",
    "itemMaster",
    "vendorMaster",
    "stockTab",
    "productsTab",
    "contractorsTab",
    "productionTab",
    "dispatchTab",
    "clientsTab",
]


@pytest.fixture
def client_as(erp_app):
    """A logged-in client holding `role`; pass `permissions` for a custom one."""
    roles_created: list[str] = []
    users_created: list[int] = []

    def _make(role, permissions=None):
        suffix = uuid.uuid4().hex[:8]
        with erp_app.app_context(), database.get_conn() as (_conn, cur):
            if permissions is not None:
                role = roles_service._slugify(f"Shell Role {suffix}")
                cur.execute(
                    "INSERT INTO custom_roles (role_key, role_name, permissions) "
                    "VALUES (%s, %s, %s)",
                    (
                        role,
                        f"Shell Role {suffix}",
                        psycopg2.extras.Json(permissions),
                    ),
                )
                roles_created.append(role)
            cur.execute(
                "INSERT INTO users (name, email, password_hash, role) "
                "VALUES (%s, %s, %s, %s) RETURNING user_id",
                (
                    f"Shell User {suffix}",
                    f"shell-{suffix}@example.invalid",
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
                "DELETE FROM custom_roles WHERE role_key = ANY(%s)",
                (roles_created,),
            )


def _desktop(client) -> str:
    response = client.get("/erp")
    assert response.status_code == 200
    return response.get_data(as_text=True)


def _phone_user(client) -> dict:
    response = client.get("/erp/mobile")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    return json.loads(
        re.search(r"window\.MOBILE_CURRENT_USER = (\{.*?\});</script>", html).group(1)
    )


def _sidebar(html: str) -> set[str]:
    return set(re.findall(r'id="btn-(\w+)"[^>]*data-action="show-tab"', html))


FIGURES = ["kpiLowStockCount", "dashboardPipeline", "dashContractorPayablesBody"]
CHROME = ["dashboardBackupStatus", "dashProductionStatusChart"]


# -- The figures ----------------------------------------------------------


def test_the_figures_are_for_admin_and_super_admin():
    """Everything below follows this one constant."""
    assert DASHBOARD_FIGURE_ROLES == frozenset({"admin", "super_admin"})


@pytest.mark.parametrize("role", ["admin", "super_admin"])
def test_an_admin_gets_the_figures(client_as, role):
    html = _desktop(client_as(role))

    for element in FIGURES + CHROME:
        assert f'id="{element}"' in html
    assert 'name="current-user-figures" content="yes"' in html
    assert _phone_user(client_as(role))["seesFigures"] is True


def test_a_user_keeps_every_page_and_quick_actions_without_the_figures(client_as):
    client = client_as("user")
    html = _desktop(client)

    for element in FIGURES + CHROME:
        assert f'id="{element}"' not in html
    assert 'name="current-user-figures" content="no"' in html
    assert 'id="dashActionsHeading"' in html
    assert _sidebar(html) >= {"dashboardTab", *SIDEBAR_TABS}

    user = _phone_user(client)
    assert user["seesFigures"] is False
    assert user["tabLevels"] is None


def test_a_user_keeps_only_the_jobs_with_no_price_in_them(client_as):
    html = _desktop(client_as("user"))

    assert "App.Production.openCreateModal()" in html
    assert 'class="no-financials"' in html
    dashboard = html.split('id="dashActionsHeading"')[1].split("</section>")[0]
    for job in ("App.PO.openCreateModal", "App.Bill.openReceiveModal"):
        assert job not in dashboard
    assert "App.Wastage.openWastageModal" in dashboard


def test_an_admin_keeps_every_job(client_as):
    html = _desktop(client_as("admin"))

    assert 'class="no-financials"' not in html
    dashboard = html.split('id="dashActionsHeading"')[1].split("</section>")[0]
    for job in ("App.PO.openCreateModal", "App.Bill.openReceiveModal"):
        assert job in dashboard


def test_the_phone_carries_what_the_about_row_needs(client_as):
    """Without figures, the About row has no dashboard payload to read."""
    user = _phone_user(client_as("user"))
    assert user["appVersion"]
    assert user["email"].endswith("@example.invalid")


# -- A custom role --------------------------------------------------------


def test_a_custom_role_sees_only_its_own_pages(client_as):
    client = client_as(None, {"stockTab": "editor", "billLedger": "viewer"})
    html = _desktop(client)

    assert _sidebar(html) == {"stockTab", "billLedger"}
    assert 'name="current-user-access" content="limited"' in html
    assert 'id="dashActionsHeading"' not in html
    for element in FIGURES + CHROME:
        assert f'id="{element}"' not in html

    assert _phone_user(client)["tabLevels"] == {
        "stockTab": "editor",
        "billLedger": "viewer",
    }


def test_a_full_account_is_not_limited(client_as):
    html = _desktop(client_as("user"))
    assert 'name="current-user-access" content="full"' in html


def test_the_masters_and_logo_are_not_a_store_room_job(client_as):
    html = _desktop(client_as(None, {"stockTab": "editor"}))

    assert "App.Unit.openModal()" not in html.split('id="sidebar-backdrop"')[0]
    assert 'id="logo-upload-input"' not in html


@pytest.mark.parametrize("tab", ["itemMaster", "productsTab"])
def test_the_masters_follow_the_pages_that_use_them(client_as, tab):
    html = _desktop(client_as(None, {tab: "viewer"}))

    assert "App.Unit.openModal()" in html.split('id="sidebar-backdrop"')[0]
    assert 'id="logo-upload-input"' not in html


def test_the_inspections_sub_tab_needs_inspection(client_as):
    assert 'id="btn-inspectionsSubTab"' not in _desktop(
        client_as(None, {"productionTab": "editor"})
    )
    assert 'id="btn-inspectionsSubTab"' in _desktop(
        client_as(None, {"productionTab": "editor", "inspectionTab": "editor"})
    )


def test_a_role_with_no_page_is_told_so(client_as):
    html = _desktop(client_as(None, {}))

    assert _sidebar(html) == set()
    assert "No pages have been assigned to your account yet" in html


def test_an_inspector_is_sent_to_the_app(client_as):
    """Inspection has no sidebar entry: inspectors work on the phone/tablet."""
    html = _desktop(client_as(None, {"inspectionTab": "editor"}))

    assert 'id="dashboardNoPages"' in html
    assert "Inspection opens in the phone and tablet app" in html
    assert "/erp/mobile" in html


def test_a_role_with_a_page_is_not_shown_the_no_pages_note(client_as):
    html = _desktop(client_as(None, {"stockTab": "viewer"}))
    assert 'id="dashboardNoPages"' not in html


def test_a_role_deleted_under_a_session_shows_nothing(client_as):
    """Fail closed, the same way rpc.py's gate does."""
    html = _desktop(client_as("role-that-no-longer-exists"))

    assert _sidebar(html) == set()
    assert 'id="dashActionsHeading"' not in html
