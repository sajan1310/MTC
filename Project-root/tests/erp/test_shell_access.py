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
from app.erp.services import financials, roles_service

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


@pytest.fixture(autouse=True)
def the_real_rule(monkeypatch):
    """Undoes conftest's plain_user_sees_money: what a User's shell shows is
    exactly what this file tests."""
    monkeypatch.setattr(
        financials, "FINANCE_ROLES", frozenset({"admin", "super_admin"})
    )


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
    assert 'class="no-price-entry"' in html
    assert 'name="current-user-money" content="no"' in html
    dashboard = html.split('id="dashActionsHeading"')[1].split("</section>")[0]
    for job in ("App.PO.openCreateModal", "App.Bill.openReceiveModal"):
        assert job not in dashboard
    assert "App.Wastage.openWastageModal" in dashboard


def test_an_admin_keeps_every_job(client_as):
    html = _desktop(client_as("admin"))

    assert 'class="no-price-entry"' not in html
    assert 'name="current-user-money" content="yes"' in html
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


# -- Prices & amounts as a grant -------------------------------------------


@pytest.mark.parametrize(
    "level,money,entry",
    [(None, "no", False), ("viewer", "yes", False), ("editor", "yes", True)],
)
def test_a_custom_role_shows_money_as_its_grant_says(client_as, level, money, entry):
    grants = {"billLedger": "editor"}
    if level:
        grants["financials"] = level
    client = client_as(None, grants)
    html = _desktop(client)

    assert f'name="current-user-money" content="{money}"' in html
    assert ('class="no-price-entry"' not in html) is entry
    user = _phone_user(client)
    assert user["seesMoney"] is (money == "yes")
    assert user["entersPrices"] is entry
    # The grant is not a page: it never adds a sidebar entry or a Dashboard.
    assert _sidebar(html) == {"billLedger"}
    assert user["seesFigures"] is False


def test_prices_alone_is_not_a_page(client_as):
    html = _desktop(client_as(None, {"financials": "editor"}))
    assert "No pages have been assigned to your account yet" in html


# -- The first screen's figures, asked for before the page has been read ---
#
# The Dashboard (desktop) and Home (phone, tablet) send the request for their
# figures inline, early in the page, as the same POST api.js sends, so it no
# longer waits for the scripts that used to send it; api.js takes the answer
# (static/erp/tests/first_screen_requests.test.js covers how). Only an account
# that will be shown those figures may be handed a page that asks for them.


def _head(html: str) -> str:
    return html.split("</head>", 1)[0]


def _phone(client) -> str:
    response = client.get("/erp/mobile")
    assert response.status_code == 200
    return response.get_data(as_text=True)


def _early_methods(html: str) -> list[str]:
    """The methods a page sends for before its scripts load, in order."""
    match = re.search(
        r"<script>(?:(?!</script>).)*?__erpEarlyCalls(?:(?!</script>).)*?</script>",
        html,
        re.S,
    )
    if not match:
        return []
    listed = re.search(r"\[([^\]]*)\]\.forEach", match.group(0))
    return re.findall(r"'(\w+)'", listed.group(1)) if listed else []


def _early_at(html: str) -> int:
    return html.index("window.__erpEarlyCalls = ")


@pytest.mark.parametrize("role", ["admin", "super_admin"])
def test_an_admins_page_asks_for_its_figures_before_its_scripts(client_as, role):
    client = client_as(role)

    desktop = _desktop(client)
    assert _early_methods(desktop) == ["getDashboardData"]
    # In the <head>, after the stylesheets: the desktop page shows nothing
    # until all of its scripts have run.
    assert _early_at(desktop) < desktop.index("</head>")
    assert desktop.rindex('rel="stylesheet"', 0, _early_at(desktop)) > 0
    assert _early_at(desktop) < desktop.index("/static/erp/api.js")

    phone = _phone(client)
    assert _early_methods(phone) == ["getMobileDashboard", "getDashboardData"]
    # Straight after the top bar: in the <head> the browser drew a frame or
    # two before any of the page existed, and the top bar came a frame later.
    assert phone.index("</header>") < _early_at(phone)
    assert _early_at(phone) < phone.index('<main id="mapp-content"')
    assert _early_at(phone) < phone.index("/static/erp/api.js")


def test_an_account_without_the_figures_asks_for_none(client_as):
    """A `user` has the Dashboard page but not its figures: the server
    would refuse the request, on every load."""
    client = client_as("user")

    assert _early_methods(_desktop(client)) == []
    assert _early_methods(_phone(client)) == []


def test_a_custom_role_asks_for_none(client_as):
    """No Dashboard in its sidebar, so nothing would ever use the answer."""
    client = client_as(None, {"stockTab": "viewer", "financials": "viewer"})

    assert _early_methods(_desktop(client)) == []
    assert _early_methods(_phone(client)) == []


@pytest.mark.parametrize("role", ["admin", "user"])
def test_api_js_is_loaded_once_where_it_always_was(client_as, role):
    """Twice would define Api twice. In the <head> it held the phone's first
    paint back by 50-150 ms, which is why the early request does not need it."""
    client = client_as(role)

    for html, followed_by in (
        (_desktop(client), "/static/erp/print-templates.js"),
        (_phone(client), "/static/erp/offline-cache.js"),
    ):
        tags = re.findall(r'<script src="/static/erp/api\.js[^"]*"', html)
        assert len(tags) == 1
        assert tags[0] not in _head(html)
        assert html.index(tags[0]) < html.index(followed_by)
        # After the token it sends with every request.
        assert html.index('name="csrf-token"') < html.index(tags[0])


# -- The faces that draw "₹" -------------------------------------------------
#
# The rupee sign is in the latin-ext font files, which the browser fetches
# only when the first amount is laid out, and then lays the page out again in
# them. The desktop page fetches them while it is still hidden, for an account
# shown amounts (it took 50-200 ms of blocking off start-up). On the phone and
# tablet that made start-up longer for no gain once the app was usable (lab,
# 2026-11-17), so that page leaves them to load when first needed.


def _rupee_faces(html: str) -> list[str]:
    match = re.search(
        r"<script>(?:(?!</script>).)*?document\.fonts\.load(?:(?!</script>).)*?</script>",
        html,
        re.S,
    )
    return re.findall(r"'(\d00 1em \w+)'", match.group(0)) if match else []


def _families(faces: list[str]) -> set[str]:
    return {face.rsplit(" ", 1)[1] for face in faces}


def test_a_desktop_shown_amounts_fetches_the_rupee_faces(client_as):
    client = client_as("admin")

    assert _families(_rupee_faces(_desktop(client))) == {"Inter", "Outfit"}
    assert _rupee_faces(_phone(client)) == []


def test_an_account_shown_no_amounts_does_not(client_as):
    client = client_as("user")

    assert _rupee_faces(_desktop(client)) == []
    assert _rupee_faces(_phone(client)) == []


def test_a_custom_role_granted_amounts_does(client_as):
    client = client_as(None, {"billLedger": "editor", "financials": "viewer"})

    assert _families(_rupee_faces(_desktop(client))) == {"Inter", "Outfit"}
    assert _rupee_faces(_phone(client)) == []


def test_no_page_preloads_them(client_as):
    """A font preload in the <head> held the tablet's first paint back by up
    to 300 ms; the phone page preloads no fonts at all."""
    client = client_as("admin")

    desktop, phone = _desktop(client), _phone(client)
    assert "latin-ext" not in "".join(re.findall(r'<link rel="preload"[^>]*>', desktop))
    assert 'rel="preload"' not in _head(phone)
