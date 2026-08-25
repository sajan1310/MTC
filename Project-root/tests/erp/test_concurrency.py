"""Concurrency invariants (DATA-002, DATA-003).

The audit's testing finding included this: *"No concurrency tests. Not one test
exercises two simultaneous requests. DATA-002 and DATA-003 are both invisible
to a sequential suite."* That is exactly why both defects survived a suite of
713 otherwise-good tests -- a sequential test cannot observe a lost update.

These tests run two real transactions on two real connections and make them
interleave at the dangerous point. Each one **fails against the pre-fix code**:
without the advisory locks, both transactions read the same availability and
both commit.

They are marked `integration` and need a real PostgreSQL. `psycopg2` releases
the GIL around libpq calls, so threads genuinely run concurrently here.
"""

from __future__ import annotations

import os
import threading
import uuid

import psycopg2
import psycopg2.extras
import pytest

from app.erp.services import locks

pytestmark = pytest.mark.integration

# Long enough that a lock wait cannot be mistaken for a hang, short enough that
# a genuine deadlock fails the suite rather than stalling it.
LOCK_TIMEOUT_MS = 5000


def _dsn():
    return dict(
        host=os.getenv("TEST_DB_HOST", os.getenv("DB_HOST", "127.0.0.1")),
        dbname=os.getenv("TEST_DB_NAME", "testdb"),
        user=os.getenv("TEST_DB_USER", os.getenv("DB_USER", "postgres")),
        password=os.getenv("TEST_DB_PASS", os.getenv("DB_PASS", "abcd")),
    )


def _connect():
    conn = psycopg2.connect(**_dsn())
    with conn.cursor() as cur:
        cur.execute(f"SET lock_timeout = {LOCK_TIMEOUT_MS}")
    return conn


