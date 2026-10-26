"""Lot inspection (inspection_service, migration 053).

The rules these tests hold, agreed with the owner on 2026-10-25:
  - clearing an inspection never changes the lot's own status, and so never
    moves stock (only Completed credits the Warehouse Pool);
  - a Pending lot becomes In Progress when its first item is checked, and
    opening or browsing a lot changes nothing;
  - only an admin may accept Production Sheet changes without re-inspecting;
  - after an admin edits a lot, checks on rows that did not change are kept,
    and changed or added rows come back unticked as Revised / New.

And on 2026-10-26, when a checklist replaced Pass / Fail:
  - an item is ticked or not, and a lot is Not started, Partially checked,
    All checked, Needs review (its review box ticked) or Inspected;
  - anyone who can inspect clears an All checked lot; an admin reviews and
    clears any open lot, after seeing what nobody ticked.
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


def _check_all(client, lot_id, result="checked") -> dict:
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


def _tick_first(client, lot_id, result="checked") -> dict:
    first = _checklist(client, lot_id)["items"][0]
    return _rpc(
        client,
        "setInspectionCheck",
        [lot_id, first["key"], result, first["fingerprint"]],
        mutation=True,
    ).get_json()


def test_clearing_needs_every_item_ticked(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    assert _tick_first(erp_client, lot_id)["data"]["stage"] == "partial"
    body = _rpc(erp_client, "clearInspection", [lot_id], mutation=True).get_json()
    assert body["success"] is False and "2 left" in body["message"]
    assert "Needs admin review" in body["message"]


def test_pass_still_ticks_and_fail_is_refused(erp_app, erp_client):
    """A phone on the old Pass / Fail screen until it reloads: Pass ticks the
    item, and Fail -- which the checklist has no meaning for -- is refused."""
    lot_id = _insert_lot(erp_app)
    assert _tick_first(erp_client, lot_id, "pass")["data"]["item"]["state"] == "checked"

    refused = _tick_first(erp_client, lot_id, "fail")
    assert (
        refused["success"] is False and "replaced by a checklist" in refused["message"]
    )


def test_a_fail_from_the_old_screen_reads_as_not_ticked(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    _tick_first(erp_client, lot_id)
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "UPDATE erp.lot_inspection_checks c SET result = 'fail' "
                "FROM erp.lot_inspections i WHERE c.inspection_id = i.id AND i.production_id = %s",
                (lot_id,),
            )

    data = _checklist(erp_client, lot_id)
    assert [i["state"] for i in data["items"]] == ["pending", "pending", "pending"]
    assert data["summary"]["checked"] == 0
    assert data["inspection"]["stage"] == "not_started"


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


# ── Needs admin review ────────────────────────────────────────────────────


def _review(client, lot_id, needs_review, remarks):
    return _rpc(
        client,
        "setInspectionReview",
        [lot_id, needs_review, remarks],
        mutation=True,
    ).get_json()


def test_needs_review_asks_an_admin_who_clears_it_after_seeing_what_was_not_ticked(
    erp_app, erp_client, erp_admin_client
):
    lot_id = _insert_lot(erp_app)
    empty = _review(erp_client, lot_id, True, "  ")
    assert (
        empty["success"] is False
        and "what the admin should look at" in empty["message"]
    )

    flagged = _review(erp_client, lot_id, True, "Spokes are 13G, not 12G")
    assert flagged["success"] is True and flagged["data"]["stage"] == "needs_review"
    assert flagged["data"]["flaggedByName"] == "ERP Test User"
    _tick_first(erp_client, lot_id)
    held = _rpc(erp_client, "clearInspection", [lot_id], mutation=True).get_json()
    assert (
        held["success"] is False and "waiting for an admin's review" in held["message"]
    )

    # The admin is shown the two items nobody ticked, and clears only that list.
    shown = _ok(_rpc(erp_admin_client, "clearInspection", [lot_id], mutation=True))
    assert shown["data"]["cleared"] is False and shown["data"]["canAcknowledge"] is True
    assert [d["kind"] for d in shown["data"]["discrepancies"]] == [
        "unchecked",
        "unchecked",
    ]
    assert shown["message"] == "2 item(s) not ticked."
    body = _ok(
        _rpc(
            erp_admin_client,
            "clearInspection",
            [lot_id, shown["data"]["token"]],
            mutation=True,
        )
    )
    assert body["data"]["cleared"] is True
    assert {d["itemName"] for d in body["data"]["acknowledged"]} == {
        "Rim Tape",
        "Nipple",
    }
    assert _checklist(erp_client, lot_id)["inspection"]["stage"] == "cleared"


def test_an_admin_clears_an_all_checked_lot_that_needs_review_at_once(
    erp_app, erp_client, erp_admin_client
):
    lot_id = _insert_lot(erp_app)
    _check_all(erp_client, lot_id)
    _review(erp_client, lot_id, True, "Check the spoke gauge again")
    body = _ok(_rpc(erp_admin_client, "clearInspection", [lot_id], mutation=True))
    assert body["data"]["cleared"] is True and body["data"]["acknowledged"] == []


def test_unticking_review_takes_the_request_back(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    _review(erp_client, lot_id, True, "Rim tape looks short")
    back = _review(erp_client, lot_id, False, "Rim tape was in the other bin")
    assert back["message"] == "Review request taken back."
    assert back["data"]["status"] == "in_progress"
    assert back["data"]["remarks"] == "Rim tape was in the other bin"

    _check_all(erp_client, lot_id)
    assert _ok(_rpc(erp_client, "clearInspection", [lot_id], mutation=True))["data"][
        "cleared"
    ]


def test_an_admin_can_still_send_a_lot_back(erp_app, erp_client, erp_admin_client):
    lot_id = _insert_lot(erp_app)
    _review(erp_client, lot_id, True, "Spokes are 13G, not 12G")
    _check_all(erp_client, lot_id)

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
    assert lots[pending]["inspection"]["stage"] == "not_started"
    assert lots[completed_inspected]["inspection"]["summary"]["checked"] == 3
    assert lots[completed_inspected]["inspection"]["stage"] == "complete"


def test_the_stage_follows_the_ticks_and_the_review_box():
    none = {"checked": 0, "complete": False}
    some = {"checked": 2, "complete": False}
    every = {"checked": 3, "complete": True}
    assert insp.stage("", none) == "not_started"
    assert insp.stage("in_progress", none) == "not_started"
    assert insp.stage("in_progress", some) == "partial"
    assert insp.stage("in_progress", every) == "complete"
    assert insp.stage("flagged", every) == "needs_review"
    assert insp.stage("cleared", some) == "cleared"


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
            [lot_id, item["key"], "checked", item["fingerprint"]],
            mutation=True,
        ).status_code
        == 403
    )
    assert (
        _rpc(
            viewer, "setInspectionReview", [lot_id, True, "Short"], mutation=True
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
