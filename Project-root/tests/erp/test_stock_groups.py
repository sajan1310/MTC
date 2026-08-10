"""Stock Groups RPC tests -- user-defined named collections of item/size
rows used to print the Low Stock Report group-wise (see
app/erp/services/stock_group_service.py)."""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _create_group(client, name: str, remarks: str = ""):
    resp = _rpc(client, "saveStockGroup", [{"name": name, "remarks": remarks}], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body
    return body["data"]["id"]


def test_get_stock_groups_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getStockGroupsData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_stock_group_creates_and_lists(erp_client):
    name = _unique_name("Stickers")
    group_id = _create_group(erp_client, name, remarks="temp")

    listed = _rpc(erp_client, "getStockGroupsData").get_json()["data"]
    match = next(g for g in listed if g["id"] == group_id)
    assert match["name"] == name
    assert match["remarks"] == "temp"
    assert match["items"] == []


def test_save_stock_group_rejects_duplicate_name(erp_client):
    name = _unique_name("Bolts")
    _create_group(erp_client, name)

    resp = _rpc(erp_client, "saveStockGroup", [{"name": name}], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_save_stock_group_edit_renames(erp_client):
    name = _unique_name("Frames")
    group_id = _create_group(erp_client, name)

    new_name = _unique_name("Frames-Renamed")
    resp = _rpc(erp_client, "saveStockGroup", [{"id": group_id, "name": new_name}], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getStockGroupsData").get_json()["data"]
    match = next(g for g in listed if g["id"] == group_id)
    assert match["name"] == new_name


def test_set_stock_group_items_bulk_replaces_membership(erp_client):
    group_id = _create_group(erp_client, _unique_name("Mudguards"))

    items = [{"name": "Mudguard Bolt", "size": "26 inch"}, {"name": "Mudguard Bolt", "size": "20 inch"}]
    resp = _rpc(erp_client, "setStockGroupItems", [{"groupId": group_id, "items": items}], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["count"] == 2

    listed = _rpc(erp_client, "getStockGroupsData").get_json()["data"]
    match = next(g for g in listed if g["id"] == group_id)
    sizes = sorted(i["size"] for i in match["items"])
    assert sizes == ["20 inch", "26 inch"]

    # A second call fully replaces the set rather than appending to it.
    resp2 = _rpc(
        erp_client,
        "setStockGroupItems",
        [{"groupId": group_id, "items": [{"name": "Mudguard Bolt", "size": "26 inch"}]}],
        mutation=True,
    )
    assert resp2.get_json()["data"]["count"] == 1

    listed2 = _rpc(erp_client, "getStockGroupsData").get_json()["data"]
    match2 = next(g for g in listed2 if g["id"] == group_id)
    assert [i["size"] for i in match2["items"]] == ["26 inch"]


def test_set_stock_group_items_deduplicates_case_insensitively(erp_client):
    group_id = _create_group(erp_client, _unique_name("Dedup"))

    items = [
        {"name": "Widget", "size": "Large"},
        {"name": "widget", "size": "large"},
        {"name": "Widget", "size": "Large"},
    ]
    resp = _rpc(erp_client, "setStockGroupItems", [{"groupId": group_id, "items": items}], mutation=True)
    assert resp.get_json()["data"]["count"] == 1


def test_delete_stock_group_removes_group_and_its_items(erp_client):
    group_id = _create_group(erp_client, _unique_name("ToDelete"))
    _rpc(
        erp_client,
        "setStockGroupItems",
        [{"groupId": group_id, "items": [{"name": "Widget", "size": ""}]}],
        mutation=True,
    )

    resp = _rpc(erp_client, "deleteStockGroup", [group_id], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getStockGroupsData").get_json()["data"]
    assert all(g["id"] != group_id for g in listed)

    # Re-adding items to the now-deleted group should fail cleanly.
    resp2 = _rpc(
        erp_client,
        "setStockGroupItems",
        [{"groupId": group_id, "items": [{"name": "Widget", "size": ""}]}],
        mutation=True,
    )
    assert resp2.get_json()["success"] is False
