"""Deleting a manual Warehouse Pool entry from where it is seen.

Manual entries -- opening stock, corrections and recounts -- could already be
deleted, but only from the Add Opening Stock window, where nobody looking at
a bucket's ledger would think to look. They can now be deleted from the
ledger line itself, which is where they are read.

What makes that safe is saying what will happen first. Deleting a manual
entry does not simply take its quantity back off: a recount REPLACES the
history behind it, so removing the newest one hands the bucket back to the
count before it -- or, with none left, to whatever its lots and entries add
up to -- and removing an older count, already inside a newer one, moves
nothing. previewDeleteWarehousePoolOpening answers that by running the
pool's own arithmetic without the entry, and changes nothing.
"""

from __future__ import annotations

from .test_warehouse_ledger import _bucket, _ledger, _make_lot, _rpc, _save_process


def _minus_ten(client):
    """A bucket reading -10: 20 of opening stock, then a lot drawing 30."""
    upstream, upstream_id = _save_process(client)
    name = upstream["outputItemName"]
    _rpc(
        client,
        "saveWarehousePoolOpening",
        [{"processId": upstream_id, "qty": 20}],
        mutation=True,
    )
    _, downstream_id = _save_process(client, sequence=2)
    _make_lot(client, downstream_id, name, 30)
    assert _bucket(client, name)["availableQty"] == -10
    return name, upstream_id


def _count(client, name, process_id, qty):
    body = _rpc(
        client,
        "adjustWarehousePoolManually",
        [name, process_id, "", "", qty, "Physical recount"],
        mutation=True,
    ).get_json()
    assert body["success"] is True, body["message"]


def _entries(client, name):
    """The manual lines of a bucket's ledger, newest first."""
    return [r for r in _ledger(client, name) if r["entryId"] is not None]


def _preview(client, entry_id):
    body = _rpc(client, "previewDeleteWarehousePoolOpening", [entry_id]).get_json()
    assert body["success"] is True, body["message"]
    return body["data"]


def _delete(client, preview):
    return _rpc(
        client,
        "deleteWarehousePoolOpening",
        [preview["rowIdx"], preview["outputItemName"], preview["qty"]],
        mutation=True,
    ).get_json()


def test_the_ledger_names_the_entry_behind_each_manual_line(erp_client):
    name, process_id = _minus_ten(erp_client)
    _count(erp_client, name, process_id, 0)

    rows = _ledger(erp_client, name)
    manual = {"Recount", "Manual Correction", "Opening Stock"}
    for row in rows:
        if row["type"] in manual:
            assert isinstance(row["entryId"], int), row
        else:
            # A lot is deleted where it was entered, not from here.
            assert row["entryId"] is None, row


def test_deleting_the_newest_count_hands_back_the_one_before(erp_client):
    name, process_id = _minus_ten(erp_client)
    _count(erp_client, name, process_id, 0)
    _count(erp_client, name, process_id, 1)

    newest = _entries(erp_client, name)[0]
    preview = _preview(erp_client, newest["entryId"])
    assert preview["type"] == "Recount"
    assert preview["countedQty"] == 1
    assert (preview["currentQty"], preview["qtyAfter"]) == (1, 0)

    body = _delete(erp_client, preview)
    assert body["success"] is True, body["message"]
    assert "went from 1 to 0" in body["message"]
    assert _bucket(erp_client, name)["availableQty"] == 0


def test_deleting_a_count_inside_a_newer_one_moves_nothing(erp_client):
    """The old confirmation would have called this "reduce the bucket by
    10". The +10 correction is already inside the count taken after it."""
    name, process_id = _minus_ten(erp_client)
    _count(erp_client, name, process_id, 0)  # -10 -> 0, a delta of +10
    _count(erp_client, name, process_id, 1)
    _count(erp_client, name, process_id, 0)

    oldest_count = [r for r in _entries(erp_client, name) if r["type"] == "Recount"][-1]
    preview = _preview(erp_client, oldest_count["entryId"])
    assert preview["qty"] == 10
    assert (preview["currentQty"], preview["qtyAfter"]) == (0, 0)

    body = _delete(erp_client, preview)
    assert body["success"] is True, body["message"]
    assert "is unchanged at 0" in body["message"]
    assert _bucket(erp_client, name)["availableQty"] == 0


def test_deleting_the_only_count_brings_back_what_the_records_add_up_to(
    erp_client,
):
    name, process_id = _minus_ten(erp_client)
    _count(erp_client, name, process_id, 0)

    recount = _entries(erp_client, name)[0]
    preview = _preview(erp_client, recount["entryId"])
    assert (preview["currentQty"], preview["qtyAfter"]) == (0, -10)

    assert _delete(erp_client, preview)["success"] is True
    assert _bucket(erp_client, name)["availableQty"] == -10


def test_deleting_opening_stock_takes_its_quantity_off(erp_client):
    upstream, process_id = _save_process(erp_client)
    name = upstream["outputItemName"]
    for qty in (20, 5):
        _rpc(
            erp_client,
            "saveWarehousePoolOpening",
            [{"processId": process_id, "qty": qty, "remarks": f"seed {qty}"}],
            mutation=True,
        )

    five = next(r for r in _entries(erp_client, name) if r["inQty"] == 5)
    preview = _preview(erp_client, five["entryId"])
    assert preview["type"] == "Opening Stock"
    assert preview["countedQty"] is None
    assert preview["remarks"] == "seed 5"
    assert (preview["currentQty"], preview["qtyAfter"]) == (25, 20)

    assert _delete(erp_client, preview)["success"] is True
    assert _bucket(erp_client, name)["availableQty"] == 20


def test_a_deletion_is_recorded_in_the_adjustment_history(erp_client):
    name, process_id = _minus_ten(erp_client)
    _count(erp_client, name, process_id, 0)
    _count(erp_client, name, process_id, 1)

    preview = _preview(erp_client, _entries(erp_client, name)[0]["entryId"])
    assert _delete(erp_client, preview)["success"] is True

    history = _rpc(erp_client, "getWarehousePoolAdjustmentHistory").get_json()["data"]
    deleted = [
        h
        for h in history
        if h["outputItemName"] == name and h["reason"].startswith("Deleted ")
    ]
    assert len(deleted) == 1
    assert (deleted[0]["oldValue"], deleted[0]["newValue"]) == (1, 0)
    assert "Recount" in deleted[0]["reason"]
    assert "(counted 1)" in deleted[0]["reason"]
    assert deleted[0]["reason"].endswith(": Physical recount")


def test_the_preview_changes_nothing(erp_client):
    name, process_id = _minus_ten(erp_client)
    _count(erp_client, name, process_id, 0)
    before = _ledger(erp_client, name)

    _preview(erp_client, _entries(erp_client, name)[0]["entryId"])

    assert _bucket(erp_client, name)["availableQty"] == 0
    assert _ledger(erp_client, name) == before


def test_an_entry_that_no_longer_exists_is_refused(erp_client):
    name, process_id = _minus_ten(erp_client)
    _count(erp_client, name, process_id, 0)
    preview = _preview(erp_client, _entries(erp_client, name)[0]["entryId"])
    assert _delete(erp_client, preview)["success"] is True

    again = _rpc(
        erp_client, "previewDeleteWarehousePoolOpening", [preview["rowIdx"]]
    ).get_json()
    assert again["success"] is False
    assert "no longer exists" in again["message"]