def _run_concurrently(worker_a, worker_b):
    """Run two callables on two connections, forced to overlap.

    Both do their READ before either does its WRITE -- the interleaving that
    makes a check-then-act unsafe. A barrier is used rather than sleeps so the
    test is deterministic rather than timing-dependent.
    """
    barrier = threading.Barrier(2, timeout=20)
    results = {}

    def _wrap(name, fn):
        def _inner():
            conn = _connect()
            try:
                results[name] = fn(conn, barrier)
            except Exception as exc:  # noqa: BLE001 -- reported, not raised, so both threads finish
                results[name] = exc
            finally:
                conn.close()

        return _inner

    threads = [
        threading.Thread(target=_wrap("a", worker_a)),
        threading.Thread(target=_wrap("b", worker_b)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=40)
        assert not t.is_alive(), "worker did not finish -- suspected deadlock"
    return results


# ── The locking primitive itself ─────────────────────────────────────────


def test_two_transactions_cannot_hold_the_same_advisory_lock(app):
    """The property everything below rests on."""
    key = f"probe-{uuid.uuid4().hex[:8]}"
    order = []

    def first(conn, barrier):
        with conn.cursor() as cur:
            locks.lock_keys(cur, locks.DISPATCH, [key])
            order.append("a-locked")
            barrier.wait()          # let B start trying
            import time

            time.sleep(0.3)         # hold it while B is definitely waiting
            order.append("a-commit")
        conn.commit()
        return "ok"

    def second(conn, barrier):
        barrier.wait()
        with conn.cursor() as cur:
            locks.lock_keys(cur, locks.DISPATCH, [key])
            order.append("b-locked")
        conn.commit()
        return "ok"

    results = _run_concurrently(first, second)
    assert results["a"] == "ok" and results["b"] == "ok"
    # B must not have acquired the lock before A committed.
    assert order.index("b-locked") > order.index("a-commit"), (
        f"lock did not serialise the two transactions: {order}"
    )


def test_different_keys_do_not_block_each_other(app):
    """Locks are per product, so unrelated dispatches stay parallel. Without
    this, the fix for DATA-002 would serialise the whole dispatch desk."""
    key_a = f"probe-a-{uuid.uuid4().hex[:8]}"
    key_b = f"probe-b-{uuid.uuid4().hex[:8]}"
    both_held = threading.Event()

    def worker(key):
        def _inner(conn, barrier):
            with conn.cursor() as cur:
                locks.lock_keys(cur, locks.DISPATCH, [key])
                barrier.wait()      # only reachable if BOTH got their lock
                both_held.set()
            conn.commit()
            return "ok"

        return _inner

    results = _run_concurrently(worker(key_a), worker(key_b))
    assert results["a"] == "ok" and results["b"] == "ok"
    assert both_held.is_set(), "two different keys blocked each other"


def test_different_namespaces_do_not_collide(app):
    """A dispatch lock on "PROD-1" must not block a stock lock on "PROD-1" --
    they are different quantities. The single-argument hashtext form would
    have collided them."""
    key = f"probe-{uuid.uuid4().hex[:8]}"
    both_held = threading.Event()

    def worker(namespace):
        def _inner(conn, barrier):
            with conn.cursor() as cur:
                locks.lock_keys(cur, namespace, [key])
                barrier.wait()
                both_held.set()
            conn.commit()
            return "ok"

        return _inner

    results = _run_concurrently(worker(locks.DISPATCH), worker(locks.STOCK))
    assert results["a"] == "ok" and results["b"] == "ok"
    assert both_held.is_set(), "namespaces collided into one lock"


def test_the_lock_is_released_by_rollback(app):
    """Transaction-scoped, so a failed save cannot strand a lock on a pooled
    connection for the next unrelated request to inherit."""
    key = f"probe-{uuid.uuid4().hex[:8]}"

    conn = _connect()
    with conn.cursor() as cur:
        locks.lock_keys(cur, locks.DISPATCH, [key])
    conn.rollback()

    other = _connect()
    try:
        with other.cursor() as cur:
            # Would raise on lock_timeout if the first connection still held it.
            locks.lock_keys(cur, locks.DISPATCH, [key])
        other.commit()
    finally:
        other.close()
        conn.close()


def test_the_lock_is_released_by_commit(app):
    key = f"probe-{uuid.uuid4().hex[:8]}"

    conn = _connect()
    with conn.cursor() as cur:
        locks.lock_keys(cur, locks.DISPATCH, [key])
    conn.commit()

    other = _connect()
    try:
        with other.cursor() as cur:
            locks.lock_keys(cur, locks.DISPATCH, [key])
        other.commit()
    finally:
        other.close()
        conn.close()


def test_overlapping_key_sets_do_not_deadlock(app):
    """Two transactions taking {X, Y} and {Y, X} would deadlock without a
    consistent acquisition order. lock_keys sorts, so they queue."""
    x = f"aaa-{uuid.uuid4().hex[:8]}"
    y = f"zzz-{uuid.uuid4().hex[:8]}"

    def worker(keys):
        def _inner(conn, barrier):
            barrier.wait()
            with conn.cursor() as cur:
                locks.lock_keys(cur, locks.DISPATCH, keys)
            conn.commit()
            return "ok"

        return _inner

    results = _run_concurrently(worker([x, y]), worker([y, x]))
    for name in ("a", "b"):
        assert results[name] == "ok", f"worker {name} failed: {results[name]!r}"


def test_lock_keys_normalises_and_deduplicates():
    """Case and whitespace must not create two locks for one product, or the
    guard silently protects nothing."""
    conn = _connect()
    try:
        with conn.cursor() as cur:
            got = locks.lock_keys(cur, locks.DISPATCH, ["  PROD-1 ", "prod-1", "PROD-2", "", "   "])
        assert got == ["prod-1", "prod-2"]
        conn.commit()
    finally:
        conn.close()


# ── The invariant, end to end ────────────────────────────────────────────


def test_concurrent_reads_of_availability_are_serialised(app):
    """A distilled model of save_dispatch's Guard #1.

    Both workers do: lock -> read a count -> insert one row. Without the lock
    both read the same starting count and both insert, so the final count is
    start+2 while each worker believed it was making it start+1. With it, the
    second read sees the first insert.

    Uses a scratch table so the assertion is about the locking, not about
    dispatch's own schema.
    """
    table = f"erp.concurrency_probe_{uuid.uuid4().hex[:8]}"
    key = f"probe-{uuid.uuid4().hex[:8]}"

    setup = _connect()
    with setup.cursor() as cur:
        cur.execute(f"CREATE TABLE {table} (id SERIAL PRIMARY KEY, note TEXT)")
    setup.commit()

    observed = []

    def worker(conn, barrier):
        barrier.wait()
        with conn.cursor() as cur:
            locks.lock_keys(cur, locks.DISPATCH, [key])
            cur.execute(f"SELECT count(*) FROM {table}")
            seen = cur.fetchone()[0]
            observed.append(seen)
            cur.execute(f"INSERT INTO {table} (note) VALUES (%s)", ("x",))
        conn.commit()
        return seen

    try:
        _run_concurrently(worker, worker)
        # The whole point: the two workers must have seen DIFFERENT counts.
        # Equal counts is the lost update this finding is about.
        assert sorted(observed) == [0, 1], (
            f"both transactions read the same availability ({observed}) -- "
            "the lock did not serialise them"
        )
    finally:
        with setup.cursor() as cur:
            cur.execute(f"DROP TABLE IF EXISTS {table}")
        setup.commit()
        setup.close()


# ── DATA-003: atomic mutation claim ──────────────────────────────────────


def _clear_mutation(mutation_id):
    import database

    with database.get_conn() as (_c, cur):
        cur.execute("DELETE FROM erp.rpc_mutations WHERE mutation_id = %s", (mutation_id,))


@pytest.fixture
def mutation_id():
    mid = str(uuid.uuid4())
    yield mid
    _clear_mutation(mid)


def test_only_one_caller_can_claim_a_mutation_id(app, mutation_id):
    """THE regression test for DATA-003.

    The old flow was SELECT -> execute -> INSERT ... ON CONFLICT DO NOTHING,
    so two concurrent requests with the same id both found no row, both
    executed, and the loser's envelope was silently discarded. Exactly one
    caller must now win the claim.
    """
    from app.erp import mutations

    outcomes = []

    def worker(conn, barrier):
        barrier.wait()
        with app.app_context():
            try:
                outcomes.append(("claimed", mutations.claim(mutation_id, "saveThing")))
            except mutations.MutationInProgress:
                outcomes.append(("in_progress", None))
        return "done"

    _run_concurrently(worker, worker)

    claimed = [o for o in outcomes if o[0] == "claimed" and o[1] is None]
    blocked = [o for o in outcomes if o[0] == "in_progress"]
    assert len(claimed) == 1, f"expected exactly one winner, got {outcomes}"
    assert len(blocked) == 1, f"expected exactly one blocked caller, got {outcomes}"


def test_a_second_claim_while_in_progress_raises(app, mutation_id):
    from app.erp import mutations

    with app.app_context():
        assert mutations.claim(mutation_id, "saveThing") is None
        with pytest.raises(mutations.MutationInProgress):
            mutations.claim(mutation_id, "saveThing")


def test_a_completed_mutation_replays_its_stored_envelope(app, mutation_id):
    from app.erp import mutations

    envelope = {"success": True, "data": {"id": 7}, "message": "Saved."}
    with app.app_context():
        assert mutations.claim(mutation_id, "saveThing") is None
        mutations.complete(mutation_id, envelope)
        assert mutations.claim(mutation_id, "saveThing") == envelope


def test_a_domain_failure_envelope_is_replayed_too(app, mutation_id):
    """A replayed duplicate of a REJECTED save must fail identically rather
    than get a second attempt -- migrations/erp/002 says so explicitly."""
    from app.erp import mutations

    failure = {"success": False, "data": None, "message": "Bill #7 already exists."}
    with app.app_context():
        mutations.claim(mutation_id, "saveBill")
        mutations.complete(mutation_id, failure)
        assert mutations.claim(mutation_id, "saveBill") == failure


def test_releasing_an_unfinished_claim_frees_the_id(app, mutation_id):
    """A request that failed without storing an envelope must not pin its id
    for STALE_CLAIM_SECONDS -- a legitimate retry should work immediately."""
    from app.erp import mutations

    with app.app_context():
        assert mutations.claim(mutation_id, "saveThing") is None
        mutations.release(mutation_id)
        assert mutations.claim(mutation_id, "saveThing") is None


def test_release_does_not_discard_a_completed_result(app, mutation_id):
    from app.erp import mutations

    envelope = {"success": True, "data": None, "message": "ok"}
    with app.app_context():
        mutations.claim(mutation_id, "saveThing")
        mutations.complete(mutation_id, envelope)
        mutations.release(mutation_id)          # must be a no-op here
        assert mutations.claim(mutation_id, "saveThing") == envelope


def test_a_stale_claim_can_be_retaken(app, mutation_id):
    """A worker killed mid-execution would otherwise pin its id forever,
    because nothing else transitions an 'in_progress' row."""
    import database
    from app.erp import mutations

    with app.app_context():
        assert mutations.claim(mutation_id, "saveThing") is None

        with database.get_conn() as (_c, cur):
            cur.execute(
                "UPDATE erp.rpc_mutations "
                "SET claimed_at = NOW() - make_interval(secs => %s) WHERE mutation_id = %s",
                (mutations.STALE_CLAIM_SECONDS + 60, mutation_id),
            )

        assert mutations.claim(mutation_id, "saveThing") is None


def test_a_fresh_claim_is_not_mistaken_for_stale(app, mutation_id):
    from app.erp import mutations

    with app.app_context():
        mutations.claim(mutation_id, "saveThing")
        with pytest.raises(mutations.MutationInProgress):
            mutations.claim(mutation_id, "saveThing")


def test_pruning_removes_old_envelopes_and_keeps_recent_ones(app):
    """DATA-005: nothing pruned this table, so a full JSONB envelope was kept
    for every mutation ever performed, forever."""
    import database
    from app.erp import mutations

    old_id, new_id = str(uuid.uuid4()), str(uuid.uuid4())
    try:
        with app.app_context():
            for mid in (old_id, new_id):
                mutations.claim(mid, "saveThing")
                mutations.complete(mid, {"success": True, "data": None, "message": ""})

            with database.get_conn() as (_c, cur):
                cur.execute(
                    "UPDATE erp.rpc_mutations "
                    "SET created_at = NOW() - make_interval(days => %s) WHERE mutation_id = %s",
                    (mutations.RETENTION_DAYS + 3, old_id),
                )

            mutations.prune_old_mutations()

            with database.get_conn() as (_c, cur):
                cur.execute(
                    "SELECT mutation_id FROM erp.rpc_mutations WHERE mutation_id IN (%s, %s)",
                    (old_id, new_id),
                )
                surviving = {str(r[0]) for r in cur.fetchall()}

        assert new_id in surviving, "pruning removed a still-relevant envelope"
        assert old_id not in surviving, "pruning kept an envelope past retention"
    finally:
        _clear_mutation(old_id)
        _clear_mutation(new_id)
