"""Item photos on the inspection checklist (asked 2026-10-29).

An inspector compares each material with its Items Master photo: every
checklist row carries the address of its item's photo (photoUrl), served by
/erp/item-photo/<id> only when the row is shown, and an inspector can add or
replace the photo from the checklist (setInspectionItemPhoto) -- without
needing to be able to edit Items Master.
"""

from __future__ import annotations

import base64
import uuid

import psycopg2.extras

import database

# A 1x1 PNG.
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


def _item(client, name, size="", image=""):
    _ok(
        _rpc(
            client,
            "saveItem",
            [{"itemName": name, "itemSize": size, "itemImage": image}],
            mutation=True,
        )
    )


def _item_row(app, name, size="") -> dict:
    with app.app_context():
        with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            _conn,
            cur,
        ):
            cur.execute(
                "SELECT id, image, row_version FROM erp.items WHERE deleted_at IS NULL "
                "AND lower(item_name) = lower(%s) AND lower(size) = lower(%s)",
                (name, size),
            )
            return dict(cur.fetchone())


def _lot(app, components) -> int:
    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                """
                INSERT INTO erp.production (production_date, qty, assigned_to, status, process_id,
                                            lot_number, components_consumed)
                VALUES (CURRENT_DATE, 10, 'Contractor P', 'In Progress', 'PRC-PHOTO', %s, %s)
                RETURNING id
                """,
                (
                    f"LOT-PHOTO-{uuid.uuid4().hex[:8].upper()}",
                    psycopg2.extras.Json(components),
                ),
            )
            return cur.fetchone()[0]


def _component(name, size="", source="ITEM", color_group="COMMON"):
    return {
        "itemName": name,
        "size": size,
        "qty": 10,
        "sourceType": source,
        "colorGroup": color_group,
    }


def _rows(client, lot_id) -> dict:
    items = _ok(_rpc(client, "getInspection", [lot_id]))["data"]["items"]
    return {i["itemName"]: i for i in items}


def _setup(erp_app, erp_client):
    name = uuid.uuid4().hex[:6]
    seat, rim, frame = f"Seat-{name}", f"Rim-{name}", f"Painted Frame {name}"
    _item(erp_client, seat, "20 inch", PNG_URL)
    _item(erp_client, rim, "20 inch")
    _item(erp_client, rim, "16 inch", PNG_URL)  # the wrong size has a photo
    lot_id = _lot(
        erp_app,
        [
            _component(seat, "20 inch"),
            _component(rim, "20 inch"),
            _component(frame, "", "POOL", "Red"),
        ],
    )
    return lot_id, seat, rim, frame


# ── The checklist says which rows have a photo ──────────────────────────


def test_each_row_carries_its_items_photo_address(erp_app, erp_client):
    lot_id, seat, rim, frame = _setup(erp_app, erp_client)
    rows = _rows(erp_client, lot_id)
    item = _item_row(erp_app, seat, "20 inch")

    assert (
        rows[seat]["photoUrl"]
        == f"/erp/item-photo/{item['id']}?v={item['row_version']}"
    )
    assert rows[seat]["canSetPhoto"] is True
    # The 16 inch rim's photo never stands in for the 20 inch row.
    assert rows[rim]["photoUrl"] == ""
    assert rows[rim]["canSetPhoto"] is True
    # A Warehouse Pool row has no Items Master item.
    assert rows[frame]["photoUrl"] == ""
    assert rows[frame]["canSetPhoto"] is False


# ── The photo by its own address ────────────────────────────────────────


def test_the_photo_is_served_as_an_image_kept_while_its_version_holds(
    erp_app, erp_client
):
    lot_id, seat, *_ = _setup(erp_app, erp_client)
    url = _rows(erp_client, lot_id)[seat]["photoUrl"]

    resp = erp_client.get(url)
    assert resp.status_code == 200
    assert resp.mimetype == "image/png"
    assert resp.data == base64.b64decode(PNG)
    assert resp.headers["Cache-Control"] == "private, max-age=31536000, immutable"
    assert resp.headers["X-Content-Type-Options"] == "nosniff"

    stale = erp_client.get(url.split("?")[0] + "?v=0")
    assert stale.headers["Cache-Control"] == "private, no-cache"
    again = erp_client.get(url, headers={"If-None-Match": stale.headers["ETag"]})
    assert again.status_code == 304


