"""Mutation-idempotency store backing X-Mutation-Id replay in rpc.py (DATA-003).

What was wrong
--------------
The original flow was check-then-act::

    cached = get_cached_result(mutation_id)     # SELECT
    if cached is not None:
        return cached
    result = spec.func(*args)                   # EXECUTE  <-- the window
    store_result(mutation_id, method, result)   # INSERT ... ON CONFLICT DO NOTHING

Two requests carrying the same id that arrive together both find no row, both
execute the method, and then ``ON CONFLICT DO NOTHING`` silently drops the
loser's envelope. The mutation ran twice and the caller was told it ran once.
The window is the whole method execution -- for a dispatch save, every query it
makes.

The fix is to **claim the id before executing**. The INSERT goes first, in
``in_progress``; whoever wins it owns the execution, and everyone else is told
the work is already in flight. ``INSERT ... ON CONFLICT DO NOTHING RETURNING``
is atomic, so exactly one caller can win.

The second half of the defect
-----------------------------
None of this helped desktop users, because ``Api.mutate()`` generated a fresh
UUID on every call -- so the table could never match and the whole mechanism
was pure write amplification. Only the mobile offline outbox, which reuses an
id across retries, benefited. Double-submit protection on desktop rested
entirely on client-side button disabling, which a second tab, an Enter-key
repeat or a user-initiated retry all defeat.

That half is fixed in ``static/erp/api.js``: an id is now minted per *user
action* and reused across retries of that action.
"""

from __future__ import annotations

from typing import Any

import psycopg2.extras

import database

# An 'in_progress' row whose worker died (SIGKILL, OOM, a recycled gunicorn
# worker mid-request) would otherwise block its id forever, because nothing
# else transitions it. Past this age the claim is treated as abandoned and may
# be re-taken.
#
# Comfortably longer than any legitimate mutation: the slowest of them is a
# production save, which is far inside this. Too short and a genuinely slow
# request gets its claim stolen and executes twice, which is the very thing
# this module exists to prevent -- so err long.
STALE_CLAIM_SECONDS = 900

# DATA-005. Nothing pruned this table, so a full JSONB envelope was kept for
# every mutation ever performed. A replay is only meaningful while the client
# might still retry; a week is generous even for the mobile outbox after a
# long offline spell.
RETENTION_DAYS = 7


class MutationInProgress(RuntimeError):
    """Another request already owns this mutation id and has not finished.

    Distinct from "already completed": there is no envelope to return yet, and
    re-executing is exactly what must not happen.
    """


def claim(mutation_id: str, method: str) -> dict | None:
    """Try to take ownership of `mutation_id`.

    Returns:
        ``None``  -- claimed; the caller owns the execution and MUST later
                     call :func:`complete` or :func:`release`.
        ``dict``  -- the stored envelope from a previous completed execution.

    Raises:
        :class:`MutationInProgress` -- someone else is executing it right now.
    """
    # Sentinel distinguishing "no cached envelope, we own it" (None) from
    # "somebody else is running it". The MutationInProgress raise happens
    # OUTSIDE the connection block deliberately: raising inside would pass a
    # normal control-flow signal through database.get_conn()'s exception
    # handler, which rolls back and logs it at ERROR -- and since
    # str(MutationInProgress(mutation_id)) is just the id, every legitimate
    # double-submit would write a log line whose entire content is a UUID.
    in_progress = object()
    outcome = None

    with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (_conn, cur):
        # Atomic: exactly one concurrent caller can get a row back.
        cur.execute(
            """
            INSERT INTO erp.rpc_mutations (mutation_id, method, status, result)
            VALUES (%s, %s, 'in_progress', NULL)
            ON CONFLICT (mutation_id) DO NOTHING
            RETURNING mutation_id
            """,
            (mutation_id, method),
        )
        if cur.fetchone() is not None:
            return None

        cur.execute(
            """
            SELECT status, result,
                   EXTRACT(EPOCH FROM (NOW() - claimed_at)) AS age_seconds
            FROM erp.rpc_mutations
            WHERE mutation_id = %s
            """,
            (mutation_id,),
        )
        row = cur.fetchone()
        if row is None:
            # Pruned between the INSERT and this SELECT -- vanishingly rare,
            # and re-running the claim is the correct response.
            retry = True
        elif row["status"] == "completed":
            retry = False
            outcome = row["result"]
        else:
            retry = False
            outcome = in_progress
            if float(row["age_seconds"] or 0) > STALE_CLAIM_SECONDS:
                # Abandoned by a worker that died. Re-take it rather than
                # leaving the id permanently unusable. The UPDATE is
                # conditional on the row still being stale, so two callers
                # racing to reclaim cannot both win.
                cur.execute(
                    """
                    UPDATE erp.rpc_mutations
                    SET claimed_at = NOW(), method = %s
                    WHERE mutation_id = %s
                      AND status = 'in_progress'
                      AND claimed_at < NOW() - make_interval(secs => %s)
                    RETURNING mutation_id
                    """,
                    (method, mutation_id, STALE_CLAIM_SECONDS),
                )
                if cur.fetchone() is not None:
                    outcome = None

    if retry:
        return claim(mutation_id, method)
    if outcome is in_progress:
        raise MutationInProgress(mutation_id)
    return outcome


def complete(mutation_id: str, result: Any) -> None:
    """Record the envelope and release the claim."""
    with database.get_conn() as (_conn, cur):
        cur.execute(
            """
            UPDATE erp.rpc_mutations
            SET result = %s, status = 'completed'
            WHERE mutation_id = %s
            """,
            (psycopg2.extras.Json(result), mutation_id),
        )


def release(mutation_id: str) -> None:
    """Drop an unfinished claim so the id can be retried immediately.

    Used when the dispatcher fails in a way that stored no envelope. Leaving
    the row would make a legitimate retry wait out STALE_CLAIM_SECONDS for no
    reason.
    """
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "DELETE FROM erp.rpc_mutations WHERE mutation_id = %s AND status = 'in_progress'",
            (mutation_id,),
        )


def prune_old_mutations(retention_days: int = RETENTION_DAYS) -> int:
    """Delete envelopes past the retention window. Returns rows removed.

    DATA-005: this table previously grew without bound, retaining a full JSONB
    result envelope -- sometimes a whole result set -- for every mutation ever
    performed.
    """
    with database.get_conn() as (_conn, cur):
        cur.execute(
            "DELETE FROM erp.rpc_mutations WHERE created_at < NOW() - make_interval(days => %s)",
            (retention_days,),
        )
        return cur.rowcount or 0
