"""Processed items received against a production lot, in parts (migration 055).

A receipt says: on this date, this many of the lot's output came back,
colour by colour. This module holds the arithmetic every reader of a lot
shares, so the Warehouse Pool, Items Stock, the Item Ledger, the contractor
ledger and the dashboard can never disagree about what a receipt means. The
RPCs that write receipts live in production_service.

The owner's rules (2026-10-29):

  - A receipt puts its items into the Warehouse Pool at the moment it was
    received, and uses up the lot's materials for those items -- colour by
    colour, so 30 Red frames back use the Red mudguards, not a third of every
    colour's.
  - Completed still means the whole lot. Marking a partly received lot
    Completed counts its balance as received at that point.
  - Cancelled keeps what was received and drops only the balance.
  - The contractor is owed for what was received.

A lot nobody received against is untouched by all of this: it moves stock
when it is Completed, all at once, exactly as before.

How much of a lot a set of received quantities stands for
---------------------------------------------------------
A lot's receivable LINES are its counting colour_breakdown entries -- the
ones whose quantities add up to the lot -- or a single blank line for a lot
without colours. A receipt names quantities against those lines.

Everything else on the lot (each component it consumes, each non-counting
colour entry) belongs either to some of those lines or to the whole lot, and
moves by that part's share of what was received:

  - COMMON, or no colour: the whole lot.
  - Exactly a line's colour: that line.
  - A non-counting entry's colour: what the entry belongs to. An entry on a
    MIRROR axis -- the primary colour described a second way, e.g. "Wine"
    mudguards on "Purple-Wine" frames -- belongs to the lines it matches.
    An entry on an independent axis (one rim colour for the whole lot) is
    the whole lot. Which is which is decided exactly as Warehouse Pool
    Pass 1 decides it.
  - Otherwise a segment or hyphen-part of a line's colour: those lines.

Shares are linear in what was received, so the receipts of a lot plus its
balance always add back up to the whole lot, whatever the colours.
"""

from __future__ import annotations

from . import process_service
from . import warehouse_service
from .. import config_maps

# Two operator-typed quantities read back through JSON and NUMERIC.
_QTY_TOLERANCE = 1e-9

_NO_AXIS_KEY = "__no_axis_key__"


def line_key(color, size) -> str:
    return f"{str(color or '').strip().lower()}|{str(size or '').strip().lower()}"


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _counting_entries(color_breakdown) -> list:
    return [
        e
        for e in (color_breakdown or [])
        if isinstance(e, dict)
        and e.get("countsTowardTotal") is not False
        and str(e.get("color") or "").strip()
    ]


def fmt_qty(qty) -> str:
    """A quantity for a message: 60, not 60.0; 2.5 stays 2.5."""
    qty = _num(qty)
    return str(int(qty)) if qty == int(qty) else f"{qty:g}"


