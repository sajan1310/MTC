"""Composite color engine tests, ported behavior from Apps_Script's
module_warehouse.js (_composeLotColorKey / _colorOrderKey) and
module_process.js (getAxisOrderByProcess) -- GAS e37529e / 1288076 /
20815ee.

Warehouse Pool Pass 1 credits ONE composite bucket per primary color,
pairing in every genuinely independent axis, using a canonical segment
order taken from the process's own recipe rather than colorBreakdown
array order. Kept separate from test_warehouse.py, which pins the
pre-composite single-independent-entry behavior that still holds for
lots carrying no axis keys.
"""

from __future__ import annotations

from .test_warehouse import _rpc, _save_process


def _three_axis_setup(erp_client):
    """Downstream process consuming three upstream pool items, so its own
    recipe defines three color axes in a known order. Returns
    (down_payload, down_id, [upstream output item names]).
    """
    upstream = []
    for colors in (("Black", "Blue"), ("Red", "Green"), ("Grey", "Kraft")):
        payload, pid = _save_process(erp_client)
        for color in colors:
            _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": pid, "qty": 50, "color": color}], mutation=True)
        upstream.append(payload["outputItemName"])

    down_payload, down_id = _save_process(
        erp_client,
        components=[
            {"itemName": name, "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"}
            for name in upstream
        ],
    )
    return down_payload, down_id, upstream


def _axis_key(output_item_name: str) -> str:
    return f"pool:{output_item_name.lower()}"


