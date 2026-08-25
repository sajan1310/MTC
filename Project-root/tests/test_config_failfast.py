"""Startup configuration fail-fast (SEC-001, SEC-010).

These exist because the production guard in app/__init__.py's _load_config()
was, for the whole life of the project, structurally unreachable for the one
key that matters most. It tested truthiness:

    for key in ("SECRET_KEY", ...):
        if not app.config.get(key):
            missing.append(key)

while config.py supplied ``os.getenv("SECRET_KEY") or "dev-insecure-key"``. A
non-empty default is always truthy, so SECRET_KEY could never land in
``missing`` and a production deployment with nothing in its environment booted
happily on a key committed to this repository -- forgeable session cookies for
any user id and forgeable password-reset tokens for any address, with no error,
no warning and no log line.

The fallback is gone and the guard now also rejects weak and short values. The
tests below pin that behaviour: every one of them fails against the old code.

They drive ``_load_config`` directly against a bare Flask app rather than
``create_app``, because create_app goes on to open a real database connection
-- which would make these tests need a database to prove a thing that has
nothing to do with one.
"""

from __future__ import annotations

import pytest
from flask import Flask

from app import MIN_SECRET_KEY_LENGTH, WEAK_SECRET_KEYS, _load_config

# Long enough to clear MIN_SECRET_KEY_LENGTH and not in WEAK_SECRET_KEYS.
STRONG_SECRET = "k7Qv2ZtR9wLpX4nC8mJyH3sD6gB1aF5eU0oI2rT7yV4xN9zM"

# Everything _load_config needs besides the key under test, so that a failure
# is unambiguously about SECRET_KEY and not collateral.
COMPLETE_DB_ENV = {
    "DATABASE_URL": "postgresql://u:p@127.0.0.1:5432/db",
    "GOOGLE_CLIENT_ID": "test-client-id",
    "GOOGLE_CLIENT_SECRET": "test-client-secret",
}


@pytest.fixture(autouse=True)
def _leave_the_config_module_as_we_found_it():
    """Put the `config` module's namespace back exactly as it was.

    `_load` below reloads `config` with SECRET_KEY/DB_PASS/DATABASE_URL
    stripped from the environment. config.py reads os.environ at class-
    definition time, so that reload leaves `config.TestingConfig` holding the
    stripped values -- with DB_PASS fallen back to its hard-coded 'testpass'
    -- for the rest of the pytest session, long after monkeypatch has put the
    environment back.

    What that cost: every later `create_app("testing")` built its config from
    that module, `database.init_app` could not authenticate, and its TESTING
    branch sets the module-global `db_pool = None` and returns rather than
    raising. Nothing ever set it back. One file's teardown thereby disabled
    the connection pool process-wide, and 27 tests across three unrelated
    files failed with "Database pool is not available" -- an error pointing
    at everything except the file responsible.

    Restoring by snapshotting the namespace rather than by reloading again:
    importlib.reload mutates the module object in place, so the snapshot
    holds the original class objects and putting it back is exact. A second
    reload would instead depend on the environment being restored first,
    which is a fixture-ordering assumption -- and the wrong one, as it turns
    out: this fixture finalises before `monkeypatch` does, so at teardown the
    environment is still stripped and the reload reproduces the damage.
    """
    import config

    pristine = dict(vars(config))
    try:
        yield
    finally:
        namespace = vars(config)
        namespace.clear()
        namespace.update(pristine)


