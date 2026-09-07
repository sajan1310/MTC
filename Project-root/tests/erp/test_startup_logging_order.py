"""Startup diagnostics must be recorded, and production pool sizing must be real.

Both of these were silent divergences between what the code said and what it
did, and both surfaced while diagnosing the 2026-09-07 incident where a worker
served requests with no connection pool:

  * `logging_config.setup_logging()` ran ~120 lines AFTER
    `database.init_app()`, so the "Database pool initialized: N-M connections"
    line -- the only evidence that a worker's pool was ever built -- was
    emitted before any handler existed. The app logger had not been levelled
    yet either, so it inherited root's WARNING and the INFO was discarded
    outright rather than merely misfiled.

  * `database.init_app` carried its own `4 if production else 2` default for
    DB_POOL_MIN. config.py always defines that key, so `.get()` never reached
    the fallback and production ran the development minimum of 2 -- which the
    live server confirmed: 8 idle connections across 4 workers, not 16.
"""

from __future__ import annotations

import importlib
import logging

import database


def test_logging_is_configured_before_the_pool_is_built(monkeypatch):
    """The ordering, asserted through behaviour rather than line numbers.

    Records whether app.logger would actually emit INFO at the moment
    init_app is called. Before the fix this was False: root's WARNING was in
    effect, so the pool-init line went nowhere.
    """
    from app import create_app

    seen = {}
    real_init = database.init_app

    def spy(app):
        seen["info_enabled"] = app.logger.isEnabledFor(logging.INFO)
        seen["has_handler"] = bool(app.logger.handlers or logging.getLogger().handlers)
        return real_init(app)

    monkeypatch.setattr(database, "init_app", spy)
    create_app("testing")

    assert seen, "database.init_app was never called"
    assert seen["info_enabled"], (
        "app.logger drops INFO at init_app time -- the 'Database pool "
        "initialized' line is being discarded, which is exactly the gap that "
        "made the missing-pool incident undiagnosable"
    )
    assert seen["has_handler"]


def test_production_pool_minimum_is_four(monkeypatch):
    """ProductionConfig must carry the production default itself.

    Asserted on a freshly reloaded module with DB_POOL_MIN unset, so this
    reflects the default rather than whatever the environment happens to say.
    """
    monkeypatch.delenv("DB_POOL_MIN", raising=False)
    import config as config_module

    config_module = importlib.reload(config_module)

    assert config_module.ProductionConfig.DB_POOL_MIN == 4
    assert config_module.Config.DB_POOL_MIN == 2


def test_db_pool_min_env_override_still_wins(monkeypatch):
    monkeypatch.setenv("DB_POOL_MIN", "7")
    import config as config_module

    config_module = importlib.reload(config_module)

    assert config_module.ProductionConfig.DB_POOL_MIN == 7
