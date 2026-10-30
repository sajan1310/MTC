"""A Labor Job bill adds its goods to the Warehouse Pool, or stays Ledger only,
whichever the person saving it says (migration 056).

A maker such as Heato Cycles bills a finished frame, so no lot of ours ever
records it; a job worker's goods come back through a lot, and adding them here
as well would count them twice. Only the person holding the bill can tell.

What matters is that the bill and the pool stay one figure: an edit never adds
the goods twice, a delete takes them back, and a recount that already includes
them is not gone past by re-saving the bill.
"""

from __future__ import annotations

import uuid
from datetime import date

import database


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _ok(resp):
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body


def _unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def _today() -> str:
    return date.today().strftime("%d/%m/%Y")


def _process(client, colors=()):
    payload = {
        "processName": _unique("Frame Making"),
        "lotPrefix": uuid.uuid4().hex[:6].upper(),
        "outputItemName": _unique("Painted Frame"),
        "sequence": 1,
        "isFinalStage": False,
        "active": True,
        "remarks": "",
        "processType": "",
        "primaryColorAxis": "",
        "components": [
            {"itemName": _unique("Sticker"), "qtyPerUnit": 1, "colorGroup": c}
            for c in colors
        ],
        "colorLinks": [],
    }
    body = _ok(_rpc(client, "saveProcess", [payload], mutation=True))
    return {**payload, "processId": body["data"]["processId"]}


def _form(process, lines, add=True, number=None, vendor=None, **form):
    """`lines` is (colour, qty). `add` None sends no answer at all."""
    payload = {
        "billType": "LABOR",
        "vendor": vendor or _unique("Heato"),
        "billNumber": number or _unique("BILL"),
        "billDate": _today(),
        "items": [
            {
                "processName": process["processName"],
                "color": color,
                "qty": qty,
                "price": 915,
            }
            for color, qty in lines
        ],
        **form,
    }
    if add is not None:
        payload["addToPool"] = "1" if add else "0"
    return payload


def _save(client, payload):
    return _ok(_rpc(client, "saveBill", [payload], mutation=True))


def _edit(client, payload, **changes):
    """The same bill saved again, as the form sends it."""
    return _save(
        client,
        {
            **payload,
            "existingBillNumber": payload["billNumber"],
            "existingVendor": payload["vendor"],
            **changes,
        },
    )


def _in_pool(process, color=""):
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT available_qty FROM erp.warehouse_pool "
            "WHERE lower(output_item_name) = lower(%s) "
            "AND lower(COALESCE(color, '')) = lower(%s)",
            (process["outputItemName"], color),
        )
        row = cur.fetchone()
    return float(row[0]) if row else 0.0


def _bill(client, payload):
    listed = _rpc(client, "getBillData").get_json()["data"]
    return next(b for b in listed if b["billNumber"] == payload["billNumber"])


# ── Choosing ───────────────────────────────────────────────────────────────


def test_a_bill_saved_to_add_puts_each_colour_in_the_pool(erp_client):
    process = _process(erp_client, ("Red", "Blue"))

    body = _save(erp_client, _form(process, [("Red", 22), ("Blue", 25)]))

    assert _in_pool(process, "Red") == 22
    assert _in_pool(process, "Blue") == 25
    assert "47 added to the Warehouse Pool" in body["message"]


def test_it_adds_to_what_is_already_there(erp_client):
    process = _process(erp_client, ("Red",))
    _ok(
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": process["processId"], "qty": 11, "color": "Red"}],
            mutation=True,
        )
    )

    _save(erp_client, _form(process, [("Red", 22)]))

    assert _in_pool(process, "Red") == 33


def test_items_stock_does_not_move_either_way(erp_client):
    process = _process(erp_client, ("Red",))

    _save(erp_client, _form(process, [("Red", 22)]))

    stock = _rpc(erp_client, "getStockData").get_json()["data"]
    row = next(s for s in stock if s["name"] == process["outputItemName"])
    assert row["currentStock"] == 0


def test_ledger_only_leaves_the_pool_alone(erp_client):
    process = _process(erp_client, ("Red",))

    body = _save(erp_client, _form(process, [("Red", 22)], add=False))

    assert _in_pool(process, "Red") == 0
    assert "Warehouse Pool" not in body["message"]


def test_saying_nothing_is_ledger_only(erp_client):
    """An older client, or a queued save from before this existed."""
    process = _process(erp_client, ("Red",))

    _save(erp_client, _form(process, [("Red", 22)], add=None))

    assert _in_pool(process, "Red") == 0