class LotShape:
    """A lot's receivable lines, and which of them each colour belongs to."""

    def __init__(self, color_breakdown, qty):
        lines: list = []
        by_key: dict = {}
        for e in _counting_entries(color_breakdown):
            key = line_key(e.get("color"), e.get("size"))
            if key in by_key:
                # Never seen in the data, but two entries spelling the same
                # colour are one line, not two competing for the same goods.
                by_key[key]["qty"] += _num(e.get("qty"))
                continue
            line = {
                "key": key,
                "color": str(e.get("color") or "").strip(),
                "size": str(e.get("size") or "").strip(),
                "qty": _num(e.get("qty")),
            }
            by_key[key] = line
            lines.append(line)
        self.colored = bool(lines)
        if not lines:
            line = {"key": line_key("", ""), "color": "", "size": "", "qty": _num(qty)}
            by_key[line["key"]] = line
            lines.append(line)
        self.lines = lines
        self.qty_by_key = {line["key"]: line["qty"] for line in lines}
        self.total = sum(self.qty_by_key.values())

        self._others = [
            e
            for e in (color_breakdown or [])
            if isinstance(e, dict)
            and e.get("countsTowardTotal") is False
            and str(e.get("color") or "").strip()
        ]
        self._axes = None
        self._keys_cache: dict = {}

    @staticmethod
    def _axis(entry) -> str:
        return str(entry.get("axisKey") or "").strip().lower() or _NO_AXIS_KEY

    def _axis_reading(self) -> tuple:
        """(mirror axis keys, inherited segments) -- which non-counting axes
        restate the primary colours, by Pass 1's own test (_axis_is_mirror),
        so a receipt credits and consumes along the same reading the pool
        composes by. A value that is a whole segment of a composite primary
        colour is another stage's axis, never a mirror (Pass 1's
        inherited_segments). Worked out on first use: showing a lot's
        balance never needs it."""
        if self._axes is None:
            primary_colors = [line["color"] for line in self.lines if line["color"]]
            axis_entries: dict = {}
            for e in self._others:
                axis_entries.setdefault(self._axis(e), []).append(e)
            mirror_axes = {
                axis
                for axis, entries in axis_entries.items()
                if primary_colors
                and all(
                    any(
                        warehouse_service._color_names_match(pc, e.get("color"))
                        for e in entries
                    )
                    for pc in primary_colors
                )
            }
            inherited_segments = set()
            for pc in primary_colors:
                segments = warehouse_service.color_segments(pc)
                if len(segments) >= 2:
                    inherited_segments.update(s.lower() for s in segments)
            self._axes = (mirror_axes, inherited_segments)
        return self._axes

    def keys_for(self, color) -> tuple:
        """The lines a colour belongs to. () is the whole lot."""
        name = str(color or "").strip()
        lower = name.lower()
        if lower in self._keys_cache:
            return self._keys_cache[lower]
        keys: tuple = ()
        if self.colored and name and not process_service._is_common_color_group(name):
            keys = self._match(name, lower)
        self._keys_cache[lower] = keys
        return keys

    def _match(self, name: str, lower: str) -> tuple:
        exact = tuple(
            line["key"] for line in self.lines if line["color"].lower() == lower
        )
        if exact:
            return exact
        named = [e for e in self._others if str(e["color"]).strip().lower() == lower]
        if named:
            mirror_axes, inherited_segments = self._axis_reading()
            for e in named:
                if lower not in inherited_segments and self._axis(e) in mirror_axes:
                    matched = tuple(
                        line["key"]
                        for line in self.lines
                        if warehouse_service._color_names_match(
                            line["color"], e["color"]
                        )
                    )
                    if matched:
                        return matched
            # A value of an independent axis is on every unit of the lot.
            return ()
        segment = tuple(
            line["key"]
            for line in self.lines
            if lower
            in {s.lower() for s in warehouse_service.color_segments(line["color"])}
        )
        if segment:
            return segment
        return tuple(
            line["key"]
            for line in self.lines
            if warehouse_service._color_names_match(line["color"], name)
        )

    def _part(self, keys: tuple, amounts: dict) -> tuple:
        """(lot quantity, amount) over `keys`, or over the whole lot."""
        keys = keys or tuple(self.qty_by_key)
        return (
            sum(self.qty_by_key.get(k, 0.0) for k in keys),
            sum(_num(amounts.get(k)) for k in keys),
        )

    @staticmethod
    def _scale(qty: float, part_qty: float, part_amount: float) -> float:
        if part_qty <= 0:
            return 0.0
        # The ordinary case -- a credit or component that IS its line's whole
        # quantity -- comes back as the amount itself, not as a float
        # product a hair off it.
        if abs(qty - part_qty) <= _QTY_TOLERANCE:
            return part_amount
        return qty * part_amount / part_qty

    def share(self, color, amounts: dict) -> float:
        part_qty, part_amount = self._part(self.keys_for(color), amounts)
        return part_amount / part_qty if part_qty > 0 else 0.0

    def entry_qty(self, entry, qty, amounts: dict) -> float:
        """`qty` of a colour_breakdown entry (or, with entry None, of a lot
        without colours), moved by `amounts`. A counting entry is its own
        line; anything else belongs where its colour says."""
        qty = _num(qty)
        if entry is None:
            keys: tuple = ()
        elif (
            entry.get("countsTowardTotal") is not False
            and str(entry.get("color") or "").strip()
        ):
            keys = (line_key(entry.get("color"), entry.get("size")),)
        else:
            keys = self.keys_for(entry.get("color"))
        return self._scale(qty, *self._part(keys, amounts))

    def component_qty(self, component, qty, amounts: dict) -> float:
        """`qty` of a consumed component, moved by `amounts`. A component
        belongs to the lines its colorGroup names -- poolColor says which
        bucket it draws FROM, not which units it went into."""
        keys = self.keys_for((component or {}).get("colorGroup"))
        return self._scale(_num(qty), *self._part(keys, amounts))

    def balance(self, received: dict) -> dict:
        """What each line still has to come, never below zero."""
        return {
            k: max(q - _num(received.get(k)), 0.0) for k, q in self.qty_by_key.items()
        }

    def received_total(self, received: dict) -> float:
        return sum(_num(received.get(k)) for k in self.qty_by_key)


