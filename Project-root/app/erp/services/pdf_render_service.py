"""Server-side vector PDF rendering, via WeasyPrint.

Why this exists
---------------
`window.print()` is how every document in this app reaches paper or a PDF, and
it is the right default: no dependencies, perfect fidelity, works offline. What
it cannot do is hand back a *file*. One print dialog produces one document, so
"export these 40 challans as 40 separately-named PDFs" has no expression in it.

That is the only job this module has. It renders the **same HTML the
build*PrintPageHtml() builders already produce** -- the markup `window.print()`
prints -- so there is one definition of every document, not two. A second
definition (redrawing the documents through a client-side PDF library) was the
alternative, and docs/audit/PDF_GENERATION_REVIEW.md PDF-004 records what
happens to duplicated document code here: it drifted in both directions.

Why WeasyPrint and not a headless browser
-----------------------------------------
The predecessor of this file drove headless Chromium through Playwright. It
produced excellent output and cost a ~400 MB image layer, which is why the
Dockerfile shipped it disabled by default -- so the default deployment quietly
produced no server-rendered PDFs at all. WeasyPrint is a few tens of megabytes
of system libraries, runs in-process, and starts no subprocess.

It renders CSS, not JavaScript, which suits this app exactly: the print
builders emit static tables with inline styles. It is also why the security
story below is short.

Security
--------
The HTML arrives from an authenticated browser, but "authenticated" is not
"trusted". A renderer that resolves whatever URLs it is handed is a
server-side request forgery primitive (`<img src="http://169.254.169.254/...">`)
and a local file reader (`file:///etc/passwd`). So:

  * **every external fetch is refused** -- `_blocked_url_fetcher` raises for
    anything that is not a `data:` URI. `data:` is not a network request and is
    what the company logo uses (core.js stores it as a canvas toDataURL), so
    the logo still renders.
  * **no base_url**, so a relative path has nothing to resolve against and
    cannot walk to the filesystem.
  * **no JavaScript**, because WeasyPrint has no script engine at all.
  * a payload cap, and a cap on documents per batch.
"""

from __future__ import annotations

import io
import os
import pathlib
import re
import sys
import zipfile

# Generous next to a purchase order (~4 KB) but far below anything that would
# tie up a worker. Rejected before the renderer is involved at all.
MAX_HTML_BYTES = 2_000_000

# One bulk export. 200 purchase orders is already an unusual day; past this the
# request is more likely a mistake than a workload.
MAX_BATCH_DOCUMENTS = 200
MAX_BATCH_BYTES = 20_000_000

# A4 minus the margin used everywhere else in the print stack. Must stay in
# step with App.Print.PAGE_MARGIN_MM (static/erp/print.js) and the @page rule
# in static/erp/styles.css, or window.print() and this path disagree on
# geometry -- which would be visible as the same document paginating
# differently depending on which button produced it.
PAGE_MARGIN_MM = 6


# Where MSYS2 puts the GTK stack on Windows. Checked in order; the first that
# actually holds the libraries wins.
_WINDOWS_LIB_DIRS = (
    r"C:\msys64\mingw64\bin",
    r"C:\msys64\clang64\bin",
    r"C:\Program Files\GTK3-Runtime Win64\bin",
)


