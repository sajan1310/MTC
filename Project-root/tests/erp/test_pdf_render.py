"""Tests for POST /erp/render-pdf -- server-side vector PDF rendering.

Split in two. The endpoint contract (auth, validation, error mapping) runs
everywhere with the renderer stubbed. The rendering tests actually launch
Chromium and are skipped where Playwright or its browser build is absent, so
the suite stays runnable on a machine that has not run `playwright install`.

The point of the whole feature is that the output is a *document*, not a
picture of one -- so the tests that matter assert extractable text, which is
exactly what the client-side raster path cannot produce (PDF-002).
"""

from __future__ import annotations

import io
import os

import pytest

from app.erp.services import pdf_render_service

PO_HTML = """
<div style="font-family:Arial;padding:20px">
  <h2 style="color:#C0392B">PURCHASE ORDER</h2>
  <p>No: PO-2026-0417</p>
  <p>Vendor: Gupta Cycle Industries</p>
  <table border="1" style="border-collapse:collapse">
    <tr><td>Freewheel 18T</td><td>75</td><td>142.00</td></tr>
    <tr><td>Frame Set 26"</td><td>50</td><td>1250.00</td></tr>
  </table>
</div>
"""


def _renderable() -> bool:
    try:
        pdf_render_service.render_pdf("<p>probe</p>")
        return True
    except pdf_render_service.PdfRenderUnavailable:
        return False


needs_chromium = pytest.mark.skipif(
    not _renderable(), reason="Playwright/Chromium not available in this environment"
)


def _pdf_text(data: bytes) -> str:
    pypdf = pytest.importorskip("pypdf")
    reader = pypdf.PdfReader(io.BytesIO(data))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


# ── endpoint contract ────────────────────────────────────────────────


def test_requires_authentication(erp_app):
    """An unauthenticated caller must not be able to drive a headless browser."""
    with erp_app.test_client() as anon:
        res = anon.post("/erp/render-pdf", json={"html": PO_HTML})
    assert res.status_code in (302, 401)


def test_rejects_empty_html(erp_client):
    res = erp_client.post("/erp/render-pdf", json={"html": "   "})
    assert res.status_code == 400
    assert res.get_json()["success"] is False


def test_rejects_missing_html(erp_client):
    res = erp_client.post("/erp/render-pdf", json={})
    assert res.status_code == 400


def test_rejects_oversized_html(erp_client):
    huge = "<p>" + ("x" * (pdf_render_service.MAX_HTML_BYTES + 1)) + "</p>"
    res = erp_client.post("/erp/render-pdf", json={"html": huge})
    assert res.status_code == 400
    assert "too large" in res.get_json()["message"].lower()


def test_reports_503_when_rendering_unavailable(erp_client, monkeypatch):
    """503 is the signal the client uses to stop asking for the session,
    rather than retrying once per document."""
    def boom(*a, **k):
        raise pdf_render_service.PdfRenderUnavailable("no chromium here")

    monkeypatch.setattr(pdf_render_service, "render_pdf", boom)
    res = erp_client.post("/erp/render-pdf", json={"html": PO_HTML})
    assert res.status_code == 503
    assert res.get_json()["success"] is False


def test_unexpected_failure_is_500_and_not_leaked(erp_client, monkeypatch):
    def boom(*a, **k):
        raise KeyError("internal detail nobody should see")

    monkeypatch.setattr(pdf_render_service, "render_pdf", boom)
    res = erp_client.post("/erp/render-pdf", json={"html": PO_HTML})
    assert res.status_code == 500
    assert "internal detail" not in res.get_json()["message"]


def test_returns_pdf_content_type(erp_client, monkeypatch):
    monkeypatch.setattr(pdf_render_service, "render_pdf", lambda *a, **k: b"%PDF-1.4 stub")
    res = erp_client.post("/erp/render-pdf", json={"html": PO_HTML})
    assert res.status_code == 200
    assert res.mimetype == "application/pdf"
    assert res.data.startswith(b"%PDF-")
    assert res.headers["Cache-Control"] == "no-store"


