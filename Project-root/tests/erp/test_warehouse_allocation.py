"""Explicit cross-axis allocation ("splits") on a production lot.

Pass 1 infers a lot's composite bucket colors from its colorBreakdown,
and deliberately refuses to when the pairing is underdetermined -- two
primary colors against a two-value rim axis have many readings that all
satisfy the row and column totals, and no rule over the stored numbers
can pick the right one (see
test_warehouse_composite.test_composite_credit_falls_back_when_one_axis_is_ambiguous).

Which frame got which rim is a fact about the shop floor, so the fix is
to record it rather than to guess harder. A primary entry may carry
`splits` -- cells of {qty, axes} saying how much of THAT color went with
a given value of another axis. This file pins that path, and pins that a
lot carrying no splits still behaves exactly as it did before.
"""

from __future__ import annotations

from .test_warehouse import _rpc
from .test_warehouse_composite import (
    _axis_key,
    _credited_buckets,
    _save_lot,
    _three_axis_setup,
)


def _cell(qty, axis_key, color):
    return {"qty": qty, "axes": {axis_key: color}}


def _ambiguous_breakdown(upstream, black_split, blue_split):
    """The shape Pass 1 cannot infer: two primary colors AND a two-value
    independent axis. `black_split`/`blue_split` are (red, green) pairs
    allocating each primary color across that axis.
    """
    primary, split_axis = _axis_key(upstream[0]), _axis_key(upstream[1])
    return [
        {
            "color": "Black",
            "qty": sum(black_split),
            "countsTowardTotal": True,
            "axisKey": primary,
            "splits": [
                _cell(black_split[0], split_axis, "Red"),
                _cell(black_split[1], split_axis, "Green"),
            ],
        },
        {
            "color": "Blue",
            "qty": sum(blue_split),
            "countsTowardTotal": True,
            "axisKey": primary,
            "splits": [
                _cell(blue_split[0], split_axis, "Red"),
                _cell(blue_split[1], split_axis, "Green"),
            ],
        },
        {
            "color": "Red",
            "qty": black_split[0] + blue_split[0],
            "countsTowardTotal": False,
            "axisKey": split_axis,
        },
        {
            "color": "Green",
            "qty": black_split[1] + blue_split[1],
            "countsTowardTotal": False,
            "axisKey": split_axis,
        },
    ]


def _save_lot_raw(erp_client, down_id, primary_axis, color_breakdown):
    """_save_lot without its success assertion -- for the rejection tests."""
    return _rpc(
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
    ).get_json()


def test_allocation_credits_a_bucket_per_cell(erp_client):
    """The headline case. Four cells across a 2x2 grid become four
    composite buckets, each carrying its own cell quantity -- where the
    same lot without splits would credit four bare single-color buckets.
    """
    down_payload, down_id, upstream = _three_axis_setup(erp_client)

    _save_lot(
        erp_client,
        down_id,
        upstream[0],
        _ambiguous_breakdown(upstream, black_split=(4, 2), blue_split=(1, 3)),
    )

    credited = _credited_buckets(erp_client, down_payload["outputItemName"])
    assert credited == {
        "Black / Red": 4,
        "Black / Green": 2,
        "Blue / Red": 1,
        "Blue / Green": 3,
    }, credited


def test_lot_without_splits_is_unchanged(erp_client):
    """The additive guarantee: strip the allocation off the very same
    breakdown and the old per-entry fallback returns, byte for byte. This
    is what makes deploying the feature a no-op for existing history.
    """
    down_payload, down_id, upstream = _three_axis_setup(erp_client)

    breakdown = _ambiguous_breakdown(upstream, black_split=(4, 2), blue_split=(1, 3))
    for entry in breakdown:
        entry.pop("splits", None)
    _save_lot(erp_client, down_id, upstream[0], breakdown)

    credited = _credited_buckets(erp_client, down_payload["outputItemName"])
    assert credited == {"Black": 6, "Blue": 4, "Red": 5, "Green": 5}, credited


