"""A photo for each Warehouse Pool item and colour (asked 2026-11-02 and
2026-11-24).

The inspection checklist offered a camera on a pool row (a painted frame, a
fitted rim) only when its name and size happened to match an Items Master
item. Now every pool row offers one, and the photo belongs to the pool item
(erp.pool_item_photos, migration 058) in one colour (migration 060: "every
processed item is supposed to have different image for its different color
combinations"): the colour of the bucket the row draws on, the same photo on
every lot's checklist and on that bucket in the Warehouse Pool screens,
served at /erp/pool-photo/<id>. A colour with none shows none -- never
another colour's.
"""

from __future__ import annotations

import base64
import uuid

import psycopg2.extras
import pytest

import database
from app.erp.services import roles_service

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
PNG_URL = f"data:image/png;base64,{PNG}"
JPEG_URL = (
    "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0fake-jpeg").decode()
)


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _ok(resp) -> dict:
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body


def _save_process(client, output_name):
    payload = {
        "processName": f"Painting {uuid.uuid4().hex[:8]}",
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": output_name,
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    body = _ok(_rpc(client, "saveProcess", [payload], mutation=True))
    return payload, body["data"]["processId"]


def _lot(app, components) -> int:
    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                """
                INSERT INTO erp.production (production_date, qty, assigned_to, status, process_id,
                                            lot_number, components_consumed)
                VALUES (CURRENT_DATE, 10, 'Contractor P', 'In Progress', 'PRC-POOLPHOTO', %s, %s)
                RETURNING id
                """,
                (
                    f"LOT-POOLPHOTO-{uuid.uuid4().hex[:8].upper()}",
                    psycopg2.extras.Json(components),
                ),
            )
            return cur.fetchone()[0]


def _component(name, size="", source="POOL", color_group="COMMON"):
    return {
        "itemName": name,
        "size": size,
        "qty": 10,
        "sourceType": source,
        "colorGroup": color_group,
    }


def _rows(client, lot_id) -> list:
    return _ok(_rpc(client, "getInspection", [lot_id]))["data"]["items"]


def _photo_rows(app, name) -> list:
    with app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            _conn,
            cur,
        ):
            cur.execute(
                "SELECT id, output_item_name, color, image, row_version "
                "FROM erp.pool_item_photos WHERE lower(output_item_name) = lower(%s) "
                "ORDER BY lower(color)",
                (name,),
            )
            return [dict(r) for r in cur.fetchall()]


def _listed(client) -> dict:
    """getPoolItemPhotos as {(name, colour): address}."""
    return {
        (p["outputItemName"], p["color"]): p["photoUrl"]
        for p in _ok(_rpc(client, "getPoolItemPhotos"))["data"]
    }


def _url(stored) -> str:
    return f"/erp/pool-photo/{stored['id']}?v={stored['row_version']}"


def _frame():
    return f"Painted Frame {uuid.uuid4().hex[:6]}"


@pytest.fixture
def role_client(erp_app):
    """A logged-in client whose user holds a fresh custom role."""
    made = []

    def _make(permissions):
        name = f"Pool Photo Role {uuid.uuid4().hex[:8]}"
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
        return client

    yield _make
    with erp_app.app_context():
        for key in made:
            with database.get_conn() as (_conn, cur):
                # A photo they saved names them; the role goes, the user stays.
                cur.execute("UPDATE users SET role = 'user' WHERE role = %s", (key,))
                cur.execute("DELETE FROM custom_roles WHERE role_key = %s", (key,))


# ── Every pool row on the checklist offers the camera ────────────────────


def test_every_pool_row_can_take_a_photo_with_no_items_master_item(erp_app, erp_client):
    frame = _frame()
    lot_id = _lot(
        erp_app,
        [_component(frame, color_group="Red"), _component(frame, color_group="Blue")],
    )
    rows = _rows(erp_client, lot_id)
    assert len(rows) == 2
    for row in rows:
        assert row["photoSource"] == "pool"
        assert row["canSetPhoto"] is True
        assert row["photoUrl"] == ""
    assert {r["photoColor"] for r in rows} == {"Red", "Blue"}