def test_landscape_flag_is_forwarded(erp_client, monkeypatch):
    seen = {}

    def capture(html, *, landscape=False):
        seen["landscape"] = landscape
        return b"%PDF-1.4 stub"

    monkeypatch.setattr(pdf_render_service, "render_pdf", capture)
    erp_client.post("/erp/render-pdf", json={"html": PO_HTML, "landscape": True})
    assert seen["landscape"] is True


# ── the document shell ───────────────────────────────────────────────


def test_page_shell_is_built_server_side():
    """Page size and margins must not be drivable from the request body."""
    doc = pdf_render_service._document("<p>hi</p>", landscape=False)
    assert "@page" in doc and "A4 portrait" in doc
    assert f"margin: {pdf_render_service.PAGE_MARGIN_MM}mm" in doc
    assert "<p>hi</p>" in doc


def test_page_shell_honours_landscape():
    assert "A4 landscape" in pdf_render_service._document("<p>hi</p>", landscape=True)


def test_shell_keeps_rows_and_closing_blocks_whole():
    """The real CSS equivalent of html2pdf's pagebreak.avoid list."""
    doc = pdf_render_service._document("<p>hi</p>", landscape=False)
    assert "break-inside: avoid" in doc
    for sel in ("tr", "#print-grand-total-container", "#print-signature", "#print-footer-meta"):
        assert sel in doc


# ── actual rendering ─────────────────────────────────────────────────


@needs_chromium
def test_renders_a_real_pdf(erp_client):
    res = erp_client.post("/erp/render-pdf", json={"html": PO_HTML})
    assert res.status_code == 200
    assert res.data.startswith(b"%PDF-")


@needs_chromium
def test_output_is_searchable_text_not_a_picture(erp_client):
    """The entire point of PDF-002: the PO number must be findable."""
    res = erp_client.post("/erp/render-pdf", json={"html": PO_HTML})
    text = _pdf_text(res.data)
    assert "PO-2026-0417" in text
    assert "Freewheel" in text
    assert "PURCHASE ORDER" in text


@needs_chromium
def test_output_embeds_no_images(erp_client):
    """A raster export would be exactly one full-page image."""
    pypdf = pytest.importorskip("pypdf")
    res = erp_client.post("/erp/render-pdf", json={"html": PO_HTML})
    page = pypdf.PdfReader(io.BytesIO(res.data)).pages[0]
    assert len(page.images) == 0


@needs_chromium
def test_output_is_a4_at_the_shared_margin(erp_client):
    pypdf = pytest.importorskip("pypdf")
    res = erp_client.post("/erp/render-pdf", json={"html": PO_HTML})
    box = pypdf.PdfReader(io.BytesIO(res.data)).pages[0].mediabox
    def mm(pt):
        return round(float(pt) * 25.4 / 72)
    assert (mm(box.width), mm(box.height)) == (210, 297)


@needs_chromium
def test_landscape_swaps_the_page_dimensions(erp_client):
    pypdf = pytest.importorskip("pypdf")
    res = erp_client.post("/erp/render-pdf", json={"html": PO_HTML, "landscape": True})
    box = pypdf.PdfReader(io.BytesIO(res.data)).pages[0].mediabox
    def mm(pt):
        return round(float(pt) * 25.4 / 72)
    assert (mm(box.width), mm(box.height)) == (297, 210)


@needs_chromium
def test_multi_page_documents_paginate(erp_client):
    pypdf = pytest.importorskip("pypdf")
    rows = "".join(
        f"<tr><td>Component {i}</td><td>{i * 7}</td></tr>" for i in range(120)
    )
    html = f"<table border='1'>{rows}</table>"
    res = erp_client.post("/erp/render-pdf", json={"html": html})
    assert len(pypdf.PdfReader(io.BytesIO(res.data)).pages) > 1


