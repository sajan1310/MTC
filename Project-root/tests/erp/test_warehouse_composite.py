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
