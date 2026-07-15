"""Mutation-idempotency store backing X-Mutation-Id replay in rpc.py.

A replayed mutation_id returns the envelope stored from its first execution
instead of re-running the RPC method -- see erp.rpc_mutations
(migrations/erp/002_rpc_mutations.sql).
"""

from __future__ import annotations

from typing import Any

import psycopg2.extras

import database


def get_cached_result(mutation_id: str) -> dict | None:
    with database.get_conn(cursor_factory=psycopg2.extras.DictCursor) as (_conn, cur):
        cur.execute(
            "SELECT result FROM erp.rpc_mutations WHERE mutation_id = %s",
            (mutation_id,),
        )
        row = cur.fetchone()
        return row["result"] if row else None


def store_result(mutation_id: str, method: str, result: Any) -> None:
    with database.get_conn() as (_conn, cur):
        cur.execute(
            """
            INSERT INTO erp.rpc_mutations (mutation_id, method, result)
            VALUES (%s, %s, %s)
            ON CONFLICT (mutation_id) DO NOTHING
            """,
            (mutation_id, method, psycopg2.extras.Json(result)),
        )
