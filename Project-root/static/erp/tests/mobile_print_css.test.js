/**
 * The phone prints under desktop's document rules.
 *
 * Both shells print the same templates, but what a document looks like on
 * paper is decided by the stylesheet it prints under, and desktop's print
 * under far more than their inline styles: Bootstrap, styles.css's bare
 * element rules (a desktop ledger's headers are uppercase Outfit with a
 * 2px rule beneath them because of a plain `th` rule), and styles.css's
 * print block. The phone had fourteen lines of print CSS. Its documents
 * came out in other type, without the header rules, with the Item
 * Ledger's tables unstyled -- and cut to one page, because the shell's own
 * flex layout pinned the document's box to the height of the screen.
 *
 * mobile_styles.css now reproduces desktop's rules: its print block in
 * @media print, and the rules desktop applies on screen as well (a sheet
 * is measured on screen before it prints) confined to print containers
 * with :where(). This reads desktop's styles.css and Bootstrap --
 * read-only; desktop is the reference -- and fails if the two drift apart,
 * including in ORDER, which is what settles the ties between them.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const DESKTOP = read('styles.css');
const MOBILE = read('mobile_styles.css');
const BOOTSTRAP = read('vendor/bootstrap-5.3.0.min.css');

// ── A small CSS reader: enough for these three files ───────────────────

// Splits on `sep` outside quotes and brackets (a data: URI or rgba() in a
// value must not split a declaration).
function split(text, sep) {
  const out = [];
  let depth = 0; let quote = null; let cur = '';
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const normSelector = s => split(s.replace(/\s+/g, ' ').trim(), ',')
  .map(part => part.trim().replace(/\s*>\s*/g, ' > ').replace(/\s+/g, ' '))
  .join(',');

// 0.5 and .5 are one number, rgba(0, 0, 0, .05) and rgb(0 0 0 / 5%) are
// one colour; case and spacing are not a difference.
const normValue = v => v.trim().toLowerCase()
  .replace(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)/g,
    (m, r, g, b, a, pct) => `rgba(${r},${g},${b},${a === undefined ? 1 : (pct ? Number(a) / 100 : Number(a))})`)
  .replace(/\s+/g, ' ')
  .replace(/\s*,\s*/g, ',')
  .replace(/(^|[^\d.])\.(\d)/g, '$10.$2');

function declarations(body) {
  const map = new Map();
  split(body, ';').forEach(d => {
    const at = d.indexOf(':');
    if (at < 0) return;
    const prop = d.slice(0, at).trim().toLowerCase();
    let value = d.slice(at + 1);
    const important = /!\s*important\s*$/i.test(value);
    value = value.replace(/!\s*important\s*$/i, '');
    map.set(prop, { value: normValue(value), important });
  });
  return map;
}

// Every declaration block, in source order, with the at-rules around it.
function rules(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let head = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const h = head.trim(); head = '';
      if (h.startsWith('@') && !/^@(page|font-face)\b/.test(h)) { stack.push(h.replace(/\s+/g, ' ')); continue; }
      const end = text.indexOf('}', i);
      out.push({ at: stack.join(' '), selector: normSelector(h), decls: declarations(text.slice(i + 1, end)), index: out.length });
      i = end;
    } else if (ch === '}') {
      stack.pop(); head = '';
    } else if (ch === ';') {
      head = ''; // a statement at-rule (Bootstrap opens with @charset)
    } else {
      head += ch;
    }
  }
  return out;
}

// Desktop's light-theme tokens, so var(--text-primary) reads as the colour
// it prints in.
function tokens(ruleList, selector) {
  const vars = {};
  ruleList.filter(r => r.at === '' && r.selector === selector).forEach(r => {
    r.decls.forEach((d, prop) => { if (prop.startsWith('--')) vars[prop] = d.value; });
  });
  return vars;
}

function resolve(value, vars) {
  let v = value;
  for (let n = 0; n < 5 && v.includes('var('); n++) {
    v = v.replace(/var\((--[\w-]+)(?:,([^()]*))?\)/g, (m, name, fallback) =>
      (vars[name] !== undefined ? vars[name] : (fallback !== undefined ? fallback.trim() : m)));
  }
  return normValue(v);
}

const D = rules(DESKTOP);
const M = rules(MOBILE);
const B = rules(BOOTSTRAP);
const D_VARS = tokens(D, ':root');
const B_VARS = tokens(B, ':root,[data-bs-theme=light]');
const PRINT = '@media print';

