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


def _unique_word(prefix: str) -> str:
    """Like _unique_name but with no hyphen in the result -- needed for
    color-combo tests, since a hyphen inside a single color's own name
    would itself get parsed as a combo separator.
    """
    return f"{prefix}{uuid.uuid4().hex[:8]}"


def test_extract_colors_from_item_master_finds_new_hyphen_combo(erp_client):
    color_a = _unique_word("ExtractRed")
    color_b = _unique_word("ExtractWhite")
    _rpc(erp_client, "saveColor", [{"name": color_a}], mutation=True)
    _rpc(erp_client, "saveColor", [{"name": color_b}], mutation=True)

    item_name = _unique_name("ComboItem")
    _rpc(
        erp_client, "saveItem",
        [{"itemName": item_name, "itemNarration": f"Frame {color_a}-{color_b} finish"}],
        mutation=True,
    )

    resp = _rpc(erp_client, "extractColorsFromItemMaster")
    body = resp.get_json()
    assert body["success"] is True
    assert f"{color_a}-{color_b}" in body["data"]["newColors"]


def test_extract_colors_from_item_master_skips_combo_already_registered(erp_client):
    color_a = _unique_word("SkipRed")
    color_b = _unique_word("SkipWhite")
    combo = f"{color_a}-{color_b}"
    _rpc(erp_client, "saveColor", [{"name": color_a}], mutation=True)
    _rpc(erp_client, "saveColor", [{"name": color_b}], mutation=True)
    _rpc(erp_client, "saveColor", [{"name": combo}], mutation=True)

    item_name = _unique_name("AlreadyComboItem")
    _rpc(erp_client, "saveItem", [{"itemName": item_name, "itemNarration": combo}], mutation=True)

    resp = _rpc(erp_client, "extractColorsFromItemMaster")
    assert combo not in resp.get_json()["data"]["newColors"]


def test_import_process_types_from_process_names_matches_substring(erp_client):
    from tests.erp.test_process import _base_process_payload

    type_name = _unique_name("PaintType")
    _rpc(erp_client, "saveProcessType", [{"name": type_name}], mutation=True)

    process_name = f"{type_name} - Line 1"
    payload = _base_process_payload(processName=process_name, processType="")
    saved = _rpc(erp_client, "saveProcess", [payload], mutation=True).get_json()
    assert saved["success"] is True
    process_id = saved["data"]["processId"]

    resp = _rpc(erp_client, "importProcessTypesFromProcessNames", [], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert body["data"]["updated"] >= 1

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    match = next(p for p in listed if p["processId"] == process_id)
    assert match["processType"] == type_name


def test_import_process_types_defaults_to_general_when_no_match(erp_client):
    from tests.erp.test_process import _base_process_payload

    process_name = _unique_name("NoTypeMatchProcess")
    payload = _base_process_payload(processName=process_name, processType=_unique_name("StaleType"))
    saved = _rpc(erp_client, "saveProcess", [payload], mutation=True).get_json()
    assert saved["success"] is True
    process_id = saved["data"]["processId"]

    resp = _rpc(erp_client, "importProcessTypesFromProcessNames", [], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    match = next(p for p in listed if p["processId"] == process_id)
    assert match["processType"] == "General"
