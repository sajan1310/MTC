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
            _rpc(
                erp_client,
                "saveWarehousePoolOpening",
                [{"processId": pid, "qty": 50, "color": color}],
                mutation=True,
            )
        upstream.append(payload["outputItemName"])

    down_payload, down_id = _save_process(
        erp_client,
        # save_process now REFUSES a 2+-axis process with no Primary Axis
        # (it is a real choice, not something to default silently). The
        # first axis in recipe order is exactly what it used to pick on
        # its own, so naming it here keeps every assertion below testing
        # the same behaviour it always did.
        primaryColorAxis=upstream[0],
        components=[
            {
                "itemName": name,
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            }
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
                "componentsConsumed": [
                    {"itemName": "RawMat", "qty": 1, "sourceType": "ITEM"}
                ],
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
        erp_client,
        down_id,
        upstream[0],
        [
            {
                "color": "Black",
                "qty": 10,
                "countsTowardTotal": True,
                "axisKey": _axis_key(upstream[0]),
            },
            {
                "color": "Red",
                "qty": 10,
                "countsTowardTotal": False,
                "axisKey": _axis_key(upstream[1]),
            },
            {
                "color": "Grey",
                "qty": 10,
                "countsTowardTotal": False,
                "axisKey": _axis_key(upstream[2]),
            },
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
        {
            "color": "Black",
            "qty": 4,
            "countsTowardTotal": True,
            "axisKey": _axis_key(upstream[0]),
        },
        {
            "color": "Red",
            "qty": 4,
            "countsTowardTotal": False,
            "axisKey": _axis_key(upstream[1]),
        },
        {
            "color": "Grey",
            "qty": 4,
            "countsTowardTotal": False,
            "axisKey": _axis_key(upstream[2]),
        },
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
        erp_client,
        down_id,
        upstream[0],
        [
            {
                "color": "Black",
                "qty": 10,
                "countsTowardTotal": True,
                "axisKey": _axis_key(upstream[0]),
            },
            {
                "color": "Red",
                "qty": 6,
                "countsTowardTotal": False,
                "axisKey": shared_axis,
            },
            {
                "color": "Green",
                "qty": 4,
                "countsTowardTotal": False,
                "axisKey": shared_axis,
            },
        ],
    )

    credited = _credited_buckets(erp_client, down_payload["outputItemName"])
    assert set(credited) == {"Black", "Red", "Green"}, (
        f"expected per-entry fallback, got {credited}"
    )


def test_composite_credit_one_bucket_per_primary_color(erp_client):
    """Two primary-axis entries produce two composite buckets, each
    carrying its own qty and each paired with the single independent axis
    value that applies to the whole lot.
    """
    down_payload, down_id, upstream = _three_axis_setup(erp_client)

    _save_lot(
        erp_client,
        down_id,
        upstream[0],
        [
            {
                "color": "Black",
                "qty": 6,
                "countsTowardTotal": True,
                "axisKey": _axis_key(upstream[0]),
            },
            {
                "color": "Blue",
                "qty": 4,
                "countsTowardTotal": True,
                "axisKey": _axis_key(upstream[0]),
            },
            {
                "color": "Red",
                "qty": 10,
                "countsTowardTotal": False,
                "axisKey": _axis_key(upstream[1]),
            },
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
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": g1_id, "qty": 50, "color": "Black"}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": g1_id, "qty": 50, "color": "Blue"}],
        mutation=True,
    )

    g2_payload, g2_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": g2_id, "qty": 50, "color": "Kraft"}],
        mutation=True,
    )
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": g2_id, "qty": 50, "color": "White"}],
        mutation=True,
    )

    # Parent combines G1 + G2 but has so far only ever produced ONE
    # combination -- its own bucket carries exactly one composite color.
    parent_payload, parent_id = _save_process(
        erp_client,
        # save_process now REFUSES a 2+-axis process with no Primary Axis
        # (it is a real choice, not something to default silently). The
        # first axis in recipe order is exactly what it used to pick on
        # its own, so naming it here keeps every assertion below testing
        # the same behaviour it always did.
        primaryColorAxis=g1_payload["outputItemName"],
        components=[
            {
                "itemName": g1_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": g2_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
        ],
    )
    g1_key = _axis_key(g1_payload["outputItemName"])
    g2_key = _axis_key(g2_payload["outputItemName"])
    _save_lot(
        erp_client,
        parent_id,
        g1_payload["outputItemName"],
        [
            {"color": "Black", "qty": 20, "countsTowardTotal": True, "axisKey": g1_key},
            {
                "color": "Kraft",
                "qty": 20,
                "countsTowardTotal": False,
                "axisKey": g2_key,
            },
        ],
    )
    assert set(_credited_buckets(erp_client, parent_payload["outputItemName"])) == {
        "Black / Kraft"
    }

    # Grandchild consumes parent's output as its only POOL component, plus
    # its own tag-based Seat Color axis.
    child_payload, child_id = _save_process(
        erp_client,
        # save_process now REFUSES a 2+-axis process with no Primary Axis
        # (it is a real choice, not something to default silently). The
        # first axis in recipe order is exactly what it used to pick on
        # its own, so naming it here keeps every assertion below testing
        # the same behaviour it always did.
        primaryColorAxis=parent_payload["outputItemName"],
        components=[
            {
                "itemName": parent_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "COMMON",
            },
            {
                "itemName": "SeatPartGrey",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Grey",
                "colorAxis": "Seat Color",
            },
            {
                "itemName": "SeatPartYellow",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Yellow",
                "colorAxis": "Seat Color",
            },
        ],
    )

    axes = _rpc(erp_client, "getProcessColorAxes", [child_id]).get_json()["data"][
        "axes"
    ]
    pool_axes = [a for a in axes if a["source"] == "pool"]
    assert len(pool_axes) == 1, (
        f"parent's single composite color was dropped as a non-axis: {axes}"
    )
    assert pool_axes[0]["colors"] == ["Black / Kraft"]

    # The chain actually saves: a lot combining the inherited composite
    # with the child's own axis is accepted (pre-fix this raises "not a
    # configured color sub-group" because "Black / Kraft" was never a
    # recognized color once its axis got excluded), and credits a THREE
    # -segment bucket -- the inherited history was carried forward, not
    # dropped.
    parent_key = _axis_key(parent_payload["outputItemName"])
    _save_lot(
        erp_client,
        child_id,
        parent_payload["outputItemName"],
        [
            {
                "color": "Black / Kraft",
                "qty": 5,
                "countsTowardTotal": True,
                "axisKey": parent_key,
            },
            {
                "color": "Grey",
                "qty": 5,
                "countsTowardTotal": False,
                "axisKey": "tag:seat color",
            },
        ],
    )
    assert set(_credited_buckets(erp_client, child_payload["outputItemName"])) == {
        "Black / Kraft / Grey"
    }


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
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": upstream_id, "qty": 50}],
        mutation=True,
    )

    down_payload, down_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "common",
            },
            {
                "itemName": "FramePartRed",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Red",
                "colorAxis": "Frame Color",
            },
            {
                "itemName": "FramePartBlue",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Blue",
                "colorAxis": "Frame Color",
            },
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
                "colorBreakdown": [
                    {
                        "color": "Red",
                        "qty": 5,
                        "countsTowardTotal": True,
                        "axisKey": "tag:frame color",
                    }
                ],
                "componentsConsumed": [
                    {
                        "itemName": upstream_payload["outputItemName"],
                        "qty": 3,
                        "sourceType": "POOL",
                        "colorGroup": "common",
                    }
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    upstream_bucket = next(
        b
        for b in pool
        if b["outputItemName"] == upstream_payload["outputItemName"] and not b["color"]
    )
    assert upstream_bucket["consumedQty"] == 3


def test_independent_axis_survives_name_collision_with_a_primary_color(erp_client):
    """A non-primary axis whose colour merely LOOKS like part of a primary
    colour must still be paired into the composite bucket when the two
    entries carry different real axis keys.

    Regression for LOT-FTD001-0012 (process PRC-1008, "Fitting Frame 14
    inch Crysta S/Rim"). That lot's frame axis included "Red-Black" and
    its rim axis was "Black". _color_names_match("Red-Black", "Black") is
    True on the hyphen-segment heuristic, so the rim entry was judged a
    mirror of the primary and dropped -- and because the test is any()
    across EVERY primary colour, that single collision stripped "/ Black"
    from all six buckets the lot credited, not just the colliding one.

    The lot therefore landed under bare frame-colour names
    ("Orange-White" rather than "Orange-White / Black"), splitting 42
    units away from the "... / Black" buckets every previous lot on that
    process had used, and driving "Pink-White" to a negative available qty
    as downstream consumption kept debiting the composite name.

    The heuristic exists for legacy entries that carry no axis identity at
    all; when both sides DO carry a real axisKey and they differ, the axes
    are structurally known to be distinct and the name must not overrule
    that. test_composite_credit_combines_three_independent_axes and
    test_warehouse.py's own single-independent-entry tests pin the
    no-axisKey path that still relies on the name comparison.
    """
    frame_payload, frame_id = _save_process(erp_client)
    for color in ("Blue-Sky Blue", "Red-Black"):
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": frame_id, "qty": 50, "color": color}],
            mutation=True,
        )

    rim_payload, rim_id = _save_process(erp_client)
    for color in ("Black", "Chrome"):
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": rim_id, "qty": 50, "color": color}],
            mutation=True,
        )

    down_payload, down_id = _save_process(
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

    frame_key = _axis_key(frame_payload["outputItemName"])
    rim_key = _axis_key(rim_payload["outputItemName"])
    _save_lot(
        erp_client,
        down_id,
        frame_payload["outputItemName"],
        [
            # "Blue-Sky Blue" does not collide; "Red-Black" does. Pre-fix,
            # the second one alone was enough to strip the rim from BOTH.
            {
                "color": "Blue-Sky Blue",
                "qty": 7,
                "countsTowardTotal": True,
                "axisKey": frame_key,
            },
            {
                "color": "Red-Black",
                "qty": 7,
                "countsTowardTotal": True,
                "axisKey": frame_key,
            },
            {
                "color": "Black",
                "qty": 14,
                "countsTowardTotal": False,
                "axisKey": rim_key,
            },
        ],
    )

    assert _credited_buckets(erp_client, down_payload["outputItemName"]) == {
        "Blue-Sky Blue / Black": 7,
        "Red-Black / Black": 7,
    }


def test_mirror_axis_without_axis_keys_still_folds_by_name(erp_client):
    """The name heuristic is unchanged for entries carrying no axisKey --
    the legacy shape it was written for. A non-primary entry that restates
    the primary ("Blue" against "Blue-White") is still folded away rather
    than paired in, so the axisKey rule above narrows the heuristic
    without removing it.
    """
    frame_payload, frame_id = _save_process(erp_client)
    for color in ("Blue-White", "Red-White"):
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": frame_id, "qty": 50, "color": color}],
            mutation=True,
        )

    rim_payload, rim_id = _save_process(erp_client)
    for color in ("Blue", "Green"):
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": rim_id, "qty": 50, "color": color}],
            mutation=True,
        )

    down_payload, down_id = _save_process(
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

    _save_lot(
        erp_client,
        down_id,
        frame_payload["outputItemName"],
        [
            {"color": "Blue-White", "qty": 10, "countsTowardTotal": True},
            {"color": "Blue", "qty": 10, "countsTowardTotal": False},
        ],
    )

    assert _credited_buckets(erp_client, down_payload["outputItemName"]) == {
        "Blue-White": 10
    }


def test_pool_consumption_resolves_token_against_hyphenated_bucket(erp_client):
    """A recipe Color Sub-Group naming part of a hyphenated colour must debit
    the real bucket, not open a phantom one.

    _resolve_composite_color_token only ever matched a WHOLE delimiter
    segment of a COMPOSITE bucket. A non-composite bucket like "Pink-White"
    carries no delimiter at all and was skipped outright, so a recipe scoped
    to "Pink" opened a debit-only bucket that no credit ever balanced --
    which is where live data grew rows such as ("Fitted Frame 16 inch Scooby
    S/Rim", "Pink", consumed 20, produced 0). The fallback now uses the same
    hyphen/slash-segment heuristic Pass 1 folds mirror axes with, so the
    credit and debit sides agree on when two names describe one colour.
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    for color in ("Pink-White", "Blue-White"):
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": upstream_id, "qty": 50, "color": color}],
            mutation=True,
        )

    # Downstream carries its own tag axis (Pink/Blue) AND consumes the
    # upstream pool item scoped to the bare token "Pink" -- a hyphen segment
    # of the real "Pink-White" bucket.
    down_payload, down_id = _save_process(
        erp_client,
        primaryColorAxis="Seat Color",
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "Pink",
            },
            {
                "itemName": "SeatPink",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Pink",
                "colorAxis": "Seat Color",
            },
            {
                "itemName": "SeatBlue",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "Blue",
                "colorAxis": "Seat Color",
            },
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
                "primaryColorAxis": "Seat Color",
                "colorBreakdown": [
                    {
                        "color": "Pink",
                        "qty": 5,
                        "countsTowardTotal": True,
                        "axisKey": "tag:seat color",
                    }
                ],
                "componentsConsumed": [
                    {
                        "itemName": upstream_payload["outputItemName"],
                        "qty": 5,
                        "sourceType": "POOL",
                        "colorGroup": "Pink",
                    }
                ],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True, resp.get_json()["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    mine = [
        b for b in pool if b["outputItemName"] == upstream_payload["outputItemName"]
    ]
    pink = next(b for b in mine if b["color"] == "Pink-White")
    assert pink["consumedQty"] == 5, "the real bucket should carry the debit"
    assert pink["availableQty"] == 45
    assert not any(b["color"] == "Pink" for b in mine), (
        "phantom bare-token bucket was opened"
    )


def test_consumption_only_bucket_is_attributed_to_its_producing_process(erp_client):
    """A bucket that only consumption ever opens must still name the process
    that produces the item.

    Pass 2 used to pass "" as the process id, and the Warehouse Pool table
    joins pool rows to processes by exact processId
    (stock.js#computeLeafRowsForProcess), so such a row matched no process
    and was never rendered -- real consumption hidden rather than shown as
    the negative balance it is. Live data held 31 of these, netting -557.
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": upstream_id, "qty": 10, "color": "Black"}],
        mutation=True,
    )

    # "Grey" matches no bucket on the upstream item, so Pass 2 has to open
    # one by itself -- the unresolvable case that used to go in blank.
    down_payload, down_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "Grey",
            }
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
                "colorBreakdown": [
                    {"color": "Grey", "qty": 4, "countsTowardTotal": True}
                ],
                "componentsConsumed": [
                    {
                        "itemName": upstream_payload["outputItemName"],
                        "qty": 4,
                        "sourceType": "POOL",
                        "colorGroup": "Grey",
                    }
                ],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True, resp.get_json()["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    grey = next(
        b
        for b in pool
        if b["outputItemName"] == upstream_payload["outputItemName"]
        and b["color"] == "Grey"
    )
    assert grey["consumedQty"] == 4
    assert grey["availableQty"] == -4
    assert grey["processId"] == upstream_id, (
        "debit-only bucket must name its producing process"
    )


