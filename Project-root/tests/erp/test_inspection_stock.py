"""Stock on hand on the inspection checklist (asked 2026-11-02).

Each checklist row carries what the records say is on hand for its item
(`stock`): the Stock page's Current Stock for an Items Master item, or the
Warehouse Pool bucket a pool item draws from, marked `short` when an open lot
needs more than that. Only getInspection sends it; nothing here moves stock.
"""

from __future__ import annotations

import uuid

import psycopg2.extras

import database
from app.erp.services import financials


def _rpc(client, method, args=None, mutation=False):
    headers = {"X-Mutation-Id": str(uuid.uuid4())} if mutation else {}
    return client.post(
        f"/api/erp/rpc/{method}", json={"args": args or []}, headers=headers
    )


def _ok(resp) -> dict:
    body = resp.get_json()
    assert body["success"] is True, body["message"]
    return body


def _item(app, client, name, size="", on_hand=0.0, base_unit="Pcs"):
    _ok(
        _rpc(
            client,
            "saveItem",
            [{"itemName": name, "itemSize": size, "itemBaseUnit": base_unit}],
            mutation=True,
        )
    )
    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "UPDATE erp.stock SET initial_stock = %s WHERE deleted_at IS NULL "
                "AND lower(item_name) = lower(%s) AND lower(size) = lower(%s)",
                (on_hand, name, size),
            )
            assert cur.rowcount == 1


def _bucket(app, name, color, qty):
    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "INSERT INTO erp.warehouse_pool "
                "(output_item_name, process_id, produced_qty, consumed_qty, available_qty, color) "
                "VALUES (%s, 'PRC-STOCK', %s, 0, %s, %s)",
                (name, qty, qty, color),
            )


def _lot(app, components, status="In Progress") -> int:
    with app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                """
                INSERT INTO erp.production (production_date, qty, assigned_to, status, process_id,
                                            lot_number, components_consumed)
                VALUES (CURRENT_DATE, 10, 'Contractor S', %s, 'PRC-STOCK', %s, %s)
                RETURNING id
                """,
                (
                    status,
                    f"LOT-STOCK-{uuid.uuid4().hex[:8].upper()}",
                    psycopg2.extras.Json(components),
                ),
            )
            return cur.fetchone()[0]


def _component(name, qty, size="", source="ITEM", color_group="COMMON", unit=""):
    return {
        "itemName": name,
        "size": size,
        "qty": qty,
        "unit": unit,
        "sourceType": source,
        "colorGroup": color_group,
    }


def _items(client, lot_id) -> list:
    return _ok(_rpc(client, "getInspection", [lot_id]))["data"]["items"]


def _names():
    tag = uuid.uuid4().hex[:6]
    return f"Seat-{tag}", f"Rim-{tag}", f"Painted Frame {tag}"


# ── What each row shows ─────────────────────────────────────────────────


def test_an_items_row_shows_the_stock_pages_current_stock(erp_app, erp_client):
    seat, rim, _frame = _names()
    _item(erp_app, erp_client, seat, "20 inch", on_hand=40)
    _item(erp_app, erp_client, rim, "16 inch", on_hand=99)  # not the size asked for
    lot_id = _lot(
        erp_app, [_component(seat, 10, "20 inch"), _component(rim, 5, "20 inch")]
    )

    rows = {i["itemName"]: i for i in _items(erp_client, lot_id)}
    listed = {
        (r["name"], r["size"]): r["currentStock"]
        for r in _ok(_rpc(erp_client, "getStockData"))["data"]
    }

    assert rows[seat]["stock"] == {
        "qty": listed[(seat, "20 inch")],
        "unit": "Pcs",
        "source": "stock",
        "color": "",
        "short": False,
    }
    assert rows[seat]["stock"]["qty"] == 40
    # The 16 inch rim's stock never stands in for the 20 inch row.
    assert rows[rim]["stock"] is None


def test_a_pool_row_shows_its_colours_bucket_and_common_shows_all(erp_app, erp_client):
    _seat, _rim, frame = _names()
    _bucket(erp_app, frame, "Red", 7)
    _bucket(erp_app, frame, "Blue", 5)
    lot_id = _lot(
        erp_app,
        [
            _component(frame, 6, source="POOL", color_group="Red"),
            _component(frame, 20, source="POOL", color_group="COMMON"),
        ],
    )

    red, common = _items(erp_client, lot_id)
    assert red["stock"] == {
        "qty": 7,
        "unit": "Pcs",
        "source": "pool",
        "color": "Red",
        "short": False,
    }
    assert common["stock"]["qty"] == 12
    assert common["stock"]["color"] == ""
    assert common["stock"]["short"] is True


