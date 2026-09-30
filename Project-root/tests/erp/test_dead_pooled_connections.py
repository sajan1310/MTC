"""A Postgres restart must not cost the next few requests.

On 2026-09-30 at 12:03 an `apt upgrade` of libaudit had needrestart restart
postgresql@17-main underneath a running application. Postgres was back in
under a second. The application was not restarted, and did not need to be --
except that each worker still held two pooled connections to backends that no
longer existed:

    12:03:16  FATAL:  terminating connection due to administrator command (x8)
    12:05:24  Database connection error: SSL connection has been closed
              unexpectedly
    12:05:24  Health check failed: connection already closed

A connection the server has dropped still reports `closed == 0` on this side;
psycopg2 only finds out on its next round trip. So get_conn()'s stale check
passed, the connection was handed out, and the request that drew it failed --
one failure per dead connection, eight in all, until the pool had worked
through them. That day health probes happened to take all eight. On a busy
morning it would have been eight people, and because a failing load_user()
reads as "not signed in" (see test_pool_unavailable.py) they would have been
sent to the login page rather than told anything.

It did not name itself either. The handler for the real error rolled back a
connection that was already closed, which raised InterfaceError and replaced
"the server hung up" with "connection already closed".

These pin the fix: get_conn() asks the socket before trusting a pooled
connection and keeps drawing until it finds a live one, and when a connection
dies with a request already on it, the error that comes out is the true one.
"""

from __future__ import annotations

import os
import select

import psycopg2
import pytest
from psycopg2 import pool

import database


def _dsn():
    return dict(
        host=os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1")),
        dbname=os.getenv("TEST_DB_NAME", "testdb"),
        user=os.getenv("TEST_DB_USER", os.getenv("DB_USER", "postgres")),
        password=os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", "abcd")),
    )


@pytest.fixture
def small_pool(monkeypatch):
    """A private pool the size of a production worker's, so hanging up on its
    backends hangs up on nobody else's."""
    private = pool.ThreadedConnectionPool(2, 5, **_dsn())
    monkeypatch.setattr(database, "db_pool", private)
    yield private
    private.closeall()


def _idle_connections(private):
    """The pool's warm connections, handed straight back so they sit idle in
    it -- which is where a restart finds them."""
    conns = [private.getconn() for _ in range(private.minconn)]
    for conn in conns:
        private.putconn(conn)
    return conns


def _server_hangs_up_on(*conns):
    """What a restart does to a connection: the backend is gone, and nothing
    tells the client."""
    admin = psycopg2.connect(**_dsn())
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            for conn in conns:
                cur.execute(
                    "SELECT pg_terminate_backend(%s)", (conn.get_backend_pid(),)
                )
    finally:
        admin.close()

    # Wait for the goodbye to land rather than sleep and hope: termination is
    # a signal, and the test must not race it to the client's socket.
    for conn in conns:
        assert select.select([conn], [], [], 5)[0], "the hang-up never arrived"
        assert not conn.closed, "psycopg2 should not know yet -- that is the bug"


def test_a_restart_costs_no_request(small_pool):
    idle = _idle_connections(small_pool)
    dead = {conn.get_backend_pid() for conn in idle}
    _server_hangs_up_on(*idle)

    # Before the fix the first of these drew a dead connection and raised,
    # and so did the next, once for every connection the pool was holding.
    served_by = []
    for _ in range(len(idle) + 1):
        with database.get_conn() as (_conn, cur):
            cur.execute("SELECT pg_backend_pid()")
            served_by.append(cur.fetchone()[0])

    assert not dead & set(served_by)


def test_a_healthy_connection_is_reused_not_replaced(small_pool):
    """The other edge. A check that cried wolf would still pass the test
    above -- by opening a new connection for every request, which is the 65ms
    that PERF-003 exists to keep out of them."""
    served_by = []
    for _ in range(3):
        with database.get_conn() as (_conn, cur):
            cur.execute("SELECT pg_backend_pid()")
            served_by.append(cur.fetchone()[0])

    assert len(set(served_by)) == 1


def test_a_connection_lost_mid_request_says_what_happened(small_pool):
    """Nothing can save the request that is already on the connection. It can
    at least fail with the reason, not with InterfaceError from rolling back
    a connection that is no longer there."""
    with pytest.raises(psycopg2.OperationalError):
        with database.get_conn() as (conn, cur):
            _server_hangs_up_on(conn)
            cur.execute("SELECT 1")

    # ... and the dead connection did not go back into the pool.
    with database.get_conn() as (_conn, cur):
        cur.execute("SELECT 1")
        assert cur.fetchone() == (1,)
