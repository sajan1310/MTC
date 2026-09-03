"""BOM RPC tests, ported behavior from Apps_Script/module_bom.js.

Also proves the four rename-cascade fixes this round makes (see
bom_service.py's module docstring): Items Master, Vendors, and Color
Master renames all previously pointed at a flat "BOM" TABLE_NAMES key that
predated this round's header+lines split -- these tests confirm the fixed
BOM_LINES/BOM_PRODUCTS-join versions actually reach erp.bom_lines now.
"""

from __future__ import annotations

import re
import uuid

from app.erp.services import bom_service

_TEST_BOM_PASSWORD = "test-only-bom-password"


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _unique_name(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _get_bom_token(erp_app, erp_client) -> str:
    with erp_app.app_context():
        bom_service.set_bom_password(_TEST_BOM_PASSWORD)
    resp = _rpc(erp_client, "verifyBOMAccess", [_TEST_BOM_PASSWORD])
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body["data"]["token"]


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


def test_verify_bom_access_wrong_password_rejected(erp_app, erp_client):
    with erp_app.app_context():
        bom_service.set_bom_password(_TEST_BOM_PASSWORD)
    resp = _rpc(erp_client, "verifyBOMAccess", ["definitely-wrong"])
    body = resp.get_json()
    assert body["success"] is False
    assert "Incorrect password" in body["message"]


def test_verify_bom_access_correct_password_issues_token(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    assert isinstance(token, str)
    assert len(token) > 0


def test_get_bom_data_requires_token(erp_client):
    resp = _rpc(erp_client, "getBOMData", [""])
    body = resp.get_json()
    assert body["success"] is False
    assert "password-protected" in body["message"]

    resp2 = _rpc(erp_client, "getBOMData", ["not-a-real-token"])
    assert resp2.get_json()["success"] is False


def test_save_bom_requires_token(erp_client):
    resp = _rpc(
        erp_client,
        "saveBOM",
        [
            {"productName": "X", "components": [{"itemName": "Y", "qtyPerProduct": 1}]},
            "bad-token",
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "password-protected" in body["message"]


def test_save_bom_creates_with_components_and_additional_costs(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    proc_payload, process_id = _save_process(erp_client, isFinalStage=True)

    item = _unique_name("BomItem")
    vendor = _unique_name("BomVendor")
    product_name = _unique_name("BomProduct")

    resp = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": product_name,
                "remarks": "Standard build",
                "components": [
                    {
                        "itemName": item,
                        "size": "L",
                        "narration": "Main frame",
                        "rate": 100,
                        "vendor": vendor,
                        "qtyPerProduct": 2,
                        "processId": process_id,
                        "color": "Red",
                    }
                ],
                "additionalCosts": [
                    {
                        "description": "Labor - Fitting",
                        "rate": 50,
                        "processName": proc_payload["processName"],
                        "contractorName": "Acme Labor",
                    }
                ],
            },
            token,
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    product_id = body["data"]["productId"]
    assert re.match(r"^PRD-\d+$", product_id)

    listed = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    match = next(p for p in listed if p["productId"] == product_id)
    assert match["productName"] == product_name
    assert match["remarks"] == "Standard build"
    assert match["components"][0]["itemName"] == item
    assert match["components"][0]["lineCost"] == 200  # 100 * 2
    assert match["components"][0]["processGroup"] == proc_payload["processName"]
    assert match["colors"] == ["Red"]
    assert match["totalCost"] == 200
    assert match["additionalCosts"][0]["description"] == "Labor - Fitting"
    assert match["totalAdditionalCost"] == 50
    assert match["grandTotal"] == 250


def test_save_bom_returns_fresh_row_for_in_place_patch(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    _proc_payload, process_id = _save_process(erp_client, isFinalStage=True)

    item1 = _unique_name("BomItem1")
    item2 = _unique_name("BomItem2")
    product_name = _unique_name("BomProduct")

    create = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": product_name,
                "components": [
                    {
                        "itemName": item1,
                        "qtyPerProduct": 1,
                        "rate": 10,
                        "processId": process_id,
                    }
                ],
            },
            token,
        ],
        mutation=True,
    ).get_json()
    product_id = create["data"]["productId"]
    assert create["data"]["product"]["productId"] == product_id
    assert create["data"]["product"]["components"][0]["itemName"] == item1

    edit = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productId": product_id,
                "productName": product_name,
                "components": [
                    {
                        "itemName": item2,
                        "qtyPerProduct": 3,
                        "rate": 20,
                        "processId": process_id,
                    }
                ],
            },
            token,
        ],
        mutation=True,
    ).get_json()
    fresh_product = edit["data"]["product"]
    assert fresh_product["productId"] == product_id
    assert len(fresh_product["components"]) == 1
    assert fresh_product["components"][0]["itemName"] == item2