// The phone keeps desktop's rules in two places: its print block, and --
// for the rules desktop applies on screen as well -- the top level, each
// confined to print containers with :where(.print-container), which adds
// no weight. To compare a phone rule with desktop's, take the confinement
// off and compare the selectors each lists.
const CONFINED = /^:where\(\.print-container\)\s*/;
const ALL_OF_IT = /^:where\(\.print-container,\s*\.print-container \*\)(::?[\w-]+)?$/;
function unscoped(selector) {
  const out = [];
  split(normSelector(selector), ',').forEach(part => {
    const p = part.trim();
    const all = ALL_OF_IT.exec(p);
    if (all) { out.push(all[1] || '*'); return; }
    const rest = p.replace(CONFINED, '');
    const is = /^:is\((.*)\)$/.exec(rest);
    (is ? split(is[1], ',') : [rest]).forEach(x => out.push(normSelector(x)));
  });
  return out.sort().join(',');
}

// The phone's rules for a selector: in its print block (PRINT), or at the
// top level and confined to print containers ('').
const phone = (sel, where) => M.filter(r => r.at === where &&
  (where === PRINT || r.selector.includes('.print-container')) &&
  unscoped(r.selector) === unscoped(sel));

// The phone reproduces `rule` if some rule of its with the same selector
// carries every one of the declarations, with the same value and the same
// !important.
function reproduced(rule, vars, where) {
  return phone(rule.selector, where).find(m => [...rule.decls].every(([prop, d]) => {
    const got = m.decls.get(prop);
    return got && got.important === d.important && got.value === resolve(d.value, vars);
  }));
}

function missing(rule, vars, where) {
  const best = phone(rule.selector, where)[0];
  return [...rule.decls]
    .filter(([prop, d]) => {
      const got = best && best.decls.get(prop);
      return !got || got.important !== d.important || got.value !== resolve(d.value, vars);
    })
    .map(([prop, d]) => `${prop}: ${resolve(d.value, vars)}${d.important ? ' !important' : ''}`);
}

const check = (rule, vars, where) =>
  ({ selector: rule.selector, missing: reproduced(rule, vars, where) ? [] : missing(rule, vars, where) });

describe('desktop\'s rules, reproduced', () => {
  // styles.css's bare element rules -- the ones that reach a print
  // container because an element selector does not know it is printing.
  const ELEMENTS = ['h1,h2,h3,h4,h5,h6', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'small', 'strong',
    'table', 'thead', 'th', 'td'];

  // styles.css's print-template isolation, page fitting and density tiers.
  const FITTING = ['.print-container th', '.print-container table',
    '.print-container th,.print-container td',
    '.print-container.print-fit-compact th,.print-container.print-fit-compact td',
    '.print-container.print-fit-dense th,.print-container.print-fit-dense td',
    '.print-container.print-fit-xdense th,.print-container.print-fit-xdense td'];

  // Desktop applies these on screen as well as on paper -- and a document
  // is laid out on screen before it prints (the Production Sheet measures
  // itself to choose a density) -- so the phone has them at the top level
  // too, not only in its print block.
  test.each(ELEMENTS.concat(FITTING))('%s', selector => {
    const found = D.filter(r => r.at === '' && r.selector === normSelector(selector));
    expect(found.length).toBeGreaterThan(0);
    found.forEach(rule => expect(check(rule, D_VARS, '')).toEqual({ selector: rule.selector, missing: [] }));
  });

  test('every rule in desktop\'s print block that reaches a document', () => {
    // The chrome-hiding list (#app-container, .modal, nav...) is desktop's
    // own chrome; the phone hides its chrome by exclusion instead. The
    // page-level body rule is checked on its own below.
    const skip = new Set(['body', normSelector('#app-container, .modal, .modal-backdrop, .toast-container, .toast, .nav-tabs, .pagination, .btn-action, nav, header, footer, .d-none, [style*="display: none"], [style*="visibility: hidden"]')]);
    const printRules = D.filter(r => r.at === PRINT && !skip.has(r.selector));
    expect(printRules.length).toBeGreaterThan(10);
    printRules.forEach(rule => expect(check(rule, D_VARS, PRINT)).toEqual({ selector: rule.selector, missing: [] }));
  });

  test('inside a document, what desktop\'s chrome-hiding rule also catches', () => {
    const rule = phone('.print-container .d-none,.print-container [style*="display: none"],.print-container [style*="visibility: hidden"]', PRINT)[0];
    expect(rule).toBeDefined();
    expect(rule.decls.get('display')).toEqual({ value: 'none', important: true });
  });

  test('the same page geometry', () => {
    const page = css => rules(css).find(r => r.selector === '@page');
    expect(page(MOBILE).decls).toEqual(page(DESKTOP).decls);
  });
});

