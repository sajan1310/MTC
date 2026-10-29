/**
 * The PO Ledger's Status dropdown, and what each item still has pending.
 *
 * A PO's status comes from its bills, and nothing could close one by hand:
 * a vendor who short-supplied left the PO at Partially Received for good,
 * and an order called off could only be deleted. Its balance kept counting
 * as pending everywhere. Now the Status cell is a dropdown -- Completed for
 * a partly received PO whose rest is never coming, Cancelled for one not
 * fully received, Reopen for one set by hand -- and every row says, item
 * by item, how much is still to come (asked for 2026-10-29).
 *
 * Run against the real po.js, api.js and po_ledger.html; the server's
 * answers are stubbed at Api.mutate.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const PARTIAL = f => fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', f), 'utf8');

const line = o => ({ narration: '', unit: 'Pcs', price: 50, shortQty: 0, ...o });

// As getPOData returns them.
const POS = [
  { poNumber: '1308', poDate: '27/10/2026', vendor: 'Brahma paints', status: 'PO Issued',
    statusFromBills: 'PO Issued', closedAs: '', closedAt: '', closedBy: '', closeNote: '',
    totalQty: 400, grandTotal: 47200,
    items: [line({ name: 'THINNER-E-400', size: 'GENERAL', qty: 400, receivedQty: 0, pendingQty: 400 })] },
  { poNumber: '1307', poDate: '24/10/2026', vendor: 'Gurpreet industries', status: 'Completed',
    statusFromBills: 'Completed', closedAs: '', closedAt: '', closedBy: '', closeNote: '',
    totalQty: 1500, grandTotal: 65000,
    items: [line({ name: 'RIM---BLACK', size: '14 inch', qty: 500, receivedQty: 500, pendingQty: 0 }),
      line({ name: 'RIM---BLACK', size: '16 inch', qty: 1000, receivedQty: 1000, pendingQty: 0 })] },
  { poNumber: '1306', poDate: '24/10/2026', vendor: 'Mahadev industries', status: 'Partially Received',
    statusFromBills: 'Partially Received', closedAs: '', closedAt: '', closedBy: '', closeNote: '',
    totalQty: 2000, grandTotal: 85000,
    items: [line({ name: 'RIM---BLACK', size: '14 inch', qty: 1000, receivedQty: 600, pendingQty: 400 }),
      line({ name: 'RIM---BLACK', size: '16 inch', qty: 1000, receivedQty: 1000, pendingQty: 0 })] },
  { poNumber: '1290', poDate: '02/10/2026', vendor: 'Sunder polyfab', status: 'Completed',
    statusFromBills: 'Partially Received', closedAs: 'Completed', closedAt: '28/10/2026',
    closedBy: 'Karanbeer Singh', closeNote: 'Vendor will not send the rest',
    totalQty: 300, grandTotal: 9000,
    items: [line({ name: 'BASKET---RED', size: 'GENERAL', qty: 300, receivedQty: 250, pendingQty: 0, shortQty: 50 })] },
  { poNumber: '1280', poDate: '01/10/2026', vendor: 'Brahma paints', status: 'Cancelled',
    statusFromBills: 'PO Issued', closedAs: 'Cancelled', closedAt: '20/10/2026',
    closedBy: 'Karanbeer Singh', closeNote: '',
    totalQty: 100, grandTotal: 1000,
    items: [line({ name: 'PRIMER', size: '5 L', qty: 100, receivedQty: 0, pendingQty: 0, shortQty: 100 })] }
];

let calls;
let answer;
let toasts;
let confirms;

beforeAll(() => {
  document.body.innerHTML = PARTIAL('po_ledger.html');
  eval([
    read('api.js').replace(/^const Api = /m, 'global.Api = '),
    'global.escapeHtml = escapeHtml;',
    'global.toNumber = toNumber;',
    'global.formatCurrency = formatCurrency;',
    'global.formatQty = formatQty;',
    'global.formatItemsPreview = formatItemsPreview;',
    'global.PO_STATUS = PO_STATUS;',
    'global.poStatusChoices = poStatusChoices;',
    'global.parseRecordDate = parseRecordDate;',
    'global.inDateRange = inDateRange;',
    'global.normalizeDateForInput = normalizeDateForInput;',
    'global.todayIso = todayIso;'
  ].join('\n'));
  eval(read('print-templates.js').replace(/^const PrintTemplates = /m, 'global.PrintTemplates = '));
  eval([
    read('core.js').replace(/^const App = /m, 'global.App = '),
    'global.$ = $;',
    'global.$$ = $$;',
    'global.safeModalShow = safeModalShow;',
    'global.safeModalHide = safeModalHide;',
    'global.setDisabled = setDisabled;'
  ].join('\n'));
  eval(read('po.js'));
});

beforeEach(() => {
  App.State.globalPOs = POS.map(po => JSON.parse(JSON.stringify(po)));
  App.State.filteredPOs = [...App.State.globalPOs];
  App.State.selectedPOs = [];
  App.State.poCurrentPage = 1;
  App.State.poRowsPerPage = 15;
  App.PO.renderTable();
  App.PO.updateStatusBar();
  document.getElementById('pendingPOsModal').classList.remove('show');

  calls = [];
  answer = null;
  Api.mutate = jest.fn(async (method, ...args) => {
    calls.push([method, ...args]);
    return answer(method, args);
  });
  toasts = [];
  App.Utils.showToast = (msg, isError) => toasts.push({ msg, isError: !!isError });
  confirms = [];
  App.Utils.confirmAction = (msg, cb) => { confirms.push(msg); return cb(); };
});

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const rowOf = poNumber => document.querySelector(`#poTableBody tr[data-po-key="${poNumber}"]`);
const cells = poNumber => rowOf(poNumber).querySelectorAll('td');
const selectOf = poNumber => rowOf(poNumber).querySelector('select.po-status-select');
const optionsOf = sel => [...sel.options].map(o => o.textContent);
const text = el => el.textContent.replace(/\s+/g, ' ').trim();
const count = id => document.getElementById(id).textContent;

// The user picks an option; the select's own onchange does the rest.
function choose(sel, value) {
  sel.value = value;
  sel.dispatchEvent(new Event('change'));
}

// The server's PO after a change, as closePO / reopenPO return it.
function serverPo(poNumber, changes) {
  const po = JSON.parse(JSON.stringify(POS.find(p => p.poNumber === poNumber)));
  return { ...po, ...changes };
}

describe('every row says what each item still has pending', () => {
  test('a partly received PO, item by item, in the line\'s own unit', () => {
    const items = [...cells('1306')[4].querySelectorAll('div')].map(text);
    expect(items).toEqual([
      'RIM---BLACK [14 inch] (1000 Pcs) · 400 Pcs pending',
      'RIM---BLACK [16 inch] (1000 Pcs) · received'
    ]);
    expect(text(cells('1306')[5])).toBe('2000400 pending');
  });

  test('a PO with nothing received yet is pending in full', () => {
    expect(text(cells('1308')[4])).toBe('THINNER-E-400 [GENERAL] (400 Pcs) · 400 Pcs pending');
  });

  test('a fully received PO adds nothing', () => {
    expect(text(cells('1307')[4]))
      .toBe('RIM---BLACK [14 inch] (500 Pcs)RIM---BLACK [16 inch] (1000 Pcs)');
    expect(text(cells('1307')[5])).toBe('1500');
  });

  test('a PO set by hand names what never came, not what is pending', () => {
    expect(text(cells('1290')[4])).toBe('BASKET---RED [GENERAL] (300 Pcs) · 50 Pcs short');
    expect(text(cells('1290')[5])).toBe('30050 short');
    expect(text(cells('1280')[4])).toBe('PRIMER [5 L] (100 Pcs) · 100 Pcs cancelled');
  });

  test('a line billed past its order says by how much', () => {
    App.State.globalPOs[2].items[1].pendingQty = -20;
    App.PO.renderTable();
    expect(text(cells('1306')[4].querySelectorAll('div')[1]))
      .toBe('RIM---BLACK [16 inch] (1000 Pcs) · 20 Pcs extra');
  });

  test('a name with markup in it is shown, never run', () => {
    App.State.globalPOs[0].items[0].name = '<img src=x onerror=alert(1)>';
    App.PO.renderTable();
    expect(cells('1308')[4].querySelector('img')).toBeNull();
    expect(text(cells('1308')[4])).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('the Status dropdown offers what may be set by hand', () => {
  test('Partially Received: Completed or Cancelled', () => {
    expect(optionsOf(selectOf('1306'))).toEqual(['Partially Received', 'Completed', 'Cancelled']);
    expect(selectOf('1306').value).toBe('Partially Received');
  });

  test('PO Issued: Cancelled only -- nothing has come, so nothing can complete', () => {
    expect(optionsOf(selectOf('1308'))).toEqual(['PO Issued', 'Cancelled']);
  });

  test('received in full: no dropdown, the plain badge', () => {
    expect(selectOf('1307')).toBeNull();
    expect(text(cells('1307')[7])).toBe('Completed');
  });

  test('set by hand: Reopen, back to what the bills say, and who set it', () => {
    expect(optionsOf(selectOf('1290'))).toEqual(['Completed', 'Reopen (Partially Received)']);
    expect(text(cells('1290')[7])).toContain('Marked complete by Karanbeer Singh, 28/10/2026');
    expect(text(cells('1290')[7])).toContain('“Vendor will not send the rest”');

    expect(optionsOf(selectOf('1280'))).toEqual(['Cancelled', 'Reopen (PO Issued)']);
    expect(text(cells('1280')[7])).toContain('Cancelled by Karanbeer Singh, 20/10/2026');
  });

  test('the status bar counts Cancelled, and Pending Orders leaves out both set by hand', () => {
    expect(count('poStatusCountAll')).toBe('5');
    expect(count('poStatusCountIssued')).toBe('1');
    expect(count('poStatusCountPartial')).toBe('1');
    expect(count('poStatusCountCompleted')).toBe('2');
    expect(count('poStatusCountCancelled')).toBe('1');
    expect(count('poStatusCountPending')).toBe('2');
  });

  test('the Cancelled tile filters to cancelled POs', () => {
    App.PO.filterByStatus('Cancelled');
    expect([...document.querySelectorAll('#poTableBody tr')].map(tr => tr.dataset.poKey)).toEqual(['1280']);
    App.PO.filterByStatus('all');
  });
});

describe('Completed, from a Partially Received PO', () => {
  test('asks first, listing only what stops being pending, and changes nothing yet', () => {
    choose(selectOf('1306'), 'Completed');

    expect(selectOf('1306').value).toBe('Partially Received');
    expect(calls).toEqual([]);
    expect(document.getElementById('poCloseTitle').textContent).toBe('Mark PO-1306 complete');
    expect(text(document.getElementById('poCloseIntro')))
      .toBe('Mahadev industries has sent part of PO-1306. Mark it complete if the rest is not coming.');
    const rows = [...document.querySelectorAll('#poCloseLines tr')].map(tr => [...tr.cells].map(text));
    expect(rows).toEqual([['RIM---BLACK (14 inch)', '1000 Pcs', '600 Pcs', '400 Pcs']]);
    const confirmBtn = document.getElementById('poCloseConfirmBtn');
    expect(confirmBtn.textContent).toBe('Mark complete');
    expect(confirmBtn.classList.contains('btn-success')).toBe(true);
  });

  test('confirming sends the reason, and the row and counts follow the server', async () => {
    answer = () => ({
      success: true,
      message: 'PO #1306 marked complete. No longer pending: 400 Pcs RIM---BLACK [14 inch].',
      data: { poNumber: '1306', po: serverPo('1306', {
        status: 'Completed', closedAs: 'Completed', closedBy: 'Karanbeer Singh', closedAt: '29/10/2026',
        closeNote: 'Short supplied',
        items: [line({ name: 'RIM---BLACK', size: '14 inch', qty: 1000, receivedQty: 600, pendingQty: 0, shortQty: 400 }),
          line({ name: 'RIM---BLACK', size: '16 inch', qty: 1000, receivedQty: 1000, pendingQty: 0 })]
      }) }
    });
    choose(selectOf('1306'), 'Completed');
    document.getElementById('poCloseNote').value = '  Short supplied ';
    await App.PO.confirmClose();

    expect(calls).toEqual([['closePO', '1306', 'Completed', 'Short supplied']]);
    expect(toasts).toEqual([{ msg: 'PO #1306 marked complete. No longer pending: 400 Pcs RIM---BLACK [14 inch].', isError: false }]);
    expect(optionsOf(selectOf('1306'))).toEqual(['Completed', 'Reopen (Partially Received)']);
    expect(text(cells('1306')[4].querySelector('div'))).toBe('RIM---BLACK [14 inch] (1000 Pcs) · 400 Pcs short');
    expect(count('poStatusCountPartial')).toBe('0');
    expect(count('poStatusCountCompleted')).toBe('3');
    expect(count('poStatusCountPending')).toBe('1');
  });

  test('a refusal is said, and the row stays as it was', async () => {
    answer = () => ({ success: false, message: 'PO #1306 has been received in full already.' });
    choose(selectOf('1306'), 'Completed');
    await App.PO.confirmClose();

    expect(toasts).toEqual([{ msg: 'PO #1306 has been received in full already.', isError: true }]);
    expect(selectOf('1306').value).toBe('Partially Received');
    expect(App.State.globalPOs[2].status).toBe('Partially Received');
  });
});

describe('Cancelled', () => {
  test('from PO Issued: asked as a cancellation, sent without a reason when none is given', async () => {
    answer = () => ({
      success: true,
      message: 'PO #1308 cancelled. No longer pending: 400 Pcs THINNER-E-400 [GENERAL].',
      data: { poNumber: '1308', po: serverPo('1308', {
        status: 'Cancelled', closedAs: 'Cancelled', closedBy: 'Karanbeer Singh', closedAt: '29/10/2026',
        items: [line({ name: 'THINNER-E-400', size: 'GENERAL', qty: 400, receivedQty: 0, pendingQty: 0, shortQty: 400 })]
      }) }
    });
    choose(selectOf('1308'), 'Cancelled');

    expect(document.getElementById('poCloseTitle').textContent).toBe('Cancel PO-1308');
    expect(text(document.getElementById('poCloseIntro')))
      .toBe('Nothing has been received against PO-1308 from Brahma paints yet. Cancel it if the order is off.');
    const confirmBtn = document.getElementById('poCloseConfirmBtn');
    expect(confirmBtn.textContent).toBe('Cancel PO');
    expect(confirmBtn.classList.contains('btn-danger')).toBe(true);
    expect(confirmBtn.classList.contains('btn-success')).toBe(false);

    await App.PO.confirmClose();
    expect(calls).toEqual([['closePO', '1308', 'Cancelled', '']]);
    expect(optionsOf(selectOf('1308'))).toEqual(['Cancelled', 'Reopen (PO Issued)']);
    expect(count('poStatusCountCancelled')).toBe('2');
    expect(count('poStatusCountIssued')).toBe('0');
  });

  test('from Partially Received: the rest of the order is off', () => {
    choose(selectOf('1306'), 'Cancelled');
    expect(text(document.getElementById('poCloseIntro')))
      .toBe('Mahadev industries has sent part of PO-1306. Cancel it if the rest of the order is off.');
    expect(document.getElementById('poCloseNote').value).toBe('');
  });
});

describe('Reopen', () => {
  test('asks, then hands the PO back to its bills', async () => {
    answer = () => ({
      success: true,
      message: 'PO #1290 reopened. It is Partially Received again.',
      data: { poNumber: '1290', po: serverPo('1290', {
        status: 'Partially Received', closedAs: '', closedBy: '', closedAt: '', closeNote: '',
        items: [line({ name: 'BASKET---RED', size: 'GENERAL', qty: 300, receivedQty: 250, pendingQty: 50 })]
      }) }
    });
    choose(selectOf('1290'), 'reopen');
    await settle();

    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('Reopen PO #1290? It goes back to Partially Received');
    expect(calls).toEqual([['reopenPO', '1290']]);
    expect(optionsOf(selectOf('1290'))).toEqual(['Partially Received', 'Completed', 'Cancelled']);
    expect(text(cells('1290')[4])).toBe('BASKET---RED [GENERAL] (300 Pcs) · 50 Pcs pending');
    expect(text(cells('1290')[7])).not.toContain('Marked complete');
  });
});

describe('Pending Orders', () => {
  const pendingRows = () => [...document.querySelectorAll('#pendingPOsTableBody tr')];

  test('lists each open PO line with its pending pcs, and a status dropdown', () => {
    App.PO.openPendingPOsModal();
    expect(pendingRows().map(tr => [...tr.cells].slice(0, 7).map(text))).toEqual([
      ['PO-1308', '27/10/2026', 'Brahma paints', 'THINNER-E-400 (GENERAL)', '400 Pcs', '0 Pcs', '400 Pcs'],
      ['PO-1306', '24/10/2026', 'Mahadev industries', 'RIM---BLACK (14 inch)', '1000 Pcs', '600 Pcs', '400 Pcs']
    ]);
    expect(optionsOf(pendingRows()[1].querySelector('select'))).toEqual(['Partially Received', 'Completed', 'Cancelled']);
  });

  test('a PO completed from the list leaves it, search kept', async () => {
    answer = () => ({
      success: true,
      message: 'PO #1306 marked complete.',
      data: { poNumber: '1306', po: serverPo('1306', {
        status: 'Completed', closedAs: 'Completed',
        items: [line({ name: 'RIM---BLACK', size: '14 inch', qty: 1000, receivedQty: 600, pendingQty: 0, shortQty: 400 }),
          line({ name: 'RIM---BLACK', size: '16 inch', qty: 1000, receivedQty: 1000, pendingQty: 0 })]
      }) }
    });
    App.PO.openPendingPOsModal();
    document.getElementById('pendingPOsModal').classList.add('show');
    document.getElementById('searchPendingPOs').value = 'rim';
    App.PO.filterPendingPOs('rim');
    expect(pendingRows()).toHaveLength(1);

    choose(pendingRows()[0].querySelector('select'), 'Completed');
    await App.PO.confirmClose();

    expect(calls).toEqual([['closePO', '1306', 'Completed', '']]);
    expect(pendingRows()).toHaveLength(0);
    expect(document.getElementById('pendingPOsEmptyState').style.display).toBe('block');
    App.PO.filterPendingPOs('');
    expect(pendingRows().map(tr => text(tr.cells[0]))).toEqual(['PO-1308']);
  });
});

describe('a PO set by hand is owed nothing more elsewhere either', () => {
  const bills = [
    { billNumber: 'B-1', vendor: 'Sunder polyfab', billDate: '10/10/2026',
      items: [{ poNumber: '1290', name: 'BASKET---RED', size: 'GENERAL', narration: '', qty: 250, baseQty: 250 }] }
  ];
  const withBase = pos => pos.map(po => ({ ...po, items: po.items.map(i => ({ ...i, baseQty: i.qty })) }));

  test('Item Master\'s Pending Order column', () => {
    const pending = PrintTemplates.pendingByItem(withBase(POS), bills);
    expect(pending.has('basket---red|general')).toBe(false);
    expect(pending.has('primer|5 l')).toBe(false);
    expect(pending.get('thinner-e-400|general').qty).toBe(400);

    const reopened = withBase(POS).map(po => (po.poNumber === '1290' ? { ...po, closedAs: '' } : po));
    expect(PrintTemplates.pendingByItem(reopened, bills).get('basket---red|general').qty).toBe(50);
  });

  test('the vendor\'s pending list', () => {
    const src = { pos: withBase(POS), bills, returns: [], issues: [] };
    const deps = { escapeHtml: s => String(s), toNumber: v => Number(v) || 0, formatCurrency: String, formatNameCase: s => s };
    expect(PrintTemplates.vendorLedger('Sunder polyfab', src, deps).pendingList).toEqual([]);
    expect(PrintTemplates.vendorLedger('Brahma paints', src, deps).pendingList.map(p => [p.name, p.pending]))
      .toEqual([['THINNER-E-400', 400]]);
  });
});


// Audit 2026-10-29: what the rows say must be right on the live data's
// awkward cases.
describe('the PO Ledger on the awkward cases', () => {
  const render = pos => {
    App.State.globalPOs = pos;
    App.State.filteredPOs = [...pos];
    App.PO.renderTable();
  };

  test('a PO ordering in two units totals each unit, never "2000"', () => {
    render([{ poNumber: '1280', poDate: '01/10/2026', vendor: 'Brahma paints', status: 'Partially Received',
      statusFromBills: 'Partially Received', closedAs: '', totalQty: 2000, grandTotal: 1,
      items: [line({ name: 'Pocket Flap', size: 'GENERAL', qty: 1000, unit: 'Pair', receivedQty: 600, pendingQty: 400 }),
        line({ name: 'Brake Wire', size: '20 inch', qty: 1000, unit: 'Set', receivedQty: 1000, pendingQty: 0 })] }]);
    const qty = cells('1280')[5];
    expect([...qty.querySelectorAll('div')].map(text)).toEqual(['1000 Pair', '1000 Set', '400 Pair pending']);
  });

  test('two lines of one item and size are told apart by their narration', () => {
    render([{ poNumber: '1289', poDate: '09/10/2026', vendor: 'Harijot Industry', status: 'Partially Received',
      statusFromBills: 'Partially Received', closedAs: '', totalQty: 10000, grandTotal: 1,
      items: [line({ name: 'FREE-WHEEL', size: 'GENERAL', narration: '16T Freewheel', qty: 4000, receivedQty: 4000, pendingQty: 0 }),
        line({ name: 'FREE-WHEEL', size: 'GENERAL', narration: '18T', qty: 6000, receivedQty: 5341, pendingQty: 659 }),
        line({ name: 'Rim', size: '20 inch', narration: 'not needed', qty: 10, receivedQty: 0, pendingQty: 10 })] }]);
    expect([...cells('1289')[4].querySelectorAll('div')].map(text)).toEqual([
      'FREE-WHEEL [GENERAL] “16T Freewheel” (4000 Pcs) · received',
      'FREE-WHEEL [GENERAL] “18T” (6000 Pcs) · 659 Pcs pending',
      'Rim [20 inch] (10 Pcs) · 10 Pcs pending'
    ]);
    App.PO.openPendingPOsModal();
    expect([...document.querySelectorAll('#pendingPOsTableBody tr')].map(tr => text(tr.cells[3])))
      .toEqual(['FREE-WHEEL (GENERAL) “18T”', 'Rim (20 inch)']);
  });

  test('identical lines share one bill in order, in Item Master and the vendor list too', () => {
    // PO 1269: RIM---BLACK 14" twice, 1000 each, one 1000-piece bill. Each
    // line used to be handed the whole bill -- nothing pending anywhere.
    const twin = line({ name: 'RIM---BLACK', size: '14 inch', narration: 'Wt 340', qty: 1000, baseQty: 1000 });
    const pos = [{ poNumber: '1269', vendor: 'Mahadev industries', poDate: '01/10/2026', items: [twin, { ...twin }] }];
    const bills = [{ billNumber: '3151', vendor: 'Mahadev industries', billDate: '07/10/2026',
      items: [{ poNumber: '1269', name: 'RIM---BLACK', size: '14 inch', narration: 'Wt 340', qty: 1000, baseQty: 1000 }] }];

    expect(PrintTemplates.billedByLine(PrintTemplates.billedQtyIndex(bills, pos), pos[0])).toEqual([1000, 0]);
    expect(PrintTemplates.pendingByItem(pos, bills).get('rim---black|14 inch').qty).toBe(1000);
    const deps = { escapeHtml: s => String(s), toNumber: v => Number(v) || 0, formatCurrency: String, formatNameCase: s => s };
    const [row] = PrintTemplates.vendorLedger('Mahadev industries', { pos, bills, returns: [], issues: [] }, deps).pendingList;
    expect(row).toMatchObject({ unit: 'Pcs', ordered: 2000, received: 1000, over: 0, pending: 1000 });

    // A second bill past both: the last line carries the overage.
    bills.push({ billNumber: '3152', vendor: 'Mahadev industries', billDate: '08/10/2026',
      items: [{ poNumber: '1269', name: 'RIM---BLACK', size: '14 inch', narration: 'Wt 340', qty: 1500, baseQty: 1500 }] });
    expect(PrintTemplates.billedByLine(PrintTemplates.billedQtyIndex(bills, pos), pos[0])).toEqual([1000, 1500]);
  });

  test('a bill naming the PO in other letters still counts, as on the server', () => {
    const pos = [{ poNumber: 'PO-A1', vendor: 'V', poDate: '01/10/2026',
      items: [line({ name: 'Bolt', size: '', qty: 10, baseQty: 10 })] }];
    const bills = [{ billNumber: 'B', vendor: 'V', billDate: '02/10/2026',
      items: [{ poNumber: ' po-a1 ', name: 'Bolt', size: '', narration: '', qty: 4, baseQty: 4 }] }];
    expect(PrintTemplates.pendingByItem(pos, bills).get('bolt|').qty).toBe(6);
  });
});
