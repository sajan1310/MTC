/**
 * A session that lapsed under an open page is recovered in place.
 *
 * 2026-11-06, 09:23: a phone left on the app overnight sent ten calls and
 * every one came back 401 "Your session has expired" -- its 24-hour session
 * had gone, though its remember-me cookie would have signed it straight back
 * in. The only way out was reloading the app. api.js now asks the server for
 * the new session's token once (GET /api/erp/csrf-token, which the cookie
 * answers), puts it in the page and repeats the call.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function loadApi() {
  const src = [
    fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8'),
    'global.Api = Api;',
  ].join('\n');
  eval(src);
}

function response({ status = 200, json }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: '',
    headers: { get: name => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

const EXPIRED = { status: 401, json: { success: false, data: null, message: 'Your session has expired. Please sign in again.' } };
const TOKEN = token => ({ status: 200, json: { success: true, data: { csrfToken: token } } });
const OK = data => ({ status: 200, json: { success: true, data } });

/**
 * fetch() that answers the token route with `tokenReply` and each RPC from
 * `rpcReplies` in turn (the last one repeats), recording what was sent.
 */
function server({ rpcReplies, tokenReply = TOKEN('fresh-token') }) {
  const sent = [];
  let i = 0;
  global.fetch = jest.fn(async (url, opts = {}) => {
    sent.push({ url, headers: { ...(opts.headers || {}) } });
    if (url === '/api/erp/csrf-token') return response(tokenReply);
    const reply = rpcReplies[Math.min(i, rpcReplies.length - 1)];
    i += 1;
    return response(reply);
  });
  return {
    rpcs: () => sent.filter(s => s.url.startsWith('/api/erp/rpc/')),
    tokenAsks: () => sent.filter(s => s.url === '/api/erp/csrf-token'),
  };
}

beforeEach(() => {
  document.head.innerHTML = '<meta name="csrf-token" content="token-of-the-session-that-lapsed">';
  loadApi();
});

afterEach(() => {
  delete global.fetch;
});

const pageToken = () => document.querySelector('meta[name="csrf-token"]').getAttribute('content');

test('a lapsed session is renewed and the call goes through', async () => {
  const s = server({ rpcReplies: [EXPIRED, OK(['Red'])] });

  await expect(Api.call('getColors')).resolves.toEqual({ success: true, data: ['Red'] });

  expect(s.tokenAsks()).toHaveLength(1);
  expect(pageToken()).toBe('fresh-token');
  expect(s.rpcs().map(r => r.headers['X-CSRFToken'])).toEqual([
    'token-of-the-session-that-lapsed',
    'fresh-token',
  ]);
});

test('calls that fail together share one renewal', async () => {
  const s = server({ rpcReplies: [EXPIRED, EXPIRED, EXPIRED, OK(1), OK(2), OK(3)] });

  const results = await Promise.all([
    Api.call('getColors'), Api.call('getModels'), Api.call('getProcessTypes'),
  ]);

  expect(results.every(r => r.success)).toBe(true);
  expect(s.tokenAsks()).toHaveLength(1);
});

test('a call answered 401 after another call renewed the session just goes again', async () => {
  // getModels is sent with the old token, but its 401 comes back only after
  // getColors has already renewed the session.
  let releaseModels;
  const modelsHeld = new Promise(r => { releaseModels = r; });
  const sent = [];
  let colorsCalls = 0;
  global.fetch = jest.fn(async (url, opts = {}) => {
    sent.push({ url, token: (opts.headers || {})['X-CSRFToken'] });
    if (url === '/api/erp/csrf-token') return response(TOKEN('fresh-token'));
    if (url.endsWith('/getColors')) return response(colorsCalls++ === 0 ? EXPIRED : OK('colors'));
    if (url.endsWith('/getModels')) {
      if (opts.headers['X-CSRFToken'] === 'fresh-token') return response(OK('models'));
      await modelsHeld;
      return response(EXPIRED);
    }
    throw new Error('unexpected ' + url);
  });

  const models = Api.call('getModels');
  await expect(Api.call('getColors')).resolves.toMatchObject({ data: 'colors' });
  releaseModels();
  await expect(models).resolves.toMatchObject({ data: 'models' });

  expect(sent.filter(s => s.url === '/api/erp/csrf-token')).toHaveLength(1);
  expect(sent.filter(s => s.url.endsWith('/getModels')).map(s => s.token))
    .toEqual(['token-of-the-session-that-lapsed', 'fresh-token']);
});

test('somebody really signed out still gets "session expired", asked once', async () => {
  const s = server({ rpcReplies: [EXPIRED], tokenReply: EXPIRED });

  await expect(Api.call('getColors')).rejects.toMatchObject({ isAuthError: true, status: 401 });

  expect(s.rpcs()).toHaveLength(1);
  expect(s.tokenAsks()).toHaveLength(1);
  expect(pageToken()).toBe('token-of-the-session-that-lapsed');
});

test('a refused renewal is not asked for again on every call', async () => {
  const s = server({ rpcReplies: [EXPIRED], tokenReply: EXPIRED });

  await Api.call('getColors').catch(() => {});
  await Api.call('getModels').catch(() => {});
  await Api.call('getProcessTypes').catch(() => {});

  expect(s.rpcs()).toHaveLength(3);
  expect(s.tokenAsks()).toHaveLength(1);
});

test('a call is repeated once, never in a loop', async () => {
  const s = server({ rpcReplies: [EXPIRED, EXPIRED] });

  await expect(Api.call('getColors')).rejects.toMatchObject({ status: 401 });

  expect(s.rpcs()).toHaveLength(2);
  expect(s.tokenAsks()).toHaveLength(1);
});

test('a save keeps its mutation id when it is repeated', async () => {
  const s = server({ rpcReplies: [EXPIRED, OK({ saved: true })] });

  await expect(Api.mutate('saveColor', { name: 'Red' })).resolves.toMatchObject({ success: true });

  const ids = s.rpcs().map(r => r.headers['X-Mutation-Id']);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBeTruthy();
  expect(ids[1]).toBe(ids[0]);
});

test('the new token is announced, for the service worker\'s copy', async () => {
  server({ rpcReplies: [EXPIRED, OK(null)] });
  const heard = [];
  document.addEventListener('api:csrf-refreshed', e => heard.push(e.detail.token));

  await Api.call('getColors');

  expect(heard).toEqual(['fresh-token']);
});
