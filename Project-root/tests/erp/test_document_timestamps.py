"""Every document records when it was entered, not just what day it is for.

A ledger row dated to a DAY is enough to put a bill in August and not
enough to say whether it was entered before or after the recount somebody
did that afternoon. Migration 045 gave production and dispatch_headers a
created_at for exactly that reason -- the warehouse pool's recount anchors
have to know what a day's entries came before and after -- and 046 does
the same for the five that move stock and were still on a bare date.

updated_at cannot stand in for it: it moves on every edit, so it says when
a row was last touched. On the live database 94% of production rows and
73% of bills have been edited after their own date, so reading updated_at
as a creation time would place a lot edited last week as though it
happened last week.

Nothing displays this. It is recorded so the time is there to be used.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import psycopg2.extras

import database

DOCUMENT_TABLES = (
    "bill_headers",
    "issue_headers",
    "wastage_headers",
    "po_headers",
    "return_headers",
    # 045 got to these two first, for the warehouse pool's anchors.
    "production",
    "dispatch_headers",
)


def _columns(cur, table):
    cur.execute(
        """
        SELECT column_name, column_default, data_type
        FROM information_schema.columns
        WHERE table_schema = 'erp' AND table_name = %s
        """,
        (table,),
    )
    return {r["column_name"]: r for r in cur.fetchall()}


def test_every_document_table_records_when_it_was_entered(erp_client):
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        for table in DOCUMENT_TABLES:
            cols = _columns(cur, table)
            assert cols, f"erp.{table} does not exist"
            assert "created_at" in cols, (
                f"erp.{table} has no created_at, so nothing can say whether "
                "one of its rows was entered before or after another on the "
                "same day"
            )
            assert cols["created_at"]["data_type"] == "timestamp with time zone"


def test_the_timestamp_is_filled_in_without_anyone_passing_it(erp_client):
    """A DEFAULT, not something every insert has to remember. A column the
    save path can forget is a column that is empty on the rows that matter.
    """
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        for table in DOCUMENT_TABLES:
            default = _columns(cur, table)["created_at"]["column_default"] or ""
            assert "now()" in default.lower(), (
                f"erp.{table}.created_at has no NOW() default "
                f"(found {default!r}) -- an insert that omits it stores NULL"
            )


def test_no_document_row_is_left_without_one(erp_client):
    """The backfill covers everything already stored. A NULL here sorts
    unpredictably against real timestamps, which is worse than the bare
    date it replaced.
    """
    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        for table in DOCUMENT_TABLES:
            cur.execute(
                f"SELECT count(*) AS n FROM erp.{table} WHERE created_at IS NULL"
            )
            assert cur.fetchone()["n"] == 0, f"erp.{table} has rows with no created_at"


def test_a_bill_saved_now_carries_the_moment_it_was_saved(erp_client):
    """End to end through the real save path: the timestamp has to be the
    moment of entry, not the bill's own date, or it answers a question the
    date already answered.
    """
    before = datetime.now(timezone.utc)

    number = f"TSINV-{uuid.uuid4().hex[:8]}"
    resp = erp_client.post(
        "/api/erp/rpc/saveBill",
        json={
            "args": [
                {
                    "vendor": f"TSVendor-{uuid.uuid4().hex[:6]}",
                    "billNumber": number,
                    # Deliberately backdated: created_at must not follow it.
                    "billDate": "01/01/2026",
                    "items": [
                        {"name": f"TSItem-{uuid.uuid4().hex[:6]}", "qty": 1, "price": 1}
                    ],
                }
            ]
        },
        headers={"X-Mutation-Id": str(uuid.uuid4())},
    )
    assert resp.get_json()["success"] is True, resp.get_json()

    with database.get_conn(cursor_factory=psycopg2.extras.RealDictCursor) as (
        _conn,
        cur,
    ):
        cur.execute(
            "SELECT bill_date, created_at FROM erp.bill_headers WHERE bill_number = %s",
            (number,),
        )
        row = cur.fetchone()

    assert row is not None
    assert str(row["bill_date"]) == "2026-01-01"
    # Entered just now, and nowhere near the date on the document.
    assert before - timedelta(minutes=5) <= row["created_at"]
    assert row["created_at"] <= datetime.now(timezone.utc) + timedelta(minutes=5)
    assert row["created_at"].date() != row["bill_date"]