def test_a_pool_photo_from_one_row_shows_on_that_colour_in_every_lot_only(
    erp_app, erp_client
):
    frame = _frame()
    lot_id = _lot(
        erp_app,
        [_component(frame, color_group="Red"), _component(frame, color_group="Blue")],
    )
    other_lot = _lot(
        erp_app,
        [
            _component(frame, "20 inch", color_group="red"),
            _component(frame, "20 inch", color_group="Black"),
        ],
    )
    red = next(r for r in _rows(erp_client, lot_id) if r["color"] == "Red")

    body = _ok(
        _rpc(
            erp_client,
            "setInspectionItemPhoto",
            [lot_id, red["key"], JPEG_URL],
            mutation=True,
        )
    )
    [stored] = _photo_rows(erp_app, frame)
    url = _url(stored)
    assert stored["image"] == JPEG_URL
    assert stored["color"] == "Red"
    assert body["data"]["photoSource"] == "pool"
    assert body["data"]["photoColor"] == "Red"
    assert body["data"]["photoUrl"] == url
    assert body["message"] == f"Photo saved for {frame} · Red."

    by_color = {r["color"]: r["photoUrl"] for r in _rows(erp_client, lot_id)}
    assert by_color == {"Red": url, "Blue": ""}
    # Another lot and a size: the Red photo on its red row, none on Black.
    by_color = {r["color"]: r["photoUrl"] for r in _rows(erp_client, other_lot)}
    assert by_color == {"red": url, "Black": ""}
    # The Warehouse Pool lists it under its colour.
    assert _listed(erp_client).get((frame, "Red")) == url

    served = erp_client.get(url)
    assert served.status_code == 200
    assert served.mimetype == "image/jpeg"
    assert served.headers["Cache-Control"] == "private, max-age=31536000, immutable"
    assert served.headers["X-Content-Type-Options"] == "nosniff"


def test_a_pool_row_named_like_an_items_master_item_keeps_to_the_pool(
    erp_app, erp_client
):
    """What made the camera seem random: a pool row whose name and size
    matched an Items Master item got that item's camera. It is the pool
    item's photo now, and the Items Master item's own photo is left alone."""
    frame = _frame()
    _ok(
        _rpc(
            erp_client,
            "saveItem",
            [{"itemName": frame, "itemSize": "", "itemImage": PNG_URL}],
            mutation=True,
        )
    )
    lot_id = _lot(erp_app, [_component(frame, color_group="Red")])
    [row] = _rows(erp_client, lot_id)
    assert row["photoSource"] == "pool"
    assert row["photoUrl"] == ""  # not the Items Master item's photo

    _ok(
        _rpc(
            erp_client,
            "setInspectionItemPhoto",
            [lot_id, row["key"], JPEG_URL],
            mutation=True,
        )
    )
    assert _photo_rows(erp_app, frame)[0]["image"] == JPEG_URL
    # The Items Master item keeps its own photo (listed by its address).
    items = _ok(_rpc(erp_client, "getItemsData"))["data"]
    listed = next(i for i in items if i["name"] == frame)["image"]
    assert listed.startswith("/erp/item-photo/")
    assert erp_client.get(listed).data == base64.b64decode(PNG_URL.partition(",")[2])


def test_a_saved_sheet_row_the_pool_knows_is_a_pool_row(erp_app, erp_client):
    """A row the saved sheet added on its own, with no recorded component to
    name its source, is a pool item when it is some Process's Output Item."""
    frame = _frame()
    _save_process(erp_client, frame)
    lot_id = _lot(erp_app, [])
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "UPDATE erp.production SET custom_components = %s WHERE id = %s",
                (
                    psycopg2.extras.Json(
                        [{"itemName": frame, "size": "", "qty": 4, "colorGroup": "Red"}]
                    ),
                    lot_id,
                ),
            )
    [row] = _rows(erp_client, lot_id)
    assert row["photoSource"] == "pool"
    assert row["canSetPhoto"] is True


