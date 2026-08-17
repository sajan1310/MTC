# Vendored third-party assets

Self-hosted copies of libraries that were previously fetched from a public CDN
at runtime. Nothing in this directory is authored here — do not edit these
files. See `docs/audit/PDF_GENERATION_REVIEW.md` (PDF-001, PDF-003) for why
they moved on-origin.

## `html2pdf.bundle.min.js`

| | |
|---|---|
| Version | **0.14.0** (was 0.10.1 from cdnjs, a 2021-09-02 build) |
| License | MIT — see `html2pdf.LICENSE` |
| Bundles | `html2canvas` 1.4.1 + `jspdf` 4.0.0 + `dompurify` — third-party notices in `html2pdf.bundle.min.js.LICENSE.txt` |
| Source | `https://registry.npmjs.org/html2pdf.js/-/html2pdf.js-0.14.0.tgz` → `package/dist/html2pdf.bundle.min.js` |
| Size | 946,030 bytes (≈261 KB gzipped) |
| `sha256` | `9563c45f032179c73454293a649929e60fc24c05a326e8ab2811cfa8f25c3607` |
| SRI | `sha384-EaWTV/aVUkLz3tfwg3+5ycX7Q/d9ET9ruOKUgUuFIRUCfzHO1eo2J62a844iWPmY` |

Loaded lazily by `App.Print.ensureHtml2Pdf()` (`static/erp/print.js`) on first
use of any "Download PDF" button — it is **not** in the page's `<script>` tags
and costs nothing until a PDF is actually exported.

### Why it is byte-identical to npm

`.gitattributes` marks this directory `-text` so Git performs no line-ending
conversion (the repo runs `core.autocrlf=true`). That keeps the checksums above
verifiable against the published tarball forever. If you ever see them
disagree, the file has been modified or mangled — re-fetch, don't patch.

### Verifying

```sh
curl -sL -o h2p.tgz https://registry.npmjs.org/html2pdf.js/-/html2pdf.js-0.14.0.tgz
sha1sum h2p.tgz    # dd2fdf2ee3036cb4c0d7c0d4606ee2da7c677e83  (npm dist.shasum)
tar xzf h2p.tgz
sha256sum package/dist/html2pdf.bundle.min.js static/erp/vendor/html2pdf.bundle.min.js
```

### Updating

1. Fetch the new tarball and verify its `shasum` against
   `https://registry.npmjs.org/html2pdf.js/<version>`.
2. Copy `package/dist/html2pdf.bundle.min.js` and its `.LICENSE.txt` here;
   refresh `package/LICENSE` → `html2pdf.LICENSE` if it changed.
3. Update the table above (version, size, both hashes).
4. Bump `CACHE_NAME` in `static/erp/sw.js` so installed service workers
   re-fetch it instead of serving the old copy from cache.
5. Re-verify output before merging — see the note on `jsPDF` below.

### Notes for the next upgrade

- **`jsPDF` major bumps are the risk, not `html2pdf` itself.** 0.10.1 → 0.14.0
  moved jsPDF 2.3.1 → 4.0.0. That was verified before merging by rendering the
  same Purchase Order (1-page and 2-page variants) through both builds under
  headless Chromium and comparing page geometry, page count, embedded image
  count and console errors: identical A4 210×297 mm, identical page counts,
  no new errors, output size within 0.2%. Do the same for the next bump.
- **No `.map` is shipped.** The bundle's trailing `sourceMappingURL` comment
  points at a 3 MB source map that is deliberately not vendored, so DevTools
  logs a 404 for it when open. Harmless; don't "fix" it by editing the bundle.
- **`html2canvas` 1.4.1 is frozen upstream** (last published 2022-01-22) and
  cannot parse modern CSS colour functions (`oklch()`, `lab()`, `color-mix()`).
  `styles.css` currently uses none, so nothing is broken. The day one appears —
  or Bootstrap is upgraded past 5.3.0 — swap to the maintained
  `html2canvas-pro` fork. See PDF-003.
