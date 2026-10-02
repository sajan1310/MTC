"""Server-side PDF rendering: validation, naming, batching, and the endpoints.

Split deliberately into two halves:

  * Everything that does NOT need a renderer -- validation, filename safety,
    de-duplication, auth, the error mapping -- runs everywhere, including a
    Windows dev box with no GTK libraries.
  * Everything that renders is skipped when `probe()` says this machine
    cannot, and activates the moment the libraries are installed.

The alternative -- one suite that fails wholesale without system libraries --
trains people to ignore it.
"""

import io
import logging
import zipfile

import pytest

from app.erp.services import pdf_render_service as svc

RENDERS, RENDER_DETAIL = svc.probe()
needs_renderer = pytest.mark.skipif(
    not RENDERS, reason=f"no PDF renderer on this machine: {RENDER_DETAIL}"
)


# ── Filenames ────────────────────────────────────────────────────────


class TestSafeFilename:
    def test_appends_pdf_extension(self):
        assert svc.safe_filename("PO_1204_Mahadev") == "PO_1204_Mahadev.pdf"
        assert svc.safe_filename("PO_1204.pdf") == "PO_1204.pdf"

    def test_strips_path_components(self):
        """A name is one archive entry, never a path."""
        assert svc.safe_filename("../../etc/passwd") == "passwd.pdf"
        assert svc.safe_filename("dir/sub/PO_1.pdf") == "PO_1.pdf"
        assert svc.safe_filename(r"C:\Windows\System32\evil.pdf") == "evil.pdf"

    def test_absolute_paths_cannot_escape(self):
        for name in ("/etc/passwd", "//server/share/x.pdf", "....//x.pdf"):
            out = svc.safe_filename(name)
            assert "/" not in out and "\\" not in out
            assert not out.startswith(".")

    def test_replaces_characters_windows_refuses(self):
        assert svc.safe_filename('PO<1>:"x"|?*.pdf') == "PO-1---x----.pdf"

    def test_falls_back_when_nothing_survives(self):
        for value in ("", "   ", None, "...", "/"):
            assert svc.safe_filename(value, "Fallback") == "Fallback.pdf"

    def test_a_long_name_keeps_its_extension(self):
        """Cut at the end, a long name lost ".pdf" and arrived as a file
        nothing would open."""
        out = svc.safe_filename("x" * 130 + ".pdf")
        assert out.endswith(".pdf")
        assert len(out) == svc.MAX_FILENAME_CHARS
        out = svc.safe_filename("y" * 200)
        assert out.endswith(".pdf") and len(out) == svc.MAX_FILENAME_CHARS

    def test_keeps_a_name_in_any_script(self):
        """Production Sheets are named in the operator's own words."""
        assert svc.safe_filename("ਪੰਜਾਬੀ – Rim_021026") == "ਪੰਜਾਬੀ – Rim_021026.pdf"


class TestDedupeFilenames:
    def test_leaves_distinct_names_alone(self):
        names = ["a.pdf", "b.pdf", "c.pdf"]
        assert svc.dedupe_filenames(names) == names

    def test_numbers_repeats(self):
        out = svc.dedupe_filenames(["PO.pdf", "PO.pdf", "PO.pdf"])
        assert out == ["PO.pdf", "PO_2.pdf", "PO_3.pdf"]

    def test_is_case_insensitive(self):
        """Windows and macOS treat these as one file; so must the archive."""
        out = svc.dedupe_filenames(["PO.pdf", "po.pdf"])
        assert out[0] != out[1]

    def test_every_name_is_unique(self):
        """The regression this exists for: a repeat inside a ZIP can be
        silently dropped by the extractor, so N records yield fewer files."""
        out = svc.dedupe_filenames(["Document.pdf"] * 40)
        assert len(set(n.lower() for n in out)) == 40

    def test_a_numbered_name_never_lands_on_a_name_already_in_the_batch(self):
        """The batch "A", "A", "A_2" used to come out as "A", "A_2", "A_2"."""
        out = svc.dedupe_filenames(["A.pdf", "A.pdf", "A_2.pdf"])
        assert len({n.lower() for n in out}) == 3
        assert out[0] == "A.pdf" and out[2] == "A_2.pdf"


