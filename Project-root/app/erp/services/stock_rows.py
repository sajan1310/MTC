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
            cur.execute("SELECT initial_stock FROM erp.stock WHERE id = %s", (old_id,))
            old_initial = float(cur.fetchone()["initial_stock"] or 0)

            # initial_stock is tracked in each item's own Base Unit -- if the
            # old and new identities were set up with different Base Units
            # (a data-entry inconsistency merge is meant to fix), adding the
            # raw numbers together would silently corrupt it. Convert the
            # old row's figure into the target's Base Unit first. Local
            # imports: items_service imports this module, so importing it
            # back at module level here would be circular.
            from . import items_service
            from . import units_service

            unit_info_map = items_service.get_item_unit_info_map(cur)
            old_info = items_service.lookup_item_unit_info(unit_info_map, old_name, old_size)
            new_info = items_service.lookup_item_unit_info(unit_info_map, new_name, new_size)
            if old_info["baseUnit"] != new_info["baseUnit"]:
                try:
                    old_initial = units_service.convert_qty_to_base_unit(
                        old_initial, old_info["baseUnit"], new_info, units_service.get_units_map(cur)
                    )
                except ValueError:
                    # Unconvertible (e.g. no Weight-per-Base-Unit set) --
                    # fall back to adding the as-entered figure rather than
                    # blocking the merge.
                    pass

            cur.execute(
                "UPDATE erp.stock SET initial_stock = initial_stock + %s WHERE id = %s",
                (old_initial, new_id),
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