def _ensure_windows_libs_on_path() -> str | None:
    """Put the GTK libraries where WeasyPrint will find them, on Windows.

    pip installs WeasyPrint on Windows perfectly happily and it then cannot
    load: pango, harfbuzz and glib are not Python packages and do not come with
    it. The usual fix is to install MSYS2 and edit PATH -- and the failure when
    somebody skips the second half is `cannot load library
    'libgobject-2.0-0'`, which says nothing about MSYS2.

    So rather than trusting PATH, look where the libraries actually live and
    adopt whichever directory has them. Must run BEFORE weasyprint is imported,
    since that import is what loads them.

    Returns the directory used, or None (already importable, not Windows, or
    nothing found -- all of which are handled by the caller).
    """
    if sys.platform != "win32":
        return None

    for candidate in _WINDOWS_LIB_DIRS:
        path = pathlib.Path(candidate)
        if not (path / "libgobject-2.0-0.dll").is_file():
            continue

        # add_dll_directory is the targeted mechanism -- it extends DLL search
        # without touching PATH -- but ctypes.util.find_library, which is how
        # WeasyPrint locates libgobject in the first place, reads PATH. So both
        # are needed.
        #
        # APPENDED, never prepended. This directory also contains MSYS2's own
        # libssl, libcrypto, zlib, libiconv and libintl, and putting those
        # ahead of everything else lets them shadow the copies psycopg loads
        # for the database connection. Prepending here broke unrelated tests
        # further down the suite -- probe() runs at import, so one PDF module
        # was quietly re-pointing the whole process's DLL resolution.
        # Appending still lets find_library locate libgobject, which nothing
        # else provides, while anything already resolvable keeps winning.
        if candidate not in os.environ.get("PATH", ""):
            os.environ["PATH"] = os.environ.get("PATH", "") + os.pathsep + candidate
        try:
            os.add_dll_directory(candidate)
        except (AttributeError, OSError):  # pragma: no cover - platform detail
            pass
        return candidate

    return None


class PdfRenderUnavailable(RuntimeError):
    """WeasyPrint is not installed, or its system libraries are missing.

    Distinct from a render failure: the caller turns this into a 503 so the
    client falls back to the print dialog for the rest of the session rather
    than retrying once per document.
    """


def _blocked_url_fetcher(url, *args, **kwargs):
    """Refuse every fetch except `data:`.

    WeasyPrint calls this for every external resource the document references.
    Raising is what stops it; returning empty content would let a document
    silently render without an image it expected, which is harder to notice.
    """
    if url.startswith("data:"):
        from weasyprint import default_url_fetcher

        return default_url_fetcher(url, *args, **kwargs)
    raise ValueError(f"External resources are not fetched when rendering: {url!r}")


# The density tiers from static/erp/styles.css, restated for this renderer.
# The client picks the tier (App.Print.fitToPage counts the widest row) and
# sends its class name, because it is the side that has a DOM to count. Keep
# the numbers here in step with the stylesheet, or the same document paginates
# differently depending on which button produced it.
_FIT_TIERS = {
    "print-fit-compact": "font-size: 10px; padding: 4px 5px;",
    "print-fit-dense": "font-size: 9px; padding: 3px 4px; line-height: 1.25;",
    "print-fit-xdense": (
        "font-size: 8px; padding: 2px 3px; line-height: 1.2; letter-spacing: -0.1px;"
    ),
}


def _document(body_html: str, landscape: bool, density: str = "") -> str:
    """Wrap a print-page fragment in the page shell.

    Built here rather than accepted from the request so page size, margins and
    the page-break rules cannot be driven by the request body. `density` is the
    one piece of layout the client chooses, and it is validated against a fixed
    set rather than interpolated.
    """
    size = "A4 landscape" if landscape else "A4 portrait"
    density = density if density in _FIT_TIERS else ""
    tier_css = (
        f"body.{density} th, body.{density} td {{ {_FIT_TIERS[density]} }}"
        if density
        else ""
    )
    return (
        "<!doctype html><html><head><meta charset='utf-8'>"
        "<style>"
        f"@page {{ size: {size}; margin: {PAGE_MARGIN_MM}mm; }}"
        "html, body { margin: 0; padding: 0; background: #fff; }"
        # The builders emit their own inline typography; this is only a floor
        # so an unstyled element does not inherit something surprising.
        "body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a1a; }"
        # Fitting the document to the page, mirroring styles.css. A table
        # wider than the printable box is CUT, not scaled, so the right-hand
        # columns simply vanish. `overflow-wrap: anywhere` is the property
        # that fixes it: unlike `break-word`, its break opportunities COUNT
        # toward min-content, which is what lets a column narrow past its
        # longest unbreakable token and lets width:100% actually hold.
        "table { width: 100%; max-width: 100%; }"
        "th, td { overflow-wrap: anywhere; }"
        f"{tier_css}"
        # The print stylesheet's pagination rules, restated for this renderer:
        # keep rows whole, repeat table headers, and keep each document's
        # closing blocks together. Mirrors the @media print block in
        # static/erp/styles.css so both paths paginate the same way.
        "tr, .print-sheet-closing-accent, #print-grand-total-container,"
        "#print-footer-meta, #print-signature { break-inside: avoid; }"
        "thead { display: table-header-group; }"
        "tfoot { display: table-footer-group; }"
        f"</style></head><body class='{density}'>"
        f"{body_html}"
        "</body></html>"
    )