# ── Input validation (no renderer needed) ────────────────────────────


class TestValidation:
    @pytest.mark.parametrize("bad", ["", "   ", None, 123, []])
    def test_render_pdf_rejects_empty_html(self, bad):
        with pytest.raises(ValueError):
            svc.render_pdf(bad)

    def test_render_pdf_rejects_oversized_html(self):
        with pytest.raises(ValueError, match="too large"):
            svc.render_pdf("x" * (svc.MAX_HTML_BYTES + 1))

    @pytest.mark.parametrize("bad", [None, [], "nope", {}])
    def test_render_batch_rejects_empty(self, bad):
        with pytest.raises(ValueError):
            svc.render_batch(bad)

    def test_render_batch_rejects_too_many_documents(self):
        docs = [
            {"filename": f"{i}.pdf", "html": "<p>x</p>"}
            for i in range(svc.MAX_BATCH_DOCUMENTS + 1)
        ]
        with pytest.raises(ValueError, match="Too many"):
            svc.render_batch(docs)

    def test_render_batch_rejects_oversized_payload(self):
        big = "x" * (svc.MAX_HTML_BYTES - 1)
        docs = [{"filename": f"{i}.pdf", "html": big} for i in range(20)]
        with pytest.raises(ValueError, match="too large"):
            svc.render_batch(docs)

    def test_the_batch_limit_is_reachable_behind_the_body_cap(self):
        """At 20 MB it sat above MAX_CONTENT_LENGTH (16 MiB) and nginx's 16m,
        so a batch that size died at the proxy with a bare 413 and never got
        this check's explanation."""
        from config import Config

        assert svc.MAX_BATCH_BYTES < Config.MAX_CONTENT_LENGTH * 0.9


# ── The URL fetcher is the whole security story ──────────────────────


