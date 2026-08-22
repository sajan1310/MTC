/**
 * Regression tests for the Colors/Sub-Groups checklist on a SEQUENCE-1
 * process -- one that consumes a pool item and produces colours of its own
 * (../production.js, _renderAxisAndSubGroupChecklist).
 *
 * The bug: getProcessColorAxes can only see axes something upstream
 * produces, so for a Painted Frame process it resolved exactly ONE -- the
 * Mudguard rib the process CONSUMES. That single axis was handed the primary
 * role by default, which totalled the wrong thing: the lot counted ribs
 * consumed, while the frames it produced sat in the non-counting "Other"
 * bucket. _pruneRedundantMatrixColumns then deleted those frame colours'
 * matrix columns (each token-matches a counting rib colour), leaving their
 * per-colour components with nowhere to be recorded -- the operator saw
 * component rows with empty pickers and no quantities.
 *
 * Neither group can be assumed primary, so both are now rendered as pickable
 * axes and the operator decides. What these pin is that the choice is
 * actually offered, that nothing counts until it is made, and that a genuine
 * sub-group bucket is not promoted alongside the real colours.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PARTIAL = path.join(__dirname, '..', '..', '..', 'templates', 'erp', 'partials', 'production.html');

const OUTPUT_ITEM = 'Painted Frame Curvy 14 inch D/Gaddi';

// The consumed pool item -- the only axis getProcessColorAxes can resolve.
const MUDGUARD_AXIS = {
  key: 'pool:14 inch broad mudguard painted rib',
  label: '14 inch Broad Mudguard Painted Rib',
  colors: ['Blue', 'Pink', 'Red', 'SeaGreen'],
  source: 'pool',
};

// Every colour the process knows: the rib axis plus the frame's own output
// colours, which no axis owns.
const OWN_COLORS = ['Blue-White', 'Pink-White', 'Red-White', 'SeaGreen-White'];
const ALL_COLORS = [...MUDGUARD_AXIS.colors, ...OWN_COLORS];

function loadProductionAsGlobal() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'production.js'), 'utf8');
  // eslint-disable-next-line no-eval
  eval(code);
}

// A Color Master rich enough for _isColorGroupName to tell a real colour
// (composites resolve from these) from a packing bucket (nothing resolves).
const COLOR_MASTER = ['Blue', 'Pink', 'Red', 'SeaGreen', 'White'].map(name => ({ name }));

function mount(outputItemName = OUTPUT_ITEM) {
  document.body.innerHTML = fs.readFileSync(PARTIAL, 'utf8');

  global.escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch]);
  global.toNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  global.$ = (sel, root = document) => root.querySelector(sel);
  global.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  global.formatCurrency = v => String(v);
  global.todayIso = () => '2026-01-01';
  global.parseRecordDate = () => 0;

  global.App = {
    State: { globalItems: [], globalColors: COLOR_MASTER, globalProcesses: [], globalProduction: [] },
    Utils: {
      sameText: (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase(),
      sameColor(a, b) { return this.sameText(a, b); },
      isCommonColorGroup: g => String(g ?? '').trim().toUpperCase() === 'COMMON',
      showToast: () => {},
    },
  };

  loadProductionAsGlobal();
  App.Production._customColorGroupOptions = [];
  document.getElementById('productionOutputItemName').value = outputItemName;
}

const checklist = () => document.getElementById('productionColorChecklist');

function render(colors = ALL_COLORS) {
  checklist().innerHTML = '';
  App.Production._renderAxisAndSubGroupChecklist(checklist(), colors, MUDGUARD_AXIS);
}

const headings = () => Array.from(document.querySelectorAll('#productionColorChecklist .axis-group-label'))
  .map(el => el.textContent.trim());

const radios = () => Array.from(
  document.querySelectorAll('#productionColorChecklist input[name="productionPrimaryAxisPick"]'));

const rowsOf = group => Array.from(document.querySelectorAll('#productionColorChecklist .production-color-row'))
  .filter(r => r.dataset.group === group);

describe('Sequence-1 process: the operator picks which group is Primary', () => {
  beforeEach(() => mount());

  test('the output item\'s own colours become a pickable axis, not the "Other" bucket', () => {
    render();

    // Was: one plain header for the rib axis, and the frame colours dumped
    // into the non-counting bucket with no way to make them count.
    expect(radios()).toHaveLength(2);
    expect(radios().map(r => r.value)).toEqual([
      'pool:14 inch broad mudguard painted rib',
      `own:${OUTPUT_ITEM.toLowerCase()}`,
    ]);
    expect(rowsOf(`own:${OUTPUT_ITEM.toLowerCase()}`).map(r => r.dataset.color)).toEqual(OWN_COLORS);
  });

  test('the group is named after the Output Item Name', () => {
    render();
    expect(headings()).toEqual([MUDGUARD_AXIS.label, OUTPUT_ITEM]);
  });

  test('no heading claims to be a Sub-Group before a Primary is picked', () => {
    render();
    // The warning asks the operator to decide; labelling every group
    // "Sub-Group" in the meantime asserts the opposite.
    headings().forEach(text => {
      expect(text).not.toContain('Sub-Group');
      expect(text).not.toContain('Color Group');
    });
    expect(document.getElementById('productionPrimaryAxisWarning')).not.toBeNull();
    expect(radios().some(r => r.checked)).toBe(false);
  });

  test('nothing counts toward the lot total until the pick is made', () => {
    render();
    Array.from(document.querySelectorAll('#productionColorChecklist .production-color-row'))
      .forEach(r => expect(r.dataset.primary).toBe('false'));
  });

  test('picking the output item makes its colours the counting group', async () => {
    render();
    const ownKey = `own:${OUTPUT_ITEM.toLowerCase()}`;
    const radio = radios().find(r => r.value === ownKey);
    radio.checked = true;
    await App.Production.setPrimaryColorAxisChoice(radio);

    rowsOf(ownKey).forEach(r => expect(r.dataset.primary).toBe('true'));
    rowsOf(MUDGUARD_AXIS.key).forEach(r => expect(r.dataset.primary).toBe('false'));
    expect(headings()).toEqual([
      `${MUDGUARD_AXIS.label} — Sub-Group`,
      `${OUTPUT_ITEM} — Color Group (Primary)`,
    ]);
    expect(document.getElementById('productionPrimaryAxisWarning')).toBeNull();
  });

  test('the submitted primary axis label is the group the operator picked', async () => {
    render();
    const radio = radios().find(r => r.value === MUDGUARD_AXIS.key);
    radio.checked = true;
    await App.Production.setPrimaryColorAxisChoice(radio);

    // saveProduction reads this off the checked radio's data-axis-label.
    expect(radio.dataset.axisLabel).toBe(MUDGUARD_AXIS.label);
  });
});

describe('Sequence-1 promotion is limited to real colours', () => {
  test('a packing bucket stays non-counting instead of becoming an axis', () => {
    mount();
    // 'KIT BAG 24"' resolves to nothing in the Color Master, so it is a
    // sub-group, not one of this process's output colours.
    render([...MUDGUARD_AXIS.colors, ...OWN_COLORS, 'KIT BAG 24"']);

    expect(radios()).toHaveLength(2);
    const bucketRow = Array.from(document.querySelectorAll('#productionColorChecklist .production-color-row'))
      .find(r => r.dataset.color === 'KIT BAG 24"');
    expect(bucketRow.dataset.group).toBe('other');
    expect(bucketRow.dataset.primary).toBe('false');
  });

  test('with no leftover colours at all the single axis still counts on its own', () => {
    mount();
    render(MUDGUARD_AXIS.colors);

    // Nothing to choose between, so no picker and no warning -- the axis is
    // the lot's output and counts, exactly as before.
    expect(radios()).toHaveLength(0);
    expect(document.getElementById('productionPrimaryAxisWarning')).toBeNull();
    rowsOf(MUDGUARD_AXIS.key).forEach(r => expect(r.dataset.primary).toBe('true'));
  });

  test('with no Output Item Name there is nothing to label a group with', () => {
    mount('');
    render();

    // An unlabelled radio the operator cannot identify is worse than the old
    // default, so this falls back to it.
    expect(radios()).toHaveLength(0);
    rowsOf(MUDGUARD_AXIS.key).forEach(r => expect(r.dataset.primary).toBe('true'));
  });
});