def test_component_scoped_to_hyphen_segment_of_lot_colour_is_kept(erp_client):
    """A recipe row whose Color Sub-Group is a hyphen segment of the lot's
    own colour must survive save_production's colour filter.

    That filter split the lot's colours only on COLOR_COMBO_DELIMITER, so it
    recognised an axis value inside a composite ("Black" in "Pink-White /
    Black") but not a segment of a single hyphenated one: a component scoped
    to "Pink" on a lot logged as "Pink-White" was dropped, the consumption
    was never written, and Warehouse Pool Pass 2 never debited for it. When
    it was the lot's only component the save failed with "At least one
    component consumed is required for this lot" -- naming the wrong cause
    entirely.
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    for color in ("Pink-White", "Blue-White"):
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": upstream_id, "qty": 50, "color": color}],
            mutation=True,
        )

    _down_payload, down_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "Pink",
            }
        ],
    )

    # The lot's only component is the "Pink"-scoped one, and the lot's colour
    # is "Pink-White" -- pre-fix this raised the misleading "at least one
    # component" error instead of saving.
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "status": "Completed",
                "colorBreakdown": [
                    {
                        "color": "Pink-White",
                        "qty": 6,
                        "countsTowardTotal": True,
                        "axisKey": _axis_key(upstream_payload["outputItemName"]),
                    }
                ],
                "componentsConsumed": [
                    {
                        "itemName": upstream_payload["outputItemName"],
                        "qty": 6,
                        "sourceType": "POOL",
                        "colorGroup": "Pink",
                    }
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    # The component was kept...
    consumed = body["data"]["row"]["componentsConsumed"]
    assert [c["itemName"] for c in consumed] == [upstream_payload["outputItemName"]]
    assert consumed[0]["qty"] == 6

    # ...and Pass 2 debited the real upstream bucket for it.
    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    pink = next(
        b
        for b in pool
        if b["outputItemName"] == upstream_payload["outputItemName"]
        and b["color"] == "Pink-White"
    )
    assert pink["consumedQty"] == 6
    assert pink["availableQty"] == 44


def test_component_scoped_to_a_colour_the_lot_did_not_make_is_still_dropped(erp_client):
    """The widened match must not turn the colour filter into a no-op: a
    component scoped to a sub-group that shares no segment with any colour
    this lot produced is still excluded, exactly as before.
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    for color in ("Pink-White", "Blue-White"):
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": upstream_id, "qty": 50, "color": color}],
            mutation=True,
        )

    _down_payload, down_id = _save_process(
        erp_client,
        components=[
            {
                "itemName": upstream_payload["outputItemName"],
                "qtyPerUnit": 1,
                "sourceType": "POOL",
                "colorGroup": "Pink",
            },
            {
                "itemName": "RawMat",
                "qtyPerUnit": 1,
                "sourceType": "ITEM",
                "colorGroup": "COMMON",
            },
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
                "colorBreakdown": [
                    {
                        "color": "Pink-White",
                        "qty": 6,
                        "countsTowardTotal": True,
                        "axisKey": _axis_key(upstream_payload["outputItemName"]),
                    }
                ],
                "componentsConsumed": [
                    {
                        "itemName": upstream_payload["outputItemName"],
                        "qty": 6,
                        "sourceType": "POOL",
                        "colorGroup": "Pink",
                    },
                    # "Blue" shares no segment with "Pink-White" -- must be dropped.
                    {
                        "itemName": "WrongColourPart",
                        "qty": 3,
                        "sourceType": "ITEM",
                        "colorGroup": "Blue",
                    },
                    {
                        "itemName": "RawMat",
                        "qty": 1,
                        "sourceType": "ITEM",
                        "colorGroup": "COMMON",
                    },
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]

    names = sorted(c["itemName"] for c in body["data"]["row"]["componentsConsumed"])
    assert names == sorted([upstream_payload["outputItemName"], "RawMat"]), (
        "a component scoped to an unproduced colour leaked through the filter"
    )


def _common_consumer(erp_client, upstream_payload, lot_colour, consume_qty):
    """Downstream process consuming the upstream pool item as COMMON, and one
    Completed lot against it. Returns the upstream item's bucket map."""
    _down_payload, down_id = _save_process(
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
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "status": "Completed",
                "colorBreakdown": [
                    {
                        "color": lot_colour,
                        "qty": 1,
                        "countsTowardTotal": True,
                        "axisKey": _axis_key(upstream_payload["outputItemName"]),
                    }
                ],
                "componentsConsumed": [
                    {
                        "itemName": upstream_payload["outputItemName"],
                        "qty": consume_qty,
                        "sourceType": "POOL",
                        "colorGroup": "COMMON",
                    }
                ],
            }
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    return {
        b["color"]: b
        for b in pool
        if b["outputItemName"] == upstream_payload["outputItemName"]
    }


def test_common_consumption_drains_coloured_buckets_when_there_is_no_blank_credit(
    erp_client,
):
    """A COMMON component against a colour-tracked upstream item must drain
    the real coloured buckets, not sink a blank-colour bucket that can never
    hold stock.

    "COMMON" means "consumes the item whatever colour it is", and it used to
    debit only the blank-colour bucket. But where the upstream item is
    colour-tracked, EVERY credit lands in a NAMED bucket and the blank one is
    never credited at all -- so the debit sank a bucket with nothing in it
    while the real coloured stock never drained. Live data showed this as
    ("Fitted Rim 20 inch Mega Hub Black", blank, -111) sitting alongside
    ("...", "Black", 105 available): two wrong numbers describing one real
    situation.

    Pass 3 already settles the identical shape for Dispatch, which likewise
    carries no colour of its own. This mirrors it.
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    for color in ("Black", "Blue"):
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": upstream_id, "qty": 50, "color": color}],
            mutation=True,
        )

    buckets = _common_consumer(erp_client, upstream_payload, "Black", 60)

    # 60 consumed against 50 Black + 50 Blue: drained in canonical colour
    # order, so Black empties and Blue gives up the remaining 10.
    assert buckets["Black"]["availableQty"] == 0
    assert buckets["Blue"]["availableQty"] == 40
    # No blank-colour sink was opened at all.
    assert "" not in buckets or buckets[""]["availableQty"] == 0
    assert sum(b["consumedQty"] for b in buckets.values()) == 60


def test_common_consumption_beyond_all_colour_stock_stays_visible_as_negative(
    erp_client,
):
    """A genuine over-consumption must still surface as a negative rather
    than being silently absorbed -- the drain reassigns where a debit lands,
    it never discards one. The shortfall lands on the blank bucket so the
    total debited still equals the total consumed.
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    for color in ("Black", "Blue"):
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": upstream_id, "qty": 50, "color": color}],
            mutation=True,
        )

    buckets = _common_consumer(erp_client, upstream_payload, "Black", 120)

    assert buckets["Black"]["availableQty"] == 0
    assert buckets["Blue"]["availableQty"] == 0
    assert buckets[""]["availableQty"] == -20, "true shortfall must remain visible"
    assert sum(b["consumedQty"] for b in buckets.values()) == 120


def test_common_consumption_still_takes_a_real_blank_bucket_first(erp_client):
    """Where the upstream item genuinely has colourless stock, nothing
    changes: the blank bucket is consumed first and the coloured buckets are
    left alone. The drain is a fallback for the shortfall, not a new default.
    """
    upstream_payload, upstream_id = _save_process(erp_client)
    # Colourless opening balance -- allowed because this process has no known
    # colours yet, so the blank bucket carries real stock.
    _rpc(
        erp_client,
        "saveWarehousePoolOpening",
        [{"processId": upstream_id, "qty": 30}],
        mutation=True,
    )

    _down_payload, down_id = _save_process(
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
    resp = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": down_id,
                "assignedTo": "Worker A",
                "qty": 5,
                "status": "Completed",
                "componentsConsumed": [
                    {
                        "itemName": upstream_payload["outputItemName"],
                        "qty": 12,
                        "sourceType": "POOL",
                        "colorGroup": "COMMON",
                    }
                ],
            }
        ],
        mutation=True,
    )
    assert resp.get_json()["success"] is True, resp.get_json()["message"]

    pool = _rpc(erp_client, "getWarehousePoolData").get_json()["data"]
    blank = next(
        b
        for b in pool
        if b["outputItemName"] == upstream_payload["outputItemName"] and not b["color"]
    )
    assert blank["consumedQty"] == 12
    assert blank["availableQty"] == 18
