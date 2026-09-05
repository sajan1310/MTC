/**
 * Documents printed from the phone must carry the company logo (D-02).
 *
 * mobile.js's own header recorded the omission: desktop's App.Print tracks
 * a companyLogo and runs injectLogo() on every print job, and MApp's port
 * "deliberately doesn't replicate" it. The consequence is customer-facing:
 * a challan printed on the shop floor and the same challan printed from the
 * office were different documents, and the phone produced the unbranded one.
 *
 * The logo is loaded through callCached rather than call, because printing
 * a challan is a shop-floor action on an unreliable factory LAN -- it has to
 * survive the same outage the rest of the offline story does.
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

const LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

describe('MApp.Print logo injection', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    // jsdom has no window.print.
    window.print = jest.fn();

    // .print-brand-text is the hook desktop's injectLogo targets, and the
    // mobile page includes the very same print.html partial.
    document.body.innerHTML = `
      <div class="print-container" id="print-dispatch-container">
        <div class="print-brand-text">Maharaja Bikes</div>
      </div>
      <div class="print-container" id="print-bill-container">
        <div class="print-brand-text">Maharaja Bikes</div>
      </div>`;

    loadAsGlobal('api.js', 'Api');
    loadAsGlobal('mobile.js', 'MApp');
    MApp.Print.companyLogo = null;
  });

  test('injects the logo into every brand slot, not just the first', () => {
    MApp.Print.companyLogo = LOGO;

    MApp.Print.injectLogo();

    const slots = document.querySelectorAll('.print-brand-text');
    expect(slots).toHaveLength(2);
    slots.forEach(el => {
      const img = el.querySelector('img');
      expect(img).not.toBeNull();
      expect(img.getAttribute('src')).toBe(LOGO);
      // Browsers drop background colours from printed output unless this
      // is set; the logo would otherwise print blank on some engines.
      expect(img.getAttribute('style')).toContain('print-color-adjust:exact');
    });
  });

  test('falls back to the brand name when no logo is configured', () => {
    MApp.Print.companyLogo = null;

    MApp.Print.injectLogo();

    document.querySelectorAll('.print-brand-text').forEach(el => {
      expect(el.querySelector('img')).toBeNull();
      expect(el.textContent).toBe('Maharaja Bikes');
    });
  });

  test('re-injecting replaces the previous logo rather than appending', () => {
    MApp.Print.companyLogo = LOGO;
    MApp.Print.injectLogo();
    MApp.Print.injectLogo();

    expect(document.querySelectorAll('.print-brand-text img')).toHaveLength(2);
  });

  test('printing a document injects the logo first', () => {
    // The bug was not a missing injectLogo() -- it was trigger() never
    // calling one. This is the assertion that actually pins D-02.
    MApp.Print.companyLogo = LOGO;

    MApp.Print.trigger('print-dispatch-container', 'Challan 1042');

    expect(document.querySelector('#print-dispatch-container img')).not.toBeNull();
    expect(window.print).toHaveBeenCalled();
  });

  test('the printed container is the only one revealed', () => {
    MApp.Print.trigger('print-bill-container', 'Bill B-1042');

    expect(document.getElementById('print-bill-container').style.display).toBe('block');
    expect(document.getElementById('print-dispatch-container').style.display).toBe('none');
  });

  test('the logo loads through the offline cache, so it survives a LAN outage', async () => {
    const cached = jest.spyOn(MApp.Api, 'callCached').mockResolvedValue({ success: true, data: LOGO });

    await MApp.Print.loadLogo();

    expect(cached).toHaveBeenCalledWith('getLogo');
    expect(MApp.Print.companyLogo).toBe(LOGO);
    // Loading also paints the slots, so a print triggered later in the
    // session does not depend on trigger() being the first to inject.
    expect(document.querySelector('.print-brand-text img')).not.toBeNull();
    cached.mockRestore();
  });

  test('a logo that cannot be fetched leaves the text fallback intact', async () => {
    const cached = jest.spyOn(MApp.Api, 'callCached').mockRejectedValue(new Error('offline'));

    await expect(MApp.Print.loadLogo()).resolves.toBeUndefined();

    expect(MApp.Print.companyLogo).toBeNull();
    cached.mockRestore();
  });
});