def test_a_tick_keeps_a_pool_rows_photo(erp_app, erp_client):
    frame = _frame()
    lot_id = _lot(erp_app, [_component(frame, color_group="Red")])
    [row] = _rows(erp_client, lot_id)
    _ok(
        _rpc(
            erp_client,
            "setInspectionItemPhoto",
            [lot_id, row["key"], JPEG_URL],
            mutation=True,
        )
    )
    [row] = _rows(erp_client, lot_id)
    body = _ok(
        _rpc(
            erp_client,
            "setInspectionCheck",
            [lot_id, row["key"], "checked", row["fingerprint"]],
            mutation=True,
        )
    )
    assert body["data"]["item"]["photoSource"] == "pool"
    assert body["data"]["item"]["photoUrl"] == row["photoUrl"]


def test_a_row_neither_ledger_knows_is_still_refused(erp_app, erp_client):
    ghost = f"Ghost-{uuid.uuid4().hex[:6]}"
    lot_id = _lot(erp_app, [_component(ghost, source="ITEM")])
    [row] = _rows(erp_client, lot_id)
    assert row["canSetPhoto"] is False
    refused = _rpc(
        erp_client,
        "setInspectionItemPhoto",
        [lot_id, row["key"], JPEG_URL],
        mutation=True,
    ).get_json()
    assert refused["success"] is False
    assert refused["message"] == (
        f"{ghost} is not in Items Master, so there is no item to put a photo on."
    )
    assert _photo_rows(erp_app, ghost) == []


# ── The Warehouse Pool screens ──────────────────────────────────────────


def test_the_warehouse_pool_adds_lists_and_replaces_a_colours_photo(
    erp_app, erp_client
):
    frame = _frame()
    _save_process(erp_client, frame)

    first = _ok(
        _rpc(
            erp_client,
            "setPoolItemPhoto",
            [frame.upper(), PNG_URL, " Red-White "],
            mutation=True,
        )
    )
    assert first["data"]["outputItemName"] == frame  # as the pool spells it
    assert first["data"]["color"] == "Red-White"
    assert first["message"] == f"Photo saved for {frame} · Red-White."
    assert _listed(erp_client)[(frame, "Red-White")] == first["data"]["photoUrl"]

    # The same colour, spelt another way, is replaced in place.
    second = _ok(
        _rpc(
            erp_client,
            "setPoolItemPhoto",
            [frame, JPEG_URL, "red-white"],
            mutation=True,
        )
    )
    assert second["data"]["photoUrl"] != first["data"]["photoUrl"]
    assert [r["color"] for r in _photo_rows(erp_app, frame)] == ["Red-White"]
    assert erp_client.get(second["data"]["photoUrl"]).mimetype == "image/jpeg"

    # Another colour is a photo of its own; the first keeps its.
    black = _ok(
        _rpc(erp_client, "setPoolItemPhoto", [frame, PNG_URL, "Black"], mutation=True)
    )
    listed = _listed(erp_client)
    assert listed[(frame, "Red-White")] == second["data"]["photoUrl"]
    assert listed[(frame, "Black")] == black["data"]["photoUrl"]

    # The checklist shows each colour's photo on the rows drawing on it.
    lot_id = _lot(
        erp_app,
        [
            _component(frame, color_group="Red-White"),
            _component(frame, color_group="Black"),
            _component(frame, color_group="Blue"),
        ],
    )
    by_color = {r["color"]: r["photoUrl"] for r in _rows(erp_client, lot_id)}
    assert by_color == {
        "Red-White": second["data"]["photoUrl"],
        "Black": black["data"]["photoUrl"],
        "Blue": "",
    }


def test_no_colour_is_the_items_own_photo_shown_only_for_no_colour(erp_app, erp_client):
    """Two arguments, as migration 058's screens send them, set the item's
    photo with no colour: the one a COMMON row (every colour) shows. It is
    not shown for a colour that has none of its own."""
    frame = _frame()
    _save_process(erp_client, frame)
    body = _ok(_rpc(erp_client, "setPoolItemPhoto", [frame, PNG_URL], mutation=True))
    assert body["data"]["color"] == ""
    assert body["message"] == f"Photo saved for {frame}."

    lot_id = _lot(
        erp_app,
        [_component(frame, color_group="COMMON"), _component(frame, color_group="Red")],
    )
    rows = _rows(erp_client, lot_id)
    common = next(r for r in rows if r["photoColor"] == "")
    red = next(r for r in rows if r["photoColor"] == "Red")
    assert common["photoUrl"] == body["data"]["photoUrl"]
    assert red["photoUrl"] == ""


