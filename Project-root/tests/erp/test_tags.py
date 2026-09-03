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

TAG_BULK_TYPES = [
    ("getColors", "saveColor", "deleteColorsBulk", "Red"),
    ("getModels", "saveModel", "deleteModelsBulk", "Roadster"),
    ("getProcessTypes", "saveProcessType", "deleteProcessTypesBulk", "Painting"),
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


@pytest.mark.parametrize("get_method,save_method,bulk_delete_method,prefix", TAG_BULK_TYPES)
def test_tag_bulk_delete_removes_selected_only(erp_client, get_method, save_method, bulk_delete_method, prefix):
    name_a = _unique_name(prefix)
    name_b = _unique_name(prefix)
    name_keep = _unique_name(prefix)
    for n in (name_a, name_b, name_keep):
        assert _rpc(erp_client, save_method, [{"name": n}], mutation=True).get_json()["success"] is True

    resp = _rpc(erp_client, bulk_delete_method, [[name_a, name_b]], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "2" in body["message"]

    names = [t["name"] for t in _rpc(erp_client, get_method).get_json()["data"]]
    assert name_a not in names
    assert name_b not in names
    assert name_keep in names


@pytest.mark.parametrize("get_method,save_method,bulk_delete_method,prefix", TAG_BULK_TYPES)
def test_tag_bulk_delete_no_selection_is_a_success_noop(erp_client, get_method, save_method, bulk_delete_method, prefix):
    resp = _rpc(erp_client, bulk_delete_method, [[]], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    assert "No" in body["message"] and "selected" in body["message"]


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


def test_color_rename_updates_one_token_in_a_composite_process_component(erp_client):
    """A color cell isn't always a single literal name -- a composite
    value joins 2+ independent axes with config_maps.COLOR_COMBO_DELIMITER
    (e.g. "Red / Blue"). Renaming just one of those colors must update
    that ONE token and rejoin, not require a whole-cell exact match (which
    would silently leave a composite cell stale).
    """
    old_color = _unique_name("ComboOld")
    new_color = _unique_name("ComboNew")
    other_color = _unique_name("ComboOther")
    _rpc(erp_client, "saveColor", [{"name": old_color}], mutation=True)
    _rpc(erp_client, "saveColor", [{"name": other_color}], mutation=True)

    process_payload = {
        "processName": _unique_name("ComboProcess"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique_name("ComboOutput"),
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [
            {
                "itemName": _unique_name("ComboItem"),
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": f"{old_color} / {other_color}",
            }
        ],
        "colorLinks": [],
    }
    create = _rpc(erp_client, "saveProcess", [process_payload], mutation=True)
    process_id = create.get_json()["data"]["processId"]

    rename = _rpc(erp_client, "saveColor", [{"name": new_color, "originalName": old_color}], mutation=True)
    assert rename.get_json()["success"] is True

    components = _rpc(erp_client, "getProcessComponentsData", [process_id]).get_json()["data"]
    assert components[0]["colorGroup"] == f"{new_color} / {other_color}"


def _save_lot_with_component_color(erp_client, color_group: str):
    """A Production lot whose componentsConsumed carries `color_group`, via a
    custom sub-group so no Process colour configuration is needed. Returns
    its lotNumber.
    """
    process_payload = {
        "processName": _unique_name("RenameProcess"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique_name("RenameOutput"),
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    create = _rpc(erp_client, "saveProcess", [process_payload], mutation=True)
    process_id = create.get_json()["data"]["processId"]

    saved = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "colorBreakdown": [{"color": color_group, "qty": 5, "isCustom": True}],
                "componentsConsumed": [
                    {
                        "itemName": _unique_name("RenameItem"),
                        "qty": 5,
                        "sourceType": "POOL",
                        "colorGroup": color_group,
                    }
                ],
            }
        ],
        mutation=True,
    )
    body = saved.get_json()
    assert body["success"] is True, body["message"]
    return body["data"]["row"]["lotNumber"]


def _lot_by_number(erp_client, lot_number: str) -> dict:
    lots = _rpc(erp_client, "getProductionData").get_json()["data"]
    match = next((row for row in lots if row["lotNumber"] == lot_number), None)
    assert match is not None, f"lot {lot_number} not found"
    return match


def test_color_rename_reaches_a_lots_components_consumed(erp_client):
    """The rename cascade updated production.color and color_breakdown but
    never components_consumed, and _rename_color_everywhere recalculates the
    Warehouse Pool on its way out -- so a rename left the lot's CREDIT under
    the new colour name and its POOL DEBIT under the old one, opening a
    debit-only bucket that goes straight to negative. The next edit-save of
    that lot then silently dropped those components at save_production's own
    filter, their colorGroup no longer matching any (renamed) breakdown
    colour.
    """
    old_color = _unique_word("ConsumedOld")
    new_color = _unique_word("ConsumedNew")
    _rpc(erp_client, "saveColor", [{"name": old_color}], mutation=True)

    lot_number = _save_lot_with_component_color(erp_client, old_color)

    rename = _rpc(erp_client, "saveColor", [{"name": new_color, "originalName": old_color}], mutation=True)
    assert rename.get_json()["success"] is True

    lot = _lot_by_number(erp_client, lot_number)
    # Both halves, so they can never again be renamed out of step.
    assert [e["color"] for e in lot["colorBreakdown"]] == [new_color]
    assert [c["colorGroup"] for c in lot["componentsConsumed"]] == [new_color]


def test_color_rename_updates_one_token_of_a_composite_component_colorgroup(erp_client):
    """Same per-token rejoin the flat columns already got: a component
    scoped to a composite must have only its matching axis replaced.
    """
    old_color = _unique_word("CompCompOld")
    new_color = _unique_word("CompCompNew")
    other_color = _unique_word("CompCompOther")
    _rpc(erp_client, "saveColor", [{"name": old_color}], mutation=True)
    _rpc(erp_client, "saveColor", [{"name": other_color}], mutation=True)

    composite = f"{old_color} / {other_color}"
    lot_number = _save_lot_with_component_color(erp_client, composite)

    _rpc(erp_client, "saveColor", [{"name": new_color, "originalName": old_color}], mutation=True)

    lot = _lot_by_number(erp_client, lot_number)
    assert lot["componentsConsumed"][0]["colorGroup"] == f"{new_color} / {other_color}"


def test_color_rename_leaves_an_unrelated_components_colorgroup_alone(erp_client):
    unrelated = _unique_word("UntouchedColor")
    renamed_from = _unique_word("SomeOther")
    renamed_to = _unique_word("SomeOtherNew")
    _rpc(erp_client, "saveColor", [{"name": unrelated}], mutation=True)
    _rpc(erp_client, "saveColor", [{"name": renamed_from}], mutation=True)

    lot_number = _save_lot_with_component_color(erp_client, unrelated)
    _rpc(erp_client, "saveColor", [{"name": renamed_to, "originalName": renamed_from}], mutation=True)

    lot = _lot_by_number(erp_client, lot_number)
    assert lot["componentsConsumed"][0]["colorGroup"] == unrelated


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