def test_allocation_shares_one_bucket_with_an_inferred_lot(erp_client):
    """An allocated lot and an inferred lot describing the SAME real
    combination must land in ONE bucket. The allocated path synthesizes
    its cell entries rather than composing names itself precisely so both
    go through the same canonical recipe-order sort -- otherwise the
    feature would split the very stock it exists to keep together.
    """
    down_payload, down_id, upstream = _three_axis_setup(erp_client)
    primary, split_axis = _axis_key(upstream[0]), _axis_key(upstream[1])

    # Allocated: 6 Black, all of it on Red.
    _save_lot(
        erp_client,
        down_id,
        upstream[0],
        [
            {
                "color": "Black",
                "qty": 6,
                "countsTowardTotal": True,
                "axisKey": primary,
                "splits": [_cell(6, split_axis, "Red")],
            },
            {
                "color": "Red",
                "qty": 6,
                "countsTowardTotal": False,
                "axisKey": split_axis,
            },
        ],
    )
    # Inferred: 4 Black against a single-value Red axis -- unambiguous, so
    # Pass 1 composes "Black / Red" on its own.
    _save_lot(
        erp_client,
        down_id,
        upstream[0],
        [
            {
                "color": "Black",
                "qty": 4,
                "countsTowardTotal": True,
                "axisKey": primary,
            },
            {
                "color": "Red",
                "qty": 4,
                "countsTowardTotal": False,
                "axisKey": split_axis,
            },
        ],
    )

    credited = _credited_buckets(erp_client, down_payload["outputItemName"])
    assert credited == {"Black / Red": 10}, credited


def test_allocation_still_pairs_in_a_fixed_third_axis(erp_client):
    """An axis that is not being split holds one value for the whole lot,
    so it belongs in every cell's bucket name -- the same treatment the
    inference gives it.
    """
    down_payload, down_id, upstream = _three_axis_setup(erp_client)

    breakdown = _ambiguous_breakdown(upstream, black_split=(4, 2), blue_split=(1, 3))
    breakdown.append(
        {
            "color": "Grey",
            "qty": 10,
            "countsTowardTotal": False,
            "axisKey": _axis_key(upstream[2]),
        }
    )
    _save_lot(erp_client, down_id, upstream[0], breakdown)

    credited = _credited_buckets(erp_client, down_payload["outputItemName"])
    assert credited == {
        "Black / Red / Grey": 4,
        "Black / Green / Grey": 2,
        "Blue / Red / Grey": 1,
        "Blue / Green / Grey": 3,
    }, credited


def test_allocation_that_does_not_add_up_is_rejected(erp_client):
    """A row whose cells miss that color's own quantity is refused at save,
    while the numbers are still on screen -- rather than silently falling
    back and discarding work the operator can no longer see.
    """
    _, down_id, upstream = _three_axis_setup(erp_client)

    breakdown = _ambiguous_breakdown(upstream, black_split=(4, 2), blue_split=(1, 3))
    breakdown[0]["splits"][0]["qty"] = 1  # Black now allocates 3 of its 6

    body = _save_lot_raw(erp_client, down_id, upstream[0], breakdown)
    assert body["success"] is False
    assert "adds up to 3" in body["message"], body["message"]
    assert "Black" in body["message"], body["message"]


def test_half_filled_allocation_is_rejected(erp_client):
    """An allocation describes the whole lot or none of it: one primary
    color left unallocated is an error, not a partial credit.
    """
    _, down_id, upstream = _three_axis_setup(erp_client)

    breakdown = _ambiguous_breakdown(upstream, black_split=(4, 2), blue_split=(1, 3))
    del breakdown[1]["splits"]  # Blue left unallocated

    body = _save_lot_raw(erp_client, down_id, upstream[0], breakdown)
    assert body["success"] is False
    assert "incomplete" in body["message"].lower(), body["message"]
    assert "Blue" in body["message"], body["message"]