def test_a_row_drawing_on_another_colours_bucket_shows_that_colours_photo(
    erp_app, erp_client
):
    """A Blue mudguard fitted to a Purple-Wine lot: its colorGroup is the
    lot's colour, its poolColor the bucket it comes out of. The photo is the
    bucket's, as the stock on hand beside it is."""
    frame = _frame()
    _save_process(erp_client, frame)
    blue = _ok(
        _rpc(erp_client, "setPoolItemPhoto", [frame, JPEG_URL, "Blue"], mutation=True)
    )["data"]["photoUrl"]
    lot_id = _lot(
        erp_app,
        [dict(_component(frame, color_group="Purple-Wine"), poolColor="Blue")],
    )
    [row] = _rows(erp_client, lot_id)
    assert row["photoColor"] == "Blue"
    assert row["photoUrl"] == blue

    # A new photo from that row goes on the Blue bucket, not on Purple-Wine.
    _ok(
        _rpc(
            erp_client,
            "setInspectionItemPhoto",
            [lot_id, row["key"], PNG_URL],
            mutation=True,
        )
    )
    [stored] = _photo_rows(erp_app, frame)
    assert (stored["color"], stored["image"]) == ("Blue", PNG_URL)


def test_a_bucket_with_no_process_is_still_a_pool_item(erp_app, erp_client):
    frame = _frame()
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "INSERT INTO erp.warehouse_pool "
                "(output_item_name, process_id, produced_qty, consumed_qty, available_qty, color) "
                "VALUES (%s, 'PRC-GONE', 3, 0, 3, 'Red')",
                (frame,),
            )
    _ok(_rpc(erp_client, "setPoolItemPhoto", [frame, PNG_URL], mutation=True))
    assert len(_photo_rows(erp_app, frame)) == 1


def test_the_warehouse_pool_refuses_what_is_not_a_pool_item_or_a_photo(
    erp_app, erp_client
):
    stranger = f"Nobody Makes This {uuid.uuid4().hex[:6]}"
    refused = _rpc(
        erp_client, "setPoolItemPhoto", [stranger, PNG_URL], mutation=True
    ).get_json()
    assert refused["success"] is False
    assert refused["message"] == (
        f"{stranger} is not an Output Item of any Process, so it is not a "
        "Warehouse Pool item."
    )

    frame = _frame()
    _save_process(erp_client, frame)
    for image in ("", "not a photo", "data:image/svg+xml;base64,PHN2Zz4="):
        bad = _rpc(
            erp_client, "setPoolItemPhoto", [frame, image, "Red"], mutation=True
        ).get_json()
        assert bad["success"] is False, image
    too_long = _rpc(
        erp_client, "setPoolItemPhoto", [frame, PNG_URL, "R" * 256], mutation=True
    ).get_json()
    assert too_long["success"] is False
    assert _photo_rows(erp_app, frame) == []


def test_pool_photos_are_not_served_to_the_signed_out_or_when_missing(
    erp_app, erp_client
):
    frame = _frame()
    _save_process(erp_client, frame)
    url = _ok(_rpc(erp_client, "setPoolItemPhoto", [frame, PNG_URL], mutation=True))[
        "data"
    ]["photoUrl"]
    assert erp_app.test_client().get(url).status_code in (302, 401)
    assert erp_client.get("/erp/pool-photo/999999999").status_code == 404


# ── Who may set one ─────────────────────────────────────────────────────


