"""Server-side vector PDF rendering, via headless Chromium (Playwright).

Why this exists
---------------
The client-side exporter (static/erp/print.js -> html2pdf.js) rasterises the
document with html2canvas and embeds the result as a single JPEG, so the PDF
contains a *picture* of the document rather than the document. Measured on a
representative 15-line Purchase Order: 361,394 bytes with **0** characters of
extractable text, against 48,256 bytes and 1,184 characters through a real
print engine -- 7.5x larger and completely unsearchable. See
docs/audit/PDF_GENERATION_REVIEW.md PDF-002.

This renders the *same* HTML the client's build*PrintPageHtml() builders
already produce, so no document markup changes. Chromium applies real
`@media print` CSS, which also retires html2pdf's page-guillotine workaround.

The client keeps its raster path as the offline fallback: this needs the
network, the other does not.

Safety
------
The HTML arrives from an authenticated browser, but "authenticated" is not
"trusted": whatever is posted here is rendered by a real browser running on
the server, so an unrestricted renderer is a server-side request forgery
primitive (`<img src="http://169.254.169.254/...">`) and a local file reader
(`file://`). Every render therefore runs with:

  * **all network blocked** -- one route handler aborts every request the page
    makes. Nothing is fetched: no http(s), no file://, no DNS. `data:` URIs
    still resolve because they are not network requests, which is what the
    company logo uses (core.js stores it as a canvas toDataURL).
  * **JavaScript disabled** -- the print builders emit static markup only.
  * a hard timeout and a payload cap.

Concurrency
-----------
Playwright's sync API binds its objects to the thread that created them, so a
single shared browser cannot be used from a threaded WSGI server. Each worker
thread lazily gets its own Playwright + browser and reuses it (thread-local),
which avoids paying ~0.5s of browser startup per export while staying within
the API's threading rules.
"""

from __future__ import annotations

import threading

from flask import current_app

# A4 minus the 6mm margin used everywhere else in the print stack. Must stay in
# step with App.Print.PAGE_MARGIN_MM (static/erp/print.js) and the @page rule in
# static/erp/styles.css, or window.print() and this path disagree on geometry.
PAGE_MARGIN_MM = 6

# Generous next to a purchase order (~4 KB) but far below anything that would
# tie up a browser. Rejected before Chromium is involved at all.
MAX_HTML_BYTES = 2_000_000

DEFAULT_TIMEOUT_MS = 20_000

_local = threading.local()


class PdfRenderUnavailable(RuntimeError):
    """Playwright or its Chromium build is not installed/usable here.

    Distinct from a render failure: the caller turns this into a 503 so the
    client can fall back to its own renderer permanently for the session,
    rather than retrying per document.
    """


def _document(body_html: str, landscape: bool) -> str:
    """Wrap a print-page fragment in the page shell.

    Built here rather than accepted from the client so that page size, margins
    and colour handling cannot be driven by the request body.
    """
    size = "A4 landscape" if landscape else "A4 portrait"
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<style>"
        f"@page {{ size: {size}; margin: {PAGE_MARGIN_MM}mm; }}"
        "html, body { margin: 0; padding: 0; background: #fff; }"
        # The builders emit their own inline typography; this is only a floor
        # so an unstyled element does not inherit something surprising.
        "body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a1a; }"
        # Keep table rows and the documents' closing blocks whole across a page
        # break. This is the real CSS equivalent of html2pdf's pagebreak.avoid
        # list -- and unlike that one, a print engine actually honours it.
        "tr, .print-sheet-closing-accent, #print-grand-total-container,"
        "#print-footer-meta, #print-signature { break-inside: avoid; }"
        "thead { display: table-header-group; }"
        "</style></head><body>"
        f"{body_html}"
        "</body></html>"
    )


def _browser():
    """The calling thread's Chromium, launched on first use."""
    browser = getattr(_local, "browser", None)
    if browser is not None and browser.is_connected():
        return browser

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - depends on deployment
        raise PdfRenderUnavailable("playwright is not installed") from exc

    try:
        pw = sync_playwright().start()
        # --no-sandbox is required in most containers, where the kernel
        # namespaces Chromium's sandbox needs are unavailable. Acceptable here
        # only because the page has no network and no JavaScript.
        browser = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
    except Exception as exc:
        raise PdfRenderUnavailable(f"could not start Chromium: {exc}") from exc

    _local.playwright = pw
    _local.browser = browser
    return browser


def render_pdf(body_html: str, *, landscape: bool = False) -> bytes:
    """Render one print-page fragment to a vector PDF.

    Raises ValueError for a bad request and PdfRenderUnavailable when this
    server cannot render at all.
    """
    if not isinstance(body_html, str) or not body_html.strip():
        raise ValueError("No document HTML supplied.")
    if len(body_html.encode("utf-8")) > MAX_HTML_BYTES:
        raise ValueError("Document is too large to render.")

    browser = _browser()
    context = browser.new_context(java_script_enabled=False)
    try:
        page = context.new_page()
        page.set_default_timeout(DEFAULT_TIMEOUT_MS)

        # Refuse every request the document tries to make. data: URIs are not
        # requests and are unaffected, so the embedded logo still renders.
        blocked: list[str] = []

        def _block(route, request):
            blocked.append(request.url)
            route.abort()

        context.route("**/*", _block)

        page.set_content(_document(body_html, landscape), wait_until="load")
        pdf = page.pdf(
            format="A4",
            landscape=landscape,
            print_background=True,
            margin={
                "top": f"{PAGE_MARGIN_MM}mm",
                "bottom": f"{PAGE_MARGIN_MM}mm",
                "left": f"{PAGE_MARGIN_MM}mm",
                "right": f"{PAGE_MARGIN_MM}mm",
            },
        )
        if blocked:
            # Not an error -- the document rendered without them -- but a
            # document reaching outward is worth seeing in the log.
            current_app.logger.info(
                "[PDF] blocked %d outbound request(s) during render: %s",
                len(blocked),
                ", ".join(sorted(set(blocked))[:5]),
            )
        return pdf
    finally:
        context.close()


def shutdown() -> None:
    """Release this thread's browser. For tests and graceful teardown."""
    import logging

    log = logging.getLogger(__name__)
    browser = getattr(_local, "browser", None)
    if browser is not None:
        try:
            browser.close()
        except Exception as exc:  # pragma: no cover - teardown is best effort
            log.debug("[PDF] browser close failed during shutdown: %s", exc)
        _local.browser = None
    pw = getattr(_local, "playwright", None)
    if pw is not None:
        try:
            pw.stop()
        except Exception as exc:  # pragma: no cover - teardown is best effort
            log.debug("[PDF] playwright stop failed during shutdown: %s", exc)
        _local.playwright = None