class TestUrlFetcherBlocksEverything:
    """The renderer is handed HTML by an authenticated browser, and
    'authenticated' is not 'trusted'. A renderer that resolves arbitrary URLs
    is an SSRF primitive and a local file reader.
    """

    @pytest.mark.parametrize(
        "url",
        [
            "http://169.254.169.254/latest/meta-data/",  # cloud metadata
            "https://example.com/x.png",
            "file:///etc/passwd",
            "file://C:/Windows/win.ini",
            "ftp://example.com/x",
            "//example.com/protocol-relative.png",
            "x.png",  # relative
        ],
    )
    def test_refuses_every_scheme(self, url):
        with pytest.raises(ValueError, match="not fetched"):
            svc._blocked_url_fetcher(url)

    @needs_renderer
    def test_allows_data_uris(self):
        """The company logo is a canvas toDataURL, so data: must still work."""
        png = (
            "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        result = svc._blocked_url_fetcher(png)
        assert result  # default fetcher returned something


# ── Rendering (needs the system libraries) ───────────────────────────


@needs_renderer
class TestRendering:
    def test_produces_a_pdf(self):
        pdf = svc.render_pdf("<h1>PO-2026-0417</h1>")
        assert pdf.startswith(b"%PDF-")

    def test_output_contains_extractable_text(self):
        """The point of the whole exercise: a document, not a picture of one."""
        pypdf = pytest.importorskip("pypdf")
        pdf = svc.render_pdf("<h1>PO-2026-0417</h1><p>Freewheel 16 inch</p>")
        reader = pypdf.PdfReader(io.BytesIO(pdf))
        text = "".join(page.extract_text() or "" for page in reader.pages)
        assert "PO-2026-0417" in text
        assert "Freewheel" in text

    def test_embeds_a_data_uri_image(self, caplog):
        """The company logo reaches the renderer as a data: URI, so it has to
        survive the whole render, not just the fetcher. WeasyPrint 70.0 took
        fetchers as URLFetcher subclasses; the old plain function still passed
        test_allows_data_uris above while every render with a logo crashed."""
        pypdf = pytest.importorskip("pypdf")
        png = (
            "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )
        with caplog.at_level("ERROR"):
            pdf = svc.render_pdf(f'<p>document</p><img src="{png}" width="40">')

        assert "Failed to load image" not in caplog.text
        images = pypdf.PdfReader(io.BytesIO(pdf)).pages[0].images
        assert len(images) == 1

    def test_does_not_execute_script(self):
        pdf = svc.render_pdf("<p>safe</p><script>document.title='pwned'</script>")
        assert pdf.startswith(b"%PDF-")

    def test_does_not_read_local_files(self, tmp_path, caplog):
        """A document referencing file:// must not embed what it points at.

        WeasyPrint catches the fetcher's refusal, logs it, and renders the
        document without the image rather than aborting -- which is the
        behaviour we want, so this asserts on the OUTPUT rather than on an
        exception. A real file with a marker in it makes the check meaningful:
        if the contents ever did reach the renderer, the marker would be in
        the PDF.
        """
        secret = tmp_path / "secret.txt"
        secret.write_text("TOPSECRETCREDENTIAL", encoding="utf-8")
        url = secret.as_uri()

        with caplog.at_level("ERROR"):
            pdf = svc.render_pdf(f'<p>document</p><img src="{url}">')

        assert pdf.startswith(b"%PDF-")
        assert b"TOPSECRETCREDENTIAL" not in pdf
        assert "not fetched" in caplog.text

    def test_does_not_reach_cloud_metadata(self, caplog):
        """The SSRF case. Nothing is fetched, so nothing can be exfiltrated,
        and the render still completes."""
        with caplog.at_level("ERROR"):
            pdf = svc.render_pdf(
                '<p>document</p><img src="http://169.254.169.254/latest/meta-data/">'
            )

        assert pdf.startswith(b"%PDF-")
        assert "169.254.169.254" in caplog.text
        assert "not fetched" in caplog.text

    def test_landscape_is_wider_than_portrait(self):
        pypdf = pytest.importorskip("pypdf")
        html = "<p>x</p>"
        portrait = pypdf.PdfReader(io.BytesIO(svc.render_pdf(html))).pages[0]
        landscape = pypdf.PdfReader(
            io.BytesIO(svc.render_pdf(html, landscape=True))
        ).pages[0]
        assert landscape.mediabox.width > portrait.mediabox.width
        assert landscape.mediabox.width > landscape.mediabox.height

    def test_a_density_tier_beats_the_templates_inline_cell_styles(self):
        """Every print template styles its cells inline, and an inline style
        beats a selector -- so without !important a tier did nothing here
        while Print shrank the same table."""
        pypdf = pytest.importorskip("pypdf")
        cell = '<td style="font-size:12px;padding:7px 6px">C{}</td>'
        html = (
            "<table><tr>" + "".join(cell.format(i) for i in range(13)) + "</tr></table>"
        )

        def sizes(density):
            found = set()

            def visit(text, cm, tm, font_dict, font_size):
                if text.strip().startswith("C"):
                    found.add(round(font_size * tm[0], 1))

            pdf = svc.render_pdf(html, density=density)
            pypdf.PdfReader(io.BytesIO(pdf)).pages[0].extract_text(visitor_text=visit)
            return found

        assert sizes("") == {12.0}
        assert sizes("print-fit-compact") == {10.0}
        assert sizes("print-fit-xdense") == {8.0}

    def test_says_nothing_about_css_only_a_browser_uses(self, caplog):
        """print-color-adjust and friends are there for Chrome's print engine.
        WeasyPrint said so ~47 times a document -- 13,645 journal lines in four
        weeks -- and buried the errors worth reading."""
        with caplog.at_level("DEBUG", logger="weasyprint"):
            svc.render_pdf(
                '<p style="print-color-adjust:exact;-webkit-print-color-adjust:exact;'
                'word-break:break-word;overflow-x:auto">x</p>'
                "<style>::-webkit-scrollbar { display: none; }</style>"
            )
        assert "Ignored" not in caplog.text
        assert "unsupported selector" not in caplog.text


class TestScriptFonts:
    """A stock Ubuntu server has only DejaVu, which covers neither Gurmukhi
    nor Devanagari, so text in either rendered as empty boxes in every
    downloaded PDF while Print looked fine. Nothing said so."""

    def _fc_list(self, monkeypatch, answers):
        import subprocess

        monkeypatch.setattr(svc.shutil, "which", lambda name: "/usr/bin/fc-list")

        def run(args, **_kw):
            lang = args[1].split("=", 1)[1]
            return subprocess.CompletedProcess(args, 0, stdout=answers[lang], stderr="")

        monkeypatch.setattr(svc.subprocess, "run", run)

    def test_names_the_scripts_with_no_font(self, monkeypatch):
        self._fc_list(monkeypatch, {"pa": "", "hi": "Noto Sans Devanagari\n"})
        assert svc.missing_scripts() == ["Gurmukhi"]

    def test_nothing_missing_once_noto_is_installed(self, monkeypatch):
        self._fc_list(
            monkeypatch, {"pa": "Noto Sans Gurmukhi\n", "hi": "Noto Sans Devanagari\n"}
        )
        assert svc.missing_scripts() == []

    def test_does_not_guess_without_fontconfig(self, monkeypatch):
        monkeypatch.setattr(svc.shutil, "which", lambda name: None)
        assert svc.missing_scripts() == []

    def test_does_not_raise_when_fc_list_fails(self, monkeypatch):
        monkeypatch.setattr(svc.shutil, "which", lambda name: "/usr/bin/fc-list")

        def boom(*_a, **_kw):
            raise OSError("no such file")

        monkeypatch.setattr(svc.subprocess, "run", boom)
        assert svc.missing_scripts() == []

    def test_boot_says_what_to_install(self, monkeypatch, caplog):
        monkeypatch.setattr(svc, "probe", lambda: (True, "weasyprint 70.0 available"))
        monkeypatch.setattr(svc, "missing_scripts", lambda: ["Gurmukhi", "Devanagari"])
        logger = logging.getLogger("test.pdf.boot")
        with caplog.at_level("INFO", logger="test.pdf.boot"):
            assert svc.log_availability(logger) is True
        assert "Gurmukhi or Devanagari" in caplog.text
        assert "fonts-noto-core" in caplog.text


class TestLogNoise:
    """The filter drops CSS notices only; failures stay audible."""

    def test_notices_are_dropped(self, caplog):
        log = logging.getLogger("weasyprint")
        with caplog.at_level("DEBUG", logger="weasyprint"):
            log.warning(
                "Ignored `%s:%s` at %d:%d, %s.",
                "print-color-adjust",
                "exact",
                1,
                2,
                "unknown property",
            )
            log.warning("Invalid or unsupported selector, %s", "'::-webkit-scrollbar'")
        assert caplog.text == ""

    def test_errors_and_other_warnings_are_kept(self, caplog):
        log = logging.getLogger("weasyprint")
        with caplog.at_level("DEBUG", logger="weasyprint"):
            log.error("Failed to load image at %r", "file:///etc/passwd")
            log.warning("Anchor defined twice: %r", "x")
        assert "Failed to load image" in caplog.text
        assert "Anchor defined twice" in caplog.text


class TestOnePageShell:
    def test_full_size_is_plain_a4(self):
        html = svc._document("<p>x</p>", landscape=False)
        assert "size: A4 portrait; margin: 6mm;" in html

    def test_a_smaller_step_lays_out_on_a_proportionally_larger_page(self):
        """write_pdf(zoom=0.96) then shrinks it back to exactly A4."""
        html = svc._document("<p>x</p>", landscape=False, scale=0.96)
        assert "size: 218.750mm 309.375mm; margin: 6.250mm;" in html

    def test_landscape_swaps_the_larger_page_too(self):
        html = svc._document("<p>x</p>", landscape=True, scale=0.96)
        assert "size: 309.375mm 218.750mm;" in html


@needs_renderer
class TestOnePage:
    """The Production Sheet is fitted to one page in the browser, in the fonts
    that machine has. This server falls back to DejaVu Sans, which is wider,
    so a sheet the browser fitted could push its closing rule onto a second,
    otherwise empty page -- 34 desktop and 146 phone sheets of 908 did."""

    # The printable box is 285 mm = 1077 CSS px tall; this overflows it by a
    # line, the way a wider font overflowed a fitted sheet.
    JUST_OVER = '<div style="height:1070px">sheet</div><p>closing rule</p>'
    pypdf = pytest.importorskip("pypdf")

    def _pages(self, pdf):
        return self.pypdf.PdfReader(io.BytesIO(pdf)).pages

    def test_a_sheet_that_spills_by_a_little_comes_back_on_one_page(self):
        assert len(self._pages(svc.render_pdf(self.JUST_OVER))) == 2
        assert len(self._pages(svc.render_pdf(self.JUST_OVER, one_page=True))) == 1

    def test_the_paper_is_still_a4(self):
        page = self._pages(svc.render_pdf(self.JUST_OVER, one_page=True))[0]
        assert float(page.mediabox.width) == pytest.approx(595.28, abs=1)
        assert float(page.mediabox.height) == pytest.approx(841.89, abs=1)

    def test_nothing_is_lost_in_the_shrinking(self):
        page = self._pages(svc.render_pdf(self.JUST_OVER, one_page=True))[0]
        text = page.extract_text()
        assert "sheet" in text and "closing rule" in text

    def test_a_genuinely_long_document_is_left_at_full_size(self):
        """Shrinking three pages onto one would be unreadable; it paginates."""
        long_doc = "".join(f"<p>line {i}</p>" for i in range(150))
        full = len(self._pages(svc.render_pdf(long_doc)))
        assert full >= 3
        assert len(self._pages(svc.render_pdf(long_doc, one_page=True))) == full

    def test_a_document_that_fits_is_not_touched(self):
        short = "<p>PO-1</p>"
        assert svc.render_pdf(short, one_page=True)[:200] == svc.render_pdf(short)[:200]

    def test_the_batch_honours_it_per_document(self):
        blob, _ = svc.render_batch(
            [
                {"filename": "a.pdf", "html": self.JUST_OVER, "onePage": True},
                {"filename": "b.pdf", "html": self.JUST_OVER},
            ]
        )
        archive = zipfile.ZipFile(io.BytesIO(blob))
        assert len(self._pages(archive.read("a.pdf"))) == 1
        assert len(self._pages(archive.read("b.pdf"))) == 2


@needs_renderer
class TestBatch:
    def test_returns_a_zip_of_one_pdf_per_document(self):
        blob, names = svc.render_batch(
            [
                {"filename": "PO_1.pdf", "html": "<p>One</p>"},
                {"filename": "PO_2.pdf", "html": "<p>Two</p>"},
                {"filename": "PO_3.pdf", "html": "<p>Three</p>"},
            ]
        )
        archive = zipfile.ZipFile(io.BytesIO(blob))
        assert archive.namelist() == names == ["PO_1.pdf", "PO_2.pdf", "PO_3.pdf"]
        for name in names:
            assert archive.read(name).startswith(b"%PDF-")

    def test_every_record_yields_a_file_even_when_names_collide(self):
        """40 records must produce 40 files, not 1."""
        blob, names = svc.render_batch(
            [{"filename": "Document.pdf", "html": f"<p>{i}</p>"} for i in range(40)]
        )
        archive = zipfile.ZipFile(io.BytesIO(blob))
        assert len(archive.namelist()) == 40
        assert len(set(archive.namelist())) == 40

    def test_archive_is_well_formed(self):
        blob, _ = svc.render_batch([{"filename": "a.pdf", "html": "<p>a</p>"}])
        assert zipfile.ZipFile(io.BytesIO(blob)).testzip() is None


# ── Endpoints ────────────────────────────────────────────────────────


class TestEndpointsRequireAuth:
    """Uses erp_app rather than the base `client` fixture: that one sets
    LOGIN_DISABLED=True, so @login_required is a no-op there and this
    assertion would pass without proving anything.
    """

    @pytest.mark.parametrize("url", ["/erp/render-pdf", "/erp/render-pdf-batch"])
    def test_anonymous_is_refused_with_401_not_redirected(self, erp_app, url):
        """A redirect is the bug, not an acceptable answer. fetch() follows
        it, and the login page then arrives as a 200 that Download saved as
        a .pdf and Share sent on. Sent the way the client sends it -- a JSON
        body and fetch's default Accept of */* -- the answer must be the
        401 envelope the RPC layer uses."""
        client = erp_app.test_client()  # no session -- not logged in
        res = client.post(url, json={"html": "<p>x</p>"}, headers={"Accept": "*/*"})

        assert res.status_code == 401
        assert res.mimetype == "application/json"
        body = res.get_json()
        assert body["success"] is False
        assert "session" in body["message"].lower()


class TestAwaitingApproval:
    """A signup nobody has approved yet is refused, as the RPC layer refuses
    them, instead of being able to keep a worker busy rendering."""

    @pytest.fixture
    def pending_client(self, erp_app):
        import database

        with erp_app.app_context():
            with database.get_conn() as (_conn, cur):
                cur.execute(
                    """
                    INSERT INTO users (name, email, password_hash, role)
                    VALUES (%s, %s, %s, 'pending_approval')
                    ON CONFLICT (email) DO UPDATE SET role = 'pending_approval'
                    RETURNING user_id
                    """,
                    ("Pending User", "pending-pdf@example.invalid", "not-a-real-hash"),
                )
                user_id = cur.fetchone()[0]
        client = erp_app.test_client()
        with client.session_transaction() as sess:
            sess["_user_id"] = str(user_id)
            sess["_fresh"] = True
        return client

    @pytest.mark.parametrize("url", ["/erp/render-pdf", "/erp/render-pdf-batch"])
    def test_is_refused_with_a_reason(self, pending_client, url):
        res = pending_client.post(
            url,
            json={"html": "<p>x</p>", "documents": [{"html": "<p>x</p>"}]},
        )
        assert res.status_code == 403
        assert "approval" in res.get_json()["message"]


class TestEndpointErrors:
    def test_bad_input_is_400(self, erp_client):
        res = erp_client.post("/erp/render-pdf", json={"html": ""})
        assert res.status_code in (400, 503)

    def test_batch_bad_input_is_400(self, erp_client):
        res = erp_client.post("/erp/render-pdf-batch", json={"documents": []})
        assert res.status_code in (400, 503)

    def test_unavailable_renderer_is_503(self, erp_client, monkeypatch):
        """A 503 is the contract the client keys on to stop asking and fall
        back to the print dialog for the rest of the session."""

        def unavailable(*a, **k):
            raise svc.PdfRenderUnavailable("no libraries here")

        monkeypatch.setattr(svc, "render_pdf", unavailable)
        res = erp_client.post("/erp/render-pdf", json={"html": "<p>x</p>"})
        assert res.status_code == 503


@needs_renderer
class TestEndpointSuccess:
    def test_single_returns_a_named_pdf(self, erp_client):
        res = erp_client.post(
            "/erp/render-pdf", json={"html": "<p>PO-1</p>", "filename": "PO_1.pdf"}
        )
        assert res.status_code == 200
        assert res.mimetype == "application/pdf"
        assert "PO_1.pdf" in res.headers["Content-Disposition"]
        assert res.data.startswith(b"%PDF-")

    def test_batch_returns_a_named_zip(self, erp_client):
        res = erp_client.post(
            "/erp/render-pdf-batch",
            json={
                "documents": [
                    {"filename": "A.pdf", "html": "<p>A</p>"},
                    {"filename": "B.pdf", "html": "<p>B</p>"},
                ],
                "zipName": "Purchase_Orders_190826.zip",
            },
        )
        assert res.status_code == 200
        assert res.mimetype == "application/zip"
        assert "Purchase_Orders_190826.zip" in res.headers["Content-Disposition"]
        assert zipfile.ZipFile(io.BytesIO(res.data)).namelist() == ["A.pdf", "B.pdf"]

    def test_response_is_not_cached(self, erp_client):
        res = erp_client.post("/erp/render-pdf", json={"html": "<p>x</p>"})
        assert res.headers["Cache-Control"] == "no-store"

    # Production Sheets are named in the operator's own words. One Gurmukhi,
    # Devanagari or curly-quote character in the Output Item name put a header
    # gunicorn refuses on the wire -- a 400 in place of the file, reported to
    # the user as "session expired".
    NAME = "ਪੰਜਾਬੀ “Rim” – 20 inch_021026.pdf"

    def test_a_name_wholly_in_another_script_still_has_a_plain_fallback(
        self, erp_client
    ):
        res = erp_client.post(
            "/erp/render-pdf", json={"html": "<p>x</p>", "filename": "ਪੰਜਾਬੀ.pdf"}
        )
        header = res.headers["Content-Disposition"]
        assert header.startswith("attachment; filename=Document.pdf; filename*=")
        assert "%E0%A8%AA" in header  # the real name rides in filename*

    def test_a_name_in_any_script_comes_back_in_a_header_the_wire_accepts(
        self, erp_client
    ):
        res = erp_client.post(
            "/erp/render-pdf", json={"html": "<p>x</p>", "filename": self.NAME}
        )
        assert res.status_code == 200
        header = res.headers["Content-Disposition"]
        header.encode("ascii")  # nothing past U+007F, so nothing past U+00FF
        assert header.startswith("attachment; ")
        assert "filename*=UTF-8''" in header
        from urllib.parse import unquote

        assert unquote(header.split("filename*=UTF-8''", 1)[1]) == self.NAME

    def test_and_gunicorn_lets_it_through(self, erp_client):
        """The check that actually failed: gunicorn's own header validation.
        gunicorn imports fcntl, so this runs on Linux (CI and the server)."""
        wsgi = pytest.importorskip("gunicorn.http.wsgi")
        res = erp_client.post(
            "/erp/render-pdf", json={"html": "<p>x</p>", "filename": self.NAME}
        )
        assert wsgi.HEADER_VALUE_RE.fullmatch(res.headers["Content-Disposition"])

    def test_an_ascii_name_is_sent_plainly(self, erp_client):
        """Quoted only where it has to be (RFC 6266 accepts a bare token)."""
        res = erp_client.post(
            "/erp/render-pdf", json={"html": "<p>x</p>", "filename": "PO_1204.pdf"}
        )
        assert res.headers["Content-Disposition"] == "attachment; filename=PO_1204.pdf"
        res = erp_client.post(
            "/erp/render-pdf",
            json={"html": "<p>x</p>", "filename": "Fitted Rim 20 inch_140926.pdf"},
        )
        assert res.headers["Content-Disposition"] == (
            'attachment; filename="Fitted Rim 20 inch_140926.pdf"'
        )

    def test_one_page_is_passed_through(self, erp_client):
        pypdf = pytest.importorskip("pypdf")
        res = erp_client.post(
            "/erp/render-pdf",
            json={
                "html": TestOnePage.JUST_OVER,
                "onePage": True,
                "filename": "PRD.pdf",
            },
        )
        assert res.status_code == 200
        assert len(pypdf.PdfReader(io.BytesIO(res.data)).pages) == 1


# ── The page shell mirrors the print stylesheet ──────────────────────


class TestPageFitting:
    """A table wider than the printable box is CUT by a print engine, not
    scaled, so the right-hand columns vanish. The shell has to carry the same
    fitting rules the browser applies, or the same document comes out
    differently depending on which button produced it.
    """

    def test_shell_lets_cells_wrap_anywhere(self):
        """`break-word` would not do: its break opportunities are not counted
        toward min-content, so the column keeps its floor and still overflows.
        """
        html = svc._document("<p>x</p>", landscape=False)
        assert "overflow-wrap: anywhere" in html
        assert "max-width: 100%" in html

    def test_shell_repeats_headers_and_keeps_rows_whole(self):
        html = svc._document("<p>x</p>", landscape=False)
        assert "display: table-header-group" in html
        assert "break-inside: avoid" in html

    @pytest.mark.parametrize(
        "density,marker",
        [
            ("print-fit-compact", "font-size: 10px"),
            ("print-fit-dense", "font-size: 9px"),
            ("print-fit-xdense", "font-size: 8px"),
        ],
    )
    def test_applies_the_density_tier_the_client_picked(self, density, marker):
        html = svc._document("<p>x</p>", landscape=False, density=density)
        assert marker in html
        assert f"body class='{density}'" in html

    def test_no_tier_css_when_the_document_fits(self):
        html = svc._document("<p>x</p>", landscape=False)
        assert "font-size: 10px" not in html
        assert "body class=''" in html

    # density arrives in the request body, so it is a value from outside.
    @pytest.mark.parametrize(
        "bad",
        [
            "print-fit-nope",
            "",
            None,
            "a{}b",
            "</style><script>alert(1)</script>",
        ],
    )
    def test_an_unknown_density_is_ignored_not_interpolated(self, bad):
        html = svc._document("<p>x</p>", landscape=False, density=bad)
        assert "<script>" not in html
        assert "</style><" not in html.replace("</style></head>", "")

    def test_landscape_switches_the_page_box(self):
        assert "A4 landscape" in svc._document("<p>x</p>", landscape=True)
        assert "A4 portrait" in svc._document("<p>x</p>", landscape=False)


@needs_renderer
class TestWideTablesStayOnThePage:
    def test_a_sixteen_column_table_does_not_overflow_the_sheet(self):
        """The regression: columns past the right edge were silently dropped."""
        pypdf = pytest.importorskip("pypdf")
        headers = "".join(f"<th>Column{i}</th>" for i in range(16))
        cells = "".join(f"<td>VALUE{i}0000</td>" for i in range(16))
        pdf = svc.render_pdf(
            f"<table><thead><tr>{headers}</tr></thead>"
            f"<tbody><tr>{cells}</tr></tbody></table>",
            density="print-fit-xdense",
        )
        text = "".join(
            page.extract_text() or "" for page in pypdf.PdfReader(io.BytesIO(pdf)).pages
        )
        # Whitespace is stripped before matching: fitting the table to the page
        # is precisely what breaks a long cell value across lines, so
        # "VALUE150000" legitimately comes back as "VALUE1500\n00". Wrapping
        # is the fix working, not a defect -- what would be a defect is the
        # text being absent entirely, which is what a cut column looks like.
        flat = "".join(text.split())

        # Every column has to survive -- especially the last one.
        for i in range(16):
            assert f"Column{i}" in flat, f"column {i} was cut from the page"
        assert "VALUE150000" in flat

    def test_an_unbreakable_token_does_not_widen_the_table(self):
        """A 40-character item code used to set a column's min-content floor
        and push the whole table past the page."""
        pypdf = pytest.importorskip("pypdf")
        long_token = "RIM" + "X" * 40 + "BLACK"
        pdf = svc.render_pdf(
            f"<table><tr><td>{long_token}</td><td>LASTCOLUMN</td></tr></table>"
        )
        text = "".join(
            page.extract_text() or "" for page in pypdf.PdfReader(io.BytesIO(pdf)).pages
        )
        assert "LASTCOLUMN" in "".join(text.split())
