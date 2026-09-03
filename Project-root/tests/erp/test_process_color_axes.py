"""Process Color Axis computation RPC tests, ported behavior from
Apps_Script/module_process.js's computeColorGroupsForProcess/
computeColorAxesForProcess/_mergeLinkedAxes/_resolveLinkedColor/
_legacyColorGroupList -- Phase 3f, fulfilling the deferral noted in
Phase 3a's plan.
"""

from __future__ import annotations

import uuid

import psycopg2.extras

import database
from app.erp.services import process_service


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _save_process(client, **overrides):
    payload = {
        "processName": _unique_name("Process"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
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
        client,
        "saveWarehousePoolOpening",
        [{"processId": process_id, "qty": qty, "color": color}],
        mutation=True,
    )
    assert resp.get_json()["success"] is True


def test_no_axis_when_zero_pool_colors(erp_client):
    _upstream_payload, upstream_id = _save_process(erp_client)
    upstream_output = _upstream_payload["outputItemName"]

    downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_output,
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]
    assert axes["axes"] == []

    groups = _rpc(erp_client, "getProcessColorGroups", [downstream_id]).get_json()[
        "data"
    ]
    assert groups == []


def test_no_axis_when_single_pool_color(erp_client):
    upstream_payload, upstream_id = _save_process(erp_client)
    _seed_pool(erp_client, upstream_id, 10, color="Black")

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]
    assert axes["axes"] == []

    groups = _rpc(erp_client, "getProcessColorGroups", [downstream_id]).get_json()[
        "data"
    ]
    assert groups == []


def test_single_composite_pool_color_is_still_an_axis(erp_client):
    """The complement of test_no_axis_when_single_pool_color: a pool item
    that has settled into exactly ONE color is normally a fixed input, not
    an axis -- UNLESS that one color is ITSELF a composite (inherited from
    an upstream process combining two of ITS OWN axes). Excluding it would
    truncate the whole upstream chain history rather than dropping a real
    non-choice. Ports module_process.js#_poolItemIsColorAxis (GAS 1288076).
    """
    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    rim_payload, rim_id = _save_process(erp_client)
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    # Parent combines Frame + Rim but has so far only ever produced ONE
    # combination -- its own Warehouse Pool bucket carries exactly one,
    # composite, color ("Black / Red").
    parent_payload, parent_id = _save_process(
        erp_client,
        primaryColorAxis=frame_payload["outputItemName"],
        components=[
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": rim_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )
    _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": parent_id,
                "assignedTo": "Worker A",
                "primaryColorAxis": frame_payload["outputItemName"],
                "status": "Completed",
                "colorBreakdown": [
                    {"color": "Black", "qty": 10, "countsTowardTotal": True},
                    {"color": "Red", "qty": 10, "countsTowardTotal": False},
                ],
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
            }
        ],
        mutation=True,
    )

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": parent_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"][
        "axes"
    ]
    assert len(axes) == 1, (
        f"parent's single composite color was dropped as a non-axis: {axes}"
    )
    assert axes[0]["colors"] == ["Black / Red"]

    groups = _rpc(erp_client, "getProcessColorGroups", [downstream_id]).get_json()[
        "data"
    ]
    assert groups == ["Black / Red"]


def test_axis_order_follows_recipe_row_order_not_pool_table_order(erp_client):
    """An axis's position in getProcessColorAxes comes from THIS process's
    own recipe row order (see process_service._compute_color_axes_for_
    process), not from whichever order Warehouse Pool happens to return
    rows in -- a plain SELECT with no ORDER BY, rebuilt on every
    recalculation and carrying no ordering guarantee of its own. Rim's
    pool rows are seeded (and therefore physically inserted) BEFORE
    Frame's, but the downstream recipe lists Frame ahead of Rim -- proving
    the two are decoupled. Ports module_process.js's 1288076 recipe-order
    fix (getAxisOrderByProcess / _composeLotColorKey's canonical ordering
    in warehouse_service.py depend on this).
    """
    rim_payload, rim_id = _save_process(erp_client)
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        primaryColorAxis=frame_payload["outputItemName"],
        components=[
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": rim_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"][
        "axes"
    ]
    assert len(axes) == 2
    assert axes[0]["label"] == frame_payload["outputItemName"]
    assert axes[1]["label"] == rim_payload["outputItemName"]


