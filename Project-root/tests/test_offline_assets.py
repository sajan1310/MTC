"""The browser must be able to load this app with no internet.

This app is deployed on factory LANs where the uplink is unreliable or
absent. Every third-party library therefore lives in static/erp/vendor/ and
is served same-origin.

That is not a style preference, and these tests exist because the failure it
prevents was both total and hard to read. The service worker caches only
same-origin /static/erp/ URLs, so while jQuery, Bootstrap, Select2, Chart.js
and the webfonts were loaded from cdn.jsdelivr.net and code.jquery.com they
were never in the offline shell. With no internet the browser fetched no
jQuery, and with no jQuery none of the app's JavaScript ran -- a blank page,
on a server that was up and healthy. It also failed unevenly: devices whose
HTTP cache was still warm kept working, so the fault appeared to follow
particular tablets rather than the network.

A single re-added CDN <script> tag restores that failure in full, which is
why it is asserted rather than documented.
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "static" / "erp" / "vendor"

# Files the browser loads that we author. vendor/ is excluded because it IS
# the fix, and tests/ because fixtures may legitimately name a CDN.
AUTHORED = [
    p
    for p in list((ROOT / "templates").rglob("*.html"))
    + list((ROOT / "static" / "erp").rglob("*.js"))
    + list((ROOT / "static" / "erp").rglob("*.css"))
    if "vendor" not in p.parts and "tests" not in p.parts
]


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def _precache_urls() -> list[str]:
    """The quoted entries of sw.js's PRECACHE_URLS.

    Line comments are stripped first. The comments inside that array explain
    why each group is there and contain ordinary apostrophes ("the app's
    JavaScript"), and a naive '([^']+)' sweep pairs one of those with the
    next real quote -- silently swallowing the URLs in between, so an
    assertion that a file is precached fails while the file is right there.
    """
    sw = _text(ROOT / "static" / "erp" / "sw.js")
    block = re.search(r"const PRECACHE_URLS = \[(.*?)\n\];", sw, re.S)
    assert block, "PRECACHE_URLS not found in sw.js"
    return re.findall(r"'([^']+)'", re.sub(r"//[^\n]*", "", block.group(1)))


@pytest.mark.parametrize("path", AUTHORED, ids=lambda p: str(p.relative_to(ROOT)))
def test_no_asset_is_loaded_from_a_remote_host(path):
    """No <script src>, <link href> or loadScript() may point off-origin."""
    text = _text(path)
    offenders = re.findall(r"""(?:src|href)=["']https?://[^"']+""", text)
    offenders += re.findall(r"""loadScript\(\s*["']https?://[^"']+""", text)
    offenders += re.findall(r"""^\s*import\s+\w+\s+from\s+["']https?://[^"']+""",
                            text, re.M)
    assert not offenders, (
        f"{path.relative_to(ROOT)} loads an asset from a remote host: {offenders}. "
        "Vendor it into static/erp/vendor/ instead -- a CDN asset cannot be "
        "precached by sw.js and breaks the app entirely on an offline LAN."
    )


def test_every_vendor_asset_referenced_actually_exists():
    """A typo'd vendor path is a 404 that only shows up in the browser."""
    referenced = set()
    for path in AUTHORED:
        referenced |= set(re.findall(r"erp/vendor/([A-Za-z0-9._/-]+)", _text(path)))
    assert referenced, "expected the app to reference vendored assets"

    missing = sorted(name for name in referenced if not (VENDOR / name).is_file())
    assert not missing, f"referenced but absent from static/erp/vendor/: {missing}"


def test_service_worker_precaches_the_vendored_libraries():
    """Without these in PRECACHE_URLS there is still no offline shell."""
    urls = set(_precache_urls())

    # jQuery is the load-bearing one: without it no other app script runs.
    for required in (
        "/static/erp/vendor/jquery-3.6.0.min.js",
        "/static/erp/vendor/bootstrap-5.3.0.bundle.min.js",
        "/static/erp/vendor/bootstrap-5.3.0.min.css",
        "/static/erp/vendor/google-fonts.css",
    ):
        assert required in urls, f"{required} missing from sw.js PRECACHE_URLS"


def test_every_precached_url_resolves_to_a_real_file():
    """cache.addAll() is atomic: one 404 discards the entire offline shell.

    So a single mistyped or deleted entry does not degrade the cache, it
    disables it -- silently, because the install event's rejection surfaces
    nowhere the user can see.
    """
    broken = [
        url
        for url in _precache_urls()
        if url.startswith("/static/") and not (ROOT / url.lstrip("/")).is_file()
    ]
    assert not broken, f"PRECACHE_URLS entries with no file on disk: {broken}"


def test_vendored_css_font_references_resolve():
    """bootstrap-icons.css and google-fonts.css use relative url() paths."""
    missing = []
    for css in VENDOR.glob("*.css"):
        for ref in re.findall(r'url\("?([^)"]+)"?\)', _text(css)):
            if ref.startswith(("data:", "http")):
                continue
            if not (VENDOR / ref.split("?")[0]).is_file():
                missing.append(f"{css.name} -> {ref}")
    assert not missing, f"vendored CSS references missing files: {missing}"