def test_a_goods_bill_ignores_the_choice(erp_client):
    item = _unique("Goods")

    _save(
        erp_client,
        {
            "vendor": _unique("Vendor"),
            "billNumber": _unique("BILL"),
            "billDate": _today(),
            "addToPool": "1",
            "items": [{"name": item, "qty": 9, "price": 5, "unit": "Pcs"}],
        },
    )

    stock = _rpc(erp_client, "getStockData").get_json()["data"]
    assert next(s for s in stock if s["name"] == item)["currentStock"] == 9
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT adds_to_pool FROM erp.bill_lines WHERE item_name = %s", (item,)
        )
        assert cur.fetchone()[0] is False


def test_the_bill_says_which_was_chosen(erp_client):
    process = _process(erp_client, ("Red",))
    pooled = _form(process, [("Red", 2)])
    ledger = _form(process, [("Red", 2)], add=False)
    _save(erp_client, pooled)
    _save(erp_client, ledger)

    saved = _bill(erp_client, pooled)
    assert saved["addToPool"] is True
    assert saved["items"][0]["addsToPool"] is True
    assert saved["items"][0]["affectsStock"] is False

    assert _bill(erp_client, ledger)["addToPool"] is False
    assert _bill(erp_client, ledger)["items"][0]["addsToPool"] is False


# ── The bill and the pool stay one figure ──────────────────────────────────


def test_saving_again_does_not_add_again(erp_client):
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)])
    _save(erp_client, payload)

    _edit(erp_client, payload, remarks="checked")
    _edit(erp_client, payload, remarks="checked twice")

    assert _in_pool(process, "Red") == 22


def test_a_quantity_edit_moves_the_pool_with_it(erp_client):
    process = _process(erp_client, ("Red", "Blue"))
    payload = _form(process, [("Red", 22)])
    _save(erp_client, payload)

    _edit(erp_client, _form(process, [("Red", 30), ("Blue", 5)], **_same(payload)))

    assert _in_pool(process, "Red") == 30
    assert _in_pool(process, "Blue") == 5


def _same(payload):
    return {"number": payload["billNumber"], "vendor": payload["vendor"]}


def test_changing_the_answer_to_ledger_only_takes_the_goods_back_out(erp_client):
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)])
    _save(erp_client, payload)

    _edit(erp_client, payload, addToPool="0")

    assert _in_pool(process, "Red") == 0
    assert _bill(erp_client, payload)["addToPool"] is False


def test_a_ledger_only_bill_can_be_added_later(erp_client):
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)], add=False)
    _save(erp_client, payload)

    _edit(erp_client, payload, addToPool="1")

    assert _in_pool(process, "Red") == 22


def test_turning_a_bill_back_to_goods_takes_the_goods_out(erp_client):
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)])
    _save(erp_client, payload)

    _edit(
        erp_client,
        payload,
        billType="GOODS",
        items=[{"name": _unique("Goods"), "qty": 1, "price": 5, "unit": "Pcs"}],
    )

    assert _in_pool(process, "Red") == 0


def test_two_lines_of_one_colour_are_one_entry(erp_client):
    process = _process(erp_client, ("Red",))

    _save(erp_client, _form(process, [("Red", 10), ("Red", 12)]))

    assert _in_pool(process, "Red") == 22
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT count(*) FROM erp.warehouse_pool_opening WHERE output_item_name = %s",
            (process["outputItemName"],),
        )
        assert cur.fetchone()[0] == 1


def test_deleting_the_bill_takes_the_goods_back_out(erp_client):
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)])
    _save(erp_client, payload)

    _ok(
        _rpc(
            erp_client,
            "deleteBill",
            [payload["vendor"], payload["billNumber"]],
            mutation=True,
        )
    )

    assert _in_pool(process, "Red") == 0


def test_bulk_deleting_bills_takes_their_goods_back_out(erp_client):
    process = _process(erp_client, ("Red",))
    first, second = (_form(process, [("Red", q)]) for q in (10, 12))
    _save(erp_client, first)
    _save(erp_client, second)

    _ok(
        _rpc(
            erp_client,
            "deleteBillsBulk",
            [
                [
                    {"vendor": b["vendor"], "billNumber": b["billNumber"]}
                    for b in (first, second)
                ]
            ],
            mutation=True,
        )
    )

    assert _in_pool(process, "Red") == 0