def test_two_independent_axes_kept_separate_but_groups_are_flat_union(erp_client):
    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    rim_payload, rim_id = _save_process(erp_client)
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        primaryColorAxis=frame_payload["outputItemName"],
        components=[
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": rim_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"][
        "axes"
    ]
    assert len(axes) == 2
    color_sets = [set(a["colors"]) for a in axes]
    assert {"Black", "Blue"} in color_sets
    assert {"Red", "Green"} in color_sets
    labels = {a["label"] for a in axes}
    assert labels == {frame_payload["outputItemName"], rim_payload["outputItemName"]}

    groups = _rpc(erp_client, "getProcessColorGroups", [downstream_id]).get_json()[
        "data"
    ]
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
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": rim_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"][
        "axes"
    ]
    assert len(axes) == 1
    merged_colors = set(axes[0]["colors"])
    assert merged_colors == {"Black / Red", "Blue / Green"}

    groups = _rpc(erp_client, "getProcessColorGroups", [downstream_id]).get_json()[
        "data"
    ]
    assert set(groups) == {"Black / Red", "Blue / Green"}


def test_same_process_axis_key_link_merges_two_tag_axes(erp_client):
    """A Process Color Link with otherProcessId == the process's own ID is
    only accepted when BOTH axis keys are given and differ -- pairing two
    of one process's OWN axes (e.g. a tag-based Rim Color <-> Mudguard
    Color) instead of colliding with itself. See process_service._axis_link_ref.
    """
    payload, process_id = _save_process(
        erp_client,
        primaryColorAxis="Rim Color",
        components=[
            {
                "itemName": "RimPart",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Red",
                "colorAxis": "Rim Color",
            },
            {
                "itemName": "RimPart",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Blue",
                "colorAxis": "Rim Color",
            },
            {
                "itemName": "MudguardPart",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "X",
                "colorAxis": "Mudguard Color",
            },
            {
                "itemName": "MudguardPart",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Y",
                "colorAxis": "Mudguard Color",
            },
        ],
    )

    # Before linking: two independent tag axes, cross-multiplied in the
    # flat group list, kept separate in the axis breakdown.
    axes_before = _rpc(erp_client, "getProcessColorAxes", [process_id]).get_json()[
        "data"
    ]["axes"]
    assert len(axes_before) == 2

    _edit_process(
        erp_client,
        payload,
        process_id,
        colorLinks=[
            {
                "otherProcessId": process_id,
                "myColor": "Red",
                "theirColor": "X",
                "myAxisKey": "tag:rim color",
                "theirAxisKey": "tag:mudguard color",
            },
            {
                "otherProcessId": process_id,
                "myColor": "Blue",
                "theirColor": "Y",
                "myAxisKey": "tag:rim color",
                "theirAxisKey": "tag:mudguard color",
            },
        ],
    )

    axes_after = _rpc(erp_client, "getProcessColorAxes", [process_id]).get_json()[
        "data"
    ]["axes"]
    assert len(axes_after) == 1
    assert set(axes_after[0]["colors"]) == {"Red / X", "Blue / Y"}

    links = _rpc(erp_client, "getProcessColorLinksData", [process_id]).get_json()[
        "data"
    ]
    assert len(links) == 2
    assert all(
        link["myAxisKey"] == "tag:rim color"
        and link["theirAxisKey"] == "tag:mudguard color"
        for link in links
    )


