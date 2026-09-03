"""The app must refuse to start on a schema older than the code.

Written after a live incident. Three migrations (036/037/038) were added and
applied to the TEST database, but not to the developer's own. The application
started normally, served every read correctly, and then returned HTTP 500 on
the first mutation anyone attempted::

    psycopg2.errors.UndefinedColumn:
      column "status" of relation "rpc_mutations" does not exist

It presented as "cannot save production or production status" only because
that is what the user happened to try first -- every mutating RPC method was
broken, since app/erp/mutations.py's claim() writes that column. Nothing at
boot mentioned the schema was behind.

deploy/mtc.service runs the migrator from ExecStartPre and
docker-entrypoint.sh does the same, so the deployed paths were covered. The
gap was every local entry point -- `flask run`, `python run.py`,
`python app.py` -- which is precisely where it bit.

_verify_schema_is_current now fails fast at create_app() for all of them.
These tests pin that, and pin the escape hatch, because a startup guard that
can be silently defeated is the shape of bug it exists to prevent (see
SEC-001, where a fallback value made the SECRET_KEY guard unreachable).
"""

from __future__ import annotations

import pathlib

import pytest

from app import _verify_schema_is_current


class _FakeCursor:
    """Answers the two queries _verify_schema_is_current makes."""

    def __init__(self, applied, table_present=True):
        self._applied = applied
        self._table_present = table_present
        self._last = None

    def execute(self, sql, params=None):
        self._last = "regclass" if "to_regclass" in sql else "applied"

    def fetchone(self):
        return (self._table_present,)

    def fetchall(self):
        return [(name,) for name in self._applied]


class _FakeConnCtx:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return (None, self._cursor)

    def __exit__(self, *exc):
        return False


@pytest.fixture
def migration_names():
    """The migrations actually on disk -- the same set the guard globs."""
    directory = pathlib.Path(__file__).resolve().parent.parent / "migrations" / "erp"
    names = sorted(p.stem for p in directory.glob("*.sql"))
    assert names, "no migrations found on disk"
    return names


def _run_guard(monkeypatch, app, applied, table_present=True):
    import database

    monkeypatch.setattr(
        database,
        "get_conn",
        lambda *a, **k: _FakeConnCtx(_FakeCursor(applied, table_present)),
    )
    _verify_schema_is_current(app)


# ── The incident ─────────────────────────────────────────────────────────


def test_refuses_to_start_when_a_migration_is_missing(
    monkeypatch, app, migration_names
):
    """THE regression test: one unapplied migration must stop the app."""
    app.config["TESTING"] = False
    applied = migration_names[:-1]  # everything except the newest
    with pytest.raises(RuntimeError) as exc:
        _run_guard(monkeypatch, app, applied)

    message = str(exc.value)
    assert "Refusing to start" in message
    assert migration_names[-1] in message, "the message must name what is pending"
    assert "runner.py" in message, "the message must say how to fix it"


def test_names_every_pending_migration(monkeypatch, app, migration_names):
    """The incident had three pending at once; naming only one would send the
    operator round the loop twice."""
    app.config["TESTING"] = False
    with pytest.raises(RuntimeError) as exc:
        _run_guard(monkeypatch, app, migration_names[:-3])
    message = str(exc.value)
    for name in migration_names[-3:]:
        assert name in message
    assert "3 database migration(s)" in message


def test_refuses_to_start_when_never_migrated(monkeypatch, app, migration_names):
    """A database with no erp.migrations_applied at all."""
    app.config["TESTING"] = False
    with pytest.raises(RuntimeError, match="never been migrated"):
        _run_guard(monkeypatch, app, [], table_present=False)


# ── The passing case ─────────────────────────────────────────────────────


def test_starts_when_the_schema_is_current(monkeypatch, app, migration_names):
    """Without this, the tests above would pass if the guard rejected
    everything."""
    app.config["TESTING"] = False
    _run_guard(monkeypatch, app, migration_names)  # must not raise


def test_extra_applied_rows_are_not_an_error(monkeypatch, app, migration_names):
    """A migration recorded in the database but no longer on disk (deleted or
    renamed in a later branch) is not a reason to refuse to start -- the code
    is not AHEAD of the schema, which is the failure being guarded."""
    app.config["TESTING"] = False
    _run_guard(monkeypatch, app, migration_names + ["999_from_another_branch"])


# ── Guard rails on the guard ─────────────────────────────────────────────


def test_skipped_under_testing(monkeypatch, app, migration_names):
    """conftest builds its own schema and constructs ~150 apps per session."""
    app.config["TESTING"] = True
    _run_guard(monkeypatch, app, [])  # must not raise


def test_escape_hatch_is_explicit_and_logged(monkeypatch, app, migration_names, caplog):
    app.config["TESTING"] = False
    monkeypatch.setenv("SKIP_MIGRATION_CHECK", "1")
    with caplog.at_level("WARNING"):
        _run_guard(monkeypatch, app, [])  # must not raise
    assert any("SKIP_MIGRATION_CHECK" in r.message for r in caplog.records), (
        "overriding the guard must leave a trace"
    )


@pytest.mark.parametrize("falsey", ["", "0", "false", "no", "off"])
def test_escape_hatch_ignores_falsey_values(monkeypatch, app, migration_names, falsey):
    """The value arrives from the environment, so it is a string."""
    app.config["TESTING"] = False
    monkeypatch.setenv("SKIP_MIGRATION_CHECK", falsey)
    with pytest.raises(RuntimeError):
        _run_guard(monkeypatch, app, migration_names[:-1])


def test_a_broken_check_does_not_block_a_healthy_app(monkeypatch, app):
    """The guard must never be the reason a correctly-migrated app fails to
    boot -- e.g. if the connection is momentarily unavailable."""
    import database

    def _boom(*a, **k):
        raise RuntimeError("connection refused")

    app.config["TESTING"] = False
    monkeypatch.setattr(database, "get_conn", _boom)
    # RuntimeError from get_conn itself is swallowed and logged, not raised.
    _verify_schema_is_current(app)
