"""Transaction-scoped advisory locks for availability-consuming operations
(DATA-002).

The problem
-----------
Every operation in this codebase that consumes a finite quantity -- dispatching
Ready-to-Dispatch stock, planning a dispatch, correcting stock by hand,
consuming Warehouse Pool items in production -- follows the same shape::

    available = <compute from history>      # read
    if requested > available:               # check
        raise ValueError(...)
    <insert the rows that consume it>       # act

Under PostgreSQL's default READ COMMITTED isolation, two concurrent
transactions running that sequence do not see each other's uncommitted
inserts. Both compute the same availability, both pass the check, and both
commit. 40 units ready, two clerks each dispatching 30, and 60 units leave the
building. Nothing errors; the discrepancy surfaces when somebody counts the
shelf.

``SELECT ... FOR UPDATE`` appeared **zero** times across all 28 service
modules. The only locks anywhere were the two in backup_service.

Why advisory locks rather than row locks
----------------------------------------
There is no single row to lock. Availability is *derived* -- computed by
aggregating production lots against dispatch lines, or bills against wastage --
so there is nothing to put ``FOR UPDATE`` on. Locking every contributing row
would be both enormous and still wrong, because the rows that would make the
count change are the ones that do not exist yet.

An advisory lock names the *concept* being consumed ("this product's
ready-to-dispatch pool") rather than any row, which is exactly the granularity
the invariant needs.

Why transaction-scoped
----------------------
``pg_advisory_xact_lock`` releases automatically at COMMIT or ROLLBACK. The
session-level ``pg_advisory_lock`` would survive the connection's return to
psycopg2's pool and then be held by whichever unrelated request picked that
connection up next -- a deadlock that outlives the request that caused it, on
a connection nobody can identify. ledger_audit_service documents the same
reasoning for the same reason.

Why sorted
----------
Two transactions taking overlapping lock sets in different orders deadlock
each other. Sorting gives every caller the same acquisition order, so they
queue instead.

This bounds the invariant; it does not enforce it. A database-level
``CHECK (available >= 0)`` on a materialised balance would (see PERF-002 step
3 in the audit). Until that exists, these locks are what stands between two
simultaneous clerks and negative stock.
"""

from __future__ import annotations

from typing import Iterable

# Namespaces for the two-argument advisory-lock form,
# pg_advisory_xact_lock(classid int4, objid int4). Using the namespace as the
# first argument means "dispatch:PROD-1" and "stock:PROD-1" cannot collide
# into the same lock, which the single-argument hashtext form would allow.
DISPATCH = "erp.dispatch.availability"
STOCK = "erp.stock.balance"
POOL = "erp.warehouse.pool"


def lock_keys(cur, namespace: str, keys: Iterable[str]) -> list[str]:
    """Take a transaction-scoped advisory lock on each of `keys`.

    Blocks until every lock is held. Returns the normalised keys actually
    locked, in acquisition order, which is useful in tests and logs.

    `cur` must be a cursor on the SAME transaction that will do the reading
    and writing -- a lock taken on another connection protects nothing.
    """
    normalised = sorted({str(k).strip().lower() for k in keys if str(k).strip()})
    for key in normalised:
        cur.execute(
            "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))",
            (namespace, key),
        )
    return normalised


def lock_namespace(cur, namespace: str) -> None:
    """Take one lock covering an entire namespace.

    For operations with no meaningful per-key granularity --
    _recalculate_warehouse_pool rebuilds every bucket from history, so two
    concurrent rebuilds interleaving is a whole-pool problem, not a per-item
    one. Coarse by design: correctness first, and pool recalculation is not on
    a hot path.
    """
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s), 0)", (namespace,))