def _load(monkeypatch, **env):
    """Run _load_config("production") against `env`, with the real environment
    and .env file taken out of the picture."""
    # config.py calls load_dotenv(override=True) at import time and again on
    # reload; without neutralising it the developer's own .env decides the
    # outcome of these tests.
    import dotenv

    monkeypatch.setattr(dotenv, "load_dotenv", lambda *a, **k: False)

    for key in (
        "SECRET_KEY",
        "DATABASE_URL",
        "DB_HOST",
        "DB_NAME",
        "DB_USER",
        "DB_PASS",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    # config.py reads os.environ at class-definition time, so it has to be
    # re-imported after the environment is set.
    import importlib

    import config

    importlib.reload(config)

    app = Flask(__name__)
    _load_config(app, "production")
    return app


# ── SEC-001: SECRET_KEY ──────────────────────────────────────────────────


def test_production_refuses_to_start_with_no_secret_key(monkeypatch):
    """The original defect, exactly: nothing in the environment."""
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _load(monkeypatch, **COMPLETE_DB_ENV)


def test_production_refuses_to_start_with_empty_secret_key(monkeypatch):
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _load(monkeypatch, SECRET_KEY="", **COMPLETE_DB_ENV)


def test_production_refuses_to_start_with_whitespace_secret_key(monkeypatch):
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _load(monkeypatch, SECRET_KEY="   ", **COMPLETE_DB_ENV)


@pytest.mark.parametrize("weak", sorted(WEAK_SECRET_KEYS))
def test_production_refuses_every_known_weak_secret_key(monkeypatch, weak):
    """Including 'dev-insecure-key' -- the literal string config.py used to
    fall back to, so choosing DevelopmentConfig in production is still
    rejected rather than quietly accepted."""
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _load(monkeypatch, SECRET_KEY=weak, **COMPLETE_DB_ENV)


def test_weak_secret_key_check_is_case_and_whitespace_insensitive(monkeypatch):
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _load(monkeypatch, SECRET_KEY="  ChangeMe  ", **COMPLETE_DB_ENV)


def test_production_refuses_a_short_secret_key(monkeypatch):
    short = "a" * (MIN_SECRET_KEY_LENGTH - 1)
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _load(monkeypatch, SECRET_KEY=short, **COMPLETE_DB_ENV)


def test_production_accepts_a_strong_secret_key(monkeypatch):
    """The positive case -- without it the tests above would still pass if the
    guard simply rejected everything."""
    app = _load(monkeypatch, SECRET_KEY=STRONG_SECRET, **COMPLETE_DB_ENV)
    assert app.config["SECRET_KEY"] == STRONG_SECRET


def test_secret_key_value_is_never_echoed_in_the_error(monkeypatch):
    """This message reaches stderr, the journal and any log shipper."""
    with pytest.raises(RuntimeError) as exc:
        _load(monkeypatch, SECRET_KEY="changeme", **COMPLETE_DB_ENV)
    assert "changeme" not in str(exc.value)


# ── SEC-010: database credentials ────────────────────────────────────────


def test_production_refuses_to_start_with_no_db_password(monkeypatch):
    """DB_PASS used to fall back to "abcd". With the fallback removed, the
    guard has to name it, or psycopg2 is handed password=None and the
    misconfiguration surfaces deep inside the first request instead."""
    with pytest.raises(RuntimeError, match="DB_PASS"):
        _load(
            monkeypatch,
            SECRET_KEY=STRONG_SECRET,
            GOOGLE_CLIENT_ID="id",
            GOOGLE_CLIENT_SECRET="secret",
            DB_HOST="127.0.0.1",
            DB_NAME="mtc",
            DB_USER="postgres",
        )


def test_discrete_db_settings_are_accepted_when_complete(monkeypatch):
    app = _load(
        monkeypatch,
        SECRET_KEY=STRONG_SECRET,
        GOOGLE_CLIENT_ID="id",
        GOOGLE_CLIENT_SECRET="secret",
        DB_HOST="127.0.0.1",
        DB_NAME="mtc",
        DB_USER="postgres",
        DB_PASS="a-real-password",
    )
    assert app.config["DB_PASS"] == "a-real-password"


def test_database_url_alone_satisfies_the_db_requirement(monkeypatch):
    """DATABASE_URL carries the password inside it, so DB_PASS is not
    separately required on that path."""
    app = _load(monkeypatch, SECRET_KEY=STRONG_SECRET, **COMPLETE_DB_ENV)
    assert app.config["DATABASE_URL"]


# ── OAuth credentials ────────────────────────────────────────────────────


def test_production_refuses_to_start_without_google_credentials(monkeypatch):
    with pytest.raises(RuntimeError, match="GOOGLE_CLIENT_ID"):
        _load(
            monkeypatch,
            SECRET_KEY=STRONG_SECRET,
            DATABASE_URL="postgresql://u:p@127.0.0.1:5432/db",
        )
