'use strict';
// ESLint config for static/erp/*.js -- see TECHNICAL_DEBT_REPORT.md TD-001 /
// HTML_CSS_JS_REVIEW.md FE-006 ("no tooling gates" was itself the debt that
// let 143 !important declarations and 1,391 inline styles accumulate one
// reasonable-looking change at a time).
//
// This codebase has no module system yet (FE-003): 17 <script> tags share
// one global namespace by load order, so every top-level const/function in
// one file is an implicit global in every file loaded after it. The
// `globals` block below is that real, load-order-dependent global surface --
// not a guess, enumerated directly from the source (`grep -oE
// '^(const|let|var|function|class) [A-Za-z_$][A-Za-z0-9_$]*' static/erp/*.js`).
// `no-undef` stays ON: it's exactly the check that would have caught a
// typo'd or load-order-broken reference to one of these, which is the
// actual failure mode this file-splitting pattern is fragile to.

const globals = require('globals');

module.exports = [
  {
    files: ['static/erp/**/*.js'],
    ignores: ['static/erp/tests/**'],
    languageOptions: {
      sourceType: 'script', // classic <script> tags, not ES modules -- see FE-003
      ecmaVersion: 2021,
      globals: {
        ...globals.browser,
        // Third-party, loaded via CDN <script> tags in index.html/mobile.html
        bootstrap: 'readonly',
        jQuery: 'readonly',
        // Preact+htm (one self-contained bundle) and SortableJS, both used
        // only by planning-board.js. Sortable is assigned by index.html's
        // one type="module" bootstrap (the MultiDrag plugin ships ES-module
        // only), so it must never be read at parse time -- see that file.
        htmPreact: 'readonly',
        Sortable: 'writable',
        // Third-party, lazily loaded at runtime via this codebase's own
        // loadScript() (core.js) -- dashboard.js, po.js/print.js, stock.js
        // respectively. Genuine existing lazy-loading, worth noting against
        // PERFORMANCE_AUDIT.md PERF-001's "nothing is lazy-loaded" framing:
        // the heaviest third-party libs already are: this is the exception.
        Chart: 'readonly',
        html2pdf: 'readonly',
        XLSX: 'readonly',
        // This app's own cross-file globals (see header comment)
        $: 'writable',
        $$: 'writable',
        Api: 'writable',
        App: 'writable',
        MApp: 'writable',
        OfflineCache: 'writable',
        PO_STATUS: 'readonly',
        CACHE_NAME: 'writable',
        PRECACHE_URLS: 'writable',
        HTML_ESCAPE_MAP: 'readonly',
        escapeHtml: 'writable',
        toNumber: 'writable',
        formatCurrency: 'writable',
        formatQty: 'writable',
        parseRecordDate: 'writable',
        formatItemsPreview: 'writable',
        todayIso: 'writable',
        tomorrowIso: 'writable',
        dateToInputValue: 'writable',
        normalizeDateForInput: 'writable',
        loadScript: 'writable',
        safeModalShow: 'writable',
        safeModalHide: 'writable',
        setDisabled: 'writable',
        bindGlobalEvents: 'writable',
        // Service worker globals (sw.js / mobile-sw.js run in a different
        // realm from the page scripts above, but share this one lint pass)
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        importScripts: 'readonly',
      },
    },
    rules: {
      // Baseline: catch real bugs (undefined refs, unreachable code,
      // duplicate keys, etc.) without relitigating this codebase's existing
      // style choices (var vs let, semicolons already consistent, etc.) --
      // see TECHNICAL_DEBT_REPORT.md TD-001: baseline first, tighten later,
      // so the gate blocks NEW debt without blocking today's work.
      ...require('@eslint/js').configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      // Every file above whose own top-level name is ALSO listed in
      // `globals` above (App, MApp, OfflineCache, CACHE_NAME, PRECACHE_URLS,
      // bindGlobalEvents) legitimately declares that name once, in the one
      // file that owns it -- that's not a real collision, it's how a
      // no-module-system codebase shares state across <script> tags
      // (FE-003). `builtinGlobals: false` stops no-redeclare from treating
      // "this file's own global declaration" as redeclaring itself; it
      // still catches a genuine accidental redeclare of a real JS builtin
      // (Array, Object, etc.), which is the check actually worth having.
      'no-redeclare': ['error', { builtinGlobals: false }],
      // Both provably behaviour-preserving to fix (no-useless-escape) or a
      // likely-but-unverified dead-store (no-useless-assignment) -- kept as
      // warnings for this baselining pass rather than mass-edited sight
      // unseen; see TECHNICAL_DEBT_REPORT.md TD-001's "baseline, don't
      // block" principle. The ~10 flagged sites are worth a human look.
      'no-useless-escape': 'warn',
      'no-useless-assignment': 'warn',
      // The exact bug class FE-004 is about: innerHTML/outerHTML assigned a
      // template string is exactly where an unescaped interpolation becomes
      // stored XSS. 360 existing call sites are already reviewed per
      // HTML_CSS_JS_REVIEW.md FE-004 -- eval specifically is a brighter,
      // narrower line worth enforcing as an error from day one.
      'no-implied-eval': 'error',
      'no-eval': 'error',
    },
  },
];