def test_bom_multi_color_cost_is_not_additive_across_colors(erp_app, erp_client):
    """A blank-Color row is common to every color; a colored row is an
    alternative exclusive to that color -- the headline totalCost/grandTotal
    must be common + the first color's own rows, not the sum of every color.
    """
    token = _get_bom_token(erp_app, erp_client)
    proc_payload, process_id = _save_process(erp_client, isFinalStage=True)

    common_item = _unique_name("BomCommonItem")
    red_item = _unique_name("BomRedItem")
    blue_item = _unique_name("BomBlueItem")
    product_name = _unique_name("BomMultiColorProduct")

    resp = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": product_name,
                "components": [
                    {
                        "itemName": common_item,
                        "rate": 10,
                        "qtyPerProduct": 1,
                        "processId": process_id,
                        "color": "",
                    },
                    {
                        "itemName": red_item,
                        "rate": 100,
                        "qtyPerProduct": 1,
                        "processId": process_id,
                        "color": "Red",
                    },
                    {
                        "itemName": blue_item,
                        "rate": 100,
                        "qtyPerProduct": 1,
                        "processId": process_id,
                        "color": "Blue",
                    },
                ],
            },
            token,
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    product_id = body["data"]["productId"]

    listed = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    match = next(p for p in listed if p["productId"] == product_id)

    # Common (10) + first color's own row (100) = 110, NOT 10 + 100 + 100 = 210.
    assert match["totalCost"] == 110
    assert match["grandTotal"] == 110
    assert match["colorCosts"] == [
        {"color": "Red", "totalCost": 110, "totalQty": 2},
        {"color": "Blue", "totalCost": 110, "totalQty": 2},
    ]


def test_save_bom_rejects_zero_components(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    resp = _rpc(
        erp_client,
        "saveBOM",
        [{"productName": "X", "components": []}, token],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "at least one component" in body["message"]


def test_save_bom_all_blank_component_names_rejected(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    resp = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("BlankProduct"),
                "components": [{"itemName": "", "qtyPerProduct": 1}],
            },
            token,
        ],
        mutation=True,
    )
    body = resp.get_json()
    assert body["success"] is False
    assert "valid component items" in body["message"]


def test_save_bom_edit_replaces_wholesale_and_preserves_sequence(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    item1 = _unique_name("EditBomItem1")
    item2 = _unique_name("EditBomItem2")

    create = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("EditProduct"),
                "components": [{"itemName": item1, "qtyPerProduct": 1}],
            },
            token,
        ],
        mutation=True,
    )
    product_id = create.get_json()["data"]["productId"]

    listed = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    original_sequence = next(p for p in listed if p["productId"] == product_id)[
        "sequence"
    ]

    edit = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productId": product_id,
                "productName": _unique_name("EditProductRenamed"),
                "components": [{"itemName": item2, "qtyPerProduct": 3}],
            },
            token,
        ],
        mutation=True,
    )
    assert edit.get_json()["success"] is True

    listed2 = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    match = next(p for p in listed2 if p["productId"] == product_id)
    assert len(match["components"]) == 1
    assert match["components"][0]["itemName"] == item2
    assert match["sequence"] == original_sequence