def test_a_pool_item_with_no_bucket_reads_zero_and_an_unknown_item_reads_none(
    erp_app, erp_client
):
    seat, _rim, frame = _names()
    lot_id = _lot(
        erp_app,
        [_component(frame, 2, source="POOL", color_group="Red"), _component(seat, 1)],
    )
    rows = {i["itemName"]: i for i in _items(erp_client, lot_id)}
    assert rows[frame]["stock"]["qty"] == 0
    assert rows[frame]["stock"]["short"] is True
    assert rows[seat]["stock"] is None


# ── When a lot needs more than is on hand ───────────────────────────────


def test_short_counts_every_row_that_draws_on_the_same_item(erp_app, erp_client):
    seat, _rim, _frame = _names()
    _item(erp_app, erp_client, seat, on_hand=15)
    lot_id = _lot(
        erp_app,
        [
            _component(seat, 10, color_group="Red"),
            _component(seat, 10, color_group="Blue"),
        ],
    )
    rows = _items(erp_client, lot_id)
    assert [r["stock"]["short"] for r in rows] == [True, True]


def test_the_need_is_converted_to_the_unit_stock_counts_in(erp_app, erp_client):
    seat, _rim, _frame = _names()
    dozen = f"Dozen-{uuid.uuid4().hex[:6]}"
    _ok(
        _rpc(
            erp_client,
            "saveUnit",
            [{"unitName": dozen, "family": "Count", "factorToBase": 12}],
            mutation=True,
        )
    )
    _item(erp_app, erp_client, seat, on_hand=30)
    enough = _lot(erp_app, [_component(seat, 2, unit=dozen)])  # 24 Pcs
    not_enough = _lot(erp_app, [_component(seat, 3, unit=dozen)])  # 36 Pcs

    assert _items(erp_client, enough)[0]["stock"]["short"] is False
    assert _items(erp_client, not_enough)[0]["stock"]["short"] is True


def test_a_completed_lot_is_not_judged(erp_app, erp_client):
    """Its own use is already out of Current Stock, so comparing would
    count it twice."""
    seat, _rim, _frame = _names()
    _item(erp_app, erp_client, seat, on_hand=3)
    lot_id = _lot(erp_app, [_component(seat, 10)], status="Completed")
    stock = _items(erp_client, lot_id)[0]["stock"]
    assert stock["short"] is None
    assert stock["qty"] == -7  # 3 on hand, 10 already taken by this lot


# ── What it is not ──────────────────────────────────────────────────────


def test_a_tick_does_not_resend_stock(erp_app, erp_client):
    """Ticking stays as quick as it was: the screen keeps the figure it
    loaded (both apps merge the reply's row into the one they hold)."""
    seat, _rim, _frame = _names()
    _item(erp_app, erp_client, seat, on_hand=40)
    lot_id = _lot(erp_app, [_component(seat, 10)])
    row = _items(erp_client, lot_id)[0]
    reply = _ok(
        _rpc(
            erp_client,
            "setInspectionCheck",
            [lot_id, row["key"], "checked", row["fingerprint"]],
            mutation=True,
        )
    )
    assert "stock" not in reply["data"]["item"]


def test_stock_is_a_quantity_not_money():
    """Roles kept away from money still see it."""
    reply = {
        "success": True,
        "data": {
            "items": [
                {
                    "stock": {
                        "qty": 40.0,
                        "unit": "Pcs",
                        "source": "stock",
                        "color": "",
                        "short": False,
                    }
                }
            ]
        },
    }
    stripped = financials.strip_financials(reply["data"], "getInspection")
    assert stripped["items"][0]["stock"]["qty"] == 40.0


# ── What production used, kept between checklist opens (2026-11-03) ──────
#
# stock_service keeps the production term of Current Stock -- 99% of opening
# a checklist -- until one of its inputs changes. The figure on the checklist
# must still follow every change.


def _qty(client, lot_id, name):
    row = next(i for i in _items(client, lot_id) if i["itemName"] == name)
    return row["stock"]["qty"]


def _counting_consumed(monkeypatch):
    from app.erp.services import stock_service

    calls = []
    real = stock_service._production_consumed_map

    def counted(cur, keys=None):
        calls.append(1)
        return real(cur, keys)

    monkeypatch.setattr(stock_service, "_production_consumed_map", counted)
    return calls