describe('in desktop\'s order', () => {
  const at = (sel, where) => {
    const r = phone(sel, where)[0];
    expect(r).toBeDefined();
    return r.index;
  };
  const atDesktop = (sel, where) => D.find(x => x.selector === normSelector(sel) && x.at === where).index;
  const BASELINE = '.print-container:not(.print-cells-own) td';
  const COMPACT = '.print-container.print-fit-compact th,.print-container.print-fit-compact td';

  test('the density tiers come before the baseline cell rule, so it wins as on desktop', () => {
    // Equal weight, both !important: the later rule wins. On desktop that
    // is the baseline, so an ordinary ledger keeps 11px cells and only its
    // header cells shrink. The phone had it the other way round and
    // printed every ledger a size smaller than desktop's.
    expect(atDesktop(COMPACT, '')).toBeLessThan(atDesktop(BASELINE, PRINT));
    expect(at(COMPACT, '')).toBeLessThan(at(BASELINE, PRINT));
  });

  test('Bootstrap first, then desktop\'s element rules, then its print isolation', () => {
    // .table > :not(caption) > * > * and .print-container th tie on weight;
    // desktop loads Bootstrap first, so the isolation rule's colour wins.
    expect(at('.table > :not(caption) > * > *', '')).toBeLessThan(at('.print-container th', ''));
    // The reboot zeroes every table border; desktop's thead rule, later,
    // puts the 2px rule back under the header row.
    expect(at('thead,tbody,tfoot,tr,td,th', '')).toBeLessThan(at('thead', ''));
  });

  test('confining a rule adds nothing to its weight', () => {
    // Which is the only reason confining them is safe: a confined `th`
    // still weighs what desktop's bare `th` weighs, so every tie between
    // the rules above is settled as it is on desktop. :where() weighs
    // nothing; :is() weighs what its heaviest argument weighs, and every
    // list it wraps here is of bare elements.
    M.filter(r => r.at === '' && r.selector.includes('.print-container'))
      .forEach(r => split(r.selector, ',').forEach(part => {
        const p = part.trim();
        expect(p).toMatch(/^(:where\(\.print-container[^)]*\)|\.print-container)/);
        const is = /:is\(([^)]*)\)/.exec(p);
        if (is) split(is[1], ',').forEach(x => expect(x.trim()).toMatch(/^[a-z][a-z0-9]*$/));
      }));
  });
});

describe('Bootstrap, the parts the documents are built from', () => {
  // [Bootstrap's selector, the phone's] -- the phone drops a class half
  // where partials/print.html already defines it.
  const PAIRS = [
    ['.table', '.table'],
    ['.table>:not(caption)>*>*', '.table > :not(caption) > * > *'],
    ['.table>tbody', '.table > tbody'],
    ['.table>thead', '.table > thead'],
    ['.table-striped>tbody>tr:nth-of-type(odd)>*', '.table-striped > tbody > tr:nth-of-type(odd) > *'],
    ['.table-light', '.table-light'],
    ['.table-responsive', '.table-responsive'],
    ['.collapse:not(.show)', '.collapse:not(.show)'],
    ['.badge:empty', '.badge:empty'],
    ['.d-flex', '.d-flex'],
    ['.shadow-sm', '.shadow-sm'],
    ['.justify-content-between', '.justify-content-between'],
    ['.align-items-center', '.align-items-center'],
    ['.mb-0', '.mb-0'], ['.mb-3', '.mb-3'], ['.ms-2', '.ms-2'], ['.p-4', '.p-4'],
    ['.px-3', '.px-3'], ['.py-2', '.py-2'],
    ['table', 'table'],
    ['th', 'th'],
    ['b,strong', 'b,strong'],
    ['img,svg', 'img,svg'],
    ['p', 'p'],
    ['.small,small', 'small'],
    ['.h6,h6', 'h6'],
    ['tbody,td,tfoot,th,thead,tr', 'thead,tbody,tfoot,tr,td,th'],
    ['.h1,.h2,.h3,.h4,.h5,.h6,h1,h2,h3,h4,h5,h6', 'h1,h2,h3,h4,h5,h6'],
    ['*,::after,::before', '*,::before,::after']
  ];

  test.each(PAIRS)('%s', (bootstrapSel, phoneSel) => {
    const source = B.find(r => r.at === '' && r.selector === normSelector(bootstrapSel));
    expect(source).toBeDefined();
    // As desktop's pages have it: Bootstrap's declarations, except where
    // styles.css -- loaded after it -- has its own rule for the element
    // and sets the same property without losing to an !important.
    const decls = new Map();
    source.decls.forEach((d, prop) => decls.set(prop, { ...d, value: resolve(d.value, B_VARS) }));
    D.filter(r => r.at === '' && r.selector === normSelector(phoneSel))
      .forEach(r => r.decls.forEach((d, prop) => {
        const earlier = decls.get(prop);
        if (!earlier || d.important || !earlier.important) {
          decls.set(prop, { ...d, value: resolve(d.value, D_VARS) });
        }
      }));
    const rule = { selector: normSelector(phoneSel), decls };
    expect(check(rule, {}, '')).toEqual({ selector: rule.selector, missing: [] });
  });

  test('.text-warning is Bootstrap\'s warning yellow', () => {
    const rule = phone('.text-warning', '')[0];
    expect(rule.decls.get('color')).toEqual({ value: '#ffc107', important: true });
  });
});

