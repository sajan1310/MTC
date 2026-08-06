"""Unit Master RPC tests, ported behavior from Apps_Script/module_units.js."""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_get_units_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getUnitsData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_save_unit_creates_and_lists_it(erp_client):
    name = _unique_name("Gross")
    resp = _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": name, "family": "Count", "factorToBase": 144, "remarks": "12 dozen"}],
        mutation=True,
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["unitName"] == name

    listed = _rpc(erp_client, "getUnitsData").get_json()
    names = [u["unitName"] for u in listed["data"]]
    assert name in names


def test_save_unit_rejects_case_insensitive_duplicate(erp_client):
    name = _unique_name("Dozen")
    first = _rpc(erp_client, "saveUnit", [{"unitName": name, "family": "Count", "factorToBase": 12}], mutation=True)
    assert first.get_json()["success"] is True

    dupe = _rpc(
        erp_client, "saveUnit", [{"unitName": name.upper(), "family": "Count", "factorToBase": 12}], mutation=True
    )
    body = dupe.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_save_unit_rename_via_original_unit_name(erp_client):
    original = _unique_name("Box")
    renamed = _unique_name("Carton")

    create = _rpc(erp_client, "saveUnit", [{"unitName": original, "family": "Count", "factorToBase": 50}], mutation=True)
    assert create.get_json()["success"] is True

    edit = _rpc(
        erp_client,
        "saveUnit",
        [{"unitName": renamed, "family": "Count", "factorToBase": 50, "originalUnitName": original}],
        mutation=True,
    )
    body = edit.get_json()
    assert body["success"] is True
    assert body["data"]["unitName"] == renamed

    listed = _rpc(erp_client, "getUnitsData").get_json()["data"]
    names = [u["unitName"] for u in listed]
    assert renamed in names
    assert original not in names


def test_delete_unit_soft_deletes(erp_client):
    name = _unique_name("Pallet")
    _rpc(erp_client, "saveUnit", [{"unitName": name, "family": "Count", "factorToBase": 200}], mutation=True)

    deleted = _rpc(erp_client, "deleteUnit", [name], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getUnitsData").get_json()["data"]
    names = [u["unitName"] for u in listed]
    assert name not in names

    missing = _rpc(erp_client, "deleteUnit", [name], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_units_bulk_soft_deletes_multiple(erp_client):
    name_a = _unique_name("Roll")
    name_b = _unique_name("Bundle")
    _rpc(erp_client, "saveUnit", [{"unitName": name_a, "family": "Count", "factorToBase": 1}], mutation=True)
    _rpc(erp_client, "saveUnit", [{"unitName": name_b, "family": "Count", "factorToBase": 1}], mutation=True)

    resp = _rpc(erp_client, "deleteUnitsBulk", [[name_a, name_b]], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "2" in body["message"]

    names = [u["unitName"] for u in _rpc(erp_client, "getUnitsData").get_json()["data"]]
    assert name_a not in names
    assert name_b not in names


def test_delete_units_bulk_no_selection_is_a_success_noop(erp_client):
    resp = _rpc(erp_client, "deleteUnitsBulk", [[]], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "No units selected" in body["message"]