def probe() -> tuple[bool, str]:
    """Can this process render? Never raises.

    Importing WeasyPrint is what actually exercises the system libraries: the
    package installs from pip on any platform, but loading it fails without
    pango/harfbuzz present, which on Windows they are not by default.
    """
    adopted = _ensure_windows_libs_on_path()

    try:
        import weasyprint
    except ImportError:
        return (
            False,
            "the 'weasyprint' package is not installed (pip install -r requirements.txt)",
        )
    except OSError as exc:
        return False, (
            "weasyprint is installed but its system libraries are missing "
            f"({exc}). On Debian/Ubuntu: apt install libpango-1.0-0 "
            "libpangoft2-1.0-0 libharfbuzz-subset0. On Windows, install MSYS2 "
            "and its mingw-w64-x86_64-pango package, then put "
            "C:\\msys64\\mingw64\\bin on PATH."
        )
    except Exception as exc:  # pragma: no cover - defensive
        return False, f"weasyprint could not be loaded: {exc}"
    version = getattr(weasyprint, "__version__", "?")
    where = f" (libraries from {adopted})" if adopted else ""
    return True, f"weasyprint {version} available{where}"


def _weasyprint():
    ok, detail = probe()
    if not ok:
        raise PdfRenderUnavailable(detail)
    import weasyprint

    return weasyprint


def log_availability(logger) -> bool:
    """Say once, at boot, whether Download PDF will produce a file here.

    Without this the only signal is a 503 the first time somebody exports, and
    the client falls back to the print dialog without complaining -- so the
    feature is quietly absent and nobody finds out.
    """
    ok, detail = probe()
    if ok:
        logger.info("[PDF] server-side rendering enabled -- %s", detail)
    else:
        logger.warning(
            "[PDF] server-side rendering DISABLED -- %s. Download PDF will fall "
            "back to the print dialog, which still produces a searchable PDF; "
            "bulk export as separate files is unavailable until this is fixed.",
            detail,
        )
    return ok


def render_pdf(body_html: str, *, landscape: bool = False, density: str = "") -> bytes:
    """Render one print-page fragment to a vector PDF.

    Raises ValueError for a bad request and PdfRenderUnavailable when this
    server cannot render at all.
    """
    if not isinstance(body_html, str) or not body_html.strip():
        raise ValueError("No document HTML supplied.")
    if len(body_html.encode("utf-8")) > MAX_HTML_BYTES:
        raise ValueError("Document is too large to render.")

    weasyprint = _weasyprint()
    document = weasyprint.HTML(
        string=_document(body_html, landscape, density),
        # No base_url: a relative URL then has nothing to resolve against and
        # cannot reach the filesystem.
        base_url=None,
        url_fetcher=_blocked_url_fetcher,
    )
    return document.write_pdf()


def safe_filename(name: str, fallback: str = "Document") -> str:
    """Normalise one entry name for the archive.

    Rejects anything that could escape the archive root when extracted --
    separators and parent traversal -- rather than sanitising around them.
    """
    name = str(name or "").strip().replace("\\", "/")
    name = name.rsplit("/", 1)[-1]  # drop any path component
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "-", name)
    name = name.strip(". ") or fallback
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name[:120]


def dedupe_filenames(names: list[str]) -> list[str]:
    """Make every name in a batch distinct, preserving order.

    Two records can easily want the same name: the client's sanitizer maps any
    wholly non-Latin vendor name onto one fallback, and its length cap can
    collapse two long names that differ only past the cap. Inside a ZIP a
    repeat is worse than a collision on disk -- some extractors silently keep
    only the last one, so a 40-record export quietly yields 38 files.
    """
    seen: dict[str, int] = {}
    out: list[str] = []
    for name in names:
        key = name.lower()
        if key not in seen:
            seen[key] = 1
            out.append(name)
            continue
        seen[key] += 1
        stem, dot, ext = name.rpartition(".")
        out.append(f"{stem}_{seen[key]}{dot}{ext}" if dot else f"{name}_{seen[key]}")
    return out