# ─────────────────────────────────────────────────────────────────────────
# Reading receipts
# ─────────────────────────────────────────────────────────────────────────


def _tables():
    return (
        config_maps.TABLE_NAMES.get("PRODUCTION_RECEIPTS"),
        config_maps.TABLE_NAMES.get("PRODUCTION_RECEIPT_LINES"),
        config_maps.TABLE_NAMES.get("PRODUCTION"),
    )


def load_receipts(cur, lot_ids=None) -> dict:
    """{lot id: [receipt, ...]}, oldest first, for live receipts on live lots.

    A receipt is {"id", "date", "createdAt", "qty", "remarks", "byName",
    "lines": [{"color", "size", "qty"}], "amounts": {line key: qty}}.
    """
    receipts_table, lines_table, production_table = _tables()
    if not (receipts_table and lines_table and production_table):
        return {}
    if lot_ids is not None and not lot_ids:
        return {}
    params: tuple = ()
    lot_filter = ""
    if lot_ids is not None:
        lot_filter = " AND r.production_id = ANY(%s)"
        params = (list(lot_ids),)
    cur.execute(
        f"""
        SELECT r.id, r.production_id, r.receipt_date, r.created_at, r.qty,
               r.remarks, r.created_by_name, l.color, l.size, l.qty AS line_qty
          FROM {receipts_table} r
          JOIN {production_table} p ON p.id = r.production_id AND p.deleted_at IS NULL
          JOIN {lines_table} l ON l.receipt_id = r.id
         WHERE r.deleted_at IS NULL{lot_filter}
         ORDER BY r.receipt_date, r.created_at, r.id, l.id
        """,
        params,
    )
    by_lot: dict = {}
    by_id: dict = {}
    for row in cur.fetchall():
        receipt = by_id.get(row["id"])
        if receipt is None:
            receipt = {
                "id": row["id"],
                "lotId": row["production_id"],
                "date": row["receipt_date"],
                "createdAt": row["created_at"],
                "qty": _num(row["qty"]),
                "remarks": row["remarks"] or "",
                "byName": row["created_by_name"] or "",
                "lines": [],
                "amounts": {},
            }
            by_id[row["id"]] = receipt
            by_lot.setdefault(row["production_id"], []).append(receipt)
        qty = _num(row["line_qty"])
        receipt["lines"].append(
            {"color": row["color"] or "", "size": row["size"] or "", "qty": qty}
        )
        key = line_key(row["color"], row["size"])
        receipt["amounts"][key] = receipt["amounts"].get(key, 0.0) + qty
    return by_lot


def received_amounts(receipts) -> dict:
    """{line key: qty} over a lot's receipts."""
    total: dict = {}
    for receipt in receipts or []:
        for key, qty in receipt["amounts"].items():
            total[key] = total.get(key, 0.0) + qty
    return total


def outstanding(color_breakdown, qty, received: dict) -> tuple:
    """(balance, colour_breakdown) of what a lot still has to come: every
    entry's quantity cut to its outstanding part, the rest unchanged."""
    shape = LotShape(color_breakdown, qty)
    rest = shape.balance(received)
    breakdown = []
    for entry in color_breakdown or []:
        if isinstance(entry, dict) and str(entry.get("color") or "").strip():
            entry = {**entry, "qty": shape.entry_qty(entry, entry.get("qty"), rest)}
        breakdown.append(entry)
    return sum(rest.values()), breakdown


def lot_ids_with_receipts(cur) -> list:
    receipts_table, _lines, _production = _tables()
    if not receipts_table:
        return []
    cur.execute(
        f"SELECT DISTINCT production_id FROM {receipts_table} WHERE deleted_at IS NULL"
    )
    return [row["production_id"] for row in cur.fetchall()]


def is_completed(status) -> bool:
    return str(status or "").strip().lower() == "completed"


def is_open(status) -> bool:
    return str(status or "").strip().lower() in ("pending", "in progress", "")


# ─────────────────────────────────────────────────────────────────────────
# The rows the Warehouse Pool walks
# ─────────────────────────────────────────────────────────────────────────


