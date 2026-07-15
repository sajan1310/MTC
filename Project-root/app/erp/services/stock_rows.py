"""Stock row CRUD, ported from Apps_Script/module_stock.js's syncStockForItem.

Internal helper only -- not RPC-exposed. Keeps erp.stock in sync with Items
Master changes (create/rename/merge/remove), keyed on (item_name, size).
Reusable later by module_vendors.js's port and the real Stock module itself,
exactly as the source's own docstring describes it being shared.

Deliberately minimal: erp.stock in this phase holds only what this sync
needs (initial_stock/threshold/dead_stock) -- no derived Current Stock yet,
that's its own dedicated round once Bills/Returns/Wastage/Issue/Production
exist.
"""

from __future__ import annotations


def _find_row(cur, name: str, size: str):
    cur.execute(
        "SELECT id FROM erp.stock WHERE lower(item_name) = lower(%s) AND lower(size) = lower(%s) AND deleted_at IS NULL",
        (name, size),
    )
    row = cur.fetchone()
    return row["id"] if row else None


def sync_stock_for_item(cur, action: str, payload: dict) -> None:
    """action: 'ensure' | 'rename' | 'merge' | 'remove'.

    - ensure: {name, size, initialStock?} -- adds a Stock row if one doesn't
      exist, seeding initial_stock with initialStock (default 0).
    - rename: {oldName, oldSize, newName, newSize} -- renames the matching
      row in place.
    - merge: {oldName, oldSize, newName, newSize} -- adds the old row's
      initial_stock into the new row's, then deletes the old row.
    - remove: {name, size} -- deletes the matching row.
    """
    if action == "ensure":
        name, size = payload["name"], payload.get("size", "")
        if _find_row(cur, name, size) is None:
            qty = float(payload.get("initialStock") or 0)
            cur.execute(
                "INSERT INTO erp.stock (item_name, size, initial_stock) VALUES (%s, %s, %s)",
                (name, size, qty),
            )

    elif action == "rename":
        old_name, old_size = payload["oldName"], payload.get("oldSize", "")
        new_name, new_size = payload["newName"], payload.get("newSize", "")
        old_id = _find_row(cur, old_name, old_size)
        new_exists = _find_row(cur, new_name, new_size) is not None

        if old_id is None:
            if not new_exists:
                cur.execute(
                    "INSERT INTO erp.stock (item_name, size) VALUES (%s, %s)", (new_name, new_size)
                )
        elif not new_exists:
            cur.execute(
                "UPDATE erp.stock SET item_name = %s, size = %s WHERE id = %s",
                (new_name, new_size, old_id),
            )
        # If the new key already has its own row, leave the old row as-is --
        # it may still belong to other items sharing the old name+size.

    elif action == "merge":
        old_name, old_size = payload["oldName"], payload.get("oldSize", "")
        new_name, new_size = payload["newName"], payload.get("newSize", "")
        old_id = _find_row(cur, old_name, old_size)
        new_id = _find_row(cur, new_name, new_size)

        if old_id is None:
            if new_id is None:
                cur.execute(
                    "INSERT INTO erp.stock (item_name, size) VALUES (%s, %s)", (new_name, new_size)
                )
        elif new_id is None:
            cur.execute(
                "UPDATE erp.stock SET item_name = %s, size = %s WHERE id = %s",
                (new_name, new_size, old_id),
            )
        else:
            cur.execute(
                """
                UPDATE erp.stock SET initial_stock = initial_stock + (
                    SELECT initial_stock FROM erp.stock WHERE id = %s
                ) WHERE id = %s
                """,
                (old_id, new_id),
            )
            # Tombstone, not a hard DELETE -- a hard delete wouldn't fire the
            # row_version trigger and would leave no tombstone for offline
            # sync clients to learn the row is gone (see architecture's
            # deleted_at convention).
            cur.execute("UPDATE erp.stock SET deleted_at = NOW() WHERE id = %s", (old_id,))

    elif action == "remove":
        name, size = payload["name"], payload.get("size", "")
        row_id = _find_row(cur, name, size)
        if row_id is not None:
            cur.execute("UPDATE erp.stock SET deleted_at = NOW() WHERE id = %s", (row_id,))

    else:
        raise ValueError(f"Unknown sync_stock_for_item action: {action}")