# ── the security boundary ────────────────────────────────────────────


@needs_chromium
def test_does_not_fetch_remote_resources(erp_client):
    """SSRF guard: an authenticated user must not be able to make the server
    fetch a URL of their choosing. The render still succeeds -- the resource
    is simply never requested."""
    html = (
        "<p>ssrf probe</p>"
        "<img src='http://169.254.169.254/latest/meta-data/'>"
        "<img src='http://127.0.0.1:1/should-not-be-hit'>"
    )
    res = erp_client.post("/erp/render-pdf", json={"html": html})
    assert res.status_code == 200
    assert "ssrf probe" in _pdf_text(res.data)


@needs_chromium
def test_does_not_read_local_files(erp_client):
    html = "<p>file probe</p><iframe src='file:///etc/passwd'></iframe>"
    res = erp_client.post("/erp/render-pdf", json={"html": html})
    assert res.status_code == 200
    text = _pdf_text(res.data)
    assert "file probe" in text
    assert "root:" not in text


@needs_chromium
def test_does_not_execute_javascript(erp_client):
    """The print builders emit static markup; scripting stays off so a
    posted document cannot run code in the renderer."""
    html = (
        "<p id='t'>static</p>"
        "<script>document.getElementById('t').textContent = 'SCRIPTED';</script>"
    )
    res = erp_client.post("/erp/render-pdf", json={"html": html})
    text = _pdf_text(res.data)
    assert "static" in text
    assert "SCRIPTED" not in text


@needs_chromium
def test_inline_data_uri_images_still_render(erp_client):
    """data: URIs are not network requests, so blocking the network must not
    break the company logo (core.js stores it as a canvas toDataURL)."""
    # 1x1 red PNG
    png = (
        "data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    res = erp_client.post("/erp/render-pdf", json={"html": f"<p>logo</p><img src='{png}'>"})
    assert res.status_code == 200
    assert "logo" in _pdf_text(res.data)


# ── deployment diagnostics ───────────────────────────────────────────
#
# The failure this guards against is silent: without Chromium the endpoint
# 503s, the client falls back to rasterising without complaint, and the PDFs
# quietly go back to being unsearchable images. These make it loud at boot.


def test_probe_is_filesystem_only_and_fast():
    """It must not start Playwright -- doing that to read executable_path
    measured ~5s, which every gunicorn worker would pay at boot."""
    import time

    start = time.monotonic()
    ok, detail = pdf_render_service.probe()
    assert isinstance(ok, bool)
    assert isinstance(detail, str) and detail
    assert time.monotonic() - start < 1.0


def test_probe_reports_missing_browsers_with_the_fix(monkeypatch, tmp_path):
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "nope"))
    ok, detail = pdf_render_service.probe()
    assert ok is False
    assert "playwright install chromium" in detail


def test_probe_reports_an_empty_browsers_directory(monkeypatch, tmp_path):
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    ok, detail = pdf_render_service.probe()
    assert ok is False
    assert "playwright install chromium" in detail


def test_probe_accepts_an_installed_chromium(monkeypatch, tmp_path):
    (tmp_path / "chromium-1234").mkdir()
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    ok, detail = pdf_render_service.probe()
    assert ok is True
    assert "chromium-1234" in detail


def test_probe_never_raises(monkeypatch):
    def boom():
        raise OSError("boom")

    monkeypatch.setattr(pdf_render_service, "_candidate_roots", boom)
    ok, detail = pdf_render_service.probe()
    assert ok is False
    assert "could not check" in detail


class _Log:
    def __init__(self):
        self.info_msgs = []
        self.warn_msgs = []

    def info(self, msg, *a):
        self.info_msgs.append(msg % a if a else msg)

    def warning(self, msg, *a):
        self.warn_msgs.append(msg % a if a else msg)