def test_opening_checklists_again_reuses_what_production_used(
    erp_app, erp_client, monkeypatch
):
    seat, _rim, _frame = _names()
    _item(erp_app, erp_client, seat, on_hand=40)
    lot_id = _lot(erp_app, [_component(seat, 10)])
    calls = _counting_consumed(monkeypatch)

    for _ in range(3):
        assert _qty(erp_client, lot_id, seat) == 40
    assert len(calls) == 1


def test_a_lot_completed_since_is_counted(erp_app, erp_client):
    seat, _rim, _frame = _names()
    _item(erp_app, erp_client, seat, on_hand=40)
    lot_id = _lot(erp_app, [_component(seat, 10)])
    assert _qty(erp_client, lot_id, seat) == 40

    _lot(erp_app, [_component(seat, 7)], status="Completed")
    assert _qty(erp_client, lot_id, seat) == 33


def test_a_lot_marked_completed_in_place_is_counted(erp_app, erp_client):
    seat, _rim, _frame = _names()
    _item(erp_app, erp_client, seat, on_hand=40)
    lot_id = _lot(erp_app, [_component(seat, 10)])
    other = _lot(erp_app, [_component(seat, 4)], status="In Progress")
    assert _qty(erp_client, lot_id, seat) == 40

    with erp_app.app_context():
        with database.get_conn() as (_conn, cur):
            cur.execute(
                "UPDATE erp.production SET status = 'Completed' WHERE id = %s", (other,)
            )
    assert _qty(erp_client, lot_id, seat) == 36


def test_a_count_taken_since_starts_the_figure_again(erp_app, erp_client):
    """A count is the starting point: production before it no longer counts,
    so the kept figure must not outlive a new count."""
    seat, _rim, _frame = _names()
    _item(erp_app, erp_client, seat, on_hand=40)
    lot_id = _lot(erp_app, [_component(seat, 10)])
    _lot(erp_app, [_component(seat, 7)], status="Completed")
    assert _qty(erp_client, lot_id, seat) == 33

    _ok(
        _rpc(
            erp_client,
            "adjustStockManually",
            [seat, "", 50, "Counted on the shelf"],
            mutation=True,
        )
    )
    assert _qty(erp_client, lot_id, seat) == 50


def _signature(app):
    from app.erp.services import stock_service

    with app.app_context():
        with database.get_conn() as (_conn, cur):
            return stock_service._consumed_inputs_signature(cur)


def test_every_input_of_the_kept_figure_changes_its_signature(erp_app, erp_client):
    seat, _rim, _frame = _names()
    _item(erp_app, erp_client, seat, on_hand=40)
    lot_id = _lot(erp_app, [_component(seat, 10)])
    _ok(
        _rpc(
            erp_client,
            "adjustStockManually",
            [seat, "", 12, "Counted on the shelf"],
            mutation=True,
        )
    )

    def changes(sql, params=()):
        before = _signature(erp_app)
        with erp_app.app_context():
            with database.get_conn() as (_conn, cur):
                cur.execute(sql, params)
        assert _signature(erp_app) != before, sql

    changes("UPDATE erp.production SET qty = qty + 1 WHERE id = %s", (lot_id,))
    changes(
        "UPDATE erp.items SET base_unit = base_unit WHERE lower(item_name) = lower(%s)",
        (seat,),
    )
    # A rename carries an item's counts in place: no row is added.
    changes(
        "UPDATE erp.stock_adjustments SET item_name = item_name || '-X' "
        "WHERE lower(item_name) = lower(%s)",
        (seat,),
    )
    changes(
        "INSERT INTO erp.production_receipts (production_id, receipt_date, qty) "
        "VALUES (%s, CURRENT_DATE, 2)",
        (lot_id,),
    )
    changes(
        "INSERT INTO erp.production_receipt_lines (receipt_id, qty) "
        "SELECT max(id), 2 FROM erp.production_receipts"
    )
    # A receipt is deleted by marking it, never edited.
    changes(
        "UPDATE erp.production_receipts SET deleted_at = NOW() "
        "WHERE id = (SELECT max(id) FROM erp.production_receipts)"
    )


def test_the_kept_figure_is_recomputed_after_its_maximum_age(
    erp_app, erp_client, monkeypatch
):
    from app.erp.services import stock_service

    seat, _rim, _frame = _names()
    _item(erp_app, erp_client, seat, on_hand=40)
    lot_id = _lot(erp_app, [_component(seat, 10)])
    calls = _counting_consumed(monkeypatch)
    monkeypatch.setattr(stock_service, "CONSUMED_CACHE_MAX_AGE_S", 0)

    _qty(erp_client, lot_id, seat)
    _qty(erp_client, lot_id, seat)
    assert len(calls) == 2
