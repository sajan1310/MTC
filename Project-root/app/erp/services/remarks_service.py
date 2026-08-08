"""The one narrow capability a Commenter-level custom role has beyond
read-only: update a single record's free-text remarks/narration column,
nothing else about it. See roles_service.py's module docstring for the
full permission model.

Deliberately its own module, absent from roles_service.TAB_BY_SERVICE_MODULE:
this method's authorization depends on the `tab` argument it receives at
call time, not a static role set the dispatcher can check ahead of the
call -- so unlike every other gated method, it enforces its own per-tab,
per-level check inline below, rather than relying on rpc.py's dispatcher.

No frontend calls this yet -- there's no UI surfaced for it in this round
(each of the 10 applicable tabs' edit forms would need its own row-id
exposure and Commenter-mode wiring, scoped as a separate follow-up). The
endpoint itself is real and enforced today for when that UI lands.
"""

from __future__ import annotations

from flask_login import current_user
from psycopg2 import sql

import database
from .current_user import get_current_user_id
from .roles_service import get_effective_tab_level
from ..envelope import build_response
from ..registry import rpc_method

# tab -> (table, remarks column). Every one of these tables' real UPDATE
# statements key on the surrogate `id` column (confirmed by reading each
# service's own save/delete SQL), so this only ever needs that one id, not
# each tab's own business-key resolution (vendor name, PO number, ...).
# stockTab is deliberately absent: erp.stock has no free-text column at
# all, so Commenter there has nothing more than Viewer does.
REMARKS_TARGETS = {
    "vendorMaster": ("erp.vendors", "remarks"),
    "itemMaster": ("erp.items", "narration"),
    "poLedger": ("erp.po_headers", "po_remarks"),
    "billLedger": ("erp.bill_headers", "remarks"),
    "returnLedger": ("erp.return_headers", "remarks"),
    "productsTab": ("erp.process_master", "remarks"),
    "contractorsTab": ("erp.contractors", "remarks"),
    "productionTab": ("erp.production", "remarks"),
    "clientsTab": ("erp.clients", "remarks"),
    "dispatchTab": ("erp.dispatch_headers", "remarks"),
}


@rpc_method("updateEntityRemarks", mutation=True)
@database.transactional
def update_entity_remarks(conn, cur, tab, entity_id, remarks):
    tab = str(tab or "")
    target = REMARKS_TARGETS.get(tab)
    if target is None:
        raise ValueError("This tab has no editable remarks field.")
    table, remarks_col = target

    role = str(getattr(current_user, "role", "") or "")
    level = get_effective_tab_level(role, tab)
    if level not in ("commenter", "editor"):
        raise ValueError("Not authorized to edit remarks for this record.")

    try:
        entity_id = int(entity_id)
    except (TypeError, ValueError):
        raise ValueError("Invalid record.")

    remarks = str(remarks or "").strip()

    query = sql.SQL("UPDATE {table} SET {col} = %s, updated_by = %s WHERE id = %s AND deleted_at IS NULL").format(
        table=sql.SQL(table), col=sql.Identifier(remarks_col)
    )
    cur.execute(query, (remarks, get_current_user_id(), entity_id))
    if cur.rowcount == 0:
        raise ValueError("Record not found.")
    return build_response(True, None, "Remarks updated.")
