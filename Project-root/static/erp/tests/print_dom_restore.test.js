'use strict';
// Covers the DOM borrow-and-restore that every PDF export depends on
// (App.Print._withElementPrepared, used by downloadElementAsPDF and
// renderElementToPdfBlob).
//
// This is the finding PDF-006 singles out. html2canvas rasterises from the
// document origin, so the print container is temporarily moved to the top of
// <body>, the body's own padding/margin/overflow are neutralised, the element
// is laid out at an exact pixel width and the page is scrolled to 0,0. If any
// of that is not put back the user is left staring at a blank or mangled app
// with no error -- and the case that matters most is the one where html2pdf
// throws part-way, because that is when the restore is easiest to lose.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TextEncoder } = require('node:util');
const { Blob } = require('node:buffer');

function loadPrintModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'print.js'), 'utf8');
  const toasts = [];
  const sandbox = {
    App: { Utils: { showToast: (m, e) => toasts.push([m, !!e]) } },
    document, window, console, setTimeout, Blob, TextEncoder, URL, Date,
    requestAnimationFrame: cb => setTimeout(cb, 0),
    loadScript: () => Promise.resolve(),
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { Print: sandbox.App.Print, toasts };
}

let Print;
let toasts;

// A layout the export has to survive: the container sits between two
// siblings, inside a wrapper, on a padded and scrolled page.
beforeEach(() => {
  document.body.innerHTML = `
    <div id="before">preceding content</div>
    <div id="wrapper">
      <div id="sib-before">a</div>
      <div id="print-bulk-container" style="display:none;color:rebeccapurple">
        <div id="print-bulk-body">content</div>
      </div>
      <div id="sib-after">b</div>
    </div>
    <div id="after">trailing content</div>
  `;
  document.body.style.padding = '40px';
  document.body.style.margin = '8px';
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';
  ({ Print, toasts } = loadPrintModule());
  window.scrollTo = jest.fn();
});

// Installs a fake html2pdf whose terminal call (save / outputPdf) runs
// `during(element)` so the mid-export DOM can be inspected, then settles.
function fakeHtml2Pdf({ during = () => {}, fail = null, result = 'ok' } = {}) {
  window.html2pdf = () => {
    let el;
    const worker = {
      set() { return worker; },
      from(e) { el = e; return worker; },
      save() { return finish(); },
      outputPdf() { return finish(); },
    };
    const finish = () => {
      during(el);
      return fail ? Promise.reject(fail) : Promise.resolve(result);
    };
    return worker;
  };
}

const snapshot = () => {
  const el = document.getElementById('print-bulk-container');
  return {
    parentId: el.parentNode.id,
    prevSibId: el.previousElementSibling && el.previousElementSibling.id,
    nextSibId: el.nextElementSibling && el.nextElementSibling.id,
    style: el.getAttribute('style'),
    bodyPadding: document.body.style.padding,
    bodyMargin: document.body.style.margin,
    bodyOverflow: document.body.style.overflow,
    htmlOverflow: document.documentElement.style.overflow,
  };
};

describe('during the export', () => {
  it('moves the element to the top of body so nothing above can clip it', async () => {
    let mid;
    fakeHtml2Pdf({ during: () => { mid = snapshot(); } });
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(mid.parentId).toBe('');           // body has no id
    expect(mid.prevSibId).toBe(null);        // it is the first child
  });

  it('neutralises body padding, margin and overflow while capturing', async () => {
    let mid;
    fakeHtml2Pdf({ during: () => { mid = snapshot(); } });
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(mid.bodyPadding).toBe('0px');
    expect(mid.bodyMargin).toBe('0px');
    expect(mid.bodyOverflow).toBe('visible');
    expect(mid.htmlOverflow).toBe('visible');
  });

  it('lays the element out at the A4 capture width by default', async () => {
    let width;
    fakeHtml2Pdf({ during: el => { width = el.style.width; } });
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(width).toBe(`${Print.PAGE_WIDTH_PX}px`);
    // 198mm at 96dpi, floored. Worth pinning: po.js's deleted duplicate
    // hardcoded 749, so the single-PO export used to capture 1px wider than
    // every other path. Deriving it from PAGE_MARGIN_MM is what removed that.
    expect(Print.PAGE_WIDTH_PX).toBe(748);
  });

  // captureWidthPx is ours, not html2pdf's: a landscape caller lays the
  // element out at the rotated width.
  it('honours captureWidthPx and does not forward it to html2pdf', async () => {
    let width;
    let opts;
    window.html2pdf = () => {
      const worker = {
        set(o) { opts = o; return worker; },
        from(el) { width = el.style.width; return worker; },
        save: () => Promise.resolve(),
      };
      return worker;
    };
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf', {
      captureWidthPx: 1122,
      jsPDF: { orientation: 'landscape' },
    });
    expect(width).toBe('1122px');
    expect(opts.captureWidthPx).toBeUndefined();
    expect(opts.jsPDF).toEqual({ orientation: 'landscape' });
  });

  it('scrolls to the origin before capturing', async () => {
    fakeHtml2Pdf();
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  });
});