def test_deleting_a_bill_whose_goods_were_used_says_so(erp_client):
    process = _process(erp_client)
    payload = _form(process, [("", 10)])
    _save(erp_client, payload)
    down = _process(erp_client)
    _ok(
        _rpc(
            erp_client,
            "saveProduction",
            [
                {
                    "processId": down["processId"],
                    "assignedTo": "Worker A",
                    "status": "Completed",
                    "qty": 8,
                    "componentsConsumed": [
                        {
                            "itemName": process["outputItemName"],
                            "qty": 8,
                            "sourceType": "POOL",
                            "colorGroup": "COMMON",
                        }
                    ],
                }
            ],
            mutation=True,
        )
    )

    body = _ok(
        _rpc(
            erp_client,
            "deleteBill",
            [payload["vendor"], payload["billNumber"]],
            mutation=True,
        )
    )

    assert "-8.00" in body["message"]
    assert _in_pool(process) == -8


def test_deleting_a_ledger_only_bill_has_nothing_to_take_back(erp_client):
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)], add=False)
    _save(erp_client, payload)

    body = _ok(
        _rpc(
            erp_client,
            "deleteBill",
            [payload["vendor"], payload["billNumber"]],
            mutation=True,
        )
    )

    assert "Warning" not in body["message"]


# ── A recount stands ───────────────────────────────────────────────────────


def _count(client, process, color, qty):
    _ok(
        _rpc(
            client,
            "adjustWarehousePoolManually",
            [process["outputItemName"], process["processId"], "", color, qty, "Count"],
            mutation=True,
        )
    )


def test_saving_a_bill_again_does_not_slip_past_a_count_that_includes_it(erp_client):
    """Re-stamped "now", the entry would land after the count and add 22 on
    top of a shelf that already held them."""
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)])
    _save(erp_client, payload)
    _count(erp_client, process, "Red", 20)

    _edit(erp_client, payload, remarks="corrected the rate")

    assert _in_pool(process, "Red") == 20


def test_a_bill_saved_after_a_count_adds_to_it(erp_client):
    process = _process(erp_client, ("Red",))
    _count(erp_client, process, "Red", 20)

    _save(erp_client, _form(process, [("Red", 22)]))

    assert _in_pool(process, "Red") == 42


# ── The colour decides the bucket ──────────────────────────────────────────


def test_a_colour_the_process_does_not_have_is_refused(erp_client):
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Rde", 22)])

    body = _rpc(erp_client, "saveBill", [payload], mutation=True).get_json()

    assert body["success"] is False
    assert '"Rde" is not a colour of' in body["message"]
    assert _in_pool(process, "Rde") == 0
    listed = _rpc(erp_client, "getBillData").get_json()["data"]
    assert payload["billNumber"] not in [b["billNumber"] for b in listed]


def test_ledger_only_does_not_care_about_the_colour(erp_client):
    process = _process(erp_client, ("Red",))

    _save(erp_client, _form(process, [("Rde", 22)], add=False))


def test_a_line_with_no_colour_is_refused_where_stock_is_kept_by_colour(erp_client):
    process = _process(erp_client, ("Red",))

    body = _rpc(
        erp_client, "saveBill", [_form(process, [("", 22)])], mutation=True
    ).get_json()

    assert body["success"] is False
    assert "keeps its stock by colour" in body["message"]


def test_a_colour_in_other_case_lands_in_the_same_bucket(erp_client):
    process = _process(erp_client, ("Sky Blue-Black",))
    _ok(
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [
                {
                    "processId": process["processId"],
                    "qty": 5,
                    "color": "Sky Blue-Black",
                }
            ],
            mutation=True,
        )
    )

    _save(erp_client, _form(process, [("SKY BLUE-BLACK", 22)]))

    assert _in_pool(process, "Sky Blue-Black") == 27
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT DISTINCT color FROM erp.warehouse_pool_opening WHERE output_item_name = %s",
            (process["outputItemName"],),
        )
        assert [r[0] for r in cur.fetchall()] == ["Sky Blue-Black"]


def test_a_process_with_no_colours_keeps_one_bucket(erp_client):
    process = _process(erp_client)

    _save(erp_client, _form(process, [("Whatever", 22)]))

    assert _in_pool(process) == 22


def test_a_colour_rename_keeps_the_goods_in_the_renamed_bucket(erp_client):
    old_color = _unique("OldColor")
    new_color = _unique("NewColor")
    _rpc(erp_client, "saveColor", [{"name": old_color}], mutation=True)
    process = _process(erp_client, (old_color,))
    payload = _form(process, [(old_color, 22)])
    _save(erp_client, payload)

    _ok(
        _rpc(
            erp_client,
            "saveColor",
            [{"name": new_color, "originalName": old_color}],
            mutation=True,
        )
    )
    assert _bill(erp_client, payload)["items"][0]["color"] == new_color

    _edit(erp_client, _form(process, [(new_color, 22)], **_same(payload)))

    assert _in_pool(process, new_color) == 22
    assert _in_pool(process, old_color) == 0