def _save_lot(erp_client, down_id, primary_axis, color_breakdown):
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "primaryColorAxis": primary_axis,
                "status": "Completed",
                "colorBreakdown": color_breakdown,
                "componentsConsumed": [{"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body


def _credited_buckets(erp_client, output_item_name) -> dict:
    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    return {
        b["color"]: b["producedQty"]
        for b in pool
        if b["outputItemName"] == output_item_name and b["producedQty"] > 0
    }


def test_composite_credit_combines_three_independent_axes(erp_client):
    """Two independent non-primary entries on DIFFERENT axes combine into
    one composite bucket. The old rule capped this at one independent
    entry and fell back to crediting each color separately.
    """
    down_payload, down_id, upstream = _three_axis_setup(erp_client)

    _save_lot(
        erp_client, down_id, upstream[0],
        [
            {"color": "Black", "qty": 10, "countsTowardTotal": True, "axisKey": _axis_key(upstream[0])},
            {"color": "Red", "qty": 10, "countsTowardTotal": False, "axisKey": _axis_key(upstream[1])},
            {"color": "Grey", "qty": 10, "countsTowardTotal": False, "axisKey": _axis_key(upstream[2])},
        ],
    )

    credited = _credited_buckets(erp_client, down_payload["outputItemName"])
    assert len(credited) == 1, f"expected one composite bucket, got {credited}"
    color, qty = next(iter(credited.items()))
    assert set(color.split(" / ")) == {"Black", "Red", "Grey"}
    assert qty == 10


def test_composite_credit_ignores_color_breakdown_array_order(erp_client):
    """Two lots naming the same real combination in different
    colorBreakdown order must land in ONE bucket, not split stock across
    two differently-ordered ones -- what the canonical ordering in
    _compose_lot_color_key exists to prevent.
    """
    down_payload, down_id, upstream = _three_axis_setup(erp_client)

    entries = [
        {"color": "Black", "qty": 4, "countsTowardTotal": True, "axisKey": _axis_key(upstream[0])},
        {"color": "Red", "qty": 4, "countsTowardTotal": False, "axisKey": _axis_key(upstream[1])},
        {"color": "Grey", "qty": 4, "countsTowardTotal": False, "axisKey": _axis_key(upstream[2])},
    ]
    _save_lot(erp_client, down_id, upstream[0], entries)
    # Same combination, reversed array order -- must NOT open a second bucket.
    _save_lot(erp_client, down_id, upstream[0], list(reversed(entries)))

    credited = _credited_buckets(erp_client, down_payload["outputItemName"])
    assert len(credited) == 1, f"stock split across {credited}"
    assert next(iter(credited.values())) == 8


def test_composite_credit_falls_back_when_one_axis_is_ambiguous(erp_client):
    """Two independent entries on the SAME axis give no way to tell which
    pairs with the primary, so crediting falls back to one bucket per
    entry -- the pre-composite behavior.
    """
    down_payload, down_id, upstream = _three_axis_setup(erp_client)
    shared_axis = _axis_key(upstream[1])

    _save_lot(
        erp_client, down_id, upstream[0],
        [
            {"color": "Black", "qty": 10, "countsTowardTotal": True, "axisKey": _axis_key(upstream[0])},
            {"color": "Red", "qty": 6, "countsTowardTotal": False, "axisKey": shared_axis},
            {"color": "Green", "qty": 4, "countsTowardTotal": False, "axisKey": shared_axis},
        ],
    )

    credited = _credited_buckets(erp_client, down_payload["outputItemName"])
    assert set(credited) == {"Black", "Red", "Green"}, f"expected per-entry fallback, got {credited}"


def test_composite_credit_one_bucket_per_primary_color(erp_client):
    """Two primary-axis entries produce two composite buckets, each
    carrying its own qty and each paired with the single independent axis
    value that applies to the whole lot.
    """
    down_payload, down_id, upstream = _three_axis_setup(erp_client)

    _save_lot(
        erp_client, down_id, upstream[0],
        [
            {"color": "Black", "qty": 6, "countsTowardTotal": True, "axisKey": _axis_key(upstream[0])},
            {"color": "Blue", "qty": 4, "countsTowardTotal": True, "axisKey": _axis_key(upstream[0])},
            {"color": "Red", "qty": 10, "countsTowardTotal": False, "axisKey": _axis_key(upstream[1])},
        ],
    )

    credited = _credited_buckets(erp_client, down_payload["outputItemName"])
    assert len(credited) == 2, f"expected one bucket per primary color, got {credited}"
    for color, qty in credited.items():
        segments = set(color.split(" / "))
        assert "Red" in segments, f"independent axis missing from {color}"
        assert qty == (6 if "Black" in segments else 4)


def test_chained_composite_pool_axis_is_not_truncated(erp_client):
    """A pool item that has settled into exactly ONE color, where that one
    color is ITSELF a composite inherited from upstream ("Black / Kraft"),
    must still be a valid, creditable axis two layers further downstream --
    excluding it (the pre-1288076 len(item_colors) <= 1 rule) silently
    drops the whole upstream chain history: saveProduction would reject the
    very color the parent lot was credited under as "not a configured
    color sub-group for this process", since its axis was never recognized
    at all. Ports module_process.js#_poolItemIsColorAxis (GAS 1288076).
    """
    g1_payload, g1_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": g1_id, "qty": 50, "color": "Black"}], mutation=True)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": g1_id, "qty": 50, "color": "Blue"}], mutation=True)

    g2_payload, g2_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": g2_id, "qty": 50, "color": "Kraft"}], mutation=True)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": g2_id, "qty": 50, "color": "White"}], mutation=True)

    # Parent combines G1 + G2 but has so far only ever produced ONE
    # combination -- its own bucket carries exactly one composite color.
    parent_payload, parent_id = _save_process(
        erp_client,
        components=[
            {"itemName": g1_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
            {"itemName": g2_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
        ],
    )
    g1_key = _axis_key(g1_payload["outputItemName"])
    g2_key = _axis_key(g2_payload["outputItemName"])
    _save_lot(
        erp_client, parent_id, g1_payload["outputItemName"],
        [
            {"color": "Black", "qty": 20, "countsTowardTotal": True, "axisKey": g1_key},
            {"color": "Kraft", "qty": 20, "countsTowardTotal": False, "axisKey": g2_key},
        ],
    )
    assert set(_credited_buckets(erp_client, parent_payload["outputItemName"])) == {"Black / Kraft"}

    # Grandchild consumes parent's output as its only POOL component, plus
    # its own tag-based Seat Color axis.
    child_payload, child_id = _save_process(
        erp_client,
        components=[
            {"itemName": parent_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "COMMON"},
            {"itemName": "SeatPartGrey", "qtyPerUnit": 1, "sourceType": "ITEM", "colorGroup": "Grey", "colorAxis": "Seat Color"},
            {"itemName": "SeatPartYellow", "qtyPerUnit": 1, "sourceType": "ITEM", "colorGroup": "Yellow", "colorAxis": "Seat Color"},
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [child_id]).get_json()["data"]["axes"]
    pool_axes = [a for a in axes if a["source"] == "pool"]
    assert len(pool_axes) == 1, f"parent's single composite color was dropped as a non-axis: {axes}"
    assert pool_axes[0]["colors"] == ["Black / Kraft"]

    # The chain actually saves: a lot combining the inherited composite
    # with the child's own axis is accepted (pre-fix this raises "not a
    # configured color sub-group" because "Black / Kraft" was never a
    # recognized color once its axis got excluded), and credits a THREE
    # -segment bucket -- the inherited history was carried forward, not
    # dropped.
    parent_key = _axis_key(parent_payload["outputItemName"])
    _save_lot(
        erp_client, child_id, parent_payload["outputItemName"],
        [
            {"color": "Black / Kraft", "qty": 5, "countsTowardTotal": True, "axisKey": parent_key},
            {"color": "Grey", "qty": 5, "countsTowardTotal": False, "axisKey": "tag:seat color"},
        ],
    )
    assert set(_credited_buckets(erp_client, child_payload["outputItemName"])) == {"Black / Kraft / Grey"}


def test_common_color_sub_group_case_insensitive_in_components_consumed(erp_client):
    """A POOL-sourced component whose Color Sub-Group was typed as
    "common" (lowercase) rather than the app's own "COMMON" spelling is
    still the COMMON sentinel, not a real color named "common" -- a
    case-sensitive compare drops it out of componentsConsumed entirely
    (understating, or here entirely skipping, Warehouse Pool Pass 2's
    debit for it). Ports GAS e37529e's isCommonColorGroup fix, at the one
    spot (save_production's colorBreakdown-driven component filter) this
    port had not yet routed through it.
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    _rpc(erp_client, "saveWarehousePoolOpening", [{"processId": upstream_id, "qty": 50}], mutation=True)

    down_payload, down_id = _save_process(
        erp_client,
        components=[
            {"itemName": upstream_payload["outputItemName"], "qtyPerUnit": 1, "sourceType": "POOL", "colorGroup": "common"},
            {"itemName": "FramePartRed", "qtyPerUnit": 1, "sourceType": "ITEM", "colorGroup": "Red", "colorAxis": "Frame Color"},
            {"itemName": "FramePartBlue", "qtyPerUnit": 1, "sourceType": "ITEM", "colorGroup": "Blue", "colorAxis": "Frame Color"},
        ],
    )

    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "status": "Completed",
                "colorBreakdown": [{"color": "Red", "qty": 5, "countsTowardTotal": True, "axisKey": "tag:frame color"}],
                "componentsConsumed": [
                    {"itemName": upstream_payload["outputItemName"], "qty": 3, "sourceType": "POOL", "colorGroup": "common"}
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    upstream_bucket = next(b for b in pool if b["outputItemName"] == upstream_payload["outputItemName"] and not b["color"])
    assert upstream_bucket["consumedQty"] == 3
