"""A POOL component can name the Warehouse Pool bucket it draws FROM,
separately from the lot colour it is consumed BY.

`colorGroup` had been answering both questions at once. For a recipe
component the two coincide -- you consume a Blue rib to make a Blue frame --
so nothing noticed. They come apart for a per-lot exception: a Blue mudguard
fitted to a lot that produces Purple-Wine. colorGroup must stay Purple-Wine
there, or save_production's own filter drops the component outright; the
debit still has to land on the pool's Blue bucket.

Before `poolColor`, neither table could express that. The Per-Color matrix
attributes to the column, so it would have tried to debit a Purple-Wine
mudguard bucket that does not exist. The Common table dropped the colour to
COMMON, and the recalculation settles COMMON by a greedy drain across
whichever buckets have room -- so the material came out of arbitrary
colours, with only a warning, and the Blue bucket could sit untouched.

What matters as much as the new capability is that nothing without the field
changes: every component ever written lacks it, and must attribute exactly
as before.
"""

from __future__ import annotations

import uuid

from app.erp.services import production_service


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers)


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _save_process(client):
    payload = {
        "processName": _unique_name("PoolColorProcess"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique_name("PoolColorOutput"),
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [],
        "colorLinks": [],
    }
    resp = _rpc(client, "saveProcess", [payload], mutation=True)
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body["data"]["processId"]


# ── The resolver itself ──────────────────────────────────────────────────


def test_pool_color_wins_when_present():
    assert production_service._pool_bucket_color(
        {"colorGroup": "Purple-Wine", "poolColor": "Blue"}
    ) == "Blue"


def test_falls_back_to_colorgroup_when_absent():
    """Every component written before this field existed. Their attribution
    must be untouched, which is the whole basis for adding a field rather
    than reinterpreting one.
    """
    assert production_service._pool_bucket_color({"colorGroup": "Blue"}) == "Blue"
    assert production_service._pool_bucket_color({"colorGroup": "Blue", "poolColor": ""}) == "Blue"
    assert production_service._pool_bucket_color({"colorGroup": "Blue", "poolColor": "   "}) == "Blue"


def test_a_components_free_text_color_is_not_a_bucket():
    """The Common table's Color column has always been descriptive, and two
    live lots carry a value in it. Reading it as a bucket would silently
    re-attribute them.
    """
    assert production_service._pool_bucket_color({"colorGroup": "COMMON", "color": "Red"}) == "COMMON"


# ── The need map the availability check and the debit both key off ───────


def test_pool_need_is_scoped_to_the_bucket_not_the_lot_colour():
    needed = production_service._build_pool_needed_map(
        [{"itemName": "Mudguard", "sourceType": "POOL", "qty": 50, "colorGroup": "Purple-Wine", "poolColor": "Blue"}]
    )
    (need,) = needed.values()
    assert need["colorGroup"] == "Blue"
    assert need["isColorScoped"] is True


def test_a_common_row_naming_a_bucket_becomes_colour_scoped():
    """The Case-2 shape that used to fall into the greedy COMMON drain."""
    needed = production_service._build_pool_needed_map(
        [{"itemName": "Mudguard", "sourceType": "POOL", "qty": 50, "colorGroup": "COMMON", "poolColor": "Blue"}]
    )
    (need,) = needed.values()
    assert need["colorGroup"] == "Blue"
    assert need["isColorScoped"] is True


def test_a_common_row_without_one_still_draws_on_the_total():
    needed = production_service._build_pool_needed_map(
        [{"itemName": "Mudguard", "sourceType": "POOL", "qty": 50, "colorGroup": "COMMON"}]
    )
    (need,) = needed.values()
    assert need["isColorScoped"] is False


def test_two_buckets_of_one_item_are_separate_needs():
    needed = production_service._build_pool_needed_map(
        [
            {"itemName": "Mudguard", "sourceType": "POOL", "qty": 20, "colorGroup": "Purple-Wine", "poolColor": "Blue"},
            {"itemName": "Mudguard", "sourceType": "POOL", "qty": 30, "colorGroup": "Purple-Wine", "poolColor": "Red"},
        ]
    )
    assert sorted(n["colorGroup"] for n in needed.values()) == ["Blue", "Red"]
    assert sorted(n["qty"] for n in needed.values()) == [20.0, 30.0]


# ── Consolidation must not merge two buckets into one ────────────────────


def test_consolidation_keeps_two_buckets_of_the_same_item_apart():
    """Same item, same size, same lot colour -- but different buckets. The
    dedupe key was (itemName, size, colorGroup), so these merged into a
    single 50-unit row and one bucket's share of the debit vanished while
    the total still looked right.
    """
    merged = production_service._consolidate_duplicate_components(
        [
            {"itemName": "Mudguard", "size": "", "sourceType": "POOL", "qty": 20, "colorGroup": "Purple-Wine", "poolColor": "Blue"},
            {"itemName": "Mudguard", "size": "", "sourceType": "POOL", "qty": 30, "colorGroup": "Purple-Wine", "poolColor": "Red"},
        ]
    )
    assert len(merged) == 2
    assert sorted(c["poolColor"] for c in merged) == ["Blue", "Red"]


def test_consolidation_still_sums_two_rows_of_the_same_bucket():
    merged = production_service._consolidate_duplicate_components(
        [
            {"itemName": "Mudguard", "size": "", "sourceType": "POOL", "qty": 20, "colorGroup": "Purple-Wine", "poolColor": "Blue"},
            {"itemName": "Mudguard", "size": "", "sourceType": "POOL", "qty": 30, "colorGroup": "Purple-Wine", "poolColor": "Blue"},
        ]
    )
    assert len(merged) == 1
    assert merged[0]["qty"] == 50


def test_consolidation_of_pre_existing_components_is_unchanged():
    merged = production_service._consolidate_duplicate_components(
        [
            {"itemName": "Rib", "size": "", "sourceType": "POOL", "qty": 4, "colorGroup": "Blue"},
            {"itemName": "Rib", "size": "", "sourceType": "POOL", "qty": 6, "colorGroup": "Blue"},
        ]
    )
    assert len(merged) == 1
    assert merged[0]["qty"] == 10


# ── Round trip through the save ──────────────────────────────────────────


def test_pool_color_survives_save_and_reload(erp_client):
    """It has to persist, or reopening the lot and pressing Save with no
    edits would silently re-attribute it. The sanitizer rebuilds each
    component from an explicit whitelist, so a field missing from that list
    is dropped without trace.
    """
    process_id = _save_process(erp_client)
    saved = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 10,
                "componentsConsumed": [
                    {"itemName": "Mudguard 26", "qty": 10, "sourceType": "POOL", "poolColor": "Blue"}
                ],
            }
        ],
        mutation=True,
    )
    body = saved.get_json()
    assert body["success"] is True, body["message"]
    lot_number = body["data"]["row"]["lotNumber"]

    lots = _rpc(erp_client, "getProductionData").get_json()["data"]
    lot = next(row for row in lots if row["lotNumber"] == lot_number)
    assert lot["componentsConsumed"][0]["poolColor"] == "Blue"


