/**
 * Correcting a Warehouse Pool bucket from the phone (Phase 6).
 *
 * A correction is not an overwrite. adjustWarehousePoolManually appends a
 * compensating opening row for (new - old), recalculates, and logs the
 * before/after against the user -- which is the only reason it is safe to
 * offer here at all.
 *
 * The refusal below is the point of this file. A negative bucket is a
 * signal, and the two kinds of negative look identical as a number and
 * need opposite actions:
 *
 *   - ATTRIBUTION: nothing was ever produced in this colour, yet
 *     something was consumed. The units are not missing -- they were
 *     credited to a sibling colour. Correcting this to zero hides it
 *     without moving a single part, and destroys the trail the next
 *     stage's checklist reads.
 *   - NEEDS A COUNT: both sides moved and it still went negative. A
 *     physical recount is exactly what this screen is for.
 *
 * The server guards only the arithmetic that cannot be true (produced_qty
 * going negative) and leaves this to the caller -- its own
 * _assert_produced_stays_nonnegative docstring says a negative available
 * qty "must stay visible so the shortfall gets counted and entered".
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

// Purple-Wine was consumed but never produced; the composite bucket
// "Purple-Wine / Black" is where those units were actually credited.
const ATTRIBUTION = {
  rowIdx: 1, outputItemName: 'Frame 26', processId: 'P1', productTag: '',
  color: 'Purple-Wine', producedQty: 0, consumedQty: 40, availableQty: -40,
};
const SIBLING = {
  rowIdx: 2, outputItemName: 'Frame 26', processId: 'P1', productTag: '',
  color: 'Purple-Wine / Black', producedQty: 100, consumedQty: 20, availableQty: 80,
};
const NEEDS_COUNT = {
  rowIdx: 3, outputItemName: 'Rim 26', processId: 'P2', productTag: '',
  color: 'Black', producedQty: 50, consumedQty: 55, availableQty: -5,
};
const HEALTHY = {
  rowIdx: 4, outputItemName: 'Hub 26', processId: 'P2', productTag: 'KALPI',
  color: '', producedQty: 30, consumedQty: 10, availableQty: 20,
};

// Fresh copies per test: submitAdjust patches the live row in place when
// the server hands back the current value, and these fixtures would
// otherwise carry that edit into the next test.
const FIXTURES = [ATTRIBUTION, SIBLING, NEEDS_COUNT, HEALTHY];
let rows;
const row = idx => rows[idx];

function mount() {
  rows = FIXTURES.map(r => ({ ...r }));
  jest.resetModules();
  global.fetch = jest.fn();
  document.body.innerHTML = `
    <div id="mapp-sheet-backdrop"></div>
    <div class="mb-sheet" id="sheet-pool">
      <div class="mb-search"><input type="search" id="pool-search"></div>
      <div class="mb-filter-chip-row" id="pool-filter-bar">
        <button class="mb-filter-chip active" data-pool-filter="all">All</button>
      </div>
      <div id="pool-list"></div>
    </div>
    <div class="mb-sheet" id="sheet-pool-adjust">
      <div id="pool-adjust-note" hidden></div>
      <input type="text" id="pool-adjust-bucket" readonly>
      <input type="text" id="pool-adjust-old" readonly>
      <input type="number" id="pool-adjust-new">
      <textarea id="pool-adjust-reason"></textarea>
      <button id="pool-adjust-save-btn">Save correction</button>
    </div>
    <div class="mb-sheet" id="sheet-pool-history"><div id="pool-history-body"></div></div>
    <div class="mb-toast-stack" id="mapp-toast-stack"></div>`;
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
  MApp.Sheet._stack = [];
  MApp.Paging._shown = {};
  MApp.Pool.rows = rows;
  window.confirm = jest.fn(() => true);
  Element.prototype.scrollIntoView = jest.fn();
}

const note = () => document.getElementById('pool-adjust-note');
const fill = (qty, reason) => {
  document.getElementById('pool-adjust-new').value = String(qty);
  document.getElementById('pool-adjust-reason').value = reason;
};

describe('the sheet names which kind of negative this is', () => {
  beforeEach(mount);

  test('an attribution bucket says so, and names where the units went', () => {
    MApp.Pool.openAdjust(row(0));

    expect(note().hidden).toBe(false);
    expect(note().textContent).toContain('attribution negative, not a shortage');
    expect(note().textContent).toContain('Purple-Wine / Black');
  });

  test('an attribution bucket with no sibling points at the recipe instead', () => {
    MApp.Pool.rows = [row(0)];
    MApp.Pool.openAdjust(row(0));

    expect(note().textContent).toContain('the consuming recipe is what to check');
  });

  test('a needs-a-count bucket says to count it, not to zero it', () => {
    MApp.Pool.openAdjust(row(2));

    expect(note().hidden).toBe(false);
    expect(note().textContent).toContain('what is physically on the shelf');
  });

  test('a healthy bucket carries no warning at all', () => {
    MApp.Pool.openAdjust(row(3));

    expect(note().hidden).toBe(true);
  });

  test('the sheet opens on the value the bucket actually has', () => {
    MApp.Pool.openAdjust(row(2));

    expect(document.getElementById('pool-adjust-old').value).toBe('-5');
    expect(document.getElementById('pool-adjust-new').value).toBe('-5');
    expect(document.getElementById('pool-adjust-reason').value).toBe('');
  });
});

describe('the refusal', () => {
  beforeEach(mount);

  test('an attribution negative cannot be lifted to zero', async () => {
    // This is the move that hides the problem without moving a part.
    Api.mutateWithId = jest.fn();
    const spy = jest.spyOn(MApp.Toast, 'error');
    MApp.Pool.openAdjust(row(0));
    fill(0, 'looks wrong');

    await MApp.Pool.submitAdjust();

    expect(Api.mutateWithId).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Purple-Wine / Black'));
    spy.mockRestore();
  });

  test('nor to any positive value', async () => {
    Api.mutateWithId = jest.fn();
    MApp.Pool.openAdjust(row(0));
    fill(40, 'found them');

    await MApp.Pool.submitAdjust();

    expect(Api.mutateWithId).not.toHaveBeenCalled();
  });

  test('the refusal names the fix, not just the problem', async () => {
    const spy = jest.spyOn(MApp.Toast, 'error');
    MApp.Pool.openAdjust(row(0));
    fill(0, 'x');

    await MApp.Pool.submitAdjust();

    expect(spy.mock.calls[0][0]).toContain('correct the pairing');
    spy.mockRestore();
  });

  test('it is narrow: a correction that leaves it negative still goes', async () => {
    // The refusal is about erasing the signal, not about touching the
    // bucket. Someone who knows the consumed figure is wrong may still
    // say so.
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    MApp.Pool.openAdjust(row(0));
    fill(-30, 'consumed figure was overstated by 10');

    await MApp.Pool.submitAdjust();

    expect(Api.mutateWithId).toHaveBeenCalled();
  });

  test('a needs-a-count bucket may be corrected to zero', async () => {
    // A recount that finds nothing there is a real answer, and this is
    // the kind of negative a recount settles.
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    MApp.Pool.openAdjust(row(2));
    fill(0, 'physical recount 08/09, shelf empty');

    await MApp.Pool.submitAdjust();

    expect(Api.mutateWithId).toHaveBeenCalled();
  });

  test('a healthy bucket is never blocked', async () => {
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    MApp.Pool.openAdjust(row(3));
    fill(18, 'recount found 18');

    await MApp.Pool.submitAdjust();

    expect(Api.mutateWithId).toHaveBeenCalled();
  });
});

describe('what gets sent', () => {
  beforeEach(mount);

  test('the bucket identity the server keys on, plus the new value', async () => {
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    MApp.Pool.open = jest.fn();
    MApp.Pool.openAdjust(row(3));
    fill(18, 'recount found 18');

    await MApp.Pool.submitAdjust();

    const call = Api.mutateWithId.mock.calls[0];
    expect(call[0]).toBe('adjustWarehousePoolManually');
    expect(call.slice(2)).toEqual(['Hub 26', 'P2', 'KALPI', '', 18, 'recount found 18']);
  });

  test('a reason is required before anything is sent', async () => {
    // The server rejects a blank one; refusing here costs no round trip
    // and keeps the typed quantity on screen.
    Api.mutateWithId = jest.fn();
    MApp.Pool.openAdjust(row(3));
    fill(18, '   ');

    await MApp.Pool.submitAdjust();

    expect(Api.mutateWithId).not.toHaveBeenCalled();
  });

  test('a blank or non-numeric quantity is refused', async () => {
    Api.mutateWithId = jest.fn();
    MApp.Pool.openAdjust(row(3));
    fill('', 'recount');

    await MApp.Pool.submitAdjust();

    expect(Api.mutateWithId).not.toHaveBeenCalled();
  });

  test('re-entering the value it already has is refused locally', async () => {
    Api.mutateWithId = jest.fn();
    MApp.Pool.openAdjust(row(3));
    fill(20, 'no change');

    await MApp.Pool.submitAdjust();

    expect(Api.mutateWithId).not.toHaveBeenCalled();
  });

  test('the confirmation names both numbers and the delta', async () => {
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {} }));
    MApp.Pool.open = jest.fn();
    MApp.Pool.openAdjust(row(3));
    fill(18, 'recount');

    await MApp.Pool.submitAdjust();

    const asked = window.confirm.mock.calls[0][0];
    expect(asked).toContain('from 20 to 18');
    expect(asked).toContain('-2');
    expect(asked).toContain('logged against your name');
  });

  test('declining the confirmation sends nothing', async () => {
    window.confirm = jest.fn(() => false);
    Api.mutateWithId = jest.fn();
    MApp.Pool.openAdjust(row(3));
    fill(18, 'recount');

    await MApp.Pool.submitAdjust();

    expect(Api.mutateWithId).not.toHaveBeenCalled();
  });
});

describe('what comes back', () => {
  beforeEach(mount);

  test('a no-op refusal reconciles the stale value on screen', async () => {
    // The server bypasses build_response on this one path specifically so
    // the current value rides along with the failure, letting the screen
    // correct itself instead of arguing with a stale number.
    Api.mutateWithId = jest.fn(async () => ({
      success: false,
      data: { oldAvailableQty: 18, newAvailableQty: 18 },
      message: 'New quantity is the same as the current value -- nothing to adjust.',
    }));
    MApp.Pool.openAdjust(row(3));
    fill(18, 'recount');

    await MApp.Pool.submitAdjust();

    expect(document.getElementById('pool-adjust-old').value).toBe('18');
  });

  test('a produced-would-go-negative refusal is reported as it comes back', async () => {
    const refusal = 'This correction would drive "Hub 26" to a negative produced quantity, which cannot happen.';
    Api.mutateWithId = jest.fn(async () => ({ success: false, message: refusal }));
    const spy = jest.spyOn(MApp.Toast, 'error');
    MApp.Pool.open = jest.fn();
    MApp.Pool.openAdjust(row(3));
    fill(-5, 'recount');

    await MApp.Pool.submitAdjust();

    expect(spy).toHaveBeenCalledWith(refusal);
    expect(MApp.Pool.open).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('a network failure re-enables the button rather than stranding it', async () => {
    Api.mutateWithId = jest.fn(async () => { throw new Error('offline'); });
    MApp.Pool.openAdjust(row(3));
    fill(18, 'recount');

    await MApp.Pool.submitAdjust();

    const btn = document.getElementById('pool-adjust-save-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Save correction');
  });

  test('a success reloads the pool in place, without re-entering the tab', async () => {
    // load(), not open(): the bucket pane is already on screen behind the
    // sheet that just closed. Now that the pool is the Stock tab's second
    // pane, open() navigates there and remounts the whole tab.
    Api.mutateWithId = jest.fn(async () => ({ success: true, data: {}, message: 'Warehouse Pool stock adjusted successfully.' }));
    MApp.Pool.load = jest.fn();
    MApp.Pool.open = jest.fn();
    MApp.Pool.openAdjust(row(3));
    fill(18, 'recount');

    await MApp.Pool.submitAdjust();

    expect(MApp.Pool.load).toHaveBeenCalled();
    expect(MApp.Pool.open).not.toHaveBeenCalled();
  });

  // The entered figure always holds -- the server widens the correction
  // until it does. What can differ is how much widening that took, and
  // that surplus is consumption recorded against stock the pool never had.
  describe('when the correction had to be widened to hold', () => {
    const widened = () => {
      Api.mutateWithId = jest.fn(async () => ({
        success: true,
        data: {
          oldAvailableQty: 0, newAvailableQty: 18, requestedQty: 18,
          expectedDelta: 18, appliedDelta: 23,
        },
        message: 'Stock set to 18. It took 23 to get there, not 18: 5 had already been drawn as colour-agnostic consumption…',
      }));
    };

    test('says so in a toast that waits, not one that fades', async () => {
      widened();
      const spy = jest.spyOn(MApp.Toast, 'action');
      MApp.Pool.load = jest.fn();
      MApp.Pool.openAdjust(row(3));
      fill(18, 'recount');

      await MApp.Pool.submitAdjust();

      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0]).toContain('colour-agnostic');
    });

    test('still closes and reloads -- the count did take', async () => {
      widened();
      MApp.Pool.load = jest.fn();
      MApp.Pool.closeAdjust = jest.fn();
      MApp.Pool.openAdjust(row(3));
      fill(18, 'recount');

      await MApp.Pool.submitAdjust();

      expect(MApp.Pool.closeAdjust).toHaveBeenCalled();
      expect(MApp.Pool.load).toHaveBeenCalled();
    });

    test('a correction that needed no widening reports plainly', async () => {
      Api.mutateWithId = jest.fn(async () => ({
        success: true,
        data: {
          oldAvailableQty: 0, newAvailableQty: 18, requestedQty: 18,
          expectedDelta: 18, appliedDelta: 18,
        },
        message: 'Warehouse Pool stock adjusted successfully.',
      }));
      const spy = jest.spyOn(MApp.Toast, 'action');
      MApp.Pool.load = jest.fn();
      MApp.Pool.closeAdjust = jest.fn();
      MApp.Pool.openAdjust(row(3));
      fill(18, 'recount');

      await MApp.Pool.submitAdjust();

      expect(spy).not.toHaveBeenCalled();
      expect(MApp.Pool.closeAdjust).toHaveBeenCalled();
    });
  });
});

describe('correction history', () => {
  beforeEach(mount);

  const HISTORY = [{
    date: '2026-09-07T10:00:00', outputItemName: 'Hub 26', productTag: 'KALPI', color: '',
    oldValue: 20, newValue: 18, reason: 'physical recount', user: 'rakesh@example.com',
  }];

  test('reads the log neither shell has ever read back', async () => {
    // Every manual correction has been recorded since the endpoint was
    // written, and nothing anywhere displayed it -- so a pool number that
    // moved with no lot behind it had no account.
    MApp.Api.call = jest.fn(async () => ({ success: true, data: HISTORY }));

    await MApp.Pool.openHistory();

    expect(MApp.Api.call).toHaveBeenCalledWith('getWarehousePoolAdjustmentHistory');
    const text = document.getElementById('pool-history-body').textContent;
    expect(text).toContain('Hub 26');
    expect(text).toContain('20 → 18');
    expect(text).toContain('physical recount');
    expect(text).toContain('rakesh@example.com');
  });

  test('an empty log reads as empty rather than broken', async () => {
    MApp.Api.call = jest.fn(async () => ({ success: true, data: [] }));

    await MApp.Pool.openHistory();

    expect(document.getElementById('pool-history-body').textContent).toContain('No corrections');
  });

  test('a failure offers a retry', async () => {
    MApp.Api.call = jest.fn(async () => { throw new Error('offline'); });

    await MApp.Pool.openHistory();

    expect(document.querySelector('#pool-history-body .mb-state-retry')).not.toBeNull();
  });
});
