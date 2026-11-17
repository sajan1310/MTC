"""A remark on each inspection checklist item (asked 2026-11-17: "add
remarks column for inspector for each item to review modifications").

The rules these tests hold (inspection_service, migration 059):
  - a remark belongs to one row of the live sheet, names who wrote it, and
    an empty one takes it off;
  - it is a note, not a tick: it does not start the lot, and it stays when
    the row is ticked, unticked or revised by an admin;
  - item remarks are enough to ask for an admin's review;
  - the admin sees each item's remark in the dialog before clearing, and the
    clearance keeps it with what was accepted;
  - once the lot is cleared, the remarks are kept as they stood.
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


def _component(item, qty, *, size="", narration=""):
    return {
        "itemName": item,
        "size": size,
        "narration": narration,
        "colorGroup": "COMMON",
        "qty": qty,
    }


COMPONENTS = [
    _component("Spoke 12G", 50, size="26in", narration="Zinc, 12G"),
    _component("Rim Tape", 60, size="26in"),
    _component("Nipple", 120, narration="Brass"),
]

SPOKE = "spoke 12g|26in|"
TAPE = "rim tape|26in|"


def _insert_lot(app, components=None):
    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                """
                INSERT INTO erp.production (production_date, qty, assigned_to, status, process_id,
                                            lot_number, components_consumed)
                VALUES (CURRENT_DATE, 60, 'Contractor B', 'Pending', 'PRC-INSPECT', %s, %s)
                RETURNING id
                """,
                (
                    f"LOT-REM-{uuid.uuid4().hex[:8].upper()}",
                    psycopg2.extras.Json(components or COMPONENTS),
                ),
            )
            return cur.fetchone()[0]


def _set_consumed(app, lot_id, components):
    """What an admin's Edit Lot does to the sheet."""
    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "UPDATE erp.production SET components_consumed = %s, custom_components = NULL WHERE id = %s",
                (psycopg2.extras.Json(components), lot_id),
            )


def _checklist(client, lot_id) -> dict:
    return _ok(_rpc(client, "getInspection", [lot_id]))["data"]


def _row(data, key) -> dict:
    return next(i for i in data["items"] if i["key"] == key)


def _remark(client, lot_id, key, text):
    return _rpc(
        client, "setInspectionItemRemark", [lot_id, key, text], mutation=True
    ).get_json()


def _tick(client, lot_id, key):
    item = _row(_checklist(client, lot_id), key)
    return _ok(
        _rpc(
            client,
            "setInspectionCheck",
            [lot_id, key, "checked", item["fingerprint"]],
            mutation=True,
        )
    )


# ── Pure ──────────────────────────────────────────────────────────────────


def test_rows_get_their_remark_and_the_summary_counts_them():
    items = [{"key": "a", "state": "pending"}, {"key": "b", "state": "checked"}]
    removed = [{"key": "c"}]
    inspection = {
        "item_remarks": {
            "a": {
                "text": "5 short",
                "byName": "Alex",
                "at": "2026-11-17T10:00:00+05:30",
            },
            "b": {"text": "   "},
            "c": {"text": "Not needed"},
        }
    }
    insp.attach_remarks(inspection, items, removed)
    assert items[0]["remark"] == {
        "text": "5 short",
        "byName": "Alex",
        "at": "2026-11-17T10:00:00+05:30",
    }
    assert items[1]["remark"] is None  # blank is no remark
    assert removed[0]["remark"]["text"] == "Not needed"
    assert insp.summarize(items, removed)["remarked"] == 1

    insp.attach_remarks(None, items)  # no inspection yet
    assert items[0]["remark"] is None


def test_a_difference_carries_its_items_remark_and_only_then():
    items = [
        {
            "key": "a",
            "itemName": "Spoke",
            "qty": 45,
            "narration": "",
            "state": "revised",
            "previous": {"qty": 50, "narration": ""},
        },
        {"key": "b", "itemName": "Cap", "qty": 6, "narration": "", "state": "new"},
    ]
    plain = insp.discrepancies(items, [])
    assert all("remark" not in d for d in plain)

    insp.attach_remarks({"item_remarks": {"a": {"text": "Was 13G"}}}, items)
    noted = insp.discrepancies(items, [])
    assert noted[0]["remark"] == "Was 13G" and "remark" not in noted[1]
    # The token names what the admin is shown, the remark included.
    assert insp.discrepancy_token(noted) != insp.discrepancy_token(plain)


# ── Writing one ───────────────────────────────────────────────────────────