def test_log_availability_warns_loudly_when_disabled(monkeypatch, tmp_path):
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "nope"))
    log = _Log()
    assert pdf_render_service.log_availability(log) is False
    assert log.info_msgs == []
    assert len(log.warn_msgs) == 1
    warning = log.warn_msgs[0]
    # Must name the consequence, not just the condition.
    assert "playwright install chromium" in warning
    assert "503" in warning
    assert "searchable" in warning


def test_log_availability_confirms_when_enabled(monkeypatch, tmp_path):
    (tmp_path / "chromium-1234").mkdir()
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    log = _Log()
    assert pdf_render_service.log_availability(log) is True
    assert log.warn_msgs == []
    assert len(log.info_msgs) == 1


# ── the two deployment traps ─────────────────────────────────────────


def test_explicit_browsers_path_is_never_second_guessed(monkeypatch, tmp_path):
    """If an operator configured a location, honour it rather than hunting."""
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    assert pdf_render_service._candidate_roots() == [tmp_path]


def test_candidates_cover_the_root_installs_service_runs_split(monkeypatch):
    """The VPS trap: installed by root, served by www-data."""
    import pathlib

    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
    monkeypatch.setattr(pdf_render_service.sys, "platform", "linux")
    roots = pdf_render_service._candidate_roots()
    # Compare Path objects, not strings: this suite also runs on Windows, where
    # Path("/ms-playwright") stringifies with a backslash.
    assert pathlib.Path(pdf_render_service.SHARED_BROWSERS_PATH) in roots
    assert pathlib.Path("/root/.cache/ms-playwright") in roots
    assert pathlib.Path("/opt/ms-playwright") in roots
    assert len(roots) == len(set(map(str, roots)))  # no duplicates


def test_resolve_adopts_a_browser_another_user_installed(monkeypatch, tmp_path):
    """The actual fix, not just the diagnosis: a browser outside this user's
    own cache is found AND pointed at, so rendering works instead of merely
    being explainable."""
    other_user_cache = tmp_path / "root-cache"
    (other_user_cache / "chromium-1234").mkdir(parents=True)
    mine = tmp_path / "my-empty-cache"
    mine.mkdir()

    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
    monkeypatch.setattr(pdf_render_service, "_candidate_roots", lambda: [mine, other_user_cache])

    found = pdf_render_service._resolve_browsers_path()
    assert found == other_user_cache
    # Playwright reads this env var, so setting it is what makes it usable.
    assert os.environ["PLAYWRIGHT_BROWSERS_PATH"] == str(other_user_cache)


def test_resolve_returns_none_when_nothing_is_installed(monkeypatch, tmp_path):
    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
    monkeypatch.setattr(pdf_render_service, "_candidate_roots", lambda: [tmp_path])
    assert pdf_render_service._resolve_browsers_path() is None


def test_probe_lists_where_it_looked(monkeypatch, tmp_path):
    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
    monkeypatch.setattr(pdf_render_service, "_candidate_roots", lambda: [tmp_path / "a", tmp_path / "b"])
    ok, detail = pdf_render_service.probe()
    assert ok is False
    assert "looked in" in detail
    assert "playwright install chromium" in detail


# The Render trap: the browser downloads, then cannot start because the host
# has no libnss3 etc. Raw, that error names a .so file and no remedy.

def test_missing_system_libraries_explains_the_fix():
    exc = Exception(
        "Host system is missing dependencies to run browsers."
        "\n    libnss3.so: cannot open shared object file"
    )
    msg = pdf_render_service._explain_launch_failure(exc)
    assert "missing its system libraries" in msg
    assert "playwright install-deps chromium" in msg
    assert "Docker" in msg


def test_shared_library_error_is_recognised_on_its_own():
    exc = Exception("error while loading shared libraries: libnss3.so: cannot open")
    msg = pdf_render_service._explain_launch_failure(exc)
    assert "playwright install-deps chromium" in msg


