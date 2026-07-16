"""Process Color Axis computation RPC tests, ported behavior from
Apps_Script/module_process.js's computeColorGroupsForProcess/
computeColorAxesForProcess/_mergeLinkedAxes/_resolveLinkedColor/
_legacyColorGroupList -- Phase 3f, fulfilling the deferral noted in
Phase 3a's plan.
"""

from __future__ import annotations

import uuid


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _save_process(client, **overrides):
    payload = {
        "processName": _unique_name("Process"),
        "lotPrefix": uuid.uuid4().hex[:5].upper(),
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
    resp = _rpc(client, "saveProcess", [payload], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return payload, body["data"]["processId"]


def _edit_process(client, payload, process_id, **overrides):
    edit_payload = dict(payload, processId=process_id, **overrides)
    resp = _rpc(client, "saveProcess", [edit_payload], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return edit_payload


def _seed_pool(client, process_id, qty, color=""):
    resp = _rpc(
        client, "saveWarehousePoolOpening", [{"processId": process_id, "qty": qty, "color": color}], mutation=True
    )
    assert resp.get_json()["success"] is True


def test_no_axis_when_zero_pool_colors(erp_client):
    _upstream_payload, upstream_id = _save_process(erp_client)
    upstream_output = _upstream_payload["outputItemName"]

    downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[{"itemName": upstream_output, "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]
    assert axes["axes"] == []

    groups = _rpc(erp_client, "getProcessColorGroups", [downstream_id]).get_json()["data"]
    assert groups == []


def test_no_axis_when_single_pool_color(erp_client):
    upstream_payload, upstream_id = _save_process(erp_client)
    _seed_pool(erp_client, upstream_id, 10, color="Black")

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]
    assert axes["axes"] == []

    groups = _rpc(erp_client, "getProcessColorGroups", [downstream_id]).get_json()["data"]
    assert groups == []


def test_two_independent_axes_kept_separate_but_groups_are_flat_union(erp_client):
    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    rim_payload, rim_id = _save_process(erp_client)
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {"itemName": frame_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
            {"itemName": rim_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]["axes"]
    assert len(axes) == 2
    color_sets = [set(a["colors"]) for a in axes]
    assert {"Black", "Blue"} in color_sets
    assert {"Red", "Green"} in color_sets
    labels = {a["label"] for a in axes}
    assert labels == {frame_payload["outputItemName"], rim_payload["outputItemName"]}

    groups = _rpc(erp_client, "getProcessColorGroups", [downstream_id]).get_json()["data"]
    # Flat union, NOT cross-multiplied (that's the legacy-fallback behavior,
    # only used when fewer than 2 axes resolve).
    assert set(groups) == {"Black", "Blue", "Red", "Green"}
    assert not any(" / " in g for g in groups)


def test_explicit_color_link_merges_two_axes_into_one(erp_client):
    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    rim_payload, rim_id = _save_process(erp_client)
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    _edit_process(
        erp_client,
        frame_payload,
        frame_id,
        colorLinks=[
            {"otherProcessId": rim_id, "myColor": "Black", "theirColor": "Red"},
            {"otherProcessId": rim_id, "myColor": "Blue", "theirColor": "Green"},
        ],
    )

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {"itemName": frame_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
            {"itemName": rim_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]["axes"]
    assert len(axes) == 1
    merged_colors = set(axes[0]["colors"])
    assert merged_colors == {"Black / Red", "Blue / Green"}

    groups = _rpc(erp_client, "getProcessColorGroups", [downstream_id]).get_json()["data"]
    assert set(groups) == {"Black / Red", "Blue / Green"}


def test_transitive_link_chain_merges_three_processes(erp_client):
    b_payload, b_id = _save_process(erp_client)
    _seed_pool(erp_client, b_id, 10, color="X1")
    _seed_pool(erp_client, b_id, 10, color="X2")

    d_payload, d_id = _save_process(erp_client)
    _seed_pool(erp_client, d_id, 10, color="Y1")
    _seed_pool(erp_client, d_id, 10, color="Y2")

    a_payload, a_id = _save_process(erp_client)
    _seed_pool(erp_client, a_id, 10, color="Z1")
    _seed_pool(erp_client, a_id, 10, color="Z2")

    # B <-> D directly, D <-> A directly -- B and A are only transitively
    # connected (via D), never linked to each other directly. Both pairs
    # are declared in ONE saveProcess call from D's side: saving a
    # process's colorLinks replaces every link touching that process on
    # EITHER side (delete-then-reinsert, matching the source exactly), so
    # a second, separate edit to D here would wipe out a B<->D link
    # established by an earlier call to B.
    _edit_process(
        erp_client,
        d_payload,
        d_id,
        colorLinks=[
            {"otherProcessId": b_id, "myColor": "Y1", "theirColor": "X1"},
            {"otherProcessId": b_id, "myColor": "Y2", "theirColor": "X2"},
            {"otherProcessId": a_id, "myColor": "Y1", "theirColor": "Z1"},
            {"otherProcessId": a_id, "myColor": "Y2", "theirColor": "Z2"},
        ],
    )

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {"itemName": b_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
            {"itemName": d_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
            {"itemName": a_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]["axes"]
    assert len(axes) == 1
    colors = axes[0]["colors"]
    assert len(colors) == 2

    # Regardless of which process anchors the merge, the two composites must
    # correctly correlate X1<->Y1<->Z1 and X2<->Y2<->Z2, never cross-paired.
    combo_1 = next(c for c in colors if "X1" in c)
    combo_2 = next(c for c in colors if "X2" in c)
    assert "Y1" in combo_1 and "Z1" in combo_1
    assert "Y2" in combo_2 and "Z2" in combo_2


def test_tag_based_axis_independent_of_pool_detection(erp_client):
    item_a = _unique_name("MudguardPartRed")
    item_b = _unique_name("MudguardPartBlue")
    _payload, process_id = _save_process(
        erp_client,
        components=[
            {"itemName": item_a, "qtyPerUnit": 1, "sourceType": "ITEM", "colorGroup": "Red", "colorAxis": "Mudguard Color"},
            {"itemName": item_b, "qtyPerUnit": 1, "sourceType": "ITEM", "colorGroup": "Blue", "colorAxis": "Mudguard Color"},
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [process_id]).get_json()["data"]["axes"]
    assert len(axes) == 1
    assert axes[0]["label"] == "Mudguard Color"
    assert axes[0]["source"] == "tag"
    assert set(axes[0]["colors"]) == {"Red", "Blue"}

    groups = _rpc(erp_client, "getProcessColorGroups", [process_id]).get_json()["data"]
    assert set(groups) == {"Red", "Blue"}


def test_case_insensitive_color_dedup(erp_client):
    upstream_payload, upstream_id = _save_process(erp_client)
    _seed_pool(erp_client, upstream_id, 5, color="Red")
    _seed_pool(erp_client, upstream_id, 5, color="red")  # same color, different casing
    _seed_pool(erp_client, upstream_id, 5, color="Blue")

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]["axes"]
    assert len(axes) == 1
    # First-seen casing kept, "red" collapsed into "Red" -- 2 distinct
    # colors, not 3.
    assert axes[0]["colors"] == ["Blue", "Red"]


def test_primary_axis_key_resolves_from_process_own_field(erp_client):
    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    rim_payload, rim_id = _save_process(erp_client)
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {"itemName": frame_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
            {"itemName": rim_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
        ],
    )

    _edit_process(erp_client, downstream_payload, downstream_id, primaryColorAxis=frame_payload["outputItemName"])

    data = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]
    assert data["primaryColorAxis"] == frame_payload["outputItemName"]
    expected_key = f"pool:{frame_payload['outputItemName'].lower()}"
    assert data["primaryAxisKey"] == expected_key


def test_get_all_process_color_groups_bulk_shape(erp_client):
    upstream_payload, upstream_id = _save_process(erp_client)
    _seed_pool(erp_client, upstream_id, 5, color="Black")
    _seed_pool(erp_client, upstream_id, 5, color="Blue")

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}
        ],
    )

    result = _rpc(erp_client, "getAllProcessColorGroups").get_json()["data"]
    assert result[downstream_id] == ["Black", "Blue"]
    assert result[upstream_id] == []
