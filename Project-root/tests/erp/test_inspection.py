"""Lot inspection (inspection_service, migration 053).

The rules these tests hold, agreed with the owner on 2026-10-25:
  - clearing an inspection never changes the lot's own status, and so never
    moves stock (only Completed credits the Warehouse Pool);
  - a Pending lot becomes In Progress when its first item is checked, and
    opening or browsing a lot changes nothing;
  - only an admin may accept Production Sheet changes without re-inspecting;
  - after an admin edits a lot, checks on rows that did not change are kept,
    and changed or added rows come back unticked as Revised / New.
"""

from __future__ import annotations

import uuid

import psycopg2.extras
import pytest

import database
from app.erp.services import inspection_service as insp
from app.erp.services import roles_service


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _ok(resp) -> dict:
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body


def _component(item, qty, *, size="", narration="", color_group="COMMON"):
    return {
        "itemName": item,
        "size": size,
        "narration": narration,
        "colorGroup": color_group,
        "qty": qty,
    }


COMPONENTS = [
    _component("Spoke 12G", 50, size="26in", narration="Zinc, 12G"),
    _component("Rim Tape", 60, size="26in"),
    _component("Nipple", 120, narration="Brass"),
]


def _insert_lot(
    app, *, status="Pending", consumed=None, custom=None, process_id="PRC-INSPECT"
):
    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                """
                INSERT INTO erp.production (production_date, qty, assigned_to, status, process_id,
                                            lot_number, components_consumed, custom_components)
                VALUES (CURRENT_DATE, 60, 'Contractor B', %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (
                    status,
                    process_id,
                    f"LOT-INSP-{uuid.uuid4().hex[:8].upper()}",
                    psycopg2.extras.Json(
                        consumed if consumed is not None else COMPONENTS
                    ),
                    psycopg2.extras.Json(custom) if custom is not None else None,
                ),
            )
            return cur.fetchone()[0]


def _set_consumed(app, lot_id, components):
    """What an admin's Edit Lot does to the sheet: new recorded consumption,
    and the saved sheet dropped."""
    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "UPDATE erp.production SET components_consumed = %s, custom_components = NULL WHERE id = %s",
                (psycopg2.extras.Json(components), lot_id),
            )


def _lot_row(app, lot_id) -> dict:
    with app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            _conn,
            cur,
        ):
            cur.execute(
                "SELECT status, completed_at FROM erp.production WHERE id = %s",
                (lot_id,),
            )
            return dict(cur.fetchone())


def _checklist(client, lot_id) -> dict:
    return _ok(_rpc(client, "getInspection", [lot_id]))["data"]


def _check_all(client, lot_id, result="pass") -> dict:
    data = _checklist(client, lot_id)
    for item in data["items"]:
        _ok(
            _rpc(
                client,
                "setInspectionCheck",
                [lot_id, item["key"], result, item["fingerprint"]],
                mutation=True,
            )
        )
    return _checklist(client, lot_id)


# ── The checklist rows: pure ──────────────────────────────────────────────


def test_a_saved_sheet_wins_over_recorded_consumption():
    custom = [
        {
            "itemName": "Spoke 12G",
            "size": "26in",
            "narration": "Zinc",
            "color": "",
            "requiredQty": 45,
        }
    ]
    rows = insp.sheet_rows(custom, COMPONENTS)
    assert [(r["itemName"], r["qty"]) for r in rows] == [("Spoke 12G", 45.0)]
    # An empty saved sheet means "not customised": the recorded consumption shows.
    assert len(insp.sheet_rows([], COMPONENTS)) == 3


def test_row_keys_are_item_size_colour_and_repeats_are_numbered():
    rows = insp.sheet_rows(
        None,
        [
            _component("Spoke", 10, size="26in", color_group="Red"),
            _component("Spoke", 12, size="26in", color_group="Red"),
            _component("Spoke", 14, size="26in"),  # COMMON: no colour
        ],
    )
    assert [r["key"] for r in rows] == [
        "spoke|26in|red",
        "spoke|26in|red#2",
        "spoke|26in|",
    ]
    assert rows[2]["color"] == ""


# ── State retention and diffing: pure ─────────────────────────────────────


def test_unchanged_rows_keep_their_checks_and_changed_ones_come_back_unticked():
    before = insp.sheet_rows(None, COMPONENTS)
    checks = {
        r["key"]: {"result": "pass", "fingerprint": r["fingerprint"], "snapshot": r}
        for r in before
    }

    after = insp.sheet_rows(
        None,
        [
            _component(
                "Spoke 12G", 45, size="26in", narration="Zinc, 12G"
            ),  # quantity changed
            _component("Rim Tape", 60, size="26in"),  # untouched
            _component("Valve Cap", 60),  # added
        ],
    )  # Nipple removed
    items, removed = insp.merge_checklist(after, checks, before)
    states = {i["itemName"]: i["state"] for i in items}

    assert states == {"Spoke 12G": "revised", "Rim Tape": "checked", "Valve Cap": "new"}
    assert next(i for i in items if i["itemName"] == "Rim Tape")["result"] == "pass"
    spoke = next(i for i in items if i["itemName"] == "Spoke 12G")
    assert spoke["result"] is None and spoke["previous"]["qty"] == 50.0
    assert [r["itemName"] for r in removed] == ["Nipple"]


def test_nothing_is_new_before_an_inspection_exists():
    items, removed = insp.merge_checklist(insp.sheet_rows(None, COMPONENTS), {}, None)
    assert {i["state"] for i in items} == {"pending"} and removed == []


def test_discrepancies_name_the_exact_change_and_the_token_follows_them():
    before = insp.sheet_rows(None, COMPONENTS)
    checks = {
        r["key"]: {"result": "pass", "fingerprint": r["fingerprint"], "snapshot": r}
        for r in before
    }
    changed = [dict(c) for c in COMPONENTS]
    changed[0]["qty"] = 45
    items, removed = insp.merge_checklist(
        insp.sheet_rows(None, changed), checks, before
    )
    diff = insp.discrepancies(items, removed)

    assert diff == [
        {
            "key": "spoke 12g|26in|",
            "itemName": "Spoke 12G",
            "size": "26in",
            "color": "",
            "unit": "",
            "kind": "changed",
            "changes": [
                {"field": "qty", "label": "Quantity", "from": 50.0, "to": 45.0}
            ],
        }
    ]
    changed[0]["qty"] = 40
    items2, removed2 = insp.merge_checklist(
        insp.sheet_rows(None, changed), checks, before
    )
    assert insp.discrepancy_token(
        insp.discrepancies(items2, removed2)
    ) != insp.discrepancy_token(diff)


# ── Status: the one write to the lot ──────────────────────────────────────


def test_opening_a_pending_lot_changes_nothing(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    _checklist(erp_client, lot_id)
    assert _lot_row(erp_app, lot_id)["status"] == "Pending"


def test_the_first_check_moves_a_pending_lot_to_in_progress(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    item = _checklist(erp_client, lot_id)["items"][0]
    body = _ok(
        _rpc(
            erp_client,
            "setInspectionCheck",
            [lot_id, item["key"], "pass", item["fingerprint"]],
            mutation=True,
        )
    )

    assert body["data"]["lotStatus"] == "In Progress"
    row = _lot_row(erp_app, lot_id)
    assert row["status"] == "In Progress" and row["completed_at"] is None


def test_checking_never_touches_a_completed_lot(erp_app, erp_client):
    lot_id = _insert_lot(erp_app, status="Completed")
    _check_all(erp_client, lot_id)
    assert _lot_row(erp_app, lot_id)["status"] == "Completed"


def test_a_check_against_a_row_that_changed_is_refused(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    item = _checklist(erp_client, lot_id)["items"][0]
    changed = [dict(c) for c in COMPONENTS]
    changed[0]["qty"] = 45
    _set_consumed(erp_app, lot_id, changed)

    body = _rpc(
        erp_client,
        "setInspectionCheck",
        [lot_id, item["key"], "pass", item["fingerprint"]],
        mutation=True,
    ).get_json()
    assert body["success"] is False and "changed" in body["message"]


# ── Admin revision: retention end to end ──────────────────────────────────


def test_after_an_admin_edit_only_changed_rows_need_checking_again(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    _check_all(erp_client, lot_id)
    _set_consumed(
        erp_app,
        lot_id,
        [
            _component("Spoke 12G", 45, size="26in", narration="Zinc, 12G"),
            _component("Rim Tape", 60, size="26in"),
            _component("Nipple", 120, narration="Brass"),
            _component("Valve Cap", 60),
        ],
    )

    data = _checklist(erp_client, lot_id)
    states = {i["itemName"]: i["state"] for i in data["items"]}
    assert states == {
        "Spoke 12G": "revised",
        "Rim Tape": "checked",
        "Nipple": "checked",
        "Valve Cap": "new",
    }
    assert data["summary"]["checked"] == 2 and data["summary"]["complete"] is False


# ── Clearing and reconciliation ───────────────────────────────────────────


def test_clearing_needs_every_item_passed(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    first = _checklist(erp_client, lot_id)["items"][0]
    _ok(
        _rpc(
            erp_client,
            "setInspectionCheck",
            [lot_id, first["key"], "pass", first["fingerprint"]],
            mutation=True,
        )
    )
    body = _rpc(erp_client, "clearInspection", [lot_id], mutation=True).get_json()
    assert body["success"] is False and "2 left" in body["message"]

    _check_all(erp_client, lot_id, result="fail")
    body = _rpc(erp_client, "clearInspection", [lot_id], mutation=True).get_json()
    assert body["success"] is False and "failed inspection" in body["message"]


def test_clearing_marks_the_inspection_and_leaves_the_lot_status_alone(
    erp_app, erp_client
):
    lot_id = _insert_lot(erp_app)
    _check_all(erp_client, lot_id)
    body = _ok(_rpc(erp_client, "clearInspection", [lot_id], mutation=True))

    assert body["data"]["cleared"] is True
    assert (
        body["message"]
        == "Thank you, ERP Test User. Your lot has been cleared for PRC-INSPECT."
    )
    assert body["data"]["inspector"]["roleLabel"] == "User"
    assert (
        _lot_row(erp_app, lot_id)["status"] == "In Progress"
    )  # moved by the first check only
    data = _checklist(erp_client, lot_id)
    assert data["inspection"]["status"] == "cleared"
    assert data["inspection"]["clearedByName"] == "ERP Test User"


def test_a_changed_sheet_at_submit_returns_the_differences_and_writes_nothing(
    erp_app, erp_client
):
    lot_id = _insert_lot(erp_app)
    _check_all(erp_client, lot_id)
    changed = [dict(c) for c in COMPONENTS]
    changed[0]["qty"] = 45
    _set_consumed(erp_app, lot_id, changed)

    body = _ok(_rpc(erp_client, "clearInspection", [lot_id], mutation=True))
    assert body["data"]["cleared"] is False
    assert [d["kind"] for d in body["data"]["discrepancies"]] == ["changed"]
    assert body["data"]["canAcknowledge"] is False
    assert _checklist(erp_client, lot_id)["inspection"]["status"] == "in_progress"


def test_only_an_admin_may_accept_changes_without_re_inspecting(
    erp_app, erp_client, erp_admin_client
):
    lot_id = _insert_lot(erp_app)
    _check_all(erp_client, lot_id)
    changed = [dict(c) for c in COMPONENTS]
    changed[0]["qty"] = 45
    _set_consumed(erp_app, lot_id, changed)
    token = _ok(_rpc(erp_client, "clearInspection", [lot_id], mutation=True))["data"][
        "token"
    ]

    refused = _rpc(
        erp_client, "clearInspection", [lot_id, token], mutation=True
    ).get_json()
    assert refused["success"] is False and "Only an admin" in refused["message"]

    body = _ok(
        _rpc(erp_admin_client, "clearInspection", [lot_id, token], mutation=True)
    )
    assert body["data"]["cleared"] is True
    assert body["data"]["acknowledged"][0]["changes"][0]["to"] == 45.0


def test_an_acknowledgement_does_not_cover_a_sheet_that_changed_again(
    erp_app, erp_client, erp_admin_client
):
    lot_id = _insert_lot(erp_app)
    _check_all(erp_client, lot_id)
    changed = [dict(c) for c in COMPONENTS]
    changed[0]["qty"] = 45
    _set_consumed(erp_app, lot_id, changed)
    token = _ok(_rpc(erp_admin_client, "clearInspection", [lot_id], mutation=True))[
        "data"
    ]["token"]
    changed[0]["qty"] = 40
    _set_consumed(erp_app, lot_id, changed)

    body = _ok(
        _rpc(erp_admin_client, "clearInspection", [lot_id, token], mutation=True)
    )
    assert body["data"]["cleared"] is False and body["data"]["changedAgain"] is True


# ── Flagging for an admin ─────────────────────────────────────────────────


def test_flagging_needs_remarks_and_holds_the_lot_until_an_admin_sends_it_back(
    erp_app, erp_client, erp_admin_client
):
    lot_id = _insert_lot(erp_app)
    empty = _rpc(
        erp_client, "saveInspectionRemarks", [lot_id, "  ", True], mutation=True
    ).get_json()
    assert empty["success"] is False

    _ok(
        _rpc(
            erp_client,
            "saveInspectionRemarks",
            [lot_id, "Spokes are 13G, not 12G", True],
            mutation=True,
        )
    )
    _check_all(erp_client, lot_id)
    held = _rpc(erp_client, "clearInspection", [lot_id], mutation=True).get_json()
    assert held["success"] is False and "waiting for an admin" in held["message"]

    denied = _rpc(erp_client, "returnInspection", [lot_id, "fixed"], mutation=True)
    assert denied.status_code == 403
    _ok(
        _rpc(
            erp_admin_client,
            "returnInspection",
            [lot_id, "Recipe corrected to 13G"],
            mutation=True,
        )
    )
    data = _checklist(erp_client, lot_id)
    assert data["inspection"]["status"] == "in_progress"
    assert data["inspection"]["reviewNote"] == "Recipe corrected to 13G"
    assert (
        _ok(_rpc(erp_client, "clearInspection", [lot_id], mutation=True))["data"][
            "cleared"
        ]
        is True
    )


# ── The lot list ──────────────────────────────────────────────────────────


def test_the_list_shows_lots_to_inspect_and_lots_already_inspected(erp_app, erp_client):
    pending = _insert_lot(erp_app)
    completed_untouched = _insert_lot(erp_app, status="Completed")
    completed_inspected = _insert_lot(erp_app, status="Completed")
    _check_all(erp_client, completed_inspected)

    lots = {
        lot["rowIdx"]: lot for lot in _ok(_rpc(erp_client, "getInspectionLots"))["data"]
    }
    assert pending in lots and completed_inspected in lots
    assert completed_untouched not in lots
    assert lots[pending]["itemCount"] == 3
    assert lots[completed_inspected]["inspection"]["summary"]["checked"] == 3


# ── Permissions ───────────────────────────────────────────────────────────


@pytest.fixture
def role_client(erp_app):
    """A logged-in client whose user holds a fresh custom role."""
    made = []

    def _make(permissions):
        name = f"Inspector {uuid.uuid4().hex[:8]}"
        key = roles_service._slugify(name)
        with erp_app.app_context():
            with database.get_conn() as (_conn, cur):
                cur.execute(
                    "INSERT INTO custom_roles (role_key, role_name, permissions) VALUES (%s, %s, %s)",
                    (key, name, psycopg2.extras.Json(permissions)),
                )
                cur.execute(
                    "INSERT INTO users (name, email, password_hash, role) VALUES (%s, %s, 'x', %s) RETURNING user_id",
                    (name, f"{key}@example.invalid", key),
                )
                user_id = cur.fetchone()[0]
        made.append(key)
        client = erp_app.test_client()
        with client.session_transaction() as sess:
            sess["_user_id"] = str(user_id)
            sess["_fresh"] = True
        return client, name

    yield _make
    with erp_app.app_context():
        for key in made:
            try:
                with database.get_conn() as (_conn, cur):
                    cur.execute("DELETE FROM users WHERE role = %s", (key,))
                    cur.execute("DELETE FROM custom_roles WHERE role_key = %s", (key,))
            except Exception:  # noqa: BLE001 -- the user signed a lot, so the row stays
                # Their checks and the lot they moved to In Progress name
                # them (foreign keys), which is the audit trail working.
                with database.get_conn() as (_conn, cur):
                    cur.execute(
                        "UPDATE users SET role = 'user' WHERE role = %s", (key,)
                    )
                    cur.execute("DELETE FROM custom_roles WHERE role_key = %s", (key,))


def test_inspection_is_its_own_permission(erp_app, role_client):
    lot_id = _insert_lot(erp_app)

    production_only, _ = role_client({"productionTab": "editor"})
    assert _rpc(production_only, "getInspection", [lot_id]).status_code == 403

    viewer, _ = role_client({"inspectionTab": "viewer"})
    item = _checklist(viewer, lot_id)["items"][0]
    assert (
        _rpc(
            viewer,
            "setInspectionCheck",
            [lot_id, item["key"], "pass", item["fingerprint"]],
            mutation=True,
        ).status_code
        == 403
    )

    inspector, name = role_client({"inspectionTab": "editor"})
    data = _checklist(inspector, lot_id)
    assert data["inspector"]["roleLabel"] == name  # the custom role's own name
    _ok(
        _rpc(
            inspector,
            "setInspectionCheck",
            [lot_id, item["key"], "pass", item["fingerprint"]],
            mutation=True,
        )
    )
