"""How photos reach the browser (asked 2026-11-24: "images are bulky, it
might slow down the loading of the application").

Between 17 and 23/11/2026, 657 of 890 photo fetches were the browser asking
again for a photo it had been told to keep for a year, because every answer
said "Vary: Cookie" and a remembered login's cookie changes with every
click. And every list downloaded the whole 800 px photo to show it at
32-48 px. Now a photo response leaves the session alone, a browser holding
the current version is answered from the version alone, and lists get a
192 px copy.
"""

from __future__ import annotations

import base64
import io
import uuid

import pytest

from app.erp.services import items_service

PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _item_with_photo(client, data_url):
    name = f"Photo Item {uuid.uuid4().hex[:8]}"
    body = _rpc(
        client,
        "saveItem",
        [{"itemName": name, "itemSize": "", "itemImage": data_url}],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]
    items = _rpc(client, "getItemsData").get_json()["data"]
    return next(i for i in items if i["name"] == name)["image"]


def _jpeg(width, height):
    image_mod = pytest.importorskip("PIL.Image")
    out = io.BytesIO()
    image_mod.new("RGB", (width, height), (180, 40, 40)).save(out, "JPEG", quality=90)
    return "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode()


def test_a_photo_answer_leaves_a_remembered_session_alone(erp_client):
    url = _item_with_photo(erp_client, f"data:image/png;base64,{PNG}")
    with erp_client.session_transaction() as sess:
        sess.permanent = True  # "Remember me": refreshed on every request

    served = erp_client.get(url)
    assert served.status_code == 200
    assert "cookie" not in served.headers.get("Vary", "").lower()
    assert "Set-Cookie" not in served.headers
    assert served.headers["Cache-Control"] == "private, max-age=31536000, immutable"

    # Every other request still refreshes it.
    listed = _rpc(erp_client, "getItemsData")
    assert "Set-Cookie" in listed.headers


def test_a_browser_holding_the_photo_is_answered_without_reading_it(
    erp_client, monkeypatch
):
    url = _item_with_photo(erp_client, f"data:image/png;base64,{PNG}")
    first = erp_client.get(url)
    etag = first.headers["ETag"]

    def unread(_item_id):
        raise AssertionError("the photo was read to answer 304")

    monkeypatch.setattr(items_service, "get_item_photo", unread)
    again = erp_client.get(url, headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.headers["ETag"] == etag
    assert again.headers["Cache-Control"] == "private, max-age=31536000, immutable"
    assert "cookie" not in again.headers.get("Vary", "").lower()


def test_an_address_naming_an_older_version_is_checked_every_time(erp_client):
    url = _item_with_photo(erp_client, f"data:image/png;base64,{PNG}")
    stale = url.split("?")[0] + "?v=1"
    served = erp_client.get(stale)
    assert served.status_code == 200
    assert served.headers["Cache-Control"] == "private, no-cache"


def test_a_list_gets_a_small_copy_and_the_viewer_the_whole_photo(erp_client):
    pytest.importorskip("PIL")
    from PIL import Image

    url = _item_with_photo(erp_client, _jpeg(800, 600))
    whole = erp_client.get(url)
    thumb = erp_client.get(f"{url}&size=thumb")

    assert whole.status_code == thumb.status_code == 200
    assert Image.open(io.BytesIO(whole.data)).size == (800, 600)
    small = Image.open(io.BytesIO(thumb.data))
    assert max(small.size) == items_service.THUMB_PX
    assert small.size == (192, 144)
    assert thumb.mimetype == "image/jpeg"
    assert len(thumb.data) < len(whole.data) / 3
    assert thumb.headers["ETag"] != whole.headers["ETag"]
    assert thumb.headers["Cache-Control"] == "private, max-age=31536000, immutable"

    again = erp_client.get(
        f"{url}&size=thumb", headers={"If-None-Match": thumb.headers["ETag"]}
    )
    assert again.status_code == 304


def test_a_photo_already_small_or_unreadable_is_sent_as_it_is():
    tiny = base64.b64decode(PNG)
    assert items_service.photo_thumbnail(("t", 1, "1"), "image/png", tiny) == (
        "image/png",
        tiny,
    )
    junk = b"\xff\xd8 not really a jpeg"
    assert items_service.photo_thumbnail(("t", 2, "1"), "image/jpeg", junk) == (
        "image/jpeg",
        junk,
    )


def test_a_pool_photo_has_a_small_copy_too(erp_client):
    pytest.importorskip("PIL")
    from PIL import Image

    process = {
        "processName": f"Painting {uuid.uuid4().hex[:8]}",
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": f"Painted Frame {uuid.uuid4().hex[:6]}",
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    assert _rpc(erp_client, "saveProcess", [process], mutation=True).get_json()[
        "success"
    ]
    saved = _rpc(
        erp_client,
        "setPoolItemPhoto",
        [process["outputItemName"], _jpeg(600, 800), "Red"],
        mutation=True,
    ).get_json()
    assert saved["success"] is True, saved["message"]
    url = saved["data"]["photoUrl"]

    thumb = erp_client.get(f"{url}&size=thumb")
    assert thumb.status_code == 200
    assert Image.open(io.BytesIO(thumb.data)).size == (144, 192)
    assert "Set-Cookie" not in thumb.headers
