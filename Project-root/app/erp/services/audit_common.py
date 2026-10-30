"""What the audit's checks share: the shape of a finding, and how a figure is
written in one. Apart from audit_service (the engine and most checks) and
audit_entries (the stock-entry checks) so each can use it without importing
the other.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime

from . import units_service

_EPS = 1e-6
# Rupee amounts: below this a difference is rounding.
MONEY_EPS = 0.01
# How many documents a grouped finding names in its text.
REFS_SHOWN = 8


def _finding(
    check: str,
    kind: str,
    area: str,
    title: str,
    detail: str,
    *,
    item: str = "",
    size: str = "",
    tag: str = "",
    colour: str = "",
    refs=(),
    qty: float = 0.0,
    when=None,
    evidence: dict | None = None,
) -> dict:
    refs = [str(r) for r in refs if r]
    when_iso = None
    if isinstance(when, datetime):
        when_iso = when.date().isoformat()
    elif isinstance(when, date):
        when_iso = when.isoformat()
    key = "|".join(
        [
            check,
            item.strip().lower(),
            size.strip().lower(),
            tag.strip().lower(),
            colour.strip().lower(),
            refs[0] if refs else "",
        ]
    )
    return {
        "fingerprint": hashlib.sha1(key.encode("utf-8")).hexdigest()[:16],
        # The numbers a review decision was made on: a dismissed finding
        # comes back as soon as these change.
        "valueSig": hashlib.sha1(detail.encode("utf-8")).hexdigest()[:16],
        "check": check,
        "kind": kind,
        "area": area,
        "title": title,
        "detail": detail,
        "item": item,
        "size": size,
        "tag": tag,
        "colour": colour,
        "refs": refs,
        "qty": round(float(qty or 0), 4),
        "when": when_iso,
        "evidence": evidence or {},
    }


def _fmt(q) -> str:
    return units_service.format_qty(q)


def _label(item: str, colour: str = "", tag: str = "") -> str:
    parts = [item]
    if tag:
        parts.append(f"tag {tag}")
    if colour:
        parts.append(colour)
    return " · ".join(p for p in parts if p)


def _k(value) -> str:
    return str(value or "").strip().lower()


def _item_key(name, size) -> str:
    return f"{_k(name)}|{_k(size)}"


def _squash(text) -> str:
    """A name with case, spaces and punctuation taken out: "A.M Coating"
    and "am coating" are the same party typed twice."""
    return "".join(ch for ch in str(text or "").lower() if ch.isalnum())


def _rs(amount) -> str:
    return f"Rs {float(amount or 0):,.2f}"


def _listed(names) -> str:
    names = list(names)
    shown = ", ".join(str(n) for n in names[:REFS_SHOWN])
    more = len(names) - REFS_SHOWN
    return shown + (f" and {more} more" if more > 0 else "")


def _lot_label(row) -> str:
    return str(row["lot_number"] or f"lot #{row['id']}").strip()


def _sized(name, size) -> str:
    return f"{name}{(' ' + size) if size else ''}"


def _bill_ref(row) -> str:
    return f"Bill {row['bill_number']} ({row['vendor']})"


def _bill_rows(ctx) -> list:
    """Every live bill line with its header, read once."""
    rows = getattr(ctx, "_bill_rows_cache", None)
    if rows is None:
        ctx.cur.execute(
            """
            SELECT h.id AS header_id, h.bill_number, h.vendor, h.bill_date, h.created_at,
                   l.id, l.po_number, l.item_name, COALESCE(l.size, '') AS size,
                   COALESCE(l.narration, '') AS narration, l.qty, l.unit, l.price,
                   l.gst_rate_pct, l.base_qty, l.base_rate, l.affects_stock, l.bill_type
              FROM erp.bill_lines l
              JOIN erp.bill_headers h ON h.id = l.header_id
             WHERE h.deleted_at IS NULL
             ORDER BY h.bill_date, h.id, l.id
            """
        )
        rows = ctx.cur.fetchall()
        ctx._bill_rows_cache = rows
    return rows
