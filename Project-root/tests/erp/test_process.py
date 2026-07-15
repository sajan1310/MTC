"""Process Master / Process Components / Process Color Links RPC tests,
ported behavior from Apps_Script/module_process.js.

Also proves the three rename cascades this round activates (see
process_service.py's module docstring): Color Master -> Process Components'
colorGroup + Process Color Links' colorA/colorB, Process Type Master ->
Process Master's processType, and the new Items Master -> Process
Components (ITEM-sourced only) target.
"""

from __future__ import annotations

import re
import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _lot_prefix() -> str:
    return uuid.uuid4().hex[:5].upper()


def _base_process_payload(**overrides) -> dict:
    payload = {
        "processName": _unique_name("Process"),
        "lotPrefix": _lot_prefix(),
        "outputItemName": _unique_name("Output"),
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    payload.update(overrides)
    return payload


def _save_process(client, **overrides):
    payload = _base_process_payload(**overrides)
    resp = _rpc(client, "saveProcess", [payload], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return payload, body["data"]["processId"]


def test_get_process_data_returns_success_envelope(erp_client):
    resp = _rpc(erp_client, "getProcessData")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True
    assert isinstance(body["data"], list)


def test_get_next_process_id_returns_bare_string(erp_client):
    """getNextProcessId is the one RPC method that returns a bare string,
    not the usual {success, data, message} envelope -- matches the source
    exactly (module_process.js:228 returns 'PRC-' + n directly).
    """
    resp = _rpc(erp_client, "getNextProcessId")
    assert resp.status_code == 200
    body = resp.get_json()
    assert isinstance(body, str)
    assert re.match(r"^PRC-\d+$", body)


def test_get_process_data_active_only_filter(erp_client):
    _payload_active, id_active = _save_process(erp_client, active=True)
    _payload_inactive, id_inactive = _save_process(erp_client, active=False)

    all_data = _rpc(erp_client, "getProcessData").get_json()["data"]
    ids_all = [p["processId"] for p in all_data]
    assert id_active in ids_all
    assert id_inactive in ids_all

    active_only = _rpc(erp_client, "getProcessData", [True]).get_json()["data"]
    ids_active = [p["processId"] for p in active_only]
    assert id_active in ids_active
    assert id_inactive not in ids_active


def test_save_process_validates_required_fields(erp_client):
    missing_name = _rpc(erp_client, "saveProcess", [_base_process_payload(processName="")], mutation=True)
    assert missing_name.get_json()["success"] is False

    bad_prefix = _rpc(erp_client, "saveProcess", [_base_process_payload(lotPrefix="TOO-LONG-1")], mutation=True)
    assert bad_prefix.get_json()["success"] is False

    missing_output = _rpc(erp_client, "saveProcess", [_base_process_payload(outputItemName="")], mutation=True)
    assert missing_output.get_json()["success"] is False

    bad_sequence = _rpc(erp_client, "saveProcess", [_base_process_payload(sequence=0)], mutation=True)
    assert bad_sequence.get_json()["success"] is False


def test_save_process_lot_prefix_uniqueness_blocks_even_inactive_process(erp_client):
    shared_prefix = _lot_prefix()
    _save_process(erp_client, lotPrefix=shared_prefix, active=False)

    resp = _rpc(erp_client, "saveProcess", [_base_process_payload(lotPrefix=shared_prefix, active=True)], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "already used by another process" in body["message"]


def test_save_process_output_item_name_allows_reuse_from_inactive_but_blocks_active(erp_client):
    shared_output = _unique_name("SharedOutput")
    _save_process(erp_client, outputItemName=shared_output, active=False)

    # B reuses the same Output Item Name while A is inactive -- allowed.
    _payload_b, _id_b = _save_process(erp_client, outputItemName=shared_output, active=True)

    # C tries the same name while B (active) already holds it -- blocked.
    resp = _rpc(erp_client, "saveProcess", [_base_process_payload(outputItemName=shared_output, active=True)], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "already used by another active process" in body["message"]


def test_save_process_rejects_duplicate_component(erp_client):
    item_name = _unique_name("DupComponentItem")
    payload = _base_process_payload(
        components=[
            {"itemName": item_name, "qtyPerUnit": 1},
            {"itemName": item_name, "qtyPerUnit": 2},
        ]
    )
    resp = _rpc(erp_client, "saveProcess", [payload], mutation=True)
    body = resp.get_json()
    assert body["success"] is False
    assert "Duplicate component" in body["message"]
    assert item_name in body["message"]


def test_save_process_creates_with_components_and_color_links(erp_client):
    item_name = _unique_name("RecipeItem")
    _payload_b, id_b = _save_process(erp_client, outputItemName=_unique_name("OutputB"))

    payload_a = _base_process_payload(
        outputItemName=_unique_name("OutputA"),
        components=[{"itemName": item_name, "size": "M", "qtyPerUnit": 3, "sourceType": "ITEM", "colorGroup": "COMMON"}],
        colorLinks=[{"otherProcessId": id_b, "myColor": "Red", "theirColor": "Blue"}],
    )
    resp = _rpc(erp_client, "saveProcess", [payload_a], mutation=True)
    body = resp.get_json()
    assert body["success"] is True
    id_a = body["data"]["processId"]

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    match = next(p for p in listed if p["processId"] == id_a)
    assert match["processName"] == payload_a["processName"]
    assert match["outputItemName"] == payload_a["outputItemName"]

    components = _rpc(erp_client, "getProcessComponentsData", [id_a]).get_json()["data"]
    assert len(components) == 1
    assert components[0]["itemName"] == item_name
    assert components[0]["qtyPerUnit"] == 3
    assert components[0]["size"] == "M"

    links_a = _rpc(erp_client, "getProcessColorLinksData", [id_a]).get_json()["data"]
    assert len(links_a) == 1
    assert links_a[0] == {"otherProcessId": id_b, "otherProcessName": _payload_b["processName"], "myColor": "Red", "theirColor": "Blue"}

    # Normalized from the OTHER side too -- process B never wrote a row
    # itself (this process is always saved as Process A on save), but
    # reading from B's perspective still surfaces it with colors swapped.
    links_b = _rpc(erp_client, "getProcessColorLinksData", [id_b]).get_json()["data"]
    assert len(links_b) == 1
    assert links_b[0] == {"otherProcessId": id_a, "otherProcessName": payload_a["processName"], "myColor": "Blue", "theirColor": "Red"}


def test_save_process_edit_replaces_components_and_links_wholesale(erp_client):
    item_1 = _unique_name("EditItem1")
    item_2 = _unique_name("EditItem2")
    payload, process_id = _save_process(
        erp_client,
        components=[
            {"itemName": item_1, "qtyPerUnit": 1},
            {"itemName": item_2, "qtyPerUnit": 2},
        ],
    )

    edit_payload = dict(payload, processId=process_id, components=[{"itemName": item_2, "qtyPerUnit": 5}])
    resp = _rpc(erp_client, "saveProcess", [edit_payload], mutation=True)
    assert resp.get_json()["success"] is True

    components = _rpc(erp_client, "getProcessComponentsData", [process_id]).get_json()["data"]
    assert len(components) == 1
    assert components[0]["itemName"] == item_2
    assert components[0]["qtyPerUnit"] == 5


def test_get_process_components_data_filtered_vs_unfiltered(erp_client):
    item_name = _unique_name("FilterItem")
    _payload, process_id = _save_process(erp_client, components=[{"itemName": item_name, "qtyPerUnit": 1}])

    filtered = _rpc(erp_client, "getProcessComponentsData", [process_id]).get_json()["data"]
    assert len(filtered) == 1
    assert filtered[0]["processId"] == process_id

    unfiltered = _rpc(erp_client, "getProcessComponentsData").get_json()["data"]
    assert any(c["processId"] == process_id and c["itemName"] == item_name for c in unfiltered)


def test_process_color_link_self_link_rejected(erp_client):
    payload, process_id = _save_process(erp_client)
    edit_payload = dict(
        payload,
        processId=process_id,
        colorLinks=[{"otherProcessId": process_id, "myColor": "Red", "theirColor": "Blue"}],
    )
    resp = _rpc(erp_client, "saveProcess", [edit_payload], mutation=True)
    # The save itself succeeds -- an invalid link entry is silently dropped,
    # not an error (matches _saveProcessColorLinksForProcess's filter()).
    assert resp.get_json()["success"] is True

    links = _rpc(erp_client, "getProcessColorLinksData", [process_id]).get_json()["data"]
    assert links == []


def test_process_color_link_to_nonexistent_process_silently_dropped(erp_client):
    _payload, process_id = _save_process(
        erp_client,
        colorLinks=[{"otherProcessId": "PRC-999999", "myColor": "Red", "theirColor": "Blue"}],
    )
    links = _rpc(erp_client, "getProcessColorLinksData", [process_id]).get_json()["data"]
    assert links == []


def test_delete_process_cascades_components_and_color_links(erp_client):
    item_name = _unique_name("DeleteCascadeItem")
    _payload_b, id_b = _save_process(erp_client)
    _payload_a, id_a = _save_process(
        erp_client,
        components=[{"itemName": item_name, "qtyPerUnit": 1}],
        colorLinks=[{"otherProcessId": id_b, "myColor": "Red", "theirColor": "Blue"}],
    )

    resp = _rpc(erp_client, "deleteProcess", [id_a], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    assert not any(p["processId"] == id_a for p in listed)

    components = _rpc(erp_client, "getProcessComponentsData", [id_a]).get_json()["data"]
    assert components == []

    links_b = _rpc(erp_client, "getProcessColorLinksData", [id_b]).get_json()["data"]
    assert links_b == []


def test_delete_process_not_found(erp_client):
    resp = _rpc(erp_client, "deleteProcess", ["PRC-999999"], mutation=True)
    assert resp.get_json()["success"] is False


def test_delete_processes_bulk(erp_client):
    _payload_a, id_a = _save_process(erp_client)
    _payload_b, id_b = _save_process(erp_client)

    resp = _rpc(erp_client, "deleteProcessesBulk", [[id_a, id_b]], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    ids = [p["processId"] for p in listed]
    assert id_a not in ids
    assert id_b not in ids


def test_reorder_processes(erp_client):
    _payload_a, id_a = _save_process(erp_client, sequence=1)
    _payload_b, id_b = _save_process(erp_client, sequence=2)

    resp = _rpc(erp_client, "reorderProcesses", [[id_b, id_a]], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    by_id = {p["processId"]: p for p in listed}
    assert by_id[id_b]["sequence"] == 1
    assert by_id[id_a]["sequence"] == 2


def test_color_rename_cascades_into_process_components_and_color_links(erp_client):
    """The 'validating moment': tags_service._rename_color_everywhere's
    PROCESS_COMPONENTS/PROCESS_COLOR_LINKS targets were written back in
    Phase 1a as guarded no-ops -- this round's migration registers both
    table names with no code changes there, so this must now actually fire.
    """
    old_color = _unique_name("OldColor")
    new_color = _unique_name("NewColor")
    _rpc(erp_client, "saveColor", [{"name": old_color}], mutation=True)

    item_name = _unique_name("ColorCascadeItem")
    _payload_b, id_b = _save_process(erp_client)
    _payload_a, id_a = _save_process(
        erp_client,
        components=[{"itemName": item_name, "qtyPerUnit": 1, "colorGroup": old_color}],
        colorLinks=[{"otherProcessId": id_b, "myColor": old_color, "theirColor": "Static"}],
    )

    rename = _rpc(erp_client, "saveColor", [{"name": new_color, "originalName": old_color}], mutation=True)
    assert rename.get_json()["success"] is True

    components = _rpc(erp_client, "getProcessComponentsData", [id_a]).get_json()["data"]
    assert components[0]["colorGroup"] == new_color

    links_a = _rpc(erp_client, "getProcessColorLinksData", [id_a]).get_json()["data"]
    assert links_a[0]["myColor"] == new_color

    links_b = _rpc(erp_client, "getProcessColorLinksData", [id_b]).get_json()["data"]
    assert links_b[0]["theirColor"] == new_color


def test_process_type_rename_cascades_into_process_master(erp_client):
    """Same validating moment as above, for
    tags_service._rename_process_type_everywhere's PROCESS_MASTER target.
    """
    old_type = _unique_name("OldType")
    new_type = _unique_name("NewType")
    _rpc(erp_client, "saveProcessType", [{"name": old_type}], mutation=True)

    _payload, process_id = _save_process(erp_client, processType=old_type)

    rename = _rpc(erp_client, "saveProcessType", [{"name": new_type, "originalName": old_type}], mutation=True)
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    match = next(p for p in listed if p["processId"] == process_id)
    assert match["processType"] == new_type


def test_item_rename_cascades_into_item_sourced_but_not_pool_sourced_component(erp_client):
    """The one genuinely new assertion this round adds to
    items_service._propagate_item_identity_change: an ITEM-sourced
    component follows an Items Master rename, but a POOL-sourced component
    sharing the exact same name+size must NOT be touched -- its itemName is
    a different identity space (an upstream process's Output Item Name).
    """
    old_item = _unique_name("OldRecipeItem")
    new_item = _unique_name("NewRecipeItem")
    _rpc(erp_client, "saveItem", [{"itemName": old_item}], mutation=True)

    _payload, process_id = _save_process(
        erp_client,
        components=[
            {"itemName": old_item, "qtyPerUnit": 1, "sourceType": "ITEM", "colorGroup": "COMMON"},
            {"itemName": old_item, "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "OtherGroup"},
        ],
    )

    rename = _rpc(erp_client, "saveItem", [{"itemName": new_item, "originalName": old_item}], mutation=True)
    assert rename.get_json()["success"] is True

    components = _rpc(erp_client, "getProcessComponentsData", [process_id]).get_json()["data"]
    item_sourced = next(c for c in components if c["sourceType"] == "ITEM")
    pool_sourced = next(c for c in components if c["sourceType"] == "POOL")
    assert item_sourced["itemName"] == new_item
    assert pool_sourced["itemName"] == old_item