def test_a_quantity_in_another_unit_goes_in_as_pieces(erp_client):
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "INSERT INTO erp.units (unit_name, family, factor_to_base) "
            "SELECT 'Pcs', 'Count', 1 WHERE NOT EXISTS "
            "(SELECT 1 FROM erp.units WHERE lower(unit_name) = 'pcs' AND deleted_at IS NULL)"
        )
    crate = _unique("Crate")
    _ok(
        _rpc(
            erp_client,
            "saveUnit",
            [{"unitName": crate, "family": "Count", "factorToBase": 12}],
            mutation=True,
        )
    )
    process = _process(erp_client)
    payload = _form(process, [("", 2)])
    payload["items"][0]["unit"] = crate

    _save(erp_client, payload)

    assert _in_pool(process) == 24


# ── The pool screens leave it to the bill ──────────────────────────────────


def _entry_id(process):
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "SELECT id FROM erp.warehouse_pool_opening WHERE output_item_name = %s",
            (process["outputItemName"],),
        )
        return cur.fetchone()[0]


def test_the_pool_ledger_names_the_bill_and_offers_no_delete(erp_client):
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)])
    _save(erp_client, payload)

    ledger = _rpc(
        erp_client,
        "getWarehousePoolLedger",
        [process["outputItemName"], "", "Red"],
    ).get_json()["data"]

    [line] = ledger
    assert line["type"] == "Bill"
    assert payload["billNumber"] in line["ref"]
    assert payload["vendor"] in line["ref"]
    assert line["inQty"] == 22
    assert line["entryId"] is None


def test_a_bills_pool_entry_cannot_be_deleted_behind_it(erp_client):
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)])
    _save(erp_client, payload)
    entry = _entry_id(process)

    preview = _rpc(erp_client, "previewDeleteWarehousePoolOpening", [entry]).get_json()
    deleted = _rpc(
        erp_client, "deleteWarehousePoolOpening", [entry], mutation=True
    ).get_json()

    assert preview["success"] is False
    assert deleted["success"] is False
    assert "Edit or delete the bill instead" in deleted["message"]
    assert _in_pool(process, "Red") == 22


def test_the_opening_list_marks_what_came_from_a_bill(erp_client):
    process = _process(erp_client, ("Red",))
    _save(erp_client, _form(process, [("Red", 22)]))
    _ok(
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": process["processId"], "qty": 5, "color": "Red"}],
            mutation=True,
        )
    )

    rows = [
        r
        for r in _rpc(erp_client, "getWarehousePoolOpeningData").get_json()["data"]
        if r["outputItemName"] == process["outputItemName"]
    ]

    assert sorted((r["qty"], r["fromBill"]) for r in rows) == [(5, False), (22, True)]


def test_excluding_a_colour_cannot_purge_a_bills_goods(erp_client):
    process = _process(erp_client, ("Red",))
    extra = _unique("Extra")
    _ok(
        _rpc(
            erp_client,
            "includeWarehousePoolColor",
            [process["processId"], extra],
            mutation=True,
        )
    )
    _save(erp_client, _form(process, [(extra, 22)]))

    _rpc(
        erp_client,
        "excludeWarehousePoolColors",
        [process["processId"], [extra]],
        mutation=True,
    )

    assert _in_pool(process, extra) == 22


# ── Bills from before this ─────────────────────────────────────────────────


def test_an_old_bill_that_counted_in_stock_moves_to_the_pool_when_added(erp_client):
    """Adding it to the pool is a decision about where the goods are, so they
    can't stay in both. Bills saved before 2026-10-14 counted in Items Stock."""
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)], add=False)
    _save(erp_client, payload)
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.bill_lines SET affects_stock = TRUE WHERE item_name = %s",
            (process["outputItemName"],),
        )

    _edit(erp_client, payload, addToPool="1")

    assert _in_pool(process, "Red") == 22
    assert _bill(erp_client, payload)["items"][0]["affectsStock"] is False


def test_an_old_bill_left_ledger_only_keeps_counting_as_it_did(erp_client):
    process = _process(erp_client, ("Red",))
    payload = _form(process, [("Red", 22)], add=False)
    _save(erp_client, payload)
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "UPDATE erp.bill_lines SET affects_stock = TRUE WHERE item_name = %s",
            (process["outputItemName"],),
        )

    _edit(erp_client, payload, remarks="corrected the rate")

    assert _in_pool(process, "Red") == 0
    assert _bill(erp_client, payload)["items"][0]["affectsStock"] is True