def _receipt_remarks(receipt: dict, lot_qty) -> str:
    text = f"Received {fmt_qty(receipt['qty'])} of {fmt_qty(lot_qty)}"
    if receipt["remarks"]:
        text = f"{text} -- {receipt['remarks']}"
    return text


def pool_rows(cur, completed_lots: list, extra_fetch) -> list:
    """The lot rows Warehouse Pool Pass 1 and Pass 2 walk, receipts included.

    `completed_lots` are the Completed lots, as Pass 1 has always read them
    (each needs `id`). `extra_fetch(ids)` returns the rows, in the same shape,
    of the lots among `ids` that are NOT Completed -- only those with
    receipts are asked for.

      - A Completed lot nobody received against is passed through untouched.
      - Each receipt becomes a slice of its lot dated by the receipt: its own
        date and entry time, and no completion moment, so _effective_at and
        _lot_freeze_at judge it by when it was received. The slice carries
        `_receipt_shape` / `_receipt_amounts`, which Pass 1 and Pass 2 scale
        each credit and each component by.
      - A Completed lot with receipts also yields the rest of the lot -- its
        balance, counted as received when it was completed -- on the lot's
        own moments, exactly where a Completed lot has always been judged.
    """
    lot_ids = lot_ids_with_receipts(cur)
    if not lot_ids:
        return completed_lots
    receipts_by_lot = load_receipts(cur, lot_ids)
    if not receipts_by_lot:
        return completed_lots

    completed_ids = {row["id"] for row in completed_lots}
    open_ids = [i for i in receipts_by_lot if i not in completed_ids]
    rows: list = []

    def slices(row, completed: bool):
        receipts = receipts_by_lot.get(row["id"])
        if not receipts:
            if completed:
                rows.append(row)
            return
        shape = LotShape(row["color_breakdown"], row["qty"])
        for receipt in receipts:
            piece = dict(row)
            piece.update(
                production_date=receipt["date"],
                created_at=receipt["createdAt"],
                completed_at=None,
                remarks=_receipt_remarks(receipt, row["qty"]),
                _receipt_shape=shape,
                _receipt_amounts=receipt["amounts"],
            )
            rows.append(piece)
        if completed:
            rest = shape.balance(received_amounts(receipts))
            if any(qty > _QTY_TOLERANCE for qty in rest.values()):
                piece = dict(row)
                lot_remarks = str(row.get("remarks") or "")
                piece.update(
                    remarks="Rest of the lot, on completion"
                    + (f" -- {lot_remarks}" if lot_remarks else ""),
                    _receipt_shape=shape,
                    _receipt_amounts=rest,
                )
                rows.append(piece)

    for row in completed_lots:
        slices(row, True)
    for row in extra_fetch(open_ids) if open_ids else []:
        slices(row, False)
    return rows


# ─────────────────────────────────────────────────────────────────────────
# Lots that are not Completed but have received something
# ─────────────────────────────────────────────────────────────────────────


def partly_received_lots(cur, columns: str) -> list:
    """(row, shape, received) for each live lot that is not Completed and has
    receipts. `columns` must include id, qty and color_breakdown."""
    lot_ids = lot_ids_with_receipts(cur)
    if not lot_ids:
        return []
    _receipts, _lines, production_table = _tables()
    cur.execute(
        f"SELECT {columns} FROM {production_table} "
        "WHERE deleted_at IS NULL AND lower(status) <> 'completed' AND id = ANY(%s)",
        (lot_ids,),
    )
    rows = cur.fetchall()
    receipts_by_lot = load_receipts(cur, [row["id"] for row in rows])
    out = []
    for row in rows:
        receipts = receipts_by_lot.get(row["id"])
        if not receipts:
            continue
        out.append(
            (
                row,
                LotShape(row["color_breakdown"], row["qty"]),
                received_amounts(receipts),
            )
        )
    return out


def component_shares(cur) -> dict:
    """{lot id: {component index: share}} -- how much of each ITEM component
    a partly received, not-Completed lot has used up. stock_service scales
    those components by these, at the lot's own moment."""
    shares: dict = {}
    for row, shape, received in partly_received_lots(
        cur, "id, qty, color_breakdown, components_consumed"
    ):
        per_index = {}
        for index, comp in enumerate(row["components_consumed"] or []):
            if not isinstance(comp, dict):
                continue
            share = shape.share(comp.get("colorGroup"), received)
            if share:
                per_index[index] = share
        if per_index:
            shares[row["id"]] = per_index
    return shares
