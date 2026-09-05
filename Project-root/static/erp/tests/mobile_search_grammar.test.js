/**
 * Query grammar and fuzzy fallback for MApp.Search.
 *
 * Two of the behaviours here were footguns rather than missing features:
 * `-kalpi` normalised to `kalpi` and returned exactly the rows the
 * operator was trying to exclude, and `vendor:acme` became the two tokens
 * "vendor" and "acme" -- the first appearing nowhere, so the query
 * silently returned an empty list. Both inverted or discarded intent
 * without saying so, which is worse than not supporting them.
 *
 * The fuzzy pass is deliberately conservative. It runs ONLY when the
 * exact pass found nothing, so an approximate match can never displace or
 * dilute a real one, and it refuses to fuzz tokens of three characters or
 * fewer -- "red" and "rod" are two colours, and guessing between them on
 * a shop floor is worse than finding nothing.
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

const SPEC = {
  fields: [
    { key: 'lotNumber', weight: 10, label: 'Lot' },
    { key: 'process', weight: 6, label: 'Process' },
    { key: 'assignedTo', weight: 5, label: 'Assigned to' },
    { key: 'colors', weight: 3, label: 'Colour', get: l => l.colors || [] },
  ],
};

const LOTS = [
  { lotNumber: 'LOT-1042', process: 'Painting 26 inch Kalpi', assignedTo: 'Rakesh', colors: ['Red'] },
  { lotNumber: 'LOT-1043', process: 'Trimming 24 inch Ranger', assignedTo: 'Suresh', colors: ['Blue'] },
  { lotNumber: 'LOT-1044', process: 'Painting 26 inch Kalpi', assignedTo: 'Mahesh', colors: ['Black'] },
];

const q = (query, rows = LOTS) => MApp.Search.run(MApp.Search.index(rows, SPEC), query);
const nums = res => res.map(r => r.lotNumber);

describe('negation', () => {
  test('-token excludes instead of returning exactly what was excluded', () => {
    // The old behaviour: "-kalpi" -> norm -> "kalpi" -> the two Kalpi lots.
    expect(nums(q('-kalpi'))).toEqual(['LOT-1043']);
  });

  test('negation composes with ordinary tokens', () => {
    expect(nums(q('painting -rakesh'))).toEqual(['LOT-1044']);
  });

  test('a bare hyphen is not treated as negation', () => {
    // "-" alone, or a hyphenated document number, must stay literal.
    expect(nums(q('lot-1042'))).toEqual(['LOT-1042']);
    expect(() => q('-')).not.toThrow();
  });

  test('excluding everything returns nothing rather than everything', () => {
    expect(q('-inch')).toEqual([]);
  });
});

describe('field scoping', () => {
  test('field:value matches only within that field', () => {
    expect(nums(q('assignedTo:rakesh'))).toEqual(['LOT-1042']);
  });

  test('the field can be named by its label as well as its key', () => {
    expect(nums(q('colour:blue'))).toEqual(['LOT-1043']);
    expect(nums(q('lot:1043'))).toEqual(['LOT-1043']);
  });

  test('scoping actually constrains -- a value in the wrong field does not match', () => {
    // "kalpi" is in `process`, so scoping it to assignedTo must find
    // nothing. If this returned rows, scoping would be decoration.
    expect(q('assignedTo:kalpi')).toEqual([]);
  });

  test('-field:value excludes', () => {
    expect(nums(q('painting -assignedTo:rakesh'))).toEqual(['LOT-1044']);
  });

  test('an unknown field searches the value instead of silently returning nothing', () => {
    const res = q('supplier:rakesh');
    expect(nums(res)).toEqual(['LOT-1042']);
    // …and says the qualifier was ignored, so the operator is not left
    // believing they filtered by a field that does not exist.
    expect(res._meta.unknownFields).toEqual(['supplier']);
  });
});

describe('quoted phrases', () => {
  test('a quoted phrase must appear contiguously', () => {
    expect(nums(q('"26 inch"'))).toEqual(['LOT-1042', 'LOT-1044']);
    // The same words in the wrong order are not the phrase.
    expect(q('"inch 26"')).toEqual([]);
  });

  test('an unquoted pair is still just two tokens', () => {
    // Order-independent, unlike the quoted form above.
    expect(nums(q('inch 26'))).toEqual(['LOT-1042', 'LOT-1044']);
  });

  test('a negated phrase excludes', () => {
    expect(nums(q('-"26 inch"'))).toEqual(['LOT-1043']);
  });
});

describe('short-token noise', () => {
  test('a short token must sit at a word start', () => {
    // "rim" previously matched "T-rim-ming", which is noise on a parts list.
    expect(q('rim')).toEqual([]);
  });

  test('but short-token prefix search still works', () => {
    expect(nums(q('kal'))).toEqual(['LOT-1042', 'LOT-1044']);
    expect(nums(q('ran'))).toEqual(['LOT-1043']);
  });

  test('longer tokens keep plain substring matching', () => {
    // A document number with no separator to sit behind must stay findable.
    const rows = [{ lotNumber: 'LOT1042', process: '', assignedTo: '', colors: [] }];
    expect(nums(q('1042', rows))).toEqual(['LOT1042']);
  });
});

describe('fuzzy fallback', () => {
  test('a one-character typo on a long word still finds the row', () => {
    const res = q('kalpli');
    expect(nums(res)).toEqual(['LOT-1042', 'LOT-1044']);
    expect(res._meta.fuzzy).toBe(true);
  });

  test('a transposition is tolerated', () => {
    expect(nums(q('painitng')).length).toBeGreaterThan(0);
  });

  test('fuzzy NEVER runs when the exact pass found something', () => {
    // The safety property: an approximate match cannot displace, dilute
    // or outrank a real one. "kalpi" matches exactly, so the result set
    // must be the exact one and must not be flagged approximate.
    const res = q('kalpi');
    expect(nums(res)).toEqual(['LOT-1042', 'LOT-1044']);
    expect(res._meta.fuzzy).toBe(false);
  });

  test('short tokens are never fuzzed', () => {
    // "red" vs "rod" vs "bed" is a guess this app must not make.
    expect(q('rod')).toEqual([]);
    expect(q('bue')).toEqual([]);
  });

  test('the slack scales with token length, and stops', () => {
    expect(MApp.Search._maxEdits('abc')).toBe(0);
    expect(MApp.Search._maxEdits('abcd')).toBe(1);
    expect(MApp.Search._maxEdits('abcdefg')).toBe(2);
    // Two edits on a 6-char word is too loose to be safe.
    expect(q('kelpa')).toEqual([]);
  });

  test('nonsense still returns nothing', () => {
    expect(q('zzzzzzzz')).toEqual([]);
    expect(q('qwertyuiop')).toEqual([]);
  });

  test('every token must match for a fuzzy hit, same as exact', () => {
    // One typo'd token plus one that matches nothing is still no match.
    expect(q('kalpli zzzzzzzz')).toEqual([]);
  });
});

describe('result metadata', () => {
  test('rides along without changing the row or array shape', () => {
    const res = q('kalpi');
    expect(Array.isArray(res)).toBe(true);
    expect(Object.keys(res)).not.toContain('_meta');
    expect(JSON.parse(JSON.stringify(res))).toHaveLength(2);
  });

  test('an empty query reports neither fuzz nor unknown fields', () => {
    const res = q('');
    expect(res._meta.fuzzy).toBe(false);
    expect(res._meta.unknownFields).toEqual([]);
  });
});

describe('the grammar cannot break the matcher', () => {
  test.each([
    '-', '--', '"', '""', ':', 'a:', ':b', '-:', '"unclosed', 'a:"b c"',
    '((', '*', '.*', '\\', '-"', 'field:-value',
  ])('survives %p', query => {
    expect(() => q(query)).not.toThrow();
  });
});
