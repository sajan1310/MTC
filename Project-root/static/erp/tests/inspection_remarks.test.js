/**
 * A remark on each item of the desktop inspection checklist (asked
 * 2026-11-17: "add remarks column for inspector for each item to review
 * modifications").
 *
 * A Remarks column holds a box per item while the lot is open; it saves
 * (setInspectionItemRemark) when it loses focus with something new in it,
 * and what was typed survives the row being redrawn by a tick. A cleared
 * lot shows its remarks as text, and the column only when there is one. The
 * dialog before clearing shows each item's remark, and item remarks are
 * enough to tick Needs admin review.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let mutations;

function load() {
  eval([
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatQty = formatQty;'
  ].join('\n'));
  eval(fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8').replace(/^const App = /m, 'global.App = '));
  eval(fs.readFileSync(path.join(__dirname, '..', 'inspection.js'), 'utf8'));
}

const PAYLOAD = '<img src=x onerror="window.__xss=1">';
const REMARK = { text: 'Spokes here are 13G', byName: 'Alex Doe', at: '2026-11-17T10:05:00+05:30' };

const item = (key, itemName, extra = {}) => ({
  key, itemName, size: '26in', color: '', narration: '', qty: 50, unit: 'Pcs', fingerprint: `fp-${key}`,
  state: 'pending', result: null, previous: null, photoUrl: '', canSetPhoto: false, stock: null, remark: null, ...extra
});

function detail(items, inspection = {}) {
  return {
    lot: { rowIdx: 7, lotNumber: 'LOT-WHL001-0042', processName: 'Wheel Building', outputItemName: '26in Wheel',
      productName: '', status: 'In Progress', date: '17/11/2026', qty: 60, colors: [] },
    inspection: { status: 'in_progress', stage: 'not_started', remarks: '', ...inspection },
    items: items.map(i => ({ ...i })),
    removed: [],
    summary: { total: items.length, checked: 0, remarked: items.filter(i => i.remark).length, complete: false },
    inspector: { name: 'Store Keeper', roleLabel: 'Storekeeper' },
    canAcknowledge: true,
    canReturn: false
  };
}

async function open(items, { inspection, reply } = {}) {
  document.body.innerHTML = `
    <div id="inspectionDetailModal" class="modal show">
      <h5 id="inspectionDetailTitle"></h5>
      <div id="inspectionDetailBody"></div>
      <div id="inspectionDetailFooterActions"></div>
    </div>
    <div id="sr-announcer"></div>`;
  mutations = [];
  global.Api = {
    callFresh: () => Promise.resolve({ success: true, data: detail(items, inspection) }),
    mutate: (...args) => {
      mutations.push(args);
      return Promise.resolve(reply ? reply(...args) : { success: true, data: {} });
    }
  };
  App.Utils.showToast = jest.fn();
  // The handlers are bound once per page; each test mounts a fresh body.
  App.Inspection._bound = false;
  App.Inspection._draftsFor = null;
  await App.Inspection.openDetail(7);
}

beforeAll(load);

const rowOf = key => [...document.querySelectorAll('#inspectionDetailBody [data-insp-row]')]
  .find(r => r.dataset.inspRow === key);
const headers = () => [...document.querySelectorAll('#inspectionDetailBody thead th')].map(th => th.textContent);
const box = key => rowOf(key).querySelector('[data-insp-remark]');
const text = el => el.textContent.replace(/\s+/g, ' ').trim();
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function type(el, value) {
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

const leave = el => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

const saved = (remark, remarked = 1) => ({
  success: true,
  message: remark ? 'Remark saved.' : 'Remark removed.',
  data: { key: 'spoke', remark, summary: { total: 2, checked: 0, remarked, complete: false }, stage: 'not_started' }
});

describe('the Remarks column', () => {
  test('a box on every row of an open lot, holding the saved remark and who wrote it', async () => {
    await open([item('spoke', 'Spoke 12G', { remark: REMARK }), item('tape', 'Rim Tape')]);
    expect(headers()).toEqual(['Ticked', 'Item', 'Size', 'Colour', 'Specification', 'Qty', 'Remarks']);
    expect(box('spoke').value).toBe('Spokes here are 13G');
    expect(text(rowOf('spoke').querySelector('.insp-remark-by'))).toContain('Alex Doe');
    expect(box('tape').value).toBe('');
    expect(box('tape').getAttribute('aria-label')).toBe('Remark on Rim Tape');
    expect(document.getElementById('inspectionProgress').textContent).toContain('1 with a remark');
  });

  test('leaving a box with something new in it saves that remark, once', async () => {
    await open([item('spoke', 'Spoke 12G'), item('tape', 'Rim Tape')],
      { reply: () => saved({ ...REMARK, text: 'Should be 45' }) });
    type(box('spoke'), 'Should be 45');
    leave(box('spoke'));
    await flush();
    expect(mutations).toEqual([['setInspectionItemRemark', 7, 'spoke', 'Should be 45']]);
    expect(App.Utils.showToast).toHaveBeenCalledWith('Remark saved.');
    expect(text(rowOf('spoke').querySelector('.insp-remark-by'))).toContain('Alex Doe');
    expect(document.getElementById('inspectionProgress').textContent).toContain('1 with a remark');

    leave(box('spoke')); // nothing new since
    leave(box('tape')); // nothing written
    await flush();
    expect(mutations).toHaveLength(1);
  });

  test('emptying a box takes the remark off', async () => {
    await open([item('spoke', 'Spoke 12G', { remark: REMARK })], { reply: () => saved(null, 0) });
    type(box('spoke'), '');
    leave(box('spoke'));
    await flush();
    expect(mutations).toEqual([['setInspectionItemRemark', 7, 'spoke', '']]);
    expect(App.Utils.showToast).toHaveBeenCalledWith('Remark removed.');
  });

  test('a refused save keeps the text in its box', async () => {
    await open([item('spoke', 'Spoke 12G')],
      { reply: () => ({ success: false, message: 'That item is no longer on this lot\'s Production Sheet.' }) });
    type(box('spoke'), 'Bent');
    leave(box('spoke'));
    await flush();
    expect(App.Utils.showToast).toHaveBeenCalledWith('That item is no longer on this lot\'s Production Sheet.', true);
    App.Inspection._repaintRow(App.Inspection._current.items[0]);
    expect(box('spoke').value).toBe('Bent');
  });

  test('what is being typed survives a tick redrawing the row, with its focus', async () => {
    await open([item('spoke', 'Spoke 12G')], {
      reply: method => (method === 'setInspectionCheck'
        ? { success: true, data: { item: { state: 'checked', result: 'pass' }, summary: { total: 1, checked: 1, complete: true } } }
        : saved({ ...REMARK, text: 'Two bent' }))
    });
    type(box('spoke'), 'Two bent');
    await App.Inspection.toggle('spoke');
    expect(rowOf('spoke').classList.contains('table-success')).toBe(true);
    expect(box('spoke').value).toBe('Two bent');
    expect(document.activeElement).toBe(box('spoke'));
    expect(mutations.map(m => m[0])).toEqual(['setInspectionCheck']); // the redraw saved nothing

    leave(box('spoke'));
    await flush();
    expect(mutations[1]).toEqual(['setInspectionItemRemark', 7, 'spoke', 'Two bent']);
  });

  test('a remark is text, never markup', async () => {
    await open([item('spoke', 'Spoke 12G', { remark: { ...REMARK, text: PAYLOAD, byName: PAYLOAD } })]);
    expect(box('spoke').value).toBe(PAYLOAD);
    expect(document.querySelector('#inspectionDetailBody img')).toBeNull();
  });
});

describe('a cleared lot', () => {
  const cleared = { status: 'cleared', stage: 'cleared', clearedByName: 'Admin User', clearedByRole: 'Admin', clearedAt: '' };

  test('shows its remarks as text', async () => {
    await open([item('spoke', 'Spoke 12G', { remark: REMARK }), item('tape', 'Rim Tape')], { inspection: cleared });
    expect(headers()).toContain('Remarks');
    expect(document.querySelector('[data-insp-remark]')).toBeNull();
    expect(text(rowOf('spoke').querySelector('.insp-remark-cell'))).toContain('Spokes here are 13G');
  });

  test('has no Remarks column when nobody wrote one', async () => {
    await open([item('spoke', 'Spoke 12G')], { inspection: cleared });
    expect(headers()).not.toContain('Remarks');
  });
});

describe('review and clearing', () => {
  test('item remarks are enough to tick Needs admin review', async () => {
    await open([item('spoke', 'Spoke 12G', { remark: REMARK })], {
      reply: () => ({ success: true, message: 'Saved.', data: { status: 'flagged', remarks: '', stage: 'needs_review', flaggedByName: 'Store Keeper' } })
    });
    document.getElementById('inspectionNeedsReview').click();
    await flush();
    expect(mutations).toEqual([['setInspectionReview', 7, true, '']]);
  });

  test('the dialog before clearing shows each item\'s remark', async () => {
    await open([item('spoke', 'Spoke 12G', { remark: REMARK })], {
      reply: () => ({
        success: true,
        data: {
          cleared: false, token: 't1', changedAgain: false, canAcknowledge: true,
          discrepancies: [
            { kind: 'unchecked', itemName: 'Spoke 12G', size: '26in', color: '', unit: 'Pcs', qty: 50, remark: 'Spokes here are 13G' },
            { kind: 'unchecked', itemName: 'Nipple', size: '', color: '', unit: 'Pcs', qty: 120 }
          ]
        }
      })
    });
    await App.Inspection.submit();
    const lines = [...document.querySelectorAll('#inspectionDetailBody li')].map(text);
    expect(lines[0]).toContain('Remark: Spokes here are 13G');
    expect(lines[1]).not.toContain('Remark');
  });
});
