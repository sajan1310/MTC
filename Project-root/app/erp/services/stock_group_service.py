"""Stock Groups: user-defined named collections of item/size rows.

Lets the Stock tab's Low Stock Report preview filter/print "group-wise"
(e.g. a saved "Stickers" or "Mudguard Bolts" group) instead of the user
re-picking the same set of items by hand every time. Two RPC surfaces:

- getStockGroupsData/saveStockGroup/deleteStockGroup: group master CRUD,
  same shape as units_service.py's Unit Master.
- setStockGroupItems: bulk-replaces a group's full item/size membership in
  one call (DELETE then re-INSERT, same "rewritten wholesale" pattern as
  items_service.py's erp.item_vendors) -- the frontend's bulk-select
  dialog collects the whole desired checked set and saves it in one shot,
  rather than diffing adds/removes itself.
"""

from __future__ import annotations

import psycopg2.extras

import database
from .current_user import get_current_user_id
from ..envelope import build_response
from ..registry import rpc_method


def _fetch_group_items(cur, group_ids: list[int]) -> dict[int, list[dict]]:
    if not group_ids:
        return {}
    cur.execute(
        """
        SELECT group_id, item_name, size
        FROM erp.stock_group_items
        WHERE group_id = ANY(%s)
        ORDER BY group_id, lower(item_name), lower(size)
        """,
        (group_ids,),
    )
    by_group: dict[int, list[dict]] = {gid: [] for gid in group_ids}
    for row in cur.fetchall():
        by_group[row["group_id"]].append(
            {"name": row["item_name"], "size": row["size"] or ""}
        )
    return by_group


@rpc_method("getStockGroupsData")
def get_stock_groups_data():
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute(
            """
            SELECT id, name, remarks
            FROM erp.stock_group_master
            WHERE deleted_at IS NULL
            ORDER BY lower(name)
            """
        )
        groups = cur.fetchall()
        items_by_group = _fetch_group_items(cur, [row["id"] for row in groups])

    result = [
        {
            "id": row["id"],
            "name": row["name"],
            "remarks": row["remarks"] or "",
            "items": items_by_group.get(row["id"], []),
        }
        for row in groups
    ]
    return build_response(True, result)


@rpc_method("saveStockGroup", mutation=True)
@database.transactional
def save_stock_group(conn, cur, form_data):
    form_data = form_data or {}

    name = str(form_data.get("name") or "").strip()
    if not name:
        raise ValueError("Group name must not be empty.")
    remarks = str(form_data.get("remarks") or "").strip()

    group_id = form_data.get("id")
    is_edit = bool(group_id)

    existing_name = None
    if is_edit:
        cur.execute(
            "SELECT id, name FROM erp.stock_group_master WHERE id = %s AND deleted_at IS NULL",
            (group_id,),
        )
        existing = cur.fetchone()
        if existing is None:
            raise ValueError("Stock group not found.")
        existing_name = existing["name"]

    # Skip the duplicate-name check on an edit that isn't actually renaming
    # the group (e.g. just updating remarks) -- comparing DB row ids to the
    # raw, untyped form `id` here would be fragile (a string "5" from a
    # non-JS caller never equals int 5), same pitfall units_service.py's
    # save_unit avoids by keying off whether the name changed instead.
    if not is_edit or name.lower() != existing_name.lower():
        cur.execute(
            "SELECT id FROM erp.stock_group_master WHERE lower(name) = lower(%s) AND deleted_at IS NULL",
            (name,),
        )
        if cur.fetchone():
            raise ValueError(f'A stock group named "{name}" already exists.')

    user_id = get_current_user_id()

    if is_edit:
        cur.execute(
            "UPDATE erp.stock_group_master SET name = %s, remarks = %s, updated_by = %s WHERE id = %s",
            (name, remarks, user_id, group_id),
        )
        new_id = group_id
        message = f'Stock group "{name}" updated.'
    else:
        cur.execute(
            "INSERT INTO erp.stock_group_master (name, remarks, updated_by) VALUES (%s, %s, %s) RETURNING id",
            (name, remarks, user_id),
        )
        new_id = cur.fetchone()["id"]
        message = f'Stock group "{name}" created.'

    return build_response(True, {"id": new_id, "name": name}, message)


@rpc_method("deleteStockGroup", mutation=True)
@database.transactional
def delete_stock_group(conn, cur, group_id):
    cur.execute(
        "SELECT id, name FROM erp.stock_group_master WHERE id = %s AND deleted_at IS NULL",
        (group_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("Stock group not found.")

    cur.execute(
        "UPDATE erp.stock_group_master SET deleted_at = NOW(), updated_by = %s WHERE id = %s",
        (get_current_user_id(), group_id),
    )
    # Leave erp.stock_group_items alone -- soft-deleting only the parent
    # (matching items_service.delete_item's convention for erp.item_vendors)
    # keeps the group's membership recoverable if deleted_at is ever reset.
    return build_response(True, None, f'Stock group "{row["name"]}" deleted.')


@rpc_method("setStockGroupItems", mutation=True)
@database.transactional
def set_stock_group_items(conn, cur, form_data):
    form_data = form_data or {}

    group_id = form_data.get("groupId")
    cur.execute(
        "SELECT id, name FROM erp.stock_group_master WHERE id = %s AND deleted_at IS NULL",
        (group_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise ValueError("Stock group not found.")

    items = form_data.get("items") or []
    seen = set()
    clean_items = []
    for entry in items:
        item_name = str((entry or {}).get("name") or "").strip()
        size = str((entry or {}).get("size") or "").strip()
        if not item_name:
            continue
        dedup_key = (item_name.lower(), size.lower())
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        clean_items.append((item_name, size))

    cur.execute("DELETE FROM erp.stock_group_items WHERE group_id = %s", (group_id,))
    if clean_items:
        # A group can legitimately hold hundreds of rows (the "Manage
        # Items" checklist bulk-selects across the whole stock list), so
        # this is one batched multi-row insert rather than a round trip
        # per item.
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO erp.stock_group_items (group_id, item_name, size) VALUES %s",
            [(group_id, item_name, size) for item_name, size in clean_items],
        )

    return build_response(
        True,
        {"id": row["id"], "name": row["name"], "count": len(clean_items)},
        f'Saved {len(clean_items)} item(s) to "{row["name"]}".',
    )