def test_a_remark_is_saved_on_its_row_and_names_who_wrote_it(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    body = _remark(erp_client, lot_id, SPOKE, "  Spokes here are 13G, not 12G  ")
    assert body["success"] is True and body["message"] == "Remark saved."
    remark = body["data"]["remark"]
    assert remark["text"] == "Spokes here are 13G, not 12G"
    assert remark["byName"] == "ERP Test User" and remark["at"]
    assert body["data"]["summary"]["remarked"] == 1

    data = _checklist(erp_client, lot_id)
    assert _row(data, SPOKE)["remark"]["text"] == "Spokes here are 13G, not 12G"
    assert _row(data, TAPE)["remark"] is None
    assert data["summary"]["remarked"] == 1
    # A note is not a check: the lot has not started, and nothing is ticked.
    assert data["lot"]["status"] == "Pending"
    assert data["inspection"]["stage"] == "not_started"

    lots = {r["rowIdx"]: r for r in _ok(_rpc(erp_client, "getInspectionLots"))["data"]}
    assert lots[lot_id]["inspection"]["summary"]["remarked"] == 1


def test_an_empty_remark_takes_it_off_and_a_long_one_is_cut(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    _remark(erp_client, lot_id, SPOKE, "x" * 600)
    assert len(_row(_checklist(erp_client, lot_id), SPOKE)["remark"]["text"]) == 500

    body = _remark(erp_client, lot_id, SPOKE, "   ")
    assert body["success"] is True and body["message"] == "Remark removed."
    assert body["data"]["remark"] is None
    assert _checklist(erp_client, lot_id)["summary"]["remarked"] == 0


def test_a_remark_stays_through_ticks_and_an_admins_change(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    _remark(erp_client, lot_id, SPOKE, "Should be 45")
    ticked = _tick(erp_client, lot_id, SPOKE)
    assert ticked["data"]["item"]["remark"]["text"] == "Should be 45"

    revised = [dict(COMPONENTS[0], qty=45), *COMPONENTS[1:]]
    _set_consumed(erp_app, lot_id, revised)
    spoke = _row(_checklist(erp_client, lot_id), SPOKE)
    assert spoke["state"] == "revised" and spoke["previous"]["qty"] == 50
    assert spoke["remark"]["text"] == "Should be 45"


def test_a_remark_needs_its_row_on_the_sheet_and_an_open_inspection(
    erp_app, erp_client
):
    lot_id = _insert_lot(erp_app)
    gone = _remark(erp_client, lot_id, "bell||", "Missing")
    assert gone["success"] is False and "no longer on this lot" in gone["message"]

    _remark(erp_client, lot_id, TAPE, "Cloth, not PVC")
    for item in _checklist(erp_client, lot_id)["items"]:
        _tick(erp_client, lot_id, item["key"])
    assert _ok(_rpc(erp_client, "clearInspection", [lot_id], mutation=True))["data"][
        "cleared"
    ]

    late = _remark(erp_client, lot_id, TAPE, "Changed my mind")
    assert late["success"] is False and "already been cleared" in late["message"]
    kept = _checklist(erp_client, lot_id)
    assert _row(kept, TAPE)["remark"]["text"] == "Cloth, not PVC"


# ── Review and clearing ───────────────────────────────────────────────────


def test_item_remarks_are_enough_to_ask_for_a_review(erp_app, erp_client):
    lot_id = _insert_lot(erp_app)
    _remark(erp_client, lot_id, TAPE, "Only 55 on the shelf")
    body = _ok(
        _rpc(erp_client, "setInspectionReview", [lot_id, True, ""], mutation=True)
    )
    assert body["data"]["stage"] == "needs_review"
    assert body["data"]["summary"]["remarked"] == 1


def test_the_admin_sees_each_items_remark_before_clearing_and_it_is_kept(
    erp_app, erp_client, erp_admin_client
):
    lot_id = _insert_lot(erp_app)
    _remark(erp_client, lot_id, TAPE, "Only 55 on the shelf")
    _tick(erp_client, lot_id, SPOKE)

    shown = _ok(_rpc(erp_admin_client, "clearInspection", [lot_id], mutation=True))
    by_item = {d["itemName"]: d for d in shown["data"]["discrepancies"]}
    assert by_item["Rim Tape"]["kind"] == "unchecked"
    assert by_item["Rim Tape"]["remark"] == "Only 55 on the shelf"
    assert "remark" not in by_item["Nipple"]

    done = _ok(
        _rpc(
            erp_admin_client,
            "clearInspection",
            [lot_id, shown["data"]["token"]],
            mutation=True,
        )
    )
    accepted = {d["itemName"]: d for d in done["data"]["acknowledged"]}
    assert accepted["Rim Tape"]["remark"] == "Only 55 on the shelf"
    data = _checklist(erp_client, lot_id)
    assert data["inspection"]["stage"] == "cleared"
    assert _row(data, TAPE)["remark"]["text"] == "Only 55 on the shelf"


# ── Permission ────────────────────────────────────────────────────────────


@pytest.fixture
def viewer_client(erp_app):
    """A logged-in client whose custom role may only view Inspection."""
    name = f"Insp Viewer {uuid.uuid4().hex[:8]}"
    key = roles_service._slugify(name)
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "INSERT INTO custom_roles (role_key, role_name, permissions) VALUES (%s, %s, %s)",
                (key, name, psycopg2.extras.Json({"inspectionTab": "viewer"})),
            )
            cur.execute(
                "INSERT INTO users (name, email, password_hash, role) VALUES (%s, %s, 'x', %s) RETURNING user_id",
                (name, f"{key}@example.invalid", key),
            )
            user_id = cur.fetchone()[0]
    client = erp_app.test_client()
    with client.session_transaction() as sess:
        sess["_user_id"] = str(user_id)
        sess["_fresh"] = True
    yield client
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute("DELETE FROM users WHERE role = %s", (key,))
            cur.execute("DELETE FROM custom_roles WHERE role_key = %s", (key,))


def test_only_someone_who_can_inspect_writes_a_remark(erp_app, viewer_client):
    lot_id = _insert_lot(erp_app)
    resp = _rpc(
        viewer_client,
        "setInspectionItemRemark",
        [lot_id, SPOKE, "Looks thin"],
        mutation=True,
    )
    assert resp.status_code == 403