def test_an_inspector_sets_pool_photos_from_the_checklist_only(erp_app, role_client):
    frame = _frame()
    lot_id = _lot(erp_app, [_component(frame, color_group="Red")])
    inspector = role_client({"inspectionTab": "editor"})
    [row] = _rows(inspector, lot_id)
    _ok(
        _rpc(
            inspector,
            "setInspectionItemPhoto",
            [lot_id, row["key"], JPEG_URL],
            mutation=True,
        )
    )
    # The Warehouse Pool's own route is the Stock page's to grant.
    assert (
        _rpc(inspector, "setPoolItemPhoto", [frame, PNG_URL], mutation=True).status_code
        == 403
    )
    viewer = role_client({"stockTab": "viewer"})
    assert _rpc(viewer, "getPoolItemPhotos").status_code == 200
    assert (
        _rpc(viewer, "setPoolItemPhoto", [frame, PNG_URL], mutation=True).status_code
        == 403
    )


# ── A renamed Output Item keeps its photo ───────────────────────────────


def test_renaming_the_output_item_carries_its_photos(erp_client):
    old, new = _frame(), _frame()
    payload, process_id = _save_process(erp_client, old)
    plain = _ok(_rpc(erp_client, "setPoolItemPhoto", [old, PNG_URL], mutation=True))[
        "data"
    ]["photoUrl"]
    red = _ok(
        _rpc(erp_client, "setPoolItemPhoto", [old, JPEG_URL, "Red"], mutation=True)
    )["data"]["photoUrl"]

    edit = dict(payload, processId=process_id, outputItemName=new)
    _ok(_rpc(erp_client, "saveProcess", [edit], mutation=True))

    listed = _listed(erp_client)
    assert not [key for key in listed if key[0] == old]
    assert listed[(new, "")].split("?")[0] == plain.split("?")[0]
    assert listed[(new, "Red")].split("?")[0] == red.split("?")[0]


def test_renaming_onto_a_name_with_its_own_photo_keeps_that_one(erp_app, erp_client):
    old, new = _frame(), _frame()
    payload, process_id = _save_process(erp_client, old)
    # `new` is a pool item by a bucket alone: two active Processes may not
    # share an Output Item Name.
    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "INSERT INTO erp.warehouse_pool "
                "(output_item_name, process_id, produced_qty, consumed_qty, available_qty, color) "
                "VALUES (%s, 'PRC-RETIRED', 2, 0, 2, '')",
                (new,),
            )
    _ok(_rpc(erp_client, "setPoolItemPhoto", [old, PNG_URL, "Red"], mutation=True))
    _ok(_rpc(erp_client, "setPoolItemPhoto", [old, PNG_URL, "Blue"], mutation=True))
    _ok(_rpc(erp_client, "setPoolItemPhoto", [new, JPEG_URL, "red"], mutation=True))

    edit = dict(payload, processId=process_id, outputItemName=new)
    _ok(_rpc(erp_client, "saveProcess", [edit], mutation=True))

    assert _photo_rows(erp_app, old) == []
    # Red: the new name's own stays. Blue: the old name's carries over.
    kept = {r["color"].lower(): r["image"] for r in _photo_rows(erp_app, new)}
    assert kept == {"red": JPEG_URL, "blue": PNG_URL}


# ── A renamed colour keeps its photo ────────────────────────────────────


def test_renaming_a_colour_carries_its_photo(erp_client):
    """Color Master renames every bucket of the colour, alone or inside a
    combination; each bucket's photo goes with it."""
    frame = _frame()
    _save_process(erp_client, frame)
    old = f"Shade {uuid.uuid4().hex[:6]}"
    new = f"Shade {uuid.uuid4().hex[:6]}"
    _ok(_rpc(erp_client, "saveColor", [{"name": old}], mutation=True))
    alone = _ok(
        _rpc(erp_client, "setPoolItemPhoto", [frame, PNG_URL, old], mutation=True)
    )["data"]["photoUrl"]
    combo = _ok(
        _rpc(
            erp_client,
            "setPoolItemPhoto",
            [frame, JPEG_URL, f"{old} / Black"],
            mutation=True,
        )
    )["data"]["photoUrl"]

    _ok(
        _rpc(
            erp_client,
            "saveColor",
            [{"name": new, "originalName": old}],
            mutation=True,
        )
    )

    listed = _listed(erp_client)
    assert listed[(frame, new)].split("?")[0] == alone.split("?")[0]
    assert listed[(frame, f"{new} / Black")].split("?")[0] == combo.split("?")[0]
    assert (frame, old) not in listed
