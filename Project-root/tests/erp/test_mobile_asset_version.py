"""The mobile shell's assets are cache-busted in step with its worker.

A deploy used to leave every installed phone running NEW HTML against OLD
JavaScript. The two halves of the shell are cached differently and always
have been: navigations are network-first, so the markup updates the instant
it ships, while /static/erp/* is cache-first with no revalidation, so the
script does not. The phone ran new markup through a script that had never
heard of it -- one good deploy presenting as four separate bugs (a dead
add-bill form, missing charts, a missing threshold editor, "modules not up
to date") for as long as the operator left the reload prompt unanswered.

Appending ?v=<n> makes the new HTML ask for a URL the old cache cannot
satisfy. The JS side of the contract is pinned in static/erp/tests/
sw_precache.test.js; this is the half that only the server can prove.
"""

from __future__ import annotations

import re
from pathlib import Path

STATIC_ERP = Path(__file__).resolve().parents[2] / "static" / "erp"
SHELL_ASSETS = ["mobile.js", "api.js", "offline-cache.js", "mobile_styles.css"]


def _worker_version() -> str:
    src = (STATIC_ERP / "mobile-sw.js").read_text(encoding="utf-8")
    match = re.search(r"CACHE_NAME\s*=\s*['\"][a-z-]+-v(\d+)['\"]", src)
    assert match, "mobile-sw.js has no parseable CACHE_NAME"
    return match.group(1)


def test_every_shell_asset_carries_the_workers_version(erp_client):
    version = _worker_version()
    html = erp_client.get("/erp/mobile").get_data(as_text=True)

    for asset in SHELL_ASSETS:
        assert f"/static/erp/{asset}?v={version}" in html, (
            f"{asset} is not cache-busted; a deploy will pair new HTML with "
            f"the old cached copy of it"
        )


def test_no_shell_asset_is_referenced_unversioned(erp_client):
    """One un-busted script is enough to bring the bug back."""
    html = erp_client.get("/erp/mobile").get_data(as_text=True)

    for asset in SHELL_ASSETS:
        for hit in re.finditer(rf"/static/erp/{re.escape(asset)}(\?v=\d+)?", html):
            assert hit.group(1), f"{asset} referenced without ?v="


def test_the_version_is_the_workers_own_not_a_second_copy(erp_client):
    """One number to bump. A constant maintained separately in pages.py
    would drift from CACHE_NAME silently, and the symptom would be the
    original bug back again with the cache-bump CI job still green.
    """
    html = erp_client.get("/erp/mobile").get_data(as_text=True)
    assert f"?v={_worker_version()}" in html


def test_a_missing_worker_degrades_to_stale_not_to_a_500():
    """_asset_version swallows OSError deliberately: an unreadable worker
    should cost cache-busting, not the whole page.
    """
    from app.erp.pages import _asset_version

    from flask import Flask

    app = Flask(__name__, static_folder=str(STATIC_ERP.parents[1]))
    with app.app_context():
        assert _asset_version("no-such-worker.js", "0") == "0"
