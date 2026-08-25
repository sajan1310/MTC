/**
 * Api.mutate's per-action mutation id, and the request timeout
 * (DATA-003, REL-001).
 *
 * `mutate()` used to call `_newMutationId()` on every invocation, so the
 * server-side idempotency table could never match for ordinary desktop use --
 * it was pure write amplification, and double-submit protection rested
 * entirely on client-side button disabling, which a second tab, an Enter-key
 * repeat or a user-initiated retry all defeat.
 *
 * An id is now derived per USER ACTION (method + args) and held for
 * DEDUPE_WINDOW_MS, so one intended action that becomes two requests carries
 * one id and the server executes it once.
 *
 * Separately, `fetch()` has no default timeout, so a stalled request never
 * settled and the caller's spinner spun forever with no recovery but a page
 * reload.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadApi() {
  const src = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.Api = Api;',
  ].join('\n');
  // eslint-disable-next-line no-eval
  eval(src);
}

/** Capture the X-Mutation-Id of every request a test makes. */
function stubFetch(responder) {
  const seen = [];
  global.fetch = jest.fn((url, opts) => {
    seen.push({
      url,
      mutationId: opts.headers['X-Mutation-Id'],
      body: JSON.parse(opts.body),
      signal: opts.signal,
    });
    return responder
      ? responder(url, opts, seen.length)
      : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: null, message: '' }) });
  });
  return seen;
}

beforeEach(() => {
  jest.useRealTimers();
  document.body.innerHTML = '<meta name="csrf-token" content="tok">';
  loadApi();
});

afterEach(() => {
  delete global.fetch;
});

describe('DATA-003: one mutation id per user action', () => {
  test('the same save fired twice in quick succession reuses one id', async () => {
    const seen = stubFetch();
    const payload = { billNumber: 'B-1', vendor: 'Sharma' };

    await Api.mutate('saveBill', payload);
    await Api.mutate('saveBill', payload);

    expect(seen).toHaveLength(2);
    expect(seen[0].mutationId).toBe(seen[1].mutationId);
  });

  test('a double-click that fires both calls before either resolves shares an id', async () => {
    // The realistic shape of a double submit: the second click lands while
    // the first request is still in flight.
    let resolvers = [];
    const seen = stubFetch(() => new Promise(res => resolvers.push(res)));

    const first = Api.mutate('saveDispatch', { lines: [1] });
    const second = Api.mutate('saveDispatch', { lines: [1] });

    expect(seen).toHaveLength(2);
    expect(seen[0].mutationId).toBe(seen[1].mutationId);

    resolvers.forEach(r => r({ ok: true, status: 200, json: async () => ({ success: true }) }));
    await Promise.all([first, second]);
  });

  test('different arguments get different ids', async () => {
    const seen = stubFetch();
    await Api.mutate('saveBill', { billNumber: 'B-1' });
    await Api.mutate('saveBill', { billNumber: 'B-2' });
    expect(seen[0].mutationId).not.toBe(seen[1].mutationId);
  });

  test('different methods get different ids', async () => {
    const seen = stubFetch();
    await Api.mutate('saveBill', { x: 1 });
    await Api.mutate('saveUnit', { x: 1 });
    expect(seen[0].mutationId).not.toBe(seen[1].mutationId);
  });

  test('every id is a well-formed UUID', async () => {
    // rpc.py rejects anything else with a 400 before doing any work.
    const seen = stubFetch();
    await Api.mutate('saveBill', { billNumber: 'B-1' });
    expect(seen[0].mutationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  test('a network failure forgets the id so an immediate retry starts clean', async () => {
    // A request that never reached the server did not consume its claim, so
    // reusing the id would collide with a claim that was never taken.
    let attempt = 0;
    const seen = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    });

    await expect(Api.mutate('saveBill', { billNumber: 'B-9' })).rejects.toThrow();
    await Api.mutate('saveBill', { billNumber: 'B-9' });

    expect(seen).toHaveLength(2);
    expect(seen[0].mutationId).not.toBe(seen[1].mutationId);
  });

  test('an HTTP error keeps the id, so a retry reaches the stored envelope', async () => {
    // The server WAS reached, so it may have executed. Retrying with the same
    // id is what lets rpc.py replay the stored result instead of re-running.
    let attempt = 0;
    const seen = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.resolve({ ok: false, status: 500, json: async () => ({ message: 'boom' }) })
        : Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    });

    await expect(Api.mutate('saveBill', { billNumber: 'B-8' })).rejects.toThrow();
    await Api.mutate('saveBill', { billNumber: 'B-8' });

    expect(seen[0].mutationId).toBe(seen[1].mutationId);
  });

  test('mutateWithId still honours an explicitly supplied id', async () => {
    // The mobile offline outbox depends on this: it must replay a queued
    // action under the exact id its original attempt used.
    const seen = stubFetch();
    await Api.mutateWithId('saveBill', '11111111-2222-4333-8444-555555555555', { x: 1 });
    expect(seen[0].mutationId).toBe('11111111-2222-4333-8444-555555555555');
  });

  test('read calls carry no mutation id at all', async () => {
    const seen = stubFetch();
    await Api.call('getStockData');
    expect(seen[0].mutationId).toBeUndefined();
  });
});

describe('REL-001: request timeout', () => {
  test('an abort signal is attached to every request', () => {
    const seen = stubFetch();
    Api.call('getStockData');
    expect(seen[0].signal).toBeDefined();
  });

  test('an aborted request rejects as a retryable network error', async () => {
    stubFetch(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    // isNetworkError routes it into the offline outbox's existing retry
    // logic, unchanged -- an unresponsive server is indistinguishable from
    // an outage from here.
    await expect(Api.call('getStockData')).rejects.toMatchObject({
      isNetworkError: true,
      isTimeout: true,
    });
  });

  test('a genuine network failure is not reported as a timeout', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(Api.call('getStockData')).rejects.toMatchObject({
      isNetworkError: true,
      isTimeout: false,
    });
  });
});

describe('API-001: only successful envelopes are cached', () => {
  test('a failure envelope is not served from cache on retry', async () => {
    // Domain failures come back as HTTP 200 {success:false}, so the previous
    // unconditional cache replayed a transient error for 15s and a user
    // pressing the button again never reached the server.
    let attempt = 0;
    const seen = stubFetch(() => {
      attempt += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => (attempt === 1
          ? { success: false, data: null, message: 'Temporarily locked.' }
          : { success: true, data: [1], message: '' }),
      });
    });

    const first = await Api.call('getStockData');
    expect(first.success).toBe(false);

    const second = await Api.call('getStockData');
    expect(second.success).toBe(true);
    expect(seen).toHaveLength(2);   // the retry actually reached the server
  });

  test('a successful envelope IS cached', async () => {
    const seen = stubFetch();
    await Api.call('getStockData');
    await Api.call('getStockData');
    expect(seen).toHaveLength(1);
  });
});