describe('after a successful export', () => {
  it('returns the element to its exact original position', async () => {
    const before = snapshot();
    fakeHtml2Pdf();
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    const after = snapshot();
    expect(after.parentId).toBe('wrapper');
    expect(after.prevSibId).toBe('sib-before');
    expect(after.nextSibId).toBe('sib-after');
    expect(after).toEqual(before);
  });

  it('restores the element\'s original style attribute verbatim', async () => {
    fakeHtml2Pdf();
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    const style = document.getElementById('print-bulk-container').getAttribute('style');
    expect(style).toBe('display:none;color:rebeccapurple');
  });

  // Restoring a style attribute that never existed must remove it, not leave
  // an empty style="" behind.
  it('removes the style attribute entirely when there was none', async () => {
    const el = document.getElementById('print-bulk-container');
    el.removeAttribute('style');
    fakeHtml2Pdf();
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(el.hasAttribute('style')).toBe(false);
  });

  it('restores body and documentElement styles', async () => {
    fakeHtml2Pdf();
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(document.body.style.padding).toBe('40px');
    expect(document.body.style.margin).toBe('8px');
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.documentElement.style.overflow).toBe('hidden');
  });

  it('restores the scroll position it started from', async () => {
    window.pageXOffset = 120;
    window.pageYOffset = 640;
    fakeHtml2Pdf();
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(window.scrollTo).toHaveBeenLastCalledWith(120, 640);
  });

  it('puts the element back as the last child when it had no next sibling', async () => {
    const el = document.getElementById('print-bulk-container');
    document.getElementById('sib-after').remove();
    fakeHtml2Pdf();
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(el.parentNode.id).toBe('wrapper');
    expect(el.nextElementSibling).toBe(null);
    expect(el.previousElementSibling.id).toBe('sib-before');
  });
});

// The regression that would leave the app looking broken with no error.
describe('after a failed export', () => {
  it('still restores everything when html2pdf throws', async () => {
    const before = snapshot();
    fakeHtml2Pdf({ fail: new Error('html2canvas exploded') });
    const ok = await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(ok).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it('reports the failure rather than throwing, since callers branch on it', async () => {
    fakeHtml2Pdf({ fail: new Error('html2canvas exploded') });
    const ok = await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(ok).toBe(false);
    expect(toasts).toEqual([['html2canvas exploded', true]]);
  });

  // html2canvas can reject with a DOMException, which carries a message
  // without being an Error -- the message must still reach the user.
  it('surfaces the message of a non-Error rejection', async () => {
    fakeHtml2Pdf({ fail: { name: 'DOMException', message: 'Tainted canvas' } });
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(toasts).toEqual([['Tainted canvas', true]]);
  });

  it('falls back to a generic message when the rejection carries none', async () => {
    fakeHtml2Pdf({ fail: 'just a string' });
    await Print.downloadElementAsPDF('print-bulk-container', 'x.pdf');
    expect(toasts).toEqual([['Failed to export PDF.', true]]);
  });

  it('restores everything when the blob path throws too', async () => {
    const before = snapshot();
    fakeHtml2Pdf({ fail: new Error('boom') });
    const blob = await Print.renderElementToPdfBlob('print-bulk-container', 'x.pdf');
    expect(blob).toBe(null);
    expect(snapshot()).toEqual(before);
  });

  it('returns false and warns for a container that does not exist', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = await Print.downloadElementAsPDF('no-such-container', 'x.pdf');
    expect(ok).toBe(false);
    expect(warn).toHaveBeenCalledWith('[PDF] Print container not found:', 'no-such-container');
    warn.mockRestore();
  });

  it('leaves the DOM untouched when the container does not exist', async () => {
    const before = snapshot();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await Print.downloadElementAsPDF('no-such-container', 'x.pdf');
    expect(snapshot()).toEqual(before);
    console.warn.mockRestore();
  });
});

describe('renderElementToPdfBlob', () => {
  it('returns the blob html2pdf produced', async () => {
    const blob = new Blob(['%PDF-1.7']);
    fakeHtml2Pdf({ result: blob });
    const out = await Print.renderElementToPdfBlob('print-bulk-container', 'x.pdf');
    expect(out).toBe(blob);
  });

  it('asks html2pdf for a blob, not a download', async () => {
    const called = [];
    window.html2pdf = () => {
      const worker = {
        set: () => worker,
        from: () => worker,
        save: () => { called.push('save'); return Promise.resolve(); },
        outputPdf: kind => { called.push(`outputPdf:${kind}`); return Promise.resolve(new Blob(['x'])); },
      };
      return worker;
    };
    await Print.renderElementToPdfBlob('print-bulk-container', 'x.pdf');
    expect(called).toEqual(['outputPdf:blob']);
  });

  it('uses the same page geometry and pagination as the download path', async () => {
    const seen = [];
    window.html2pdf = () => {
      const worker = {
        set(o) { seen.push(o); return worker; },
        from: () => worker,
        save: () => Promise.resolve(),
        outputPdf: () => Promise.resolve(new Blob(['x'])),
      };
      return worker;
    };
    await Print.downloadElementAsPDF('print-bulk-container', 'a.pdf');
    await Print.renderElementToPdfBlob('print-bulk-container', 'a.pdf');
    expect(seen[0]).toEqual(seen[1]);
  });
});