def test_get_bom_production_data_no_token_needed_and_omits_cost_fields(
    erp_app, erp_client
):
    token = _get_bom_token(erp_app, erp_client)
    item = _unique_name("ProdDataItem")
    create = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("ProdDataProduct"),
                "components": [{"itemName": item, "qtyPerProduct": 1, "rate": 999}],
            },
            token,
        ],
        mutation=True,
    )
    product_id = create.get_json()["data"]["productId"]

    resp = _rpc(erp_client, "getBOMProductionData")  # no token
    body = resp.get_json()
    assert body["success"] is True
    match = next(p for p in body["data"] if p["productId"] == product_id)
    assert match["components"][0]["itemName"] == item
    assert "rate" not in match["components"][0]
    assert "totalCost" not in match


def test_get_next_product_id_bare_string_and_fallback_on_bad_token(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    resp = _rpc(erp_client, "getNextProductId", [token])
    body = resp.get_json()
    assert isinstance(body, str)
    assert re.match(r"^PRD-\d+$", body)

    bad_resp = _rpc(erp_client, "getNextProductId", ["not-a-real-token"])
    assert bad_resp.get_json() == "PRD-1001"


def test_delete_bom_success_and_not_found(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    item = _unique_name("DeleteBomItem")
    create = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("DeleteBomProduct"),
                "components": [{"itemName": item, "qtyPerProduct": 1}],
            },
            token,
        ],
        mutation=True,
    )
    product_id = create.get_json()["data"]["productId"]

    deleted = _rpc(erp_client, "deleteBOM", [product_id, token], mutation=True)
    assert deleted.get_json()["success"] is True

    listed = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    assert not any(p["productId"] == product_id for p in listed)

    missing = _rpc(erp_client, "deleteBOM", [product_id, token], mutation=True)
    assert missing.get_json()["success"] is False


def test_delete_boms_bulk(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    item_a = _unique_name("BulkBomA")
    item_b = _unique_name("BulkBomB")
    a = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("BulkBomProductA"),
                "components": [{"itemName": item_a, "qtyPerProduct": 1}],
            },
            token,
        ],
        mutation=True,
    ).get_json()["data"]["productId"]
    b = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("BulkBomProductB"),
                "components": [{"itemName": item_b, "qtyPerProduct": 1}],
            },
            token,
        ],
        mutation=True,
    ).get_json()["data"]["productId"]

    resp = _rpc(erp_client, "deleteBOMsBulk", [[a, b], token], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    ids = [p["productId"] for p in listed]
    assert a not in ids
    assert b not in ids


def test_reorder_bom(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    item_a = _unique_name("ReorderBomA")
    item_b = _unique_name("ReorderBomB")
    a = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("ReorderProductA"),
                "components": [{"itemName": item_a, "qtyPerProduct": 1}],
            },
            token,
        ],
        mutation=True,
    ).get_json()["data"]["productId"]
    b = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("ReorderProductB"),
                "components": [{"itemName": item_b, "qtyPerProduct": 1}],
            },
            token,
        ],
        mutation=True,
    ).get_json()["data"]["productId"]

    resp = _rpc(erp_client, "reorderBOM", [[b, a], token], mutation=True)
    assert resp.get_json()["success"] is True

    listed = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    by_id = {p["productId"]: p for p in listed}
    assert by_id[b]["sequence"] == 1
    assert by_id[a]["sequence"] == 2


def test_get_bom_process_components_drift_no_token_and_detects_mismatch(
    erp_app, erp_client
):
    token = _get_bom_token(erp_app, erp_client)
    item = _unique_name("DriftItem")

    # A final-stage process whose own recipe costs this item at qty 5.
    _proc_payload, process_id = _save_process(
        erp_client,
        isFinalStage=True,
        components=[
            {
                "itemName": item,
                "qtyPerUnit": 5,
                "sourceType": "ITEM",
                "colorGroup": "COMMON",
            }
        ],
    )

    # A BOM costing the same item at a DIFFERENT qty (3) -> should drift.
    create = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("DriftProduct"),
                "components": [
                    {"itemName": item, "qtyPerProduct": 3, "processId": process_id}
                ],
            },
            token,
        ],
        mutation=True,
    )
    product_id = create.get_json()["data"]["productId"]

    resp = _rpc(erp_client, "getBomProcessComponentsDrift")  # no token
    body = resp.get_json()
    assert body["success"] is True
    match = next(d for d in body["data"] if d["productId"] == product_id)
    assert match["itemName"] == item
    assert match["bomQtyPerProduct"] == 3
    assert match["recipeQtyPerUnit"] == 5