def test_no_photo_and_non_raster_photos_are_not_served(erp_app, erp_client):
    name = f"Svg-{uuid.uuid4().hex[:6]}"
    svg = (
        "data:image/svg+xml;base64,"
        + base64.b64encode(
            b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"
        ).decode()
    )
    _item(erp_client, name, "", svg)
    _item(erp_client, f"Bare-{name}")
    assert (
        erp_client.get(f"/erp/item-photo/{_item_row(erp_app, name)['id']}").status_code
        == 404
    )
    bare = _item_row(erp_app, f"Bare-{name}")["id"]
    assert erp_client.get(f"/erp/item-photo/{bare}").status_code == 404
    assert erp_client.get("/erp/item-photo/999999999").status_code == 404


def test_the_photo_needs_a_signed_in_approved_user(erp_app, erp_client):
    lot_id, seat, *_ = _setup(erp_app, erp_client)
    url = _rows(erp_client, lot_id)[seat]["photoUrl"]

    anonymous = erp_app.test_client().get(url)
    assert anonymous.status_code in (302, 401)

    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "INSERT INTO users (name, email, password_hash, role) VALUES (%s, %s, %s, "
                "'pending_approval') ON CONFLICT (email) DO UPDATE SET role = 'pending_approval' "
                "RETURNING user_id",
                ("Waiting", "photo-pending@example.invalid", "x"),
            )
            pending_id = cur.fetchone()[0]
    waiting = erp_app.test_client()
    with waiting.session_transaction() as sess:
        sess["_user_id"] = str(pending_id)
        sess["_fresh"] = True
    assert waiting.get(url).status_code == 403


# ── An inspector adds or changes the photo ──────────────────────────────


def test_an_inspector_adds_a_missing_photo_from_the_checklist(erp_app, erp_client):
    lot_id, _seat, rim, _frame = _setup(erp_app, erp_client)
    key = _rows(erp_client, lot_id)[rim]["key"]

    body = _ok(
        _rpc(
            erp_client, "setInspectionItemPhoto", [lot_id, key, JPEG_URL], mutation=True
        )
    )
    item = _item_row(erp_app, rim, "20 inch")
    assert item["image"] == JPEG_URL
    assert (
        body["data"]["photoUrl"]
        == f"/erp/item-photo/{item['id']}?v={item['row_version']}"
    )
    assert body["message"] == f"Photo saved for {rim} 20 inch."
    assert _rows(erp_client, lot_id)[rim]["photoUrl"] == body["data"]["photoUrl"]
    # Only that size: the 16 inch rim keeps its own photo.
    assert _item_row(erp_app, rim, "16 inch")["image"] == PNG_URL

    served = erp_client.get(body["data"]["photoUrl"])
    assert served.mimetype == "image/jpeg"


def test_changing_a_photo_gives_it_a_new_address(erp_app, erp_client):
    lot_id, seat, *_ = _setup(erp_app, erp_client)
    before = _rows(erp_client, lot_id)[seat]
    body = _ok(
        _rpc(
            erp_client,
            "setInspectionItemPhoto",
            [lot_id, before["key"], JPEG_URL],
            mutation=True,
        )
    )
    assert body["data"]["photoUrl"] != before["photoUrl"]


def test_what_cannot_be_photographed_is_refused(erp_app, erp_client):
    lot_id, seat, _rim, frame = _setup(erp_app, erp_client)
    rows = _rows(erp_client, lot_id)

    def attempt(key, image):
        return _rpc(
            erp_client, "setInspectionItemPhoto", [lot_id, key, image], mutation=True
        ).get_json()

    pool = attempt(rows[frame]["key"], JPEG_URL)
    assert pool["success"] is False
    assert pool["message"] == (
        f"{frame} is not in Items Master, so there is no item to put a photo on."
    )

    gone = attempt("not-on-the-sheet", JPEG_URL)
    assert gone["success"] is False
    assert "no longer on this lot's Production Sheet" in gone["message"]

    for image in ("", "not a photo", "data:image/svg+xml;base64,PHN2Zz4="):
        refused = attempt(rows[seat]["key"], image)
        assert refused["success"] is False, image
    assert _item_row(erp_app, seat, "20 inch")["image"] == PNG_URL


def test_a_tick_keeps_the_rows_photo(erp_app, erp_client):
    lot_id, seat, *_ = _setup(erp_app, erp_client)
    row = _rows(erp_client, lot_id)[seat]
    body = _ok(
        _rpc(
            erp_client,
            "setInspectionCheck",
            [lot_id, row["key"], "checked", row["fingerprint"]],
            mutation=True,
        )
    )
    assert body["data"]["item"]["photoUrl"] == row["photoUrl"]