describe('the page', () => {
  const inPrint = sel => phone(sel, PRINT);
  const pageRule = inPrint('html,body')[0];
  const body = inPrint('body').find(r => r.decls.has('display'));

  test('one continuous flow, not a box the height of the screen', () => {
    // The shell pins html and body to 100% and makes body a flex row from
    // 640px up -- which an A4 page is -- so the document became a flex item
    // one page tall and everything after page 1 printed outside it.
    expect(pageRule.decls.get('height')).toEqual({ value: 'auto', important: true });
    expect(pageRule.decls.get('min-height')).toEqual({ value: '0', important: true });
    expect(body.decls.get('display')).toEqual({ value: 'block', important: true });
  });

  test('white, whatever the phone\'s theme, margins included', () => {
    expect(pageRule.decls.get('background')).toEqual({ value: '#fff', important: true });
    // !important because the dark theme sets it with more weight, and the
    // page margins are painted in the colour scheme's canvas colour.
    expect(pageRule.decls.get('color-scheme')).toEqual({ value: 'light', important: true });
  });

  test('desktop\'s body type, for anything in a document that inherits it', () => {
    expect(body.decls.get('font-family').value).toBe('inter,sans-serif');
    expect(body.decls.get('font-size').value).toBe('14px');
    expect(body.decls.get('line-height').value).toBe('1.5');
    expect(body.decls.get('color').value).toBe(resolve('var(--text-primary)', D_VARS));
  });

  test('rem is desktop\'s 16px, not the phone\'s text-size setting', () => {
    expect(inPrint('html')[0].decls.get('font-size')).toEqual({ value: '16px', important: true });
  });

  test('nothing but the document reaches paper', () => {
    const rule = inPrint('body > *:not(.print-container)')[0];
    expect(rule.decls.get('display')).toEqual({ value: 'none', important: true });
  });

  test('outside the print block, nothing in the print section can reach a screen', () => {
    // Everything after @page that is not in the print block must be
    // confined to print containers, or a bare `th` here would restyle
    // every table the app draws.
    const pageAt = M.findIndex(r => r.selector === '@page');
    const loose = M.filter(r => r.index > pageAt && r.at === '')
      .filter(r => !split(r.selector, ',').every(part =>
        /^(:where\(\.print-container|\.print-container)/.test(part.trim())));
    expect(loose.map(r => r.selector)).toEqual([]);
  });
});

describe('a page desktop prints outside its app', () => {
  test('the wastage popup\'s page keeps its own type and cells', () => {
    ['.print-container .mb-standalone-doc small', '.print-container .mb-standalone-doc strong',
      '.print-container .mb-standalone-doc th', '.print-container .mb-standalone-doc thead']
      .forEach(sel => expect(phone(sel, '').length).toBe(1));
    const economy = phone('.print-container .mb-standalone-doc,.print-container .mb-standalone-doc *', '')[0];
    expect(economy.decls.get('print-color-adjust')).toEqual({ value: 'economy', important: true });
  });
});

describe('MApp.Print sizes and turns pages as App.Print does', () => {
  let AppPrint;

  beforeAll(() => {
    global.App = {};
    // eslint-disable-next-line no-eval
    eval(read('print.js'));
    AppPrint = global.App.Print;
    // eslint-disable-next-line no-eval
    eval(read('api.js').replace(/^const Api = /m, 'global.Api = '));
    // eslint-disable-next-line no-eval
    eval(read('mobile.js').replace(/^const MApp = /m, 'global.MApp = '));
  });

  afterAll(() => { delete global.App; });

  test('the same density tiers', () => {
    expect(MApp.Print.FIT_TIERS).toEqual(AppPrint.FIT_TIERS);
  });

  test('the same point at which a wide document turns landscape', () => {
    expect(MApp.Print.AUTO_LANDSCAPE_COLUMNS).toBe(AppPrint.AUTO_LANDSCAPE_COLUMNS);
    expect(MApp.Print.PAGE_MARGIN_MM).toBe(AppPrint.PAGE_MARGIN_MM);
  });

  test('the same filename rule for the print job\'s title', () => {
    ['PO: 12/14 "Webest"', '  Dispatch Plan - 2026-08-19  ', '', null, 'a'.repeat(200), 'x<y>|z?*']
      .forEach(t => expect(MApp.Print.titleToFilename(t)).toBe(AppPrint.titleToFilename(t)));
  });
});
