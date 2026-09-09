/**
 * Download PDF and Share, from the phone.
 *
 * window.print() cannot hand back a file, so MApp could print a challan
 * and had no way to keep one or send one. Desktop has had Download since
 * the server renderer landed; POST /erp/render-pdf takes the same
 * print-container markup this shell already builds, so the whole gap was
 * a caller.
 *
 * Share is new to the product rather than ported, and it is the one of
 * the three that only makes sense here: a challan into WhatsApp is what
 * the office asks the floor for, and the alternative is a photo of a
 * screen.
 *
 * Most of what is pinned below is the failure taxonomy. "Could not reach
 * the renderer" covers four different situations that need four
 * different answers, and getting that wrong sends someone to check which
 * virtualenv the server is running from.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadAsGlobal(relPath, exportName) {
  const code = fs
    .readFileSync(path.join(__dirname, '..', relPath), 'utf8')
    .replace(new RegExp(`^const ${exportName} = `, 'm'), `global.${exportName} = `);
  // eslint-disable-next-line no-eval
  eval(code);
}

function mount() {
  jest.resetModules();
  document.head.innerHTML = '<meta name="csrf-token" content="tok-123">';
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="print-container" id="print-doc-container"><p>DOC BODY</p></div>
    <div class="mb-sheet" id="mapp-picker-sheet">
      <h2 id="mapp-picker-title"></h2>
      <div id="mapp-picker-search-wrap"><input id="mapp-picker-search"></div>
      <div id="mapp-picker-list"></div>
    </div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  global.fetch = jest.fn();
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Print.serverPdfAvailable = null;
  MApp.Print.lastPdfError = null;
  Element.prototype.scrollIntoView = jest.fn();
  window.print = jest.fn();

  // One navigator is shared across every test in a file, so a
  // share-enabling test leaks into the one asserting Share is hidden.
  navigator.share = undefined;
  navigator.canShare = undefined;

  // jsdom has no object URLs and no anchor downloads.
  global.URL.createObjectURL = jest.fn(() => 'blob:fake');
  global.URL.revokeObjectURL = jest.fn();
}

const pdfOk = () => ({ ok: true, status: 200, blob: async () => new Blob(['%PDF'], { type: 'application/pdf' }) });
const status = n => ({ ok: false, status: n, blob: async () => new Blob([]) });

const options = () => [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
  .map(b => b.textContent.trim());
const pick = label => [...document.querySelectorAll('#mapp-picker-list .mb-picker-option')]
  .find(b => b.textContent.trim().startsWith(label)).click();

describe('rendering the PDF', () => {
  beforeEach(mount);

  test('posts the container markup, with the CSRF token', async () => {
    // Not an RPC: /api/erp/rpc is a JSON envelope bridge and this returns
    // binary. CSRFProtect is global, so the token still has to ride along.
    global.fetch = jest.fn(async () => pdfOk());

    await MApp.Print.download('print-doc-container', 'Doc');

    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('/erp/render-pdf');
    expect(init.method).toBe('POST');
    expect(init.headers['X-CSRFToken']).toBe('tok-123');
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body).html).toContain('DOC BODY');
  });

  test('the filename gains .pdf, and only once', async () => {
    global.fetch = jest.fn(async () => pdfOk());

    await MApp.Print.download('print-doc-container', 'Challan_1041');
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).filename).toBe('Challan_1041.pdf');

    await MApp.Print.download('print-doc-container', 'Challan_1041.pdf');
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).filename).toBe('Challan_1041.pdf');
  });

  test('landscape is passed through when asked for', async () => {
    global.fetch = jest.fn(async () => pdfOk());

    await MApp.Print.download('print-doc-container', 'Doc', { landscape: true });

    expect(JSON.parse(global.fetch.mock.calls[0][1].body).landscape).toBe(true);
  });

  test('a missing container sends nothing rather than an empty document', async () => {
    global.fetch = jest.fn(async () => pdfOk());

    const ok = await MApp.Print.download('no-such-container', 'Doc');

    expect(ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a successful download hands the blob over under its filename', async () => {
    global.fetch = jest.fn(async () => pdfOk());

    const ok = await MApp.Print.download('print-doc-container', 'Doc');

    expect(ok).toBe(true);
    expect(global.URL.createObjectURL).toHaveBeenCalled();
  });
});

describe('when the server cannot render', () => {
  beforeEach(mount);

  // Which of these happened decides what the operator is told. They are
  // four different problems with four different fixes.
  const cases = [
    ['offline', () => { throw new TypeError('network'); }, 'No connection'],
    ['no-renderer', () => status(503), 'no PDF renderer installed'],
    ['no-endpoint', () => status(404), 'older build'],
    ['rejected', () => status(403), 'session expired'],
    ['failed', () => status(500), 'could not render'],
  ];

  test.each(cases)('%s is reported in its own words', async (_name, respond, phrase) => {
    global.fetch = jest.fn(async () => respond());
    const spy = jest.spyOn(MApp.Toast, 'error');

    const ok = await MApp.Print.download('print-doc-container', 'Doc');

    expect(ok).toBe(false);
    expect(spy.mock.calls[0][0]).toContain(phrase);
    spy.mockRestore();
  });

  test('a download never silently becomes a print dialog', async () => {
    // The earlier desktop behaviour, and it was wrong: the user asked for
    // a file. A print dialog is a different task with a different
    // outcome, arriving without warning.
    global.fetch = jest.fn(async () => status(503));

    await MApp.Print.download('print-doc-container', 'Doc');

    expect(window.print).not.toHaveBeenCalled();
  });

  test('once the server proves it cannot render, the session stops asking', async () => {
    // Every subsequent download would otherwise pay a full round trip to
    // be told the same thing.
    global.fetch = jest.fn(async () => status(503));
    await MApp.Print.download('print-doc-container', 'Doc');
    await MApp.Print.download('print-doc-container', 'Doc');

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a rejected request does NOT stop the session asking', async () => {
    // A stale CSRF token or an expired session is fixed by reloading, so
    // the next attempt is worth making.
    global.fetch = jest.fn(async () => status(403));
    await MApp.Print.download('print-doc-container', 'Doc');
    await MApp.Print.download('print-doc-container', 'Doc');

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('sharing', () => {
  beforeEach(mount);

  const enableShare = () => {
    navigator.canShare = jest.fn(() => true);
    navigator.share = jest.fn(async () => undefined);
  };

  test('is offered only where the phone can actually share a file', () => {
    // navigator.share exists on browsers that cannot take files at all --
    // desktop Chrome among them. A button that opens nothing is worse
    // than a button that is not there.
    expect(MApp.Print.canShareFiles()).toBe(false);

    enableShare();
    expect(MApp.Print.canShareFiles()).toBe(true);
  });

  test('canShare is asked about a real File, not just about sharing', () => {
    navigator.canShare = jest.fn(() => true);
    navigator.share = jest.fn();

    MApp.Print.canShareFiles();

    expect(navigator.canShare.mock.calls[0][0].files[0]).toBeInstanceOf(File);
  });

  test('shares the rendered PDF as a file', async () => {
    enableShare();
    global.fetch = jest.fn(async () => pdfOk());

    const ok = await MApp.Print.share('print-doc-container', 'Challan_1041');

    expect(ok).toBe(true);
    const shared = navigator.share.mock.calls[0][0];
    expect(shared.files[0].name).toBe('Challan_1041.pdf');
    expect(shared.files[0].type).toBe('application/pdf');
  });

  test('dismissing the share sheet is not an error', async () => {
    // It is the most common outcome of opening one, and reporting it as a
    // failure would train people to distrust the toast.
    enableShare();
    navigator.share = jest.fn(async () => {
      const err = new Error('cancelled');
      err.name = 'AbortError';
      throw err;
    });
    global.fetch = jest.fn(async () => pdfOk());
    const spy = jest.spyOn(MApp.Toast, 'error');

    const ok = await MApp.Print.share('print-doc-container', 'Doc');

    expect(ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('a real share failure says so', async () => {
    enableShare();
    navigator.share = jest.fn(async () => { throw new Error('nope'); });
    global.fetch = jest.fn(async () => pdfOk());
    const spy = jest.spyOn(MApp.Toast, 'error');

    await MApp.Print.share('print-doc-container', 'Doc');

    expect(spy.mock.calls[0][0]).toContain('can still be downloaded');
    spy.mockRestore();
  });

  test('a share never runs if the PDF did not render', async () => {
    enableShare();
    global.fetch = jest.fn(async () => status(503));

    await MApp.Print.share('print-doc-container', 'Doc');

    expect(navigator.share).not.toHaveBeenCalled();
  });
});

describe('the chooser', () => {
  beforeEach(mount);

  test('offers Print and Download, and hides Share where it cannot work', async () => {
    MApp.Print.chooseAction({ containerId: 'print-doc-container', filename: 'Doc' });
    await Promise.resolve();

    expect(options()).toHaveLength(2);
    expect(options()[0]).toContain('Print');
    expect(options()[1]).toContain('Download PDF');
  });

  test('offers all three where the phone can share', async () => {
    navigator.canShare = jest.fn(() => true);
    navigator.share = jest.fn(async () => undefined);

    MApp.Print.chooseAction({ containerId: 'print-doc-container', filename: 'Doc' });
    await Promise.resolve();

    expect(options()).toHaveLength(3);
    expect(options()[2]).toContain('Share');
  });

  test('populates the container before acting, so all three are one document', async () => {
    // The Print path always populated; Download and Share have to run the
    // same fill or they would describe a different record.
    const populate = jest.fn();
    global.fetch = jest.fn(async () => pdfOk());

    const done = MApp.Print.chooseAction({
      containerId: 'print-doc-container', filename: 'Doc', populate,
    });
    await Promise.resolve();
    pick('Download PDF');
    await done;

    expect(populate).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalled();
  });

  test('choosing Print prints', async () => {
    const done = MApp.Print.chooseAction({ containerId: 'print-doc-container', filename: 'Doc' });
    await Promise.resolve();
    pick('Print');
    await done;

    expect(window.print).toHaveBeenCalled();
  });

  test('dismissing the chooser does nothing at all', async () => {
    const populate = jest.fn();
    global.fetch = jest.fn(async () => pdfOk());

    const done = MApp.Print.chooseAction({
      containerId: 'print-doc-container', filename: 'Doc', populate,
    });
    await Promise.resolve();
    MApp.Picker.cancel();
    await done;

    expect(populate).not.toHaveBeenCalled();
    expect(window.print).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('every printable document offers all three', () => {
  const MOBILE_JS = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');

  test('no screen prints without also offering to download', () => {
    // A document reachable by Print but not by Download is the gap this
    // whole change closes. Every caller now goes through chooseAction,
    // which is the only thing left that prints -- so a new screen wiring
    // Print straight to trigger() reopens the gap and fails here.
    const direct = MOBILE_JS.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /MApp\.Print\.trigger\(/.test(line) && !line.startsWith('//'));

    expect(direct).toEqual([]);
    // ...and the chooser is where printing actually happens.
    expect(MOBILE_JS).toContain('this.trigger(containerId, filename)');
  });

  test('all four documents go through the chooser', () => {
    ['print-po-container', 'print-bill-container',
      'print-dispatch-container', 'print-contractor-ledger-container']
      .forEach(id => {
        const at = MOBILE_JS.indexOf(`containerId: '${id}'`);
        expect(at).toBeGreaterThan(-1);
      });
  });
});
