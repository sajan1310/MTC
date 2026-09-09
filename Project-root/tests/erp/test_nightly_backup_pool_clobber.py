"""The nightly backup must not take the database away from its own worker.

On 2026-09-09 worker 1240 served requests for two hours with
`database.db_pool = None`. The journal recorded the whole chain:

    20:23:48  [backup_service] Nightly automated backup triggered
    20:26:02  Google Sheets backup created/updated
    20:26:30  [TESTING] Database not reachable; proceeding without DB pool:
              FATAL: password authentication failed for user "postgres"

_scheduler_loop ran the nightly job from a daemon thread with no app context.
Flask contexts are thread-local, so the GAS sheet mirror's
`_stock_app_context()` asked `has_app_context()`, was told False, and -- doing
exactly what it was written to do when run standalone -- booted
`create_app("testing")` inside the live worker. That called
`database.init_app()` with TESTING=True, which tried to connect as user
`postgres`, failed, and hit the one failure path that does not re-raise:

    db_pool = None
    return

`db_pool` is a module-level global, so the *production* pool of a worker still
serving traffic was gone, permanently, with nothing raised and nothing to see
but a WARNING with the word TESTING in it.

It did not look like a database fault either -- see test_pool_unavailable.py
for that half of the story.

These pin both layers of the fix: the scheduler carries a real app context so
the mirror stays the no-op it intends to be, and init_app refuses to discard a
live pool even if something gets there anyway.
"""

from __future__ import annotations

import threading

import psycopg2
import pytest
from flask import has_app_context

import database
from app.erp.services import backup_service


class _StubLogger:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, msg, *a, **k) -> None:
        self.errors.append(str(msg))

    def warning(self, msg, *a, **k) -> None:
        self.warnings.append(str(msg))

    def info(self, msg, *a, **k) -> None:
        pass

    def critical(self, msg, *a, **k) -> None:
        pass


class _StubApp:
    """The shape init_app actually uses: a config mapping and a logger."""

    def __init__(self, **overrides) -> None:
        self.config = {
            "TESTING": True,
            "DATABASE_URL": "postgresql://postgres:wrong@127.0.0.1:5432/nope",
        }
        self.config.update(overrides)
        self.logger = _StubLogger()


@pytest.fixture
def unreachable_db(monkeypatch):
    """Make pool construction fail the way the incident did."""

    def _boom(*args, **kwargs):
        raise psycopg2.OperationalError(
            'connection to server at "127.0.0.1", port 5432 failed: '
            'FATAL:  password authentication failed for user "postgres"'
        )

    monkeypatch.setattr(database.pool, "ThreadedConnectionPool", _boom)


def test_a_failing_testing_app_does_not_discard_a_live_pool(
    monkeypatch, unreachable_db
):
    """The exact defect: a throwaway TESTING app nulling a running worker's pool."""
    live_pool = object()
    monkeypatch.setattr(database, "db_pool", live_pool)

    app = _StubApp()
    database.init_app(app)

    assert database.db_pool is live_pool, (
        "a TESTING app that could not connect discarded the live pool"
    )


def test_discarding_a_live_pool_is_reported_as_an_error(monkeypatch, unreachable_db):
    """A TESTING app inside a live process is a caller bug, and must say so.

    The original was invisible precisely because it logged at WARNING with the
    word TESTING in it, which reads as routine in a test run.
    """
    monkeypatch.setattr(database, "db_pool", object())

    app = _StubApp()
    database.init_app(app)

    assert any("live connection pool" in m for m in app.logger.errors)


def test_without_a_live_pool_a_testing_app_still_starts_without_one(
    monkeypatch, unreachable_db
):
    """The behaviour the TESTING branch exists for is unchanged: tests that mock
    the database still get an app, and no error is claimed."""
    monkeypatch.setattr(database, "db_pool", None)

    app = _StubApp()
    database.init_app(app)

    assert database.db_pool is None
    assert app.logger.errors == []


def test_scheduler_runs_the_nightly_job_inside_an_app_context(erp_app, monkeypatch):
    """The cause, rather than the symptom: with a context pushed, the mirror's
    has_app_context() check is answered True and it never boots its own app."""
    seen: list[bool] = []

    monkeypatch.setattr(
        backup_service,
        "_run_scheduled_backup_safely",
        lambda: seen.append(has_app_context()),
    )
    monkeypatch.setattr(backup_service.time, "sleep", lambda _s: None)

    # Already set, so wait() returns immediately and the loop runs once.
    stop_event = threading.Event()
    stop_event.set()

    backup_service._scheduler_loop(erp_app, stop_event)

    assert seen == [True], "the nightly backup ran outside an app context"
