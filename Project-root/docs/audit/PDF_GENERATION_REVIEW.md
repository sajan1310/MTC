# PDF Generation Review — Print/Export Pipeline

Covers the three PDF/print output paths in `static/erp/print.js`, their callers
across 10 modules, the service-worker interaction, and the third-party library
choice. Frontend delivery performance generally is in `PERFORMANCE_AUDIT.md`;
this document is scoped to document *output*.

> ## ⚠️ Superseded in part — there is now one renderer
>
> **2026-08-19.** The pipeline this document audits no longer exists. Both
> renderers it weighs against each other were removed and every export path
> consolidated onto the browser's own print engine (`window.print()`).
> See [PDF-009](#pdf-009--consolidated-onto-windowprint-one-renderer-no-dependencies)
> at the foot of this file for what changed and what it cost.
>
> Findings PDF-001 through PDF-005 and PDF-008 describe code that has since
> been deleted. They are kept because the *measurements* in PDF-002 are the
> reason the consolidation went the way it did, and because the history
> explains why the CSS and markup look as they do. PDF-006 (test coverage) and
> PDF-007 (`MApp.Print` duplication) were carried forward and are now closed.

> **Provenance.** Unlike the other audits in this folder, the two headline
> numbers here are **measured, not projected**: a representative 15-line
> Purchase Order was rendered through both the current pipeline and a vector
> pipeline under headless Chromium, and the resulting PDFs were parsed. Method
> and reproduction steps are in PDF-002. Everything else is read from the
> artifacts (line counts, npm registry metadata, CSP config).

---

## Findings

| ID | Title | Severity | Priority | Status |
|---|---|---|---|---|
| PDF-001 | PDF export cannot work offline — its only library is deliberately un-cached | High | P0 | ✅ Fixed |
| PDF-002 | Output is a flat JPEG: 0 characters of searchable text, 7.5× the bytes | High | P0 | ✅ Fixed |
| PDF-003 | `html2pdf.js` pinned 4.5 years stale; 12 CDN deps carry no SRI | Medium | P1 | ✅ Fixed |
| PDF-004 | `po.js` duplicates `downloadElementAsPDF` in 116 lines, drifted both ways | Medium | P1 | ✅ Fixed |
| PDF-005 | Bulk separate-PDF export can silently under-deliver and over-report | Medium | P1 | ✅ Fixed |
| PDF-006 | `print.js` has zero test coverage across 10+ call sites | High (process) | P1 | ✅ Fixed |
| PDF-007 | `MApp.Print` duplicates `App.Print.trigger`; desktop's container list is manual | Low | P3 | ✅ Fixed |
| PDF-008 | A vector renderer is already installed, undeclared in `requirements.txt` | Info | — | ⬜ Obsolete |
| PDF-009 | Consolidated onto `window.print()`: one renderer, no dependencies | — | — | ✅ Done |
| PDF-010 | Bulk export as N separately-named files, via WeasyPrint | — | — | ✅ Done |
| PDF-011 | Documents fit the A4 page; one naming convention for every export | — | — | ✅ Done |

---

## PDF-001 · PDF export cannot work offline — its only library is deliberately un-cached
**Location** `static/erp/print.js:151-161` · `static/erp/sw.js:100-101` · **Severity** High · **Priority** P0
· **Status** ✅ **Fixed** — see *Resolution* below

`ensureHtml2Pdf()` fetches the library from `cdnjs.cloudflare.com` at the moment
the user clicks a Download button:

```js
await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');
```

The service worker precaches `print.js` itself (`sw.js:29`) but its fetch handler
ends by explicitly declining to touch third-party CDN assets:

```js
// Everything else (RPC endpoints, third-party CDN assets, other app
// routes) -- let the browser handle it normally, untouched.
```

That comment is a coherent policy for RPC data — ERP records must never come
from a cache — but it also means the one hard dependency of every "Download PDF"
button is the single un-cached asset in the export path.

**Failure modes.** Installed PWA with no connectivity; a factory-floor device on
patchy mobile data; a corporate network that blocks `cdnjs`. In all three the app
shell loads from cache, tables render, **Print** works (it is native
`window.print()`), and only **Download PDF** fails with
*"PDF library failed to load."*

The current roadmap defers offline-with-sync to Phase 6, so this is not a broken
promise today — but it is the cheapest reliability fix in this document, and it
must land before Phase 6 rather than after.

### Resolution

Self-hosted, and the library upgraded at the same time (PDF-003):

1. Vendored to `static/erp/vendor/html2pdf.bundle.min.js` at **0.14.0**,
   byte-identical to the npm tarball and checksum-verified — provenance,
   hashes and the upgrade procedure are in `static/erp/vendor/README.md`.
2. `ensureHtml2Pdf()` now loads `App.Print.HTML2PDF_URL`
   (`/static/erp/vendor/…`). `po.js`'s duplicate loader was pointed at the same
   helper rather than given a second copy of the path (it is deleted in PDF-004).
3. `CACHE_NAME` `erp-shell-v19` → **`v20`** so installed workers re-fetch.
4. `https://cdnjs.cloudflare.com` removed from CSP `script-src` — it was that
   host's only use. A comment there now requires SRI before any CDN host returns.
5. `.gitattributes` marks `vendor/**` as `-text`, so `core.autocrlf=true` cannot
   rewrite line endings and invalidate the recorded checksums.
6. `eslint.config.js` gained a **global** `ignores` block for `vendor/**`. Note
   an `ignores` inside a `files` block would not have been enough — that only
   excludes the file from *that* block and still leaves ESLint parsing 946 KB of
   minified code on every run.

**Deviation from the plan above: warm after activation, don't precache.** Step 2
originally said to add the bundle to `PRECACHE_URLS`. Measuring it first changed
the decision — at **946 KB** it is roughly 75% of everything else precached
combined, and `install()` blocks on `cache.addAll()`, so precaching would make
every install pay that cost up front for a feature not every user touches. It is
instead fetched by a new non-blocking `WARM_URLS` step after `activate`, which
keeps install exactly as fast as before while still making export work offline.
The existing cache-first handler remains the backstop if the warm fetch fails.

**Verified.** A staged web root mirroring all 21 precached paths was served, the
real `sw.js` registered, then the network cut and a PDF exported:

```
service worker            : active
bundle cached by SW in    : erp-shell-v20
origin now                : unreachable (network cut)
html2pdf loaded offline    : cache
PDF generated OFFLINE     : 33,127 bytes, 1 page, 210.0x297.0 mm
producer                  : jsPDF 4.0.0
```

Also confirmed: Flask serves the asset (`200`, 946,030 bytes), and the real
`print.js` loaded over HTTP resolves `HTML2PDF_URL` and exports successfully
with no error toasts and no console errors.

Output is unchanged — this was pure reliability, and it also resolved half of
PDF-003.

---

## PDF-002 · Output is a flat JPEG: 0 characters of searchable text, 7.5× the bytes
**Location** `static/erp/print.js:175-272` · **Severity** High · **Priority** P0
· **Status** ✅ **Fixed** — vector rendering added server-side, raster kept as the offline fallback

`downloadElementAsPDF()` runs `html2canvas` over the print container, encodes the
result as JPEG at `quality: 0.98`, and embeds that single image in a jsPDF page
(`print.js:217-227`). The delivered PDF therefore contains a *photograph* of the
document, not the document.

**Measured.** Same representative 15-line Purchase Order, same markup, both
paths, parsed with `pypdf`:

| | `html2pdf.js` 0.10.1 (ships today) | Chromium print-to-PDF (vector) |
|---|---:|---:|
| File size | **361,394 bytes** | **48,256 bytes** |
| Embedded images | 1 | 0 |
| Extractable text | **0 characters** | **1,184 characters** |
| Search `PO-2026-0417` | **not found** | found |
| Search `Freewheel` | **not found** | found |

The raster output is **7.5× larger** and **completely unsearchable**. Both PDFs
report a `/Font` dictionary, so that is not a valid check — jsPDF embeds one even
for image-only pages. Only text extraction distinguishes them.

**Consequences.**

- A saved or emailed PO cannot be searched for its own PO number.
- Part numbers, HSN codes and vendor names cannot be copied out — they must be
  retyped, in a workflow where they were already typed once.
- Screen readers get nothing; the PDF is opaque to assistive technology.
- Any future document archive is un-indexable without an OCR stage.
- A 50-PO bulk export moves ~18 MB instead of ~2.4 MB.

**Root cause is structural, not a setting.** `html2canvas` is a screen-media
rasteriser: it reimplements layout and paint in JS onto a canvas, so text is
pixels by construction. It also never applies `@media print` CSS, which the
codebase already discovered and worked around — the `pagebreak.avoid` list at
`print.js:244` exists solely because `page-break-inside: avoid` in the print
stylesheet is invisible to it, and html2pdf's page model is a single tall canvas
guillotined at page-height multiples. Every one of those workarounds disappears
under a real print engine.

Note also `image: { type: 'jpeg' }`: JPEG is a DCT photographic codec and
produces ringing artefacts on sharp glyph edges. For a text document PNG would at
least be lossless — but that trades one problem for a larger file, and is moot if
the path goes vector.

**Reproduction.** The measurement harness is not committed (it is throwaway);
recreate it by loading any print container in headless Chromium, calling
`page.pdf()` for the vector baseline, then `add_script_tag` the pinned cdnjs
bundle and run `html2pdf().set({...print.js settings...}).outputPdf('blob')` for
the raster comparison. Parse both with `pypdf` and compare
`page.extract_text()` length and `len(page.images)`. Playwright and a Chromium
build are already present in the local `venv` (see PDF-008 note below).

### Resolution

Option B, as recommended. A new endpoint renders the **same HTML the existing
builders already produce** through headless Chromium, so no document markup
changed.

- `app/erp/services/pdf_render_service.py` — the renderer.
- `POST /erp/render-pdf` (`app/erp/pages.py`) — deliberately not an RPC method,
  since `/api/erp/rpc/<method>` is a JSON-envelope bridge and this returns
  binary. `@login_required`, and CSRF applies automatically.
- `App.Print.renderViaServer()` (`static/erp/print.js`) — tried first by
  `deliverSeparatePDFs` for every delivery mode.

**It is an upgrade path, not a dependency.** `renderViaServer` returns `null`
when the server cannot render, and every caller then uses the raster renderer
exactly as before. A 503 (deployed without Chromium) or a failed fetch (offline)
settles `serverPdfAvailable = false` for the session so a 40-record export does
not stall once per record; a per-document 4xx/5xx does not, since the next
document may be fine. This is what keeps export working with no network.

**Measured end to end** through the real Flask app and a real browser, driving
`deliverSeparatePDFs` with a purchase order:

| | vector (server) | fallback (offline) |
|---|---:|---:|
| Bytes | 51,690 | 122,354 |
| Embedded images | **0** | 1 |
| Extractable text | **204 chars** | **0 chars** |
| Search the PO number | **found** | not found |
| Producer | Skia/PDF (Chromium) | jsPDF 4.0.0 |

Both paths delivered all files. (The size ratio here is 2.4× rather than the
7.5× quoted above — that figure was measured on the denser 15-line PO. The
ratio depends on how much content is on the page; the *searchability* difference
does not.)

**The page shell is built server-side**, so page size, margins and the
break-inside rules cannot be driven by the request body. Those rules are the
real CSS equivalent of html2pdf's `pagebreak.avoid` list — and unlike that one,
a print engine actually honours them.

### Security

The HTML arrives from an authenticated browser, but authenticated is not
trusted: an unrestricted renderer is a server-side request forgery primitive and
a local file reader. Each render therefore runs with **all network blocked**
(one route handler aborts every request the page makes), **JavaScript
disabled**, a payload cap and a hard timeout. `data:` URIs are unaffected, which
is what the company logo uses, so it still renders.

Covered by `tests/erp/test_pdf_render.py` (21 cases): auth, validation, the
error mapping, and specifically that the renderer does **not** fetch
`169.254.169.254`, does **not** read `file:///etc/passwd`, does **not** execute
a `<script>`, and does still render an inline `data:` image.

### Cost, as stated up front

`playwright==1.62.0` is now in `requirements.txt` and the Dockerfile runs
`playwright install --with-deps chromium` — the largest layer in the image by
some margin, placed after pip and before the app source so code changes do not
rebuild it. Rendering costs server CPU per document, and a browser is held per
worker thread (Playwright's sync API binds objects to their creating thread, so
one shared browser is not an option).

---

## PDF-003 · `html2pdf.js` pinned 4.5 years stale; 12 CDN deps carry no SRI
**Location** `static/erp/print.js:154` · `static/erp/po.js:1173` · `app/__init__.py:427-433` · **Severity** Medium · **Priority** P1
· **Status** ✅ **Fixed** — upgraded to 0.14.0, one CDN host retired, and every remaining CDN asset pinned with SRI

Contrary to a reasonable assumption, `html2pdf.js` is **actively maintained** —
the project is simply pinned to a 2021 build.

| | Pinned | Current |
|---|---|---|
| `html2pdf.js` | **0.10.1** (cdnjs `Last-Modified` 2021-09-02) | **0.14.0** (2026-01-12) |
| → `jspdf` | `^2.3.1` | `^4.0.0` |
| → `dompurify` | *absent* | `^3.3.1` |
| → `html2canvas` | `^1.0.0` | `^1.0.0` |
| → `es6-promise` | `^4.2.5` (dead weight) | *dropped* |

Four minor versions and a major jsPDF bump behind. The `dompurify` addition is
notable: upstream added HTML sanitisation to this path. The app's own print
builders do escape correctly (`escapeHtml()` is applied consistently — verified,
no injection found), so this is defence-in-depth rather than an open hole.

`html2canvas` itself is genuinely frozen at **1.4.1 (2022-01-22)**. A maintained
fork, **`html2canvas-pro` 2.3.8 (2026-08-14)**, adds modern CSS colour support
(`oklch()`, `lab()`, `color-mix()`).

> **Latent trigger, not a present bug.** `styles.css` currently contains **zero**
> occurrences of `oklch`/`lab`/`color-mix`/`color()`, and Bootstrap is pinned at
> 5.3.0, so nothing breaks today. The moment the project adopts any modern colour
> function — or upgrades Bootstrap to a version that emits them — html2canvas
> 1.4.1 fails to parse them and renders those elements black or throws. Swap to
> `html2canvas-pro` **at that point**, not pre-emptively.

**Subresource Integrity.** All 12 third-party assets load without an `integrity`
attribute, and `loadScript()` (`core.js:19-33`) has no parameter for one:

```
code.jquery.com          jquery 3.6.0
cdn.jsdelivr.net         bootstrap 5.3.0 (css+js), bootstrap-icons 1.11.3,
                         chart.js 4.4.0, select2 4.1.0-rc.0 (+theme),
                         htm 3.1.1, sortablejs 1.15.7, xlsx 0.18.5
cdnjs.cloudflare.com     html2pdf.js 0.10.1
```

A compromise at either CDN executes arbitrary JS inside an authenticated ERP
session.

### Resolution (partial)

The upgrade shipped with PDF-001: **0.14.0**, vendored on-origin, which retired
`cdnjs.cloudflare.com` from CSP entirely and removed the last runtime-loaded CDN
script. jsPDF 2.3.1 → 4.0.0 is a major bump, so it was verified before merging
rather than assumed — the same Purchase Order rendered through both builds under
headless Chromium:

| | 0.10.1 (jsPDF 2.3.1) | 0.14.0 (jsPDF 4.0.0) |
|---|---:|---:|
| 1-page PO — geometry | 210.0 × 297.0 mm | 210.0 × 297.0 mm |
| 1-page PO — size | 361,394 B | 362,269 B (+0.2%) |
| 2-page PO — page count | 2 | 2 |
| 2-page PO — size | 1,038,408 B | 1,036,786 B (−0.2%) |
| Console errors | none | none |

`.set()` / `.from()` / `.save()` / `.outputPdf('blob')` and the
`jsPDF: { unit, format, orientation }` passthrough all behave identically, and
the `pagebreak.avoid` list still paginates the same. Safe drop-in, confirmed.

> Incidentally: that 2-page PO is a **1.04 MB** PDF. Worth holding next to
> PDF-002 when weighing Option B.

### Resolution (SRI)

Every remaining CDN asset is now pinned with a `sha384` integrity hash and
`crossorigin="anonymous"` — both are required together, since without the
latter the response is opaque and the browser blocks the asset instead of
verifying it.

- **8 tags in `index.html`**: Bootstrap CSS+JS, Bootstrap Icons, Select2 CSS+JS,
  the Select2 Bootstrap 5 theme, jQuery, and htm/preact.
- **2 runtime-loaded scripts**: `loadScript()` gained an `integrity` parameter,
  and `dashboard.js` (Chart.js) and `stock.js` (SheetJS) pass their hashes. A
  mismatch fires `onerror`, so it lands in the existing rejection path.

Versioned jsdelivr / code.jquery URLs are immutable, so these hashes stay valid.

**Verified in a browser, including the control that matters:** all 8 pinned
tags load and their globals are present, and the same jQuery tag with *one
character* of its hash corrupted is refused. Same for both `loadScript` assets —
correct hash loads, corrupted hash rejected. Without that control the exercise
would be decorative: a wrong hash does not warn, it silently removes the asset.

**One gap remains, and it cannot be closed this way.** `sortablejs` is pulled in
by a bare ESM `import` specifier inside a `<script type="module">`
(`index.html:495`), and an import specifier takes no `integrity` attribute.
Closing it needs either an import map with an `integrity` key (Chromium-only and
recent) or vendoring the file the way html2pdf was. Left as-is and recorded here
rather than half-solved.

---

## PDF-004 · `po.js` duplicates `downloadElementAsPDF` in 116 lines, drifted both ways
**Location** `static/erp/po.js:1151-1266` · **Severity** High → **Medium** (see correction) · **Priority** P1
· **Status** ✅ **Fixed**

`App.PO.downloadPDF(index)` is a near-verbatim copy of
`App.Print.downloadElementAsPDF()` — 116 lines against a 273-line shared module,
i.e. **42% of `print.js` re-implemented in one caller**. It repeats the whole
html2canvas offset/clipping dance: scroll save, `document.body.insertBefore`,
body padding/margin/overflow overrides, and the `finally` restore.

The two copies have **diverged in both directions**, so each carries a fix the
other lacks:

| `pagebreak.avoid` entry | `print.js:244` | `po.js:1231-1234` |
|---|:---:|:---:|
| `tr` | ✓ | ✓ |
| `.print-sheet-closing-accent` | ✓ | — |
| `#print-grand-total-container` | — | ✓ |
| `#print-footer-meta` | — | ✓ |
| `#print-signature` | — | ✓ |

> **Correction.** The first version of this finding asserted the consequence
> was that a single-PO download protects its grand-total block, footer and
> signature from the page guillotine while a bulk download does not — two
> adjacent buttons paginating the same record differently. **That was
> over-claimed, and testing it disproved it.** Row counts were swept until
> `#print-signature` genuinely straddled a page boundary (37 rows: block spans
> 1046–1067 px, boundary at 1055 px) and pagination was identical with and
> without the three `#print-*` selectors, at every row count from 30 to 45. A
> control re-running the same list twice showed html2pdf's output is not
> byte-reproducible, so an earlier byte-comparison signal was noise. Those
> selectors appear **inert** — html2pdf's `avoid` does not act on them the way
> it does on `tr`.
>
> They were still kept when consolidating, because a refactor is the wrong place
> to also change behaviour and a non-matching selector costs nothing.

What remains, without the pagination claim, is still worth fixing: two copies of
a 116-line function whose configuration had already drifted apart in both
directions, where any future fix lands in one and not the other.

`po.js` also hardcodes the page geometry it was meant to inherit —
`element.style.width = '749px'` (`po.js:1207`) and `margin: [6, 6, 6, 6]`
(`po.js:1215`) — directly defeating the "single source of truth for every export
path" contract stated at `print.js:12-20`, where `PAGE_WIDTH_PX` derives 749 from
`PAGE_MARGIN_MM`. Change the margin in `print.js` and the single-PO export
silently keeps the old geometry.

### Resolution

`downloadPDF()` is now a 23-line function that resolves a filename and calls
`App.Print.downloadElementAsPDF('print-po-container', filename)`. **Net −110
lines** in `po.js` (1,430 → 1,316). Deleted alongside it:

- `App.PO.sanitizeFilename` — superseded by `App.Print.sanitizeFilename`.
- `App.PO.ensureAssetsReady` — it awaited `document.fonts.ready`, which
  `downloadElementAsPDF` already does internally.

The union of both `avoid` lists moved into the shared default so the deletion
changed no configuration (see the correction above on why those selectors are
kept despite appearing inert). The hardcoded `749px` and `[6, 6, 6, 6]` are gone
with it, so the single-PO path now derives its geometry from `PAGE_MARGIN_MM`
like every other export — previously, changing that constant would have silently
left this one path on the old geometry.

`downloadElementAsPDF` also gained the `console.warn` on a missing container that
`po.js`'s copy had, so no diagnostic was lost and every caller now gets it.

**Verified** by driving the refactored `App.PO.downloadPDF(0)` through the real
`print.js` and `po.js` over HTTP with html2pdf's `save` intercepted:

```
filename requested : ['PO_2026-0417_Document.pdf']
toasts             : [['PDF exported successfully!', false]]
DOM after          : parent BODY, bodyPad 40px, display none
page errors        : none
```

The borrowed container is returned to its original parent and `body` padding is
restored. That filename also shows the PDF-005 fix working: the vendor name is
Gurmukhi, which before the `'Document'` fallback was restored produced
`PO_2026-0417_.pdf`.

---

## PDF-005 · Bulk separate-PDF export can silently under-deliver and over-report
**Location** `static/erp/print.js:138-147` · **Severity** Medium · **Priority** P1
· **Status** ✅ **Fixed** — all four problems closed; cancellation remains as a separate enhancement

`downloadSeparatePDFs()` (added when bulk export was changed from one merged file
to one file per record, now used by all 8 bulk callers) has three honest
limitations:

**1. Browsers block rapid successive downloads.** Chrome and Edge show a
*"Download multiple files?"* permission prompt once a page initiates several
downloads without intervening user gestures. If the user dismisses or blocks it,
every subsequent download is dropped — silently, from the page's perspective.

**2. Success is counted on attempt, not delivery.** `html2pdf`'s `.save()`
resolves once it has handed the blob to the browser; it cannot observe whether
the download landed. So `successCount` counts *attempts*, and the toast
(`"${count} purchase order(s) exported to PDF!"`) can claim 12 when 1 reached
disk. That is the worst property here — a wrong confirmation is worse than a
visible failure.

**3. No progress or cancellation.** Each record triggers a full html2canvas
rasterisation on the main thread. Total work is comparable to the old merged
export (same content area), but it is now N discrete jobs with no counter, no
spinner and no way to stop a 40-record export mid-flight.

**4. Filenames could collide, so files overwrote each other.** Found while
fixing PDF-004 and fixed separately: `sanitizeFilename` strips everything outside
`[a-zA-Z0-9_-]`, so any name written wholly in Gurmukhi or Devanagari sanitized
to the empty string. Every such record produced the identical filename, and a
browser handed the same name repeatedly either overwrites or appends its own
`(1)`. A 5-record export could quietly deliver fewer than 5 distinct documents.

This was a regression introduced when `sanitizeFilename` was promoted out of
`po.js` — the promotion dropped its `.slice(0, 50)` cap and its `|| 'Document'`
fallback. It was latent in the original because that sanitizer only ever named
single-record downloads, one file at a time, where a collision is impossible.

### Resolution (partial)

Both dropped behaviours restored, and `downloadSeparatePDFs` now de-duplicates
across the batch via `uniqueFilename()`, suffixing repeats `_2`, `_3`, … before
the extension. Matching is case-insensitive, since Windows and macOS treat
`PO_1_Acme.pdf` and `po_1_acme.pdf` as one file. This also covers two long names
that differ only past the 50-character cap.

Covered by `static/erp/tests/print_filenames.test.js` (14 cases), including the
Gurmukhi/Devanagari fallback and the three-records-one-name case.

### Resolution (items 2, 3 and 4)

**Progress (item 3).** `downloadSeparatePDFs` takes a `progressButtonId`; the
button that triggered the export is disabled and relabelled
*"Exporting 3 of 12…"* with a spinner, then restored — including when an export
throws. Reusing that button avoids new markup and, more importantly, keeps
progress out of `showToast`, which also feeds `App.Notify` and would otherwise
leave one notification per record behind. A short yield (`BULK_EXPORT_YIELD_MS`)
between records lets the label actually paint; without it the main thread is
occupied by `html2canvas` and the button jumps straight from its original text to
done. That yield is **not** a workaround for item 1 — a delay does not grant user
activation.

**Honest wording (item 2).** All eight callers now end at a shared
`reportBulkResult(generated, total, noun)` rather than eight copies of a
success-only toast. It says **"generated"**, which is the strongest claim this
code can support, and it reports partial failure as an error naming both numbers
(*"Generated 2 of 5 item ledger PDFs — 3 failed."*) instead of quietly claiming
success. Previously every caller did `if (count) showToast(...)` — a batch where
4 of 5 failed announced the 1 success and said nothing about the 4.

**Item 4** was fixed in the preceding commit.

Covered by `static/erp/tests/print_bulk_export.test.js` (13 cases: label
sequence, disable/restore, restore-on-throw, already-disabled buttons, missing
and absent button ids, `pdfOverrides` forwarding, and all four wordings).

**Verified end to end** in a real browser with downloads landing on disk: four
records produced four distinct valid PDFs, progress ran
`Exporting 1..4 of 4`, the button was restored to `Download PDFs (4)` and
re-enabled, the toast read *"4 purchase order PDFs generated."*, no console
errors.

### Resolution (item 1 — delivery)

Both candidates were built, and a bulk export now picks the best one available
(`chooseBulkDestination`):

| Mode | When | Delivery | Confirmable |
|---|---|---|---|
| **folder** | `showDirectoryPicker` exists (Chromium) | separate files, exact names, one permission prompt | **yes** — each write resolves or throws |
| **zip** | no picker, and more than `ZIP_THRESHOLD` (5) records | one download containing separate PDFs | one download, so no multi-download prompt |
| **files** | otherwise, and always for a single record | one download per PDF | no — the original ceiling |

**Activation.** `showDirectoryPicker()` needs live user activation, which does
not survive an earlier `await`. All eight callers were restructured to choose the
destination as their **first** await — `items.js`, `process.js` and `vendors.js`
previously loaded data first, which would have spent the activation and made the
picker throw. Dismissing the picker cancels the export rather than falling back
to a noisier mode.

**ZIP.** Written here rather than vendored (~90 lines, store-only). Every entry
is STOREd, not deflated, which costs almost nothing: a PDF's streams are already
deflate-compressed. No ZIP64 — that would only matter past 4 GB or 65,535
entries. Note this reverses the delivery decision taken at the outset (one file
per download over a ZIP); it was reinstated on request, and the folder mode means
Chromium users still get separate files.

**Wording follows the mode**, since only one of them can prove delivery:
*"4 purchase order PDFs saved to the selected folder."* / *"… packaged into
Purchase_Orders_180826.zip."* / *"… generated."*

**Verified end to end** in a real browser:

```
ZIP    : one download, opened with Python's zipfile
         testzip (CRC check): all entries OK
         4 entries, every one a valid 1-page PDF
FOLDER : 4 writes confirmed through a real FileSystemDirectoryHandle shape,
         zero downloads triggered
```

The ZIP check matters most: `testzip()` validates every entry's CRC using an
independent implementation, so a malformed archive from a hand-written writer
cannot pass. 15 more unit tests assert the byte structure directly (signatures,
CRC against `zlib.crc32`, sizes, central-directory offsets, the UTF-8 name flag).

### Still open

- **No cancellation.** A 40-record export still cannot be stopped once started.
  The progress button is the natural place to put it (relabel to "Cancel"), now
  that it is already wired.
- `stock.js`'s three consolidated-report toasts still say *"exported to PDF"*.
  They are single-file exports on a different path, where the overstatement is
  much smaller, and were left alone as out of scope for this finding.

---

## PDF-006 · `print.js` has zero test coverage across 10+ call sites
**Location** `static/erp/tests/` · **Severity** High (process) · **Priority** P1

`print.js` is the most widely shared frontend module — `po.js`, `bill.js`,
`bom.js`, `items.js`, `issue.js`, `dispatch.js`, `process.js`, `vendors.js`,
`stock.js`, `production.js`, `dispatch-plan.js` and `client.js` all call into it —
and it has **no tests**. The only print-adjacent spec,
`production_sheet_print.test.js`, exercises a markup builder, not `print.js`.

`downloadElementAsPDF()` is unusually well suited to jsdom testing because its
risky behaviour is pure DOM bookkeeping, independent of html2pdf. With
`window.html2pdf` stubbed, these invariants are all assertable:

- the element returns to its **original parent and next-sibling**, not appended
  to the end (the `originalSibling` branch, `print.js:264-270`);
- `style` is restored, and **removed** when there was none (`:259-263`);
- `body` padding/margin/overflow and `documentElement.overflow` are restored;
- scroll position is restored;
- **all of the above still happen when html2pdf throws** — the `finally` path,
  which is exactly the case that leaves the app visibly broken if it regresses;
- `false` is returned rather than throwing, since every caller branches on it;
- `captureWidthPx` is consumed locally and **not** forwarded to html2pdf
  (`:179-180`) — a subtle contract a refactor could easily break.

`downloadSeparatePDFs()` is equally testable: N records ⇒ N renders, one file
name per record, and a count that reflects failures.

### Progress

`print.js` now has **27 cases** across two files, where it had none:

- `print_filenames.test.js` — 14 cases over `sanitizeFilename` and
  `uniqueFilename` (the naming layer).
- `print_bulk_export.test.js` — 13 cases over `downloadSeparatePDFs`'s loop and
  `reportBulkResult`, including **restore-on-throw**, which is the same
  `finally`-path class of bug listed above.

Both load the real `print.js` in a `vm` context; the second passes the real
jsdom `document` in, so button relabelling is exercised rather than mocked. That
is the pattern the remaining cases should follow.

**Still open:** the `downloadElementAsPDF` DOM-restore invariants listed above —
the `finally` path in particular. Those are the ones that leave the app visibly
broken when they regress, and they remain uncovered.

---

## PDF-007 · `MApp.Print` duplicates `App.Print.trigger`; desktop's container list is manual
**Location** `static/erp/mobile.js:859-889` vs `static/erp/print.js:67-95` · **Severity** Low · **Priority** P3

`MApp.Print.trigger()` reimplements `App.Print.trigger()` — same hide-all,
`active-print`, title swap, `afterprint` + 1000 ms fallback cleanup. Worth noting
that **the mobile copy is the better design** in one respect:

```js
// mobile.js — self-maintaining
document.querySelectorAll('[id^="print-"]').forEach(...)

// print.js — hand-maintained list of 11 ids
CONTAINER_IDS: ['print-po-container', ... ]   // :22-34
```

Desktop's `CONTAINER_IDS` must be edited by hand whenever a print container is
added to `print.html`; a container omitted from it is never hidden by
`hideAll()` and can be left visible after a print job. **It is in sync today** —
all 11 real containers are listed, and `print-grand-total-container` is correctly
excluded as an inner element — so this is a latent maintenance hazard, not a
present bug. Adopting the selector form deletes the array and the hazard.

Also worth recording: **mobile has no html2pdf at all.** Its PO and Bill flows
call `MApp.Print.trigger()` and rely entirely on native print → *Save as PDF*
(`mobile.js:3470-3471`, `:3932`). The mobile PWA has been shipping vector,
searchable, correctly-paginated PDFs this whole time — by doing less.

---

## PDF-008 · Note: a vector renderer is already installed, undeclared
**Location** `requirements.txt` · `venv/Lib/site-packages/playwright` · **Severity** Informational
· **Status** ✅ **Fixed** — `playwright==1.62.0` declared, and now a real runtime dependency (PDF-002)

`playwright 1.62.0` plus Chromium builds (`chromium-1234` and two older) are
present in the local `venv`, and `puppeteer-core 25.5.0` is in `devDependencies`
— but **`playwright` is absent from `requirements.txt`**. It is an undeclared
incidental install (the audit docs reference Playwright only for future visual
regression testing).

This matters for the options below: the capability to render true vector PDFs
server-side is already on the dev machine, and the audit backlog independently
wants Playwright in CI. If it is going to be a declared dependency anyway, the
marginal cost of Option B drops considerably. Either way, `requirements.txt`
should stop disagreeing with the environment.

---

## Options

The current pipeline's three paths, for reference:

| Path | Mechanism | Output | Callers |
|---|---|---|---|
| Native print | `App.Print.trigger` → `window.print()` | **vector** | every Print button; **all** of mobile |
| Raster download | `App.Print.downloadElementAsPDF` → html2pdf | raster | every Download PDF button |
| `po.js` private copy | duplicate of the above | raster | single-PO download only |

All three share the same substrate: 11 hidden containers in `print.html` (1,163
lines) and per-module `build*PrintPageHtml()` string builders. **That substrate is
sound** — PDF-002 proves those same HTML builders yield a 48 KB searchable PDF
through a real print engine. The problem is confined to the renderer.

| # | Option | Output | Offline | Effort | Verdict |
|---|---|---|---|---|---|
| A | Vendor + upgrade to `html2pdf.js` 0.14.0 | raster | **✓** | S | **Do now, unconditionally** |
| B | Server-side Chromium (`page.pdf()`) via Playwright | **vector** | ✗ | M | **Recommended for documents** |
| C | Paged.js over the native print path | vector | ✓ | M | Only for "Page N of M" |
| D | `pdfmake` — rewrite builders as document definitions | vector | ✓ | L | **Not recommended** |
| E | Swap `html2canvas` → `html2canvas-pro` | raster | ✓ | S | Defer until triggered |

**A — Vendor and upgrade.** Fixes PDF-001 and most of PDF-003 with no change to
output. Self-host, precache, bump `CACHE_NAME`, drop the CDN host from CSP, move
0.10.1 → 0.14.0 (jsPDF 2→4 is a major bump: re-verify one document per module
against a current export before merging). Should land regardless of what is
decided about B.

**B — Server-side Chromium.** A Flask endpoint accepts the HTML the existing
builders already produce and returns a vector PDF from `page.pdf()`. Its decisive
advantage is that it **reuses every `build*PrintPageHtml()` verbatim** — no
document markup is rewritten. It also applies real `@media print` CSS, which
retires the entire `pagebreak.avoid` workaround (PDF-002) and the guillotine
model with it, and makes proper bulk-as-ZIP and future email/WhatsApp delivery
straightforward. Costs, stated plainly: `playwright` must enter
`requirements.txt`, Chromium adds roughly a 400 MB Docker layer, each render
costs server CPU, and **it needs network** — which is why it complements A rather
than replacing it. Keep the local raster path as the offline fallback and prefer
the server when reachable.

**C — Paged.js.** Improves the native path with real CSS Paged Media (running
headers, page counters). Vector and fully offline, but it still cannot write a
named file without the browser's print dialog, so it does not serve the
Download-PDF use case. `pagedjs` last published 0.4.3 in July 2023 — quiet.
Worth it only if "Page 1 of 3" and running headers are wanted for their own sake.

**D — `pdfmake` (0.3.11, actively maintained).** Genuinely vector, searchable and
fully offline, and it would be the technically purest client-side answer. Rejected
on cost and drift: all 11 document builders would be rewritten from HTML strings
into pdfmake's JSON model, and `print.html` would then be a *second*, diverging
definition of every document — the print preview and the PDF would be free to
disagree. Given those builders were only just ported, this is the wrong time.

**E — `html2canvas-pro`.** Insurance, not a fix. Trigger it on the first modern
CSS colour function or a Bootstrap upgrade (see PDF-003), not before.

---

## Recommended sequence

1. ~~**Vendor + precache + upgrade** (Option A) — closes PDF-001, most of
   PDF-003.~~ ✅ **Done.** Vendored at 0.14.0, warmed after activate rather than
   precached (see PDF-001 *Resolution* for why), `cdnjs` dropped from CSP,
   jsPDF 2→4 verified, offline export verified. `npm run lint` clean and all
   135 tests pass. Output unchanged.
2. ~~**Delete the `po.js` duplicate** (PDF-004)~~ ✅ **Done.** −110 lines;
   `App.PO.sanitizeFilename` and `App.PO.ensureAssetsReady` deleted with it, and
   the hardcoded `749px`/`[6,6,6,6]` geometry now derives from `PAGE_MARGIN_MM`.
   Testing the claimed pagination symptom disproved it — see the correction in
   PDF-004.
3. ~~**Make bulk export honest** (PDF-005)~~ ✅ **Done.** Filename collisions, a
   determinate progress indicator, a shared `reportBulkResult` that never claims
   total success on partial work, and both delivery models — folder picker
   (confirmable) and single ZIP — with the mode chosen automatically.
   Cancellation remains as a separate enhancement.
4. ~~**Pin `print.js` with jsdom tests, add SRI** (PDF-006, PDF-003)~~ ✅ **Done.**
   73 cases across four files, including every DOM-restore invariant and the
   `finally` path. Every CDN asset pinned with `sha384` + `crossorigin`, with a
   corrupted-hash control proving enforcement. One gap recorded: `sortablejs`
   loads via an ESM import specifier, which takes no integrity attribute. Do this *before* step 5, so the
   renderer swap has a safety net. Also add SRI to the remaining CDN assets.
5. ~~**Move the document paths to vector** (Option B)~~ ✅ **Done.** Every bulk
   export now renders server-side through Chromium when reachable, falling back
   to the raster path offline. `playwright` declared, Chromium added to the
   image, 37 new tests (21 backend, 16 frontend). `requirements.txt` reconciled
   (PDF-008).

All five steps are complete. What remains is listed under *Still open* in
PDF-005 and PDF-007: no cancellation on a long export, `sortablejs` cannot take
an SRI attribute through an ESM import specifier, and the mobile shell still
carries its own copy of `App.Print.trigger`.

---

## PDF-009 · Consolidated onto `window.print()`: one renderer, no dependencies
**Location** `static/erp/print.js` · `static/erp/styles.css` · `static/erp/mobile_styles.css`
· `templates/erp/partials/print.html` · **Status** ✅ **Done** — 2026-08-19

Everything in this document up to here describes a pipeline with **two**
renderers behind one set of buttons: `html2pdf.js` (html2canvas + jsPDF) in the
browser, and headless Chromium behind `POST /erp/render-pdf`, with the raster
path as the offline fallback. Both are gone. Every print and every PDF in the
app is now the browser's own print engine.

### Why

PDF-002 established that the raster path produced a picture of a document —
0 extractable characters, 7.5× the bytes. The server renderer fixed that, but
at the cost of a ~400 MB Chromium layer, which is why the Dockerfile shipped it
as `INSTALL_CHROMIUM=false`. **The default deployment therefore still produced
unsearchable PDFs**, and the one path that always produced a searchable
document — Print → Save as PDF — was already present, already free, and
already shipped.

### What changed

| | Before | After |
|---|---|---|
| Renderers | 3 (raster, Chromium, native print) | **1** (native print) |
| `print.js` | 842 lines | **223 lines** |
| Client payload | 946 KB vendored bundle, warmed by the SW | **none** |
| Server dependency | `playwright` + Chromium layer | **none** |
| Env vars | `PDF_SERVER_RENDER` | **none** |
| Searchable output | only where Chromium was installed | **always** |
| Container id lists | **10 copies** across JS + 2 stylesheets | **1 class** |

Deleted: `deliverSeparatePDFs`, `downloadElementAsPDF`, `renderElementToPdfBlob`,
`renderViaServer`, `ensureHtml2Pdf`, `_withElementPrepared`, `_prepareExport`,
`_pdfOptions`, `chooseBulkDestination`, `zipStore` (+ CRC-32/DOS-time helpers),
`saveBlob`, `uniqueFilename`, `reportBulkResult`, `hintSearchablePdfOnce`,
`bulkZipName`, `_writeIntoFolder`; `app/erp/services/pdf_render_service.py`,
`POST /erp/render-pdf`, `scripts/install_chromium.sh`, the vendored bundle, the
service worker's post-activate warm step, and the Dockerfile's Chromium layer.

### What it cost

**Bulk export as N separately-named files was lost, then restored** — see
PDF-010. For a period it produced one multi-page PDF instead of N files. The
folder-write delivery mode did not come back, and neither did PDF-005's class
of under-deliver/over-report problem: there is now one archive, and the browser
either saved it or the user cancelled.

**The buttons themselves are unchanged.** Every "Print", "Print Selected",
"Download PDF" and "Download PDFs" control is still in place, with its original
id, position and label; each delegates to the print path. An earlier revision of
this change deleted the download buttons on the grounds that they duplicated
Print. That was wrong: the brief was to change the mechanism, not to remove the
affordance, and "Download PDF" tells a user what they are going to get in a way
that "Print" does not.

The multi-page-instead-of-N-files change is the one genuine regression.
Restoring per-record files would require a second renderer, which is the thing
this change exists to remove.

### Fixed on the way through

- **PDF-007 is closed.** The 11 print containers now carry a shared
  `.print-container` class. That class replaced the id list, which had been
  written out **ten times** — `CONTAINER_IDS` in `print.js`, seven selector
  lists in `styles.css`, and two more in `mobile_styles.css` — and had already
  drifted: five containers were missing from the `@media print` block
  entirely, so its page-break, repeating-header and cell-border rules silently
  never applied to them.
- **A real mobile bug.** `MApp.Print.trigger` selected `[id^="print-"]`, a
  prefix that also matches `#print-grand-total-container` — a block *nested
  inside* the PO template. Printing a purchase order from the phone hid its own
  grand total. The class selector cannot make that mistake.
- **A dead user-facing option.** The Production Sheet's Landscape checkbox was
  read only by the PDF exporter. `printProductionSheet()` never passed it, so
  ticking Landscape and pressing Print produced a portrait page. Orientation is
  now a per-job `@page` override that `App.Print` appends and removes around
  the print call, so it cannot leak into the next document.
- **`@page` documentation.** The rule's comment claimed "10mm margins match the
  html2pdf jsPDF margin" while the rule itself said `6mm`, and pointed at a
  file that no longer exists.
- **The `td` exclusion is now stated.** `#print-po-container` and
  `#print-low-stock-container` were quietly absent from the cell-styling
  selector list; those rules are `!important` and would otherwise override the
  inline styling those two templates set. They carry `print-cells-own` and the
  rule reads `.print-container:not(.print-cells-own) td`.

### Coverage

The four test files covering deleted APIs (`print_bulk_export`, `print_zip`,
`print_server_render`, `print_dom_restore`) and `print_filenames` were replaced
by a single `static/erp/tests/print.test.js` — 24 cases over container
selection, the arm/print/restore cycle, orientation set-and-clear, filename
shaping and bulk pagination, run against the real `print.js` in a real jsdom
document. `production_sheet_print.test.js` gained cases for the lot-derived
filename and the Landscape option. Suite: 245 passing.

---

## PDF-010 · Bulk export as N separately-named files, via WeasyPrint
**Location** `app/erp/services/pdf_render_service.py` · `static/erp/print.js`
· **Status** ✅ **Done** — 2026-08-19

PDF-009 consolidated every export onto `window.print()`, which cost exactly one
capability: **one print dialog produces one document**, so "export these 40
challans as 40 separately-named PDFs" had no expression. That is a real
workflow here — each challan goes to a different client — so it is back.

### The shape

`window.print()` remains the renderer for *printing*. A second renderer exists
only to return **bytes**, which is the thing a print dialog cannot do:

| Button | Path |
|---|---|
| Print / Print Selected | `window.print()` — unchanged |
| Download PDF | `POST /erp/render-pdf` → one named PDF |
| Download PDFs | `POST /erp/render-pdf-batch` → ZIP of N named PDFs |

Both endpoints render **the same `build*PrintPageHtml()` output the browser
prints**. That is the whole design constraint: there is one definition of every
document, not two. The rejected alternative was a client-side PDF library
(jsPDF + AutoTable), which would have meant re-implementing 1,138 lines of
document layout as drawing calls and maintaining it alongside the HTML — and
PDF-004 in this same document records what happened last time document code was
duplicated here: it drifted in both directions.

### Why WeasyPrint and not the headless browser again

The renderer PDF-009 deleted was Playwright + Chromium: a ~400 MB image layer,
which is why the Dockerfile shipped it `INSTALL_CHROMIUM=false` and the default
deployment produced no server-rendered PDFs at all. WeasyPrint is three apt
packages, runs in-process, starts no subprocess, and is installed
unconditionally. It renders CSS and no JavaScript, which suits builders that
emit static tables with inline styles.

**Its one real cost is Windows dev**, and it is now mostly paid down. WeasyPrint
pip-installs there but cannot load pango/harfbuzz, which are not Python packages
-- the failure is `cannot load library 'libgobject-2.0-0'`, which says nothing
about the fix. `_ensure_windows_libs_on_path()` looks in the places MSYS2 and
the GTK runtime actually install to and adopts whichever holds the libraries,
setting both PATH (for `ctypes.util.find_library`) and `os.add_dll_directory`
(for the DLLs' own dependencies -- neither alone is enough). So the remaining
cost is one `winget install MSYS2.MSYS2` plus one `pacman -S
mingw-w64-x86_64-pango`; no PATH editing, and nothing to remember on the next
machine.

The test suite is split regardless: validation, filename safety,
de-duplication, auth and the error mapping run everywhere; rendering assertions
skip when `probe()` reports no libraries, and activate the moment they are
installed.

### Verified against a real renderer

WeasyPrint 69.0, 60 tests, none skipped:

```
probe   : ok -- weasyprint 69.0 available (libraries from C:/msys64/mingw64/bin)
render  : ok -- 5,807 bytes
batch   : ok -- entries=['PO_1204_Mahadev.pdf', 'PO_1204_Mahadev_2.pdf']
page    : 210 x 297 mm
columns : ok -- all 16 survived on A4
text    : ok -- 316 extractable characters
```

Three assertions had to be corrected, and each was wrong about how a real
renderer behaves rather than about the product:

- **`file://` and cloud-metadata refusals do not raise.** WeasyPrint catches
  the fetcher's `ValueError`, logs `Failed to load image at ...`, and renders
  the document without the image. That is better than aborting a whole export
  over one bad `<img>`, so the tests now assert on the output -- a real temp
  file with a marker in it, and the marker absent from the PDF bytes -- rather
  than on an exception.
- **Fitted text wraps mid-token, by design.** `VALUE150000` extracts as
  `VALUE1500
00`, because breaking a long cell value is exactly what
  `overflow-wrap: anywhere` is there to do. The assertion strips whitespace
  before matching; what would be a defect is the text missing entirely, which
  is what a cut column looks like.

The `pypdf` dependency is back in `requirements.txt` for this: asserting a PDF
"has a font dictionary" proves nothing (the old raster exporter embedded one
for an image-only page). Only reading the text back distinguishes a document
from a picture of one.

### Degradation, not dependency

`Download PDF` is an upgrade over `Print`, never a requirement. When the server
cannot render — offline, or libraries missing — the button falls through to
`window.print()` and says so once per browser. **The output is never worse:**
the print dialog still produces a searchable vector PDF with no network. This is
categorically unlike the pre-PDF-009 fallback, which silently produced a JPEG.

A `503` latches the client off for the session, so a 40-record export does not
make 40 pointless round trips; a per-request `5xx` does not latch, because the
next request may succeed.

### One request per batch

`POST /erp/render-pdf-batch` takes the whole selection and returns one archive.
The pre-PDF-009 implementation issued one HTTP request and one render **per
record**, with a deliberate `BULK_EXPORT_YIELD_MS` pause between them — so a
50-record export was 50 round trips, 50 renders and 50 sleeps.

A ZIP rather than N loose downloads is also deliberate: Chrome and Edge prompt
once per origin for "automatic downloads" and silently drop the rest if denied,
which is exactly how PDF-005's silent under-delivery happened. One archive
either arrives or does not.

Names are sanitised and de-duplicated server-side. A repeat inside a ZIP is
worse than a filename collision on disk — some extractors keep only the last
entry, so 40 records could quietly yield 38 files.

### Not restored

**Folder-write delivery** (File System Access API) did not come back. It existed
to make delivery confirmable when the alternative was N unconfirmable
downloads; with a single archive there is nothing left for it to solve.

---

## PDF-011 · Documents fit the A4 page; one naming convention for every export
**Location** `static/erp/styles.css` · `static/erp/print.js`
· `app/erp/services/pdf_render_service.py` · **Status** ✅ **Done** — 2026-08-20

Two problems, both visible to whoever holds the paper.

### Columns fell off the right edge

A print engine does not scale or scroll a table wider than the printable box —
it **cuts** it. On A4 portrait at 6mm margins that box is 198mm, and the Low
Stock sheet lost its Price and Total Value columns to it.

The earlier partial fix (`th { white-space: normal }`) treated the header. The
real cause is that these tables are `table-layout: auto`, where **no column can
be narrower than its own min-content**, and min-content is set by the longest
unbreakable run of characters — a 30-character item code, an HSN string, a
composite colour like `Silky Blue-Navy Blue / Black`. Enough of those floors and
the table exceeds 100% no matter what width is declared.

The fix is one property, and *which* property is the whole point:

| | wraps text | counts toward min-content | fixes the overflow |
|---|---|---|---|
| `overflow-wrap: break-word` | yes | **no** | **no** |
| `overflow-wrap: anywhere` | yes | **yes** | **yes** |

`anywhere` lets a column narrow past its longest token, which is what finally
makes `width: 100%` achievable. `table-layout: fixed` would also cap the width
and is still **not** used: the print tables declare no per-column widths, so
fixed layout would divide space equally and give the `#` column as much room as
`Item Name`. Auto layout keeps the proportions the documents were designed
with; this only removes the floors that let it overflow.

**Readability is a separate problem from fitting.** A 16-column pivot that fits
only because every cell wrapped to one character per line is on the page and
useless. So `App.Print.fitToPage()` counts the widest row and applies a density
tier — 10px, 9px, 8px, with matching padding. Nothing is applied below 9
columns, so ordinary purchase orders and challans are untouched.

Column count, not measured width, is the input: this runs before
`window.print()`, when the container is laid out at *screen* width, so anything
measured would be measuring the wrong box.

Past 12 columns no font size helps much, and rotating buys 40% more width than
any of them. The stock pivot — the one document whose width is unbounded, since
it grows a column per size — passes `landscape: 'auto'` and rotates itself.

The server shell carries the same rules and the same tier, which the client
sends (it is the side with a DOM to count). The tier name is validated against
a fixed set rather than interpolated into the stylesheet.

### Filenames were long, inconsistent, and unsearchable

`Delivery_Challan_DC-1041_Sharma_Traders.pdf` spends 17 characters on a prefix
repeated across every challan, which pushes the distinguishing part out of a
file-manager column. Every module also invented its own shape, and the ZIP used
`DDMMYY` while nothing else used a date at all.

`App.Print.docName()` is now the single convention, used by **both** the Print
title and the Download filename — so `Print → Save as PDF` and `Download PDF`
put the identical name in front of the user:

```
CODE_KEY_PARTY[_YYMMDD]
```

| Before | After |
|---|---|
| `PO_1204_Mahadev industries.pdf` | `PO_1204_Mahadev.pdf` |
| `Bill_B-3391_Gupta_Cycle_Co.pdf` | `GRN_B-3391_GuptaCycle.pdf` |
| `Delivery_Challan_DC-1041_Sharma_Traders.pdf` | `DC_1041_SharmaTraders.pdf` |
| `Stock_Issue_Receipt_882.pdf` | `ISS_882.pdf` |
| `Item_Ledger_RIM---BLACK.pdf` | `ILG_RIMBLACK_260820.pdf` |
| `Purchase_Orders_190826.zip` | `PO_260819.zip` |

Three rules, each earning its place:

1. **A short code first.** Typing `DC_` finds every challan.
2. **The document's own number next** — what someone searches for when holding
   a paper copy.
3. **A date only where the date is the identity.** A purchase order is
   identified by its number; stamping today's date on it is noise *and* a small
   lie, since it is the day it was downloaded rather than the day it was
   raised. Reports and ledgers have no number, so for those the date is the
   whole identity. `YYMMDD`, which sorts; the old ZIP used `DDMMYY`, which
   sorted a year of exports by day-of-month.

### Two rules, not one, and the split is deliberate

A production sheet is not named by the CODE_KEY_PARTY scheme. It is named
after **the operator's own Output Item Name plus the lot's date**:

```
20 inch Rider D-Gaddi Steel Rim S-Kid Type_210826.pdf
14 inch Crysta D-Gaddi Steel Rim_210826.pdf
```

The distinction is about how each document is recognised. A purchase order or
a challan is identified by a number somebody quotes back at you, so the number
leads. A production sheet is recognised by *what it makes* -- and the operator
already typed that name into the Output Item field. Abbreviating it into a
code and a model fragment would hide the one string they actually search for.

So the label is kept whole and readable, spaces intact, matching the Output
Item column character for character; only the characters Windows refuses are
replaced (these names routinely carry slashes -- `D/Gaddi`, `S/Kid`).

The date format differs between the two rules for the same reason, and this is
the part most likely to be "corrected" by someone tidying up:

| | Format | Why |
|---|---|---|
| Reports, ledgers, ZIPs | `YYMMDD` | No number of their own; found **by date**, so the name must sort chronologically |
| Production sheets | `DDMMYY` | The name already leads with something distinctive, so the date is **read**, not sorted on -- and it then matches the order shown on screen |

Two lots of the same item on the same day genuinely collide. That is resolved
server-side by `dedupe_filenames`, so forty records still yield forty files;
the client does not attempt to pre-empt it.

Three details that only showed up on real data: a party name is never truncated
mid-word (`Mahadevindustrie` reads as a typo and is no more distinct than
`Mahadev`); a code the key already carries is not repeated (`DC-1041` would
have produced `DC_DC-1041`); and a vendor named wholly in Gurmukhi or
Devanagari — ordinary here — has no Latin characters at all, so rather than
dropping the segment and giving every such vendor the same filename, a short
stable tag keeps them apart.