def test_get_bom_process_components_drift_matches_lowercase_common_color_group(
    erp_app, erp_client
):
    """GAS e37529e: a Color Sub-Group of "Common"/"common" was compared
    exactly against the COMMON sentinel, dropping the row out of the
    recipe cache entirely -- a lowercase "common" (or any other casing) on
    a recipe row silently hid real drift instead of reporting it. Ports
    the same case-insensitive isCommonColorGroup() check bom_service.py
    now uses (via process_service._is_common_color_group).
    """
    token = _get_bom_token(erp_app, erp_client)
    item = _unique_name("DriftItemLower")

    _proc_payload, process_id = _save_process(
        erp_client,
        isFinalStage=True,
        components=[
            {
                "itemName": item,
                "qtyPerUnit": 5,
                "sourceType": "ITEM",
                "colorGroup": "common",
            }
        ],
    )

    create = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("DriftProductLower"),
                "components": [
                    {"itemName": item, "qtyPerProduct": 3, "processId": process_id}
                ],
            },
            token,
        ],
        mutation=True,
    )
    product_id = create.get_json()["data"]["productId"]

    resp = _rpc(erp_client, "getBomProcessComponentsDrift")
    body = resp.get_json()
    assert body["success"] is True
    match = next(d for d in body["data"] if d["productId"] == product_id)
    assert match["itemName"] == item
    assert match["bomQtyPerProduct"] == 3
    assert match["recipeQtyPerUnit"] == 5


def test_item_rename_cascades_into_bom_lines(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    old_item = _unique_name("OldBomItem")
    new_item = _unique_name("NewBomItem")
    _rpc(erp_client, "saveItem", [{"itemName": old_item}], mutation=True)

    create = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("ItemCascadeProduct"),
                "components": [{"itemName": old_item, "qtyPerProduct": 1}],
            },
            token,
        ],
        mutation=True,
    )
    product_id = create.get_json()["data"]["productId"]

    rename = _rpc(
        erp_client,
        "saveItem",
        [{"itemName": new_item, "originalName": old_item}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    match = next(p for p in listed if p["productId"] == product_id)
    assert match["components"][0]["itemName"] == new_item


def test_vendor_rename_cascades_into_bom_lines(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    old_vendor = _unique_name("OldBomVendor")
    new_vendor = _unique_name("NewBomVendor")
    _rpc(erp_client, "saveVendor", [{"vendorName": old_vendor}], mutation=True)

    item = _unique_name("VendorCascadeBomItem")
    create = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("VendorCascadeProduct"),
                "components": [
                    {"itemName": item, "qtyPerProduct": 1, "vendor": old_vendor}
                ],
            },
            token,
        ],
        mutation=True,
    )
    product_id = create.get_json()["data"]["productId"]

    rename = _rpc(
        erp_client,
        "saveVendor",
        [{"vendorName": new_vendor, "originalVendorName": old_vendor}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    match = next(p for p in listed if p["productId"] == product_id)
    assert match["components"][0]["vendor"] == new_vendor


def test_color_rename_cascades_into_bom_lines(erp_app, erp_client):
    token = _get_bom_token(erp_app, erp_client)
    old_color = _unique_name("OldBomColor")
    new_color = _unique_name("NewBomColor")
    _rpc(erp_client, "saveColor", [{"name": old_color}], mutation=True)

    item = _unique_name("ColorCascadeBomItem")
    create = _rpc(
        erp_client,
        "saveBOM",
        [
            {
                "productName": _unique_name("ColorCascadeProduct"),
                "components": [
                    {"itemName": item, "qtyPerProduct": 1, "color": old_color}
                ],
            },
            token,
        ],
        mutation=True,
    )
    product_id = create.get_json()["data"]["productId"]

    rename = _rpc(
        erp_client,
        "saveColor",
        [{"name": new_color, "originalName": old_color}],
        mutation=True,
    )
    assert rename.get_json()["success"] is True

    listed = _rpc(erp_client, "getBOMData", [token]).get_json()["data"]
    match = next(p for p in listed if p["productId"] == product_id)
    assert match["components"][0]["color"] == new_color