def test_missing_browser_explains_the_other_fix():
    exc = Exception("Executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome")
    msg = pdf_render_service._explain_launch_failure(exc)
    assert "playwright install chromium" in msg
    assert "PLAYWRIGHT_BROWSERS_PATH" in msg


def test_permission_error_explains_the_permission_fix():
    msg = pdf_render_service._explain_launch_failure(PermissionError("permission denied"))
    assert "not executable by this user" in msg


def test_unknown_launch_failure_still_reports_something_useful():
    msg = pdf_render_service._explain_launch_failure(Exception("kaboom"))
    assert "could not start Chromium" in msg
    assert "kaboom" in msg


def test_launch_failures_are_truncated_not_dumped():
    exc = Exception("x" * 5000)
    assert len(pdf_render_service._explain_launch_failure(exc)) < 400


# ── PDF_SERVER_RENDER=off: skipping Chromium as a stated choice ───────


def test_disabled_by_config_returns_503_without_rendering(erp_client, erp_app, monkeypatch):
    """The point of the switch: no browser is touched at all."""
    launched = {"n": 0}

    def spy():
        launched["n"] += 1
        raise AssertionError("must not launch a browser when disabled")

    monkeypatch.setattr(pdf_render_service, "_browser", spy)
    monkeypatch.setitem(erp_app.config, "PDF_SERVER_RENDER", "off")

    res = erp_client.post("/erp/render-pdf", json={"html": PO_HTML})
    assert res.status_code == 503
    assert res.get_json()["success"] is False
    assert "disabled" in res.get_json()["message"].lower()
    assert launched["n"] == 0


def test_auto_is_the_default(erp_app):
    assert erp_app.config.get("PDF_SERVER_RENDER", "auto") in ("auto", "off")


def test_is_enabled_reflects_the_setting(erp_app):
    with erp_app.app_context():
        erp_app.config["PDF_SERVER_RENDER"] = "off"
        assert pdf_render_service.is_enabled() is False
        erp_app.config["PDF_SERVER_RENDER"] = "auto"
        assert pdf_render_service.is_enabled() is True


def test_is_enabled_outside_an_app_context():
    """The smoke check runs with no Flask context and must still work."""
    assert pdf_render_service.is_enabled() is True


# A deliberate choice must not be logged as a broken deploy -- warning about
# configuration teaches people to ignore warnings.
def test_disabled_by_config_logs_info_not_warning():
    log = _Log()
    assert pdf_render_service.log_availability(log, enabled=False) is False
    assert log.warn_msgs == []
    assert len(log.info_msgs) == 1
    msg = log.info_msgs[0]
    assert "OFF by configuration" in msg
    assert "PDF_SERVER_RENDER=off" in msg
    # Must name the workaround that needs nothing installed.
    assert "Save as PDF" in msg


def test_wanted_but_missing_still_warns(monkeypatch, tmp_path):
    """Contrast: enabled but no browser is a real problem, so still WARNING."""
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path / "nope"))
    log = _Log()
    assert pdf_render_service.log_availability(log, enabled=True) is False
    assert log.info_msgs == []
    assert len(log.warn_msgs) == 1
    # And it should point at the switch as the way to silence it deliberately.
    assert "PDF_SERVER_RENDER=off" in log.warn_msgs[0]


def test_shell_passes_the_setting_to_the_client(erp_client, erp_app):
    """The client reads this to avoid one wasted request per session."""
    monkey = erp_app.config
    monkey["PDF_SERVER_RENDER"] = "off"
    res = erp_client.get("/erp")
    assert res.status_code == 200
    assert b'name="pdf-server-render" content="off"' in res.data
    monkey["PDF_SERVER_RENDER"] = "auto"
    res = erp_client.get("/erp")
    assert b'name="pdf-server-render" content="auto"' in res.data