def test_same_process_link_dropped_without_distinct_axis_keys(erp_client):
    """A same-process link with a blank or matching axis key is meaningless
    (there is no "this process's own pool axis, paired with itself") and
    is silently dropped, matching the original behavior from before axis
    keys existed (self-links rejected unconditionally).
    """
    payload, process_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": "RimPart2",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Red",
                "colorAxis": "Rim Color",
            },
            {
                "itemName": "RimPart2",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Blue",
                "colorAxis": "Rim Color",
            },
        ],
    )

    _edit_process(
        erp_client,
        payload,
        process_id,
        colorLinks=[
            {"otherProcessId": process_id, "myColor": "Red", "theirColor": "Blue"}
        ],
    )

    links = _rpc(erp_client, "getProcessColorLinksData", [process_id]).get_json()[
        "data"
    ]
    assert links == []


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
            {
                "itemName": b_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": d_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": a_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"][
        "axes"
    ]
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
            {
                "itemName": item_a,
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Red",
                "colorAxis": "Mudguard Color",
            },
            {
                "itemName": item_b,
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Blue",
                "colorAxis": "Mudguard Color",
            },
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [process_id]).get_json()["data"][
        "axes"
    ]
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
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"][
        "axes"
    ]
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
        primaryColorAxis=rim_payload["outputItemName"],
        components=[
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": rim_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )

    _edit_process(
        erp_client,
        downstream_payload,
        downstream_id,
        primaryColorAxis=frame_payload["outputItemName"],
    )

    data = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]
    assert data["primaryColorAxis"] == frame_payload["outputItemName"]
    expected_key = f"pool:{frame_payload['outputItemName'].lower()}"
    assert data["primaryAxisKey"] == expected_key


def test_include_warehouse_pool_color_force_adds_a_known_combination(erp_client):
    """includeWarehousePoolColor force-adds one color as a known
    combination even though nothing else (recipe, pool history, Color
    Master) would produce it -- the Warehouse Pool breakdown dialog's
    "Add Combination" escape hatch.
    """
    payload, process_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": "OverrideItem",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "BaseColor",
            }
        ],
    )

    before = _rpc(erp_client, "getProcessColorGroups", [process_id]).get_json()["data"]
    assert "Extra" not in before

    resp = _rpc(
        erp_client, "includeWarehousePoolColor", [process_id, "Extra"], mutation=True
    )
    assert resp.get_json()["success"] is True

    after = _rpc(erp_client, "getProcessColorGroups", [process_id]).get_json()["data"]
    assert "Extra" in after
    assert "BaseColor" in after

    dupe = _rpc(
        erp_client, "includeWarehousePoolColor", [process_id, "Extra"], mutation=True
    )
    assert dupe.get_json()["success"] is False
    assert "already a known combination" in dupe.get_json()["message"]


def test_exclude_warehouse_pool_colors_hides_only_zero_data_placeholder(erp_client):
    """excludeWarehousePoolColors only ever removes a zero-data PLACEHOLDER
    combination: a color actually configured on the process's own recipe
    is protected and reported back individually, never silently skipped.
    """
    payload, process_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": "ProtectedItem",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "BaseColor",
            }
        ],
    )
    _rpc(
        erp_client,
        "includeWarehousePoolColor",
        [process_id, "RemovableExtra"],
        mutation=True,
    )

    resp = _rpc(
        erp_client,
        "excludeWarehousePoolColors",
        [process_id, ["BaseColor", "RemovableExtra"]],
        mutation=True,
    )
    body = resp.get_json()
    assert body["data"]["removed"] == ["RemovableExtra"]
    assert len(body["data"]["blocked"]) == 1
    assert "configured on this process's recipe" in body["data"]["blocked"][0]

    after = _rpc(erp_client, "getProcessColorGroups", [process_id]).get_json()["data"]
    assert "RemovableExtra" not in after
    assert "BaseColor" in after  # protected, still present


def test_exclude_then_include_undoes_the_exclusion(erp_client):
    """Re-adding a previously-excluded color overwrites its EXCLUDE row
    with INCLUDE -- one row per (process, color), always the current
    state, never a growing log.
    """
    payload, process_id = _save_process(erp_client)
    _rpc(
        erp_client, "includeWarehousePoolColor", [process_id, "Toggled"], mutation=True
    )
    _rpc(
        erp_client,
        "excludeWarehousePoolColors",
        [process_id, ["Toggled"]],
        mutation=True,
    )

    excluded = _rpc(erp_client, "getProcessColorGroups", [process_id]).get_json()[
        "data"
    ]
    assert "Toggled" not in excluded

    resp = _rpc(
        erp_client, "includeWarehousePoolColor", [process_id, "Toggled"], mutation=True
    )
    assert resp.get_json()["success"] is True

    included = _rpc(erp_client, "getProcessColorGroups", [process_id]).get_json()[
        "data"
    ]
    assert "Toggled" in included


