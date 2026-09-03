"""Collision-safe generation of the human-facing document numbers.

Issues, wastages and returns each get an auto-generated identifier of the
form ``PFX-YYYYMMDD-HHMMSS``. That is second-resolution, so two documents
saved inside the same second produce the SAME string, and what happened next
differed by table:

  return_number   erp.return_headers has a case-insensitive partial unique
                  index (009_return_ledger.sql) and save_return checks it, so
                  the second save was rejected with "already exists. Please
                  use a unique return number." -- advice the operator cannot
                  act on, about a number they never chose and cannot see.

  issue_id        Neither had a unique index nor any application check;
  wastage_id      011_wastage_and_issue.sql says so outright ("No unique index
                  on wastage_id/issue_id -- the source itself never checks").
                  So the collision raised nothing at all and simply produced
                  two different documents sharing one identifier. Silent
                  duplicate identifiers are the worse failure of the two:
                  nothing surfaces until somebody searches for a document and
                  gets back two.

Neither is hypothetical. The CI suite runs in about two minutes and hit the
return case on most runs, which is how this was found; the same suite takes
28 minutes on a developer machine and never hits it. Speed is what decides
it, so a fast production server makes collisions MORE likely, not less --
and several operators on a shop floor is exactly the shape of load that
produces two saves in one second.

This module is the one implementation. 042_unique_document_ids.sql adds the
matching indexes for issue and wastage, so the database now refuses a
duplicate even if some future code path forgets to come through here.
"""

from __future__ import annotations

from datetime import datetime

from psycopg2 import sql

SCHEMA = "erp"

# Suffixes are only ever reached by same-second saves, so single digits are
# already generous. The cap exists so a caller that somehow passes a base
# that can never be free fails loudly instead of looping.
MAX_ATTEMPTS = 1000


def build_base(prefix: str, now: datetime | None = None) -> str:
    """`PFX-YYYYMMDD-HHMMSS` for `now`, unchanged from the original format."""
    now = now or datetime.now()
    return f"{prefix}-{now.strftime('%Y%m%d')}-{now.strftime('%H%M%S')}"


def next_document_number(
    cur,
    *,
    prefix: str,
    table: str,
    column: str,
    now: datetime | None = None,
) -> str:
    """An unused document number: `base`, else `base-2`, `base-3`, ...

    The suffix is not the normal shape and will not be seen unless two saves
    land in the same second. Matching is case-insensitive and ignores
    soft-deleted rows, mirroring the partial unique indexes exactly -- a
    number freed by a delete is available again, and one that differs only in
    case is not free at all.

    Only AUTO-GENERATED numbers should come through here. A duplicate the
    user typed themselves must still be an error, because there the message
    is something they can act on.
    """
    base = build_base(prefix, now)

    taken = sql.SQL(
        "SELECT 1 FROM {table} "
        "WHERE lower({column}::text) = lower(%s) AND deleted_at IS NULL"
    ).format(
        table=sql.Identifier(SCHEMA, table),
        column=sql.Identifier(column),
    )

    candidate = base
    for attempt in range(2, MAX_ATTEMPTS + 2):
        cur.execute(taken, (candidate,))
        if cur.fetchone() is None:
            return candidate
        candidate = f"{base}-{attempt}"

    raise ValueError(
        f'Could not allocate a free document number from "{base}". '
        "Save again, or enter a number yourself."
    )