def render_batch(documents: list[dict]) -> tuple[bytes, list[str]]:
    """Render many documents into one ZIP of separately-named PDFs.

    `documents` is [{"filename": str, "html": str, "landscape": bool}, ...].
    Returns (zip_bytes, names_used).

    One request for the whole batch, deliberately. The predecessor of this
    feature issued one HTTP request and one render per record, with a
    deliberate pause between them, so a 50-record export was 50 round trips.

    Entries are STOREd rather than deflated: a PDF's own streams are already
    compressed, so re-compressing them buys almost nothing for real CPU.
    """
    if not isinstance(documents, list) or not documents:
        raise ValueError("No documents supplied.")
    if len(documents) > MAX_BATCH_DOCUMENTS:
        raise ValueError(
            f"Too many documents in one export (limit {MAX_BATCH_DOCUMENTS})."
        )

    total = sum(len(str(d.get("html") or "").encode("utf-8")) for d in documents)
    if total > MAX_BATCH_BYTES:
        raise ValueError("This export is too large to render in one request.")

    names = dedupe_filenames(
        [
            safe_filename(d.get("filename"), f"Document_{i + 1}")
            for i, d in enumerate(documents)
        ]
    )

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        for name, doc in zip(names, documents):
            pdf = render_pdf(
                doc.get("html"),
                landscape=bool(doc.get("landscape")),
                density=str(doc.get("density") or ""),
            )
            archive.writestr(name, pdf)
    return buffer.getvalue(), names


if __name__ == "__main__":  # pragma: no cover - operational tool
    # Smoke check:  python -m app.erp.services.pdf_render_service
    ok, detail = probe()
    print(f"probe   : {'ok' if ok else 'FAILED'} -- {detail}")
    if not ok:
        raise SystemExit(1)

    pdf = render_pdf("<h1>PDF render smoke check</h1><p>PO-2026-0417</p>")
    print(f"render  : ok -- {len(pdf):,} bytes")
    if not pdf.startswith(b"%PDF-"):
        print("output  : FAILED -- not a PDF")
        raise SystemExit(1)

    blob, names = render_batch(
        [
            {"filename": "PO_1204_Mahadev.pdf", "html": "<h1>One</h1>"},
            {"filename": "PO_1204_Mahadev.pdf", "html": "<h1>Two</h1>"},
        ]
    )
    print(f"batch   : ok -- {len(blob):,} bytes, entries={names}")

    # The check that matters for A4: a wide table must keep every column.
    # A print engine CUTS what does not fit, so a missing last column is the
    # symptom, and it is silent.
    columns = 16
    head = "".join(f"<th>Column{i}</th>" for i in range(columns))
    body = "".join(f"<td>VALUE{i}0000</td>" for i in range(columns))
    wide = render_pdf(
        f"<table><thead><tr>{head}</tr></thead><tbody><tr>{body}</tr></tbody></table>",
        density="print-fit-xdense",
    )
    try:
        import pypdf

        reader = pypdf.PdfReader(io.BytesIO(wide))
        page = reader.pages[0]
        text = "".join(p.extract_text() or "" for p in reader.pages)
        lost = [i for i in range(columns) if f"Column{i}" not in text]
        mm = 25.4 / 72
        print(
            f"page    : {float(page.mediabox.width) * mm:.0f}"
            f" x {float(page.mediabox.height) * mm:.0f} mm"
        )
        if lost:
            print(
                f"columns : FAILED -- {len(lost)} of {columns} cut from the page: {lost}"
            )
            raise SystemExit(1)
        print(f"columns : ok -- all {columns} survived on A4")
        print(f"text    : ok -- {len(text)} extractable characters")
    except ImportError:
        print("columns : SKIPPED -- pip install pypdf to verify column survival")

    print("output  : ok -- server-side rendering is working")