def test_get_all_process_color_groups_bulk_shape(erp_client):
    """getAllProcessColorGroups returns {colors, removable} per process --
    `removable` is the subset of `colors` NOT configured on the process's
    own recipe/pool detection (i.e. safe to pass to
    excludeWarehousePoolColors). Both of downstream's colors here are pool
    -detected (its own baseColors), so neither is removable.
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    _seed_pool(erp_client, upstream_id, 5, color="Black")
    _seed_pool(erp_client, upstream_id, 5, color="Blue")

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
        ],
    )

    result = _rpc(erp_client, "getAllProcessColorGroups").get_json()["data"]
    assert result[downstream_id]["colors"] == ["Black", "Blue"]
    assert result[downstream_id]["removable"] == []
    assert result[upstream_id]["colors"] == []
    assert result[upstream_id]["removable"] == []


# ── Primary Color Axis is mandatory once 2+ axes exist ───────────────────
# A blank Primary Color Axis used to mean "legacy: sum every checked color
# across every axis", which double-counts a multi-axis lot's non-primary
# rows -- the exact bug the Color Axes feature exists to fix. saveProcess
# and saveProduction used to paper over a blank cell by silently defaulting
# to the process's first axis in recipe order (GAS 6a22f0e); that default
# is exactly the "nobody actually decided, a reorder could flip it later"
# behavior that made the Production Lot form stop reliably landing on the
# right Primary group, and let unrelated Color Sub-Group tags read as if
# they were a deliberate choice. Both RPCs now require a real, explicit
# choice once there's genuinely more than one axis to choose between.


def _two_axis_downstream(erp_client, **overrides):
    """Downstream process consuming two independent pool axes (Frame
    Black/Blue, Rim Red/Green), in that recipe order. Returns
    (downstream_payload, downstream_id, frame_output_name, rim_output_name).

    Defaults primaryColorAxis to Frame (first in recipe order) -- 2+ axes
    means saveProcess now requires an explicit choice (see save_process's
    own len(axes) >= 2 check), so this stands in for "the operator picked
    one" the same way every other field in `_save_process`'s payload
    stands in for a real form submission. A caller simulating the
    grandfathered pre-this-feature state (a genuinely blank cell) still
    creates through this same explicit choice and then clears it directly
    via SQL afterward -- exactly like `_save_process` itself is not how
    that state is reached, only how a valid starting point is.
    """
    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    rim_payload, rim_id = _save_process(erp_client)
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    kwargs = {"primaryColorAxis": frame_payload["outputItemName"]}
    kwargs.update(overrides)
    downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": rim_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
        **kwargs,
    )
    return (
        downstream_payload,
        downstream_id,
        frame_payload["outputItemName"],
        rim_payload["outputItemName"],
    )


def test_save_process_requires_explicit_primary_axis_when_two_or_more_axes_exist(
    erp_client,
):
    """The replacement for the old default-when-blank behavior: 2+
    independent axes is a real choice (which one's checked quantities
    become the lot's total), so saveProcess now rejects a blank Primary
    Axis outright instead of silently picking the first axis in recipe
    order.
    """
    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    rim_payload, rim_id = _save_process(erp_client)
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    resp = _rpc(
        erp_client,
        "saveProcess",
        [
            {
                "processName": _unique_name("Process"),
                "lotPrefix": uuid.uuid4().hex[:6].upper(),
                "outputItemName": _unique_name("Output"),
                "sequence": 1,
                "isFinalStage": False,
                "active": True,
                "remarks": "",
                "processType": "",
                "primaryColorAxis": "",
                "colorLinks": [],
                "components": [
                    {
                        "itemName": frame_payload["outputItemName"],
                        "qtyPerUnit": 1,
                        "sourceType": "POOL",
                        "colorGroup": "COMMON",
                    },
                    {
                        "itemName": rim_payload["outputItemName"],
                        "qtyPerUnit": 1,
                        "sourceType": "POOL",
                        "colorGroup": "COMMON",
                    },
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "Primary Axis" in body["message"]


def test_save_process_leaves_primary_axis_blank_when_no_axes_exist(erp_client):
    _payload, process_id = _save_process(erp_client)
    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    saved = next(p for p in listed if p["processId"] == process_id)
    assert saved["primaryColorAxis"] == ""


def test_save_process_does_not_override_an_explicitly_set_primary_axis(erp_client):
    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    rim_payload, rim_id = _save_process(erp_client)
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        primaryColorAxis=rim_payload["outputItemName"],
        components=[
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": rim_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    saved = next(p for p in listed if p["processId"] == downstream_id)
    assert saved["primaryColorAxis"] == rim_payload["outputItemName"]


def test_save_production_defaults_unconfigured_primary_axis_prevents_double_counting(
    erp_client,
):
    """Regression for the exact bug the Color Axes feature exists to fix:
    with a Primary Color Axis configured on the process (via
    _two_axis_downstream's explicit choice at save time) but nothing
    resubmitted on this particular lot, a multi-axis lot must count only
    its primary-axis rows, not every checked row across every axis.
    """
    downstream_payload, downstream_id, frame_output, rim_output = _two_axis_downstream(
        erp_client
    )
    frame_key = f"pool:{frame_output.lower()}"
    rim_key = f"pool:{rim_output.lower()}"

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": downstream_id,
                "assignedTo": "Worker A",
                # No primaryColorAxis submitted -- and the process's own
                # cell is still blank at the time this save resolves it.
                "colorBreakdown": [
                    {
                        "color": "Black",
                        "qty": 5,
                        "countsTowardTotal": True,
                        "axisKey": frame_key,
                    },
                    {
                        "color": "Red",
                        "qty": 7,
                        "countsTowardTotal": True,
                        "axisKey": rim_key,
                    },
                ],
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    listed = _rpc(erp_client, "getProductionData").get_json()["data"]
    lot = next(r for r in listed if r["lotNumber"] == body["data"]["lotNumber"])
    # Frame (axes[0], first in recipe order) is primary -- only its 5 units
    # count, NOT 5+7=12 (the pre-fix double-counted total).
    assert lot["qty"] == 5


def test_save_production_writes_resolved_default_axis_back_onto_process(
    erp_app, erp_client
):
    """When the process's own Primary Color Axis cell is genuinely blank
    at production-save time (e.g. a process created before this feature
    existed, simulated here by clearing it directly via SQL after
    creation), saveProduction now requires the operator to pick one right
    on this lot -- and that pick is written back onto the process, same as
    configuring it by hand in the Process editor, or via
    refresh_process_primary_color_axes in bulk -- so later lots and the
    Process editor's own picker see it filled in without needing a
    Process-editor save first.
    """
    downstream_payload, downstream_id, frame_output, rim_output = _two_axis_downstream(
        erp_client
    )
    with erp_app.app_context(), database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.process_master SET primary_color_axis = '' WHERE lower(process_id) = lower(%s)",
            (downstream_id,),
        )

    before = _rpc(erp_client, "getProcessData").get_json()["data"]
    assert (
        next(p for p in before if p["processId"] == downstream_id)["primaryColorAxis"]
        == ""
    )

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": downstream_id,
                "assignedTo": "Worker A",
                "primaryColorAxis": frame_output,
                "colorBreakdown": [
                    {
                        "color": "Black",
                        "qty": 4,
                        "countsTowardTotal": True,
                        "axisKey": f"pool:{frame_output.lower()}",
                    },
                    {
                        "color": "Red",
                        "qty": 3,
                        "countsTowardTotal": True,
                        "axisKey": f"pool:{rim_output.lower()}",
                    },
                ],
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True, resp.get_json()["message"]

    after = _rpc(erp_client, "getProcessData").get_json()["data"]
    assert (
        next(p for p in after if p["processId"] == downstream_id)["primaryColorAxis"]
        == frame_output
    )


def test_save_production_requires_primary_axis_pick_when_process_has_no_default(
    erp_app, erp_client
):
    """The other half of the write-back test above: with the process's own
    cell genuinely blank AND nothing picked on this lot either, saveProduction
    now rejects the save instead of silently defaulting to the first axis in
    recipe order -- closing the one gap left after save_process started
    requiring an explicit choice (a process saved before that existed).
    """
    downstream_payload, downstream_id, frame_output, rim_output = _two_axis_downstream(
        erp_client
    )
    with erp_app.app_context(), database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.process_master SET primary_color_axis = '' WHERE lower(process_id) = lower(%s)",
            (downstream_id,),
        )

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": downstream_id,
                "assignedTo": "Worker A",
                "colorBreakdown": [
                    {
                        "color": "Black",
                        "qty": 4,
                        "countsTowardTotal": True,
                        "axisKey": f"pool:{frame_output.lower()}",
                    },
                    {
                        "color": "Red",
                        "qty": 3,
                        "countsTowardTotal": True,
                        "axisKey": f"pool:{rim_output.lower()}",
                    },
                ],
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "Primary" in body["message"]


def test_refresh_process_primary_color_axes_backfills_unconfigured_process(
    erp_app, erp_client
):
    frame_payload, frame_id = _save_process(erp_client)
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")

    # A process saved with components but not through saveProcess's own
    # defaulting -- simulate a pre-existing row with a genuinely blank
    # cell by clearing it directly, the same state a process created
    # before this feature existed would be in.
    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
        ],
    )
    with erp_app.app_context(), database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.process_master SET primary_color_axis = '' WHERE lower(process_id) = lower(%s)",
            (downstream_id,),
        )

    with (
        erp_app.app_context(),
        database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
            _conn,
            cur,
        ),
    ):
        result = process_service.refresh_process_primary_color_axes(cur)

    assert result["filled"] >= 1
    assert any(downstream_id in d for d in result["details"])

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    saved = next(p for p in listed if p["processId"] == downstream_id)
    assert saved["primaryColorAxis"] == frame_payload["outputItemName"]


# ── GAS e37529e/1288076/6a22f0e regression coverage ──────────────────────
# Four small, independent fixes ported from the reference project's own
# post-verification-report commits, none caught by the tests above because
# every existing fixture happens to seed/author things in an order that
# coincidentally matches the buggy shortcut each bug actually took.


def test_axis_link_ref_lowercases_process_id():
    """_axis_link_ref must lowercase the Process ID half, not just the axis
    key -- a Process Color Link whose stored processId differs in case
    from the axis's own processId would otherwise fail to pair, and the
    axes cross-multiply instead of merging (GAS e37529e fixed this; before
    that fix only the axis key was lowercased).
    """
    assert process_service._axis_link_ref(
        "PRC-1001", "tag:rim color"
    ) == process_service._axis_link_ref("prc-1001", "TAG:RIM COLOR")
    assert process_service._axis_link_ref("PRC-1001") == process_service._axis_link_ref(
        "prc-1001"
    )


def test_duplicate_component_message_labels_common_case_insensitively(erp_client):
    """The duplicate-component error message must recognize a colorGroup of
    "common"/"Common" as Common Components, not a literal color sub-group
    named "common" -- same isCommonColorGroup fix as GAS e37529e (roughly a
    dozen exact `=== COMPONENT_COLOR_GROUP_COMMON` checks in module_process.js,
    including this exact message).
    """
    resp = _rpc(
        erp_client,
        "saveProcess",
        [
            {
                "processName": _unique_name("Process"),
                "lotPrefix": uuid.uuid4().hex[:6].upper(),
                "outputItemName": _unique_name("Output"),
                "sequence": 1,
                "isFinalStage": False,
                "active": True,
                "remarks": "",
                "processType": "",
                "primaryColorAxis": "",
                "colorLinks": [],
                "components": [
                    {
                        "itemName": "DupPart",
                        "qtyPerUnit": 1,
                        "sourceType": "ITEM",
                        "colorGroup": "common",
                    },
                    {
                        "itemName": "DupPart",
                        "qtyPerUnit": 1,
                        "sourceType": "ITEM",
                        "colorGroup": "Common",
                    },
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "Common Components" in body["message"]
    assert "color sub-group" not in body["message"]


def test_common_color_group_is_case_insensitive_in_legacy_list(erp_client):
    """A Color Sub-Group value of "Common" (not the exact "COMMON" sentinel
    spelling the app itself writes) must still be folded into Common
    Components rather than treated as a real color literally named
    "Common" -- which would invent a phantom color axis and leak "Common"
    itself into the flat color list (GAS e37529e's isCommonColorGroup fix).
    """
    _payload, process_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": "BasePart",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Common",
            }
        ],
    )

    groups = _rpc(erp_client, "getProcessColorGroups", [process_id]).get_json()["data"]
    assert groups == []


def test_chained_composite_single_color_still_counts_as_axis(erp_client):
    """A POOL-sourced recipe item with only ONE distinct color in Warehouse
    Pool normally does NOT count as a color axis (a fixed input, e.g. a
    Fitted Rim that's always Black, not a real per-output choice) -- but
    when that single color is ITSELF a composite (e.g. "Black / Red",
    produced by an upstream multi-axis process that has, so far, only ever
    produced ONE combination), excluding it would truncate the chain and
    silently discard everything the upstream stages already recorded (GAS
    1288076's _poolItemIsColorAxis exception).
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    _seed_pool(erp_client, upstream_id, 10, color="Black / Red")

    _downstream_payload, downstream_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"][
        "axes"
    ]
    assert len(axes) == 1
    assert axes[0]["colors"] == ["Black / Red"]

    groups = _rpc(erp_client, "getProcessColorGroups", [downstream_id]).get_json()[
        "data"
    ]
    assert groups == ["Black / Red"]


def test_axis_order_follows_recipe_row_order_not_pool_seed_order(erp_client):
    """computeColorAxesForProcess orders axes by the CONSUMING process's own
    recipe row order (GAS 1288076), not by whichever pool item's colors
    happened to land in Warehouse Pool first. Frame's pool colors are
    seeded before Rim's here, but the downstream recipe lists Rim BEFORE
    Frame -- the axis list (and so the composite color a lot is credited
    under) must still come back Rim-first, matching what the operator
    authored, not insertion order. Also proves saveProcess doesn't silently
    override an explicit Primary Axis choice with recipe order -- Rim is
    picked here even though nothing about "first in recipe order" forced it.
    """
    frame_payload, frame_id = _save_process(erp_client)
    rim_payload, rim_id = _save_process(erp_client)

    # Seeded Frame-then-Rim -- the OPPOSITE of the recipe order below.
    _seed_pool(erp_client, frame_id, 10, color="Black")
    _seed_pool(erp_client, frame_id, 10, color="Blue")
    _seed_pool(erp_client, rim_id, 10, color="Red")
    _seed_pool(erp_client, rim_id, 10, color="Green")

    # Recipe lists Rim before Frame.
    _downstream_payload, downstream_id = _save_process(
        erp_client,
        primaryColorAxis=rim_payload["outputItemName"],
        components=[
            {
                "itemName": rim_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": frame_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"][
        "axes"
    ]
    assert len(axes) == 2
    assert axes[0]["label"] == rim_payload["outputItemName"]
    assert axes[1]["label"] == frame_payload["outputItemName"]

    listed = _rpc(erp_client, "getProcessData").get_json()["data"]
    saved = next(p for p in listed if p["processId"] == downstream_id)
    assert saved["primaryColorAxis"] == rim_payload["outputItemName"]


def test_get_process_color_axes_reports_primary_is_default_when_unsaved(
    erp_app, erp_client
):
    """getProcessColorAxes falls back to axes[0] (recipe order) as the
    primary when the process's own cell is genuinely blank, and flags it
    via primaryIsDefault so the Process editor can tell a resolved default
    apart from an operator's own explicit choice (GAS 6a22f0e).
    """
    downstream_payload, downstream_id, frame_output, _rim_output = _two_axis_downstream(
        erp_client
    )
    with erp_app.app_context(), database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.process_master SET primary_color_axis = '' WHERE lower(process_id) = lower(%s)",
            (downstream_id,),
        )

    data = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()["data"]
    assert data["savedPrimaryColorAxis"] == ""
    assert data["primaryIsDefault"] is True
    assert data["primaryColorAxis"] == frame_output

    _edit_process(
        erp_client, downstream_payload, downstream_id, primaryColorAxis=frame_output
    )

    data_after = _rpc(erp_client, "getProcessColorAxes", [downstream_id]).get_json()[
        "data"
    ]
    assert data_after["primaryIsDefault"] is False
    assert data_after["savedPrimaryColorAxis"] == frame_output
