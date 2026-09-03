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
    def test_anonymous_is_redirected_or_refused(self, erp_app, url):
        client = erp_app.test_client()  # no session -- not logged in
        res = client.post(url, json={"html": "<p>x</p>"})
        # Flask-Login either redirects to the login view or aborts 401,
        # depending on the request's Accept header.
        assert res.status_code in (302, 401)


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
