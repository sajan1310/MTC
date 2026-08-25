"""One cache-busting token per deploy, not per worker (PERF-007).

`Config.VERSION` was `str(int(time.time()))`, evaluated at class-definition
time. Every gunicorn worker imports config separately, so every worker
computed a different value. With 4 workers a user could receive up to 4
different URLs for the same unchanged file depending on which worker rendered
the page -- four cache entries, four downloads, and a page able to load
styles.css from one version and core.js from another.

It also changed on every restart, discarding every returning user's asset
cache for restarts that shipped no new assets at all.
"""

from __future__ import annotations

import importlib
import os
import re

import pytest


def _fresh_version() -> str:
    """Config.VERSION as a newly-started worker would compute it."""
    import config

    importlib.reload(config)
    return config.Config.VERSION


@pytest.fixture(autouse=True)
def _restore_config_module():
    """Reloading config mutates a module every other test shares. Snapshot
    the namespace and put it back -- the same failure mode, and the same
    remedy, as tests/test_config_failfast.py documents at length."""
    import config

    pristine = dict(vars(config))
    try:
        yield
    finally:
        namespace = vars(config)
        namespace.clear()
        namespace.update(pristine)


# ── The finding ──────────────────────────────────────────────────────────


def test_two_workers_compute_the_same_version():
    """THE regression test. Each reload stands in for a separate worker
    process importing config for itself."""
    assert _fresh_version() == _fresh_version() == _fresh_version()


def test_the_version_does_not_track_the_clock():
    """A token derived from time.time() changes on every restart, so a
    restart that shipped no new assets still invalidated every user's cache."""
    import time

    before = _fresh_version()
    time.sleep(1.1)
    assert _fresh_version() == before


def test_the_version_is_a_usable_url_token():
    """It goes straight into ?v= in a dozen templates, so anything needing
    escaping would corrupt the URL."""
    version = _fresh_version()
    assert version
    assert re.fullmatch(r"[A-Za-z0-9._-]+", version), version


# ── The override ─────────────────────────────────────────────────────────


def test_asset_version_env_var_wins(monkeypatch):
    """The right answer for a multi-machine deployment: separate checkouts
    give the same file different mtimes on different hosts, so the fingerprint
    would differ between them even though the assets are identical."""
    monkeypatch.setenv("ASSET_VERSION", "release-2026-08-25")
    assert _fresh_version() == "release-2026-08-25"


def test_without_the_env_var_it_falls_back_to_the_fingerprint(monkeypatch):
    monkeypatch.delenv("ASSET_VERSION", raising=False)
    version = _fresh_version()
    assert version
    assert version != "release-2026-08-25"


# ── The fingerprint itself ───────────────────────────────────────────────


def test_the_fingerprint_tracks_the_newest_asset(tmp_path, monkeypatch):
    """It has to change when a file changes, or the whole point is lost."""
    import config

    static_dir = tmp_path / "static"
    (static_dir / "erp").mkdir(parents=True)
    asset = static_dir / "erp" / "thing.js"
    asset.write_text("// v1", encoding="utf-8")
    os.utime(asset, (1_700_000_000, 1_700_000_000))

    monkeypatch.setattr(
        config.os.path, "dirname", lambda _p: str(tmp_path), raising=False
    )
    first = config._static_asset_fingerprint()

    os.utime(asset, (1_700_000_500, 1_700_000_500))
    second = config._static_asset_fingerprint()

    assert first != second, "editing an asset must change the token"
    assert int(second) > int(first)


def test_an_unreadable_static_directory_does_not_reintroduce_the_clock(monkeypatch):
    """The fallback must not be time.time(). An asset directory that cannot
    be read is not a reason to hand every user a new token on every restart,
    which is the exact behaviour this finding is about."""
    import config

    def _explode(*_args, **_kwargs):
        raise OSError("no such directory")

    monkeypatch.setattr(config.os, "walk", _explode)
    assert config._static_asset_fingerprint() == "static"
    assert config._static_asset_fingerprint() == "static"


# ── It reaches the page ──────────────────────────────────────────────────


def test_the_rendered_page_carries_one_version(client):
    """Templates reference config.VERSION on every stylesheet and script; if
    a single page ever carried two different tokens, that is the mixed-assets
    failure this finding describes."""
    html = client.get("/auth/login").get_data(as_text=True)
    tokens = set(re.findall(r"\?v=([A-Za-z0-9._-]+)", html))
    assert tokens, "no cache-busting tokens on the page at all"
    assert len(tokens) == 1, f"page mixes asset versions: {tokens}"
