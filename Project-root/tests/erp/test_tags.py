"""Color/Model/Process Type master RPC tests, ported behavior from
Apps_Script/module_tags.js. All three share one code path server-side, so
the CRUD tests are parametrized across the 3 RPC method sets.
"""

from __future__ import annotations

import uuid

import pytest


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


TAG_TYPES = [
    ("getColors", "saveColor", "deleteColor", "Red"),
    ("getModels", "saveModel", "deleteModel", "Roadster"),
    ("getProcessTypes", "saveProcessType", "deleteProcessType", "Painting"),
]


@pytest.mark.parametrize("get_method,save_method,delete_method,prefix", TAG_TYPES)
def test_tag_create_list_rename_delete(erp_client, get_method, save_method, delete_method, prefix):
    original = _unique_name(prefix)
    renamed = _unique_name(prefix)

    created = _rpc(erp_client, save_method, [{"name": original, "remarks": "test"}], mutation=True)
    body = created.get_json()
    assert body["success"] is True
    assert body["data"]["name"] == original

    listed = _rpc(erp_client, get_method).get_json()["data"]
    assert original in [t["name"] for t in listed]

    edited = _rpc(erp_client, save_method, [{"name": renamed, "originalName": original}], mutation=True)
    edit_body = edited.get_json()
    assert edit_body["success"] is True
    assert edit_body["data"]["name"] == renamed

    listed_after_rename = _rpc(erp_client, get_method).get_json()["data"]
    names = [t["name"] for t in listed_after_rename]
    assert renamed in names
    assert original not in names

    deleted = _rpc(erp_client, delete_method, [renamed], mutation=True)
    assert deleted.get_json()["success"] is True

    listed_after_delete = _rpc(erp_client, get_method).get_json()["data"]
    assert renamed not in [t["name"] for t in listed_after_delete]


@pytest.mark.parametrize("get_method,save_method,delete_method,prefix", TAG_TYPES)
def test_tag_rejects_case_insensitive_duplicate(erp_client, get_method, save_method, delete_method, prefix):
    name = _unique_name(prefix)
    first = _rpc(erp_client, save_method, [{"name": name}], mutation=True)
    assert first.get_json()["success"] is True

    dupe = _rpc(erp_client, save_method, [{"name": name.upper()}], mutation=True)
    body = dupe.get_json()
    assert body["success"] is False
    assert "already exists" in body["message"]


def test_color_rename_cascade_is_a_noop_when_target_tables_dont_exist_yet(erp_client):
    """Color rename cascades into Process Components/BOM/Warehouse Pool
    Opening/Process Color Links -- none of which exist yet in this phase.
    The rename itself must still succeed (the guard in rename_utils uses
    to_regclass(), which never raises, so it can't poison the transaction).
    """
    original = _unique_name("Cascade")
    renamed = _unique_name("Cascade")
    _rpc(erp_client, "saveColor", [{"name": original}], mutation=True)

    edited = _rpc(erp_client, "saveColor", [{"name": renamed, "originalName": original}], mutation=True)
    body = edited.get_json()
    assert body["success"] is True
    assert body["data"]["name"] == renamed