def test_an_item_sourced_component_carries_no_bucket(erp_client):
    process_id = _save_process(erp_client)
    saved = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "qty": 10,
                "componentsConsumed": [{"itemName": "Bolt", "qty": 10, "sourceType": "ITEM"}],
            }
        ],
        mutation=True,
    )
    body = saved.get_json()
    assert body["success"] is True, body["message"]
    lot_number = body["data"]["row"]["lotNumber"]

    lots = _rpc(erp_client, "getProductionData").get_json()["data"]
    lot = next(row for row in lots if row["lotNumber"] == lot_number)
    assert lot["componentsConsumed"][0]["poolColor"] == ""


# ── A component dropped for naming an unproduced colour says so ──────────


def test_dropped_component_warning_names_them():
    warning = production_service._dropped_component_warning(
        [{"itemName": "Mudguard 26", "colorGroup": "Blue"}]
    )
    assert "Mudguard 26 (Blue)" in warning
    assert "NOT recorded" in warning


def test_dropped_component_warning_caps_the_list():
    warning = production_service._dropped_component_warning(
        [{"itemName": f"Part {i}", "colorGroup": "Blue"} for i in range(5)]
    )
    assert "and 2 more" in warning
    assert "Part 4" not in warning


def test_nothing_dropped_means_no_warning():
    assert production_service._dropped_component_warning([]) is None


def test_save_reports_a_component_scoped_to_an_unproduced_colour(erp_client):
    """The save still succeeds and the component is still dropped -- writing
    it would debit a bucket this lot has no claim on. What changed is that
    the operator is told, instead of seeing a clean save and silently losing
    the consumption.
    """
    process_id = _save_process(erp_client)
    saved = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "colorBreakdown": [{"color": "Purple-Wine", "qty": 5, "isCustom": True}],
                "componentsConsumed": [
                    {"itemName": "Frame Tube", "qty": 5, "sourceType": "ITEM"},
                    {"itemName": "Mudguard 26", "qty": 5, "sourceType": "POOL", "colorGroup": "Blue"},
                ],
            }
        ],
        mutation=True,
    )
    body = saved.get_json()
    assert body["success"] is True, body["message"]
    assert "Mudguard 26 (Blue)" in body["message"]

    lots = _rpc(erp_client, "getProductionData").get_json()["data"]
    lot = next(row for row in lots if row["lotNumber"] == body["data"]["row"]["lotNumber"])
    assert [c["itemName"] for c in lot["componentsConsumed"]] == ["Frame Tube"]


def test_a_clean_save_says_nothing_extra(erp_client):
    process_id = _save_process(erp_client)
    saved = _rpc(
        erp_client,
        "saveProduction",
        [
            {
                "processId": process_id,
                "assignedTo": "Worker A",
                "colorBreakdown": [{"color": "Purple-Wine", "qty": 5, "isCustom": True}],
                "componentsConsumed": [
                    {"itemName": "Frame Tube", "qty": 5, "sourceType": "ITEM"},
                    # Scoped to the lot's own colour, drawn from a different
                    # pool bucket -- the whole point of poolColor, and it
                    # must NOT trip the dropped-component warning.
                    {
                        "itemName": "Mudguard 26",
                        "qty": 5,
                        "sourceType": "POOL",
                        "colorGroup": "Purple-Wine",
                        "poolColor": "Blue",
                    },
                ],
            }
        ],
        mutation=True,
    )
    body = saved.get_json()
    assert body["success"] is True, body["message"]
    assert "NOT recorded" not in body["message"]

    lots = _rpc(erp_client, "getProductionData").get_json()["data"]
    lot = next(row for row in lots if row["lotNumber"] == body["data"]["row"]["lotNumber"])
    mudguard = next(c for c in lot["componentsConsumed"] if c["itemName"] == "Mudguard 26")
    assert mudguard["colorGroup"] == "Purple-Wine"
    assert mudguard["poolColor"] == "Blue"
