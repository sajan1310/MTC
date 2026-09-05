/**
 * MApp.Search -- the one keyword matcher (Phase 2, F3).
 *
 * The eleven onSearch() methods it replaces each took the whole query as a
 * single substring and tested it against one to three hard-coded fields.
 * The query shape operators actually use on the floor -- size, model and
 * colour, which live in three different fields on every record here --
 * matched nothing anywhere. "AND across tokens, OR across fields" is the
 * rule that fixes that, and most of what follows pins it.
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

beforeAll(() => {
  global.fetch = jest.fn();
  loadAsGlobal('api.js', 'Api');
  loadAsGlobal('mobile.js', 'MApp');
});

// A production lot, shaped the way MApp.Production actually holds one.
const SPEC = {
  fields: [
    { key: 'lotNumber', weight: 10, label: 'Lot' },
    { key: 'process', weight: 6, label: 'Process' },
    { key: 'assignedTo', weight: 5, label: 'Assigned to' },
    { key: 'status', weight: 4, label: 'Status' },
    { key: 'colors', weight: 3, label: 'Colour', get: l => (l.colorQty || []).map(c => c.color) },
  ],
};

const LOTS = [
  { lotNumber: 'LOT-1042', process: 'Painting 26 inch Kalpi', assignedTo: 'Rakesh', status: 'Pending', colorQty: [{ color: 'Red' }, { color: 'Black' }] },
  { lotNumber: 'LOT-1043', process: 'Welding 24 inch Kalpi', assignedTo: 'Suresh', status: 'Completed', colorQty: [{ color: 'Blue' }] },
  { lotNumber: 'LOT-1044', process: 'Painting 26 inch Ranger', assignedTo: 'Rakesh', status: 'Pending', colorQty: [{ color: 'Red' }] },
];

const search = (rows, q, spec = SPEC) => MApp.Search.run(MApp.Search.index(rows, spec), q);
const lotNumbers = rows => rows.map(r => r.lotNumber);

describe('MApp.Search.norm', () => {
  test('folds case and strips diacritics', () => {
    expect(MApp.Search.norm('Kalpí')).toBe('kalpi');
    expect(MApp.Search.norm('RED')).toBe('red');
  });

  test('turns punctuation into a separator rather than deleting it', () => {
    // Deleting would make "PO-1042" index as "po1042", which "1042" would
    // then miss. This is the behaviour that makes document numbers findable
    // by their digits alone.
    expect(MApp.Search.norm('PO-1042')).toBe('po 1042');
    expect(MApp.Search.norm('26" rim')).toBe('26 rim');
  });

  test('collapses whitespace and survives null/undefined', () => {
    expect(MApp.Search.norm('  a   b  ')).toBe('a b');
    expect(MApp.Search.norm(null)).toBe('');
    expect(MApp.Search.norm(undefined)).toBe('');
    expect(MApp.Search.norm(0)).toBe('0');
  });
});

describe('MApp.Search.run -- the defect this module exists to fix', () => {
  test('matches tokens spread across DIFFERENT fields', () => {
    // "26" is in process, "kalpi" is in process, "red" is in colorQty --
    // no single field contains the whole query. Every old implementation
    // returned nothing for this.
    expect(lotNumbers(search(LOTS, '26 kalpi red'))).toEqual(['LOT-1042']);
  });

  test('token order does not matter', () => {
    expect(lotNumbers(search(LOTS, 'red kalpi'))).toEqual(['LOT-1042']);
    expect(lotNumbers(search(LOTS, 'kalpi red'))).toEqual(['LOT-1042']);
  });

  test('every token must appear somewhere -- AND, not OR', () => {
    // "ranger" and "blue" each match a row, but no row has both.
    expect(search(LOTS, 'ranger blue')).toEqual([]);
  });

  test('searches fields the old implementations ignored entirely', () => {
    expect(lotNumbers(search(LOTS, 'rakesh'))).toEqual(['LOT-1042', 'LOT-1044']);
    expect(lotNumbers(search(LOTS, 'pending'))).toEqual(['LOT-1042', 'LOT-1044']);
    expect(lotNumbers(search(LOTS, 'blue'))).toEqual(['LOT-1043']);
  });

  test('finds a document number by its digits alone', () => {
    expect(lotNumbers(search(LOTS, '1043'))).toEqual(['LOT-1043']);
  });

  test('flattens array-valued fields so any element matches', () => {
    // LOT-1042 has two colours; either one should find it.
    expect(lotNumbers(search(LOTS, 'black'))).toEqual(['LOT-1042']);
  });
});

describe('MApp.Search.run -- ordering', () => {
  test('an empty query returns every row in its original order', () => {
    expect(lotNumbers(search(LOTS, ''))).toEqual(['LOT-1042', 'LOT-1043', 'LOT-1044']);
    expect(lotNumbers(search(LOTS, '   '))).toEqual(['LOT-1042', 'LOT-1043', 'LOT-1044']);
  });

  test('equally-scoring rows keep their original order', () => {
    // Both lots match only on assignedTo, with the same weight and the
    // same match quality -- so a date-sorted ledger stays date-sorted when
    // someone searches a vendor or contractor name. Relies on
    // Array.prototype.sort being stable, which it is per spec.
    expect(lotNumbers(search(LOTS, 'rakesh'))).toEqual(['LOT-1042', 'LOT-1044']);
  });

  test('a heavier field outranks a lighter one', () => {
    const rows = [
      { lotNumber: 'LOT-2', process: 'Painting', assignedTo: 'Kalpi', status: '', colorQty: [] },
      { lotNumber: 'KALPI-1', process: 'Welding', assignedTo: 'Ravi', status: '', colorQty: [] },
    ];
    // lotNumber is weight 10 and starts with the token; assignedTo is 5.
    expect(lotNumbers(search(rows, 'kalpi'))).toEqual(['KALPI-1', 'LOT-2']);
  });

  test('a whole-word match outranks a mid-word one', () => {
    const rows = [
      { lotNumber: 'A', process: 'Repainting', assignedTo: '', status: '', colorQty: [] },
      { lotNumber: 'B', process: 'Paint', assignedTo: '', status: '', colorQty: [] },
    ];
    expect(lotNumbers(search(rows, 'paint'))).toEqual(['B', 'A']);
  });
});

describe('MApp.Search -- robustness', () => {
  test('handles empty and missing inputs without throwing', () => {
    expect(MApp.Search.run(MApp.Search.index([], SPEC), 'x')).toEqual([]);
    expect(MApp.Search.run(MApp.Search.index(null, SPEC), '')).toEqual([]);
    expect(MApp.Search.index([{}], SPEC)).toHaveLength(1);
  });

  test('rows with null/missing fields are indexed, not skipped', () => {
    const rows = [{ lotNumber: 'LOT-9', process: null, assignedTo: undefined, status: 'Pending' }];
    expect(lotNumbers(search(rows, 'pending'))).toEqual(['LOT-9']);
    expect(lotNumbers(search(rows, 'lot 9'))).toEqual(['LOT-9']);
  });

  test('a token that appears nowhere returns nothing', () => {
    expect(search(LOTS, 'zzzz')).toEqual([]);
  });

  test('regex metacharacters in a query are harmless', () => {
    // norm() strips them to spaces, so they can never reach the RegExp
    // built during scoring.
    expect(() => search(LOTS, '(.*)+[')).not.toThrow();
    expect(search(LOTS, '(.*)+[')).toEqual(LOTS.slice(0, 0).concat(LOTS));
  });

  test('reports which field matched, without changing the row shape', () => {
    const [hit] = search(LOTS, 'rakesh');
    expect(hit._matchedOn).toEqual(['Assigned to']);
    // Non-enumerable: render code that spreads or JSON-serialises a row
    // must not start seeing a stray _matchedOn key.
    expect(Object.keys(hit)).not.toContain('_matchedOn');
    expect(JSON.parse(JSON.stringify(hit))._matchedOn).toBeUndefined();
  });

  test('the index is built once and reused across queries', () => {
    const entries = MApp.Search.index(LOTS, SPEC);
    expect(lotNumbers(MApp.Search.run(entries, 'rakesh'))).toEqual(['LOT-1042', 'LOT-1044']);
    expect(lotNumbers(MApp.Search.run(entries, 'blue'))).toEqual(['LOT-1043']);
    expect(lotNumbers(MApp.Search.run(entries, ''))).toHaveLength(3);
  });
});
