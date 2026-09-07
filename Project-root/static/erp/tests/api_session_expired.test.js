/**
 * An expired session must not surface as a JSON parse error.
 *
 * Flask-Login's default unauthorized handler redirects to the login page.
 * `fetch()` follows that redirect silently, so an RPC issued by a tab whose
 * session had since expired resolved with status 200 and an HTML body --
 * api.js called res.json() on `<!DOCTYPE html>` and every caller reported
 * `SyntaxError: Unexpected token '<'`. The one seen in the wild was
 * App.Logo.load's console.warn, but it was every RPC in that tab.
 *
 * The server now answers /api/ with a JSON 401 (create_app's _unauthorized);
 * these cover the client half: the 401 branch, and the belt-and-braces
 * non-JSON guard for anything between the browser and this app (an SSO page,
 * a captive portal, a proxy error page) that still answers 200 with HTML.
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

/** A response object shaped like the one fetch() hands back. */
function response({ status = 200, contentType = 'application/json', json, text, redirected = false, url = '/api/erp/rpc/getLogo' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    url,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => {
      if (json !== undefined) return json;
      // What res.json() actually does to an HTML body -- the bug's symptom.
      return JSON.parse(text);
    },
    // The non-JSON guard reads the body to report WHAT came back.
    text: async () => (text !== undefined ? text : JSON.stringify(json)),
  };
}

beforeEach(() => {
  document.body.innerHTML = '<meta name="csrf-token" content="tok">';
  loadApi();
});

afterEach(() => {
  delete global.fetch;
});

const LOGIN_PAGE = '<!DOCTYPE html>\n<html><head><title>Sign in</title></head><body></body></html>';

describe('a signed-out session', () => {
  test('a 401 envelope becomes a readable auth error, not a parse error', async () => {
    global.fetch = jest.fn(async () => response({
      status: 401,
      json: { success: false, data: null, message: 'Your session has expired. Please sign in again.' },
    }));

    await expect(Api.call('getLogo')).rejects.toMatchObject({
      message: 'Your session has expired. Please sign in again.',
      isAuthError: true,
      isHttpError: true,
      status: 401,
    });
  });

  test('a 401 is NOT a network error, so the outbox marks it failed rather than looping', async () => {
    global.fetch = jest.fn(async () => response({ status: 401, json: { success: false } }));

    const err = await Api.mutate('saveLogo', ['data:image/png;base64,x']).catch(e => e);
    expect(err.isNetworkError).toBeUndefined();
    expect(err.isHttpError).toBe(true);
  });

  test('a 200 HTML login page is reported as a sign-out, not SyntaxError', async () => {
    global.fetch = jest.fn(async () => response({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      text: LOGIN_PAGE,
      redirected: true,
      url: 'https://erp.example.com/login?next=%2Ferp',
    }));

    const err = await Api.call('getLogo').catch(e => e);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect(err.message).toMatch(/session has expired/i);
    expect(err.isAuthError).toBe(true);
    // The diagnostics that identify WHICH box produced the page.
    expect(err.finalUrl).toContain('/login');
    expect(err.responseSnippet).toContain('<!DOCTYPE html>');
  });

  test('a non-login HTML page says so plainly and keeps the body for the console', async () => {
    global.fetch = jest.fn(async () => response({
      status: 200,
      contentType: 'text/html',
      text: '<!DOCTYPE html><html><body>502 Bad Gateway - upstream unavailable</body></html>',
      url: '/api/erp/rpc/getStockData',
    }));

    const err = await Api.call('getStockData').catch(e => e);
    expect(err.message).toMatch(/page instead of data/i);
    expect(err.responseSnippet).toContain('502 Bad Gateway');
  });

  test('a failed read is not cached, so signing back in works without a reload', async () => {
    let status = 401;
    global.fetch = jest.fn(async () =>
      status === 401
        ? response({ status: 401, json: { success: false, message: 'expired' } })
        : response({ status: 200, json: { success: true, data: 'data:image/png;base64,x' } })
    );

    await expect(Api.call('getLogo')).rejects.toBeDefined();
    status = 200;
    await expect(Api.call('getLogo')).resolves.toMatchObject({ success: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('an ordinary JSON response still passes through untouched', async () => {
    global.fetch = jest.fn(async () => response({ status: 200, json: { success: true, data: 42 } }));
    await expect(Api.call('getLogo')).resolves.toEqual({ success: true, data: 42 });
  });
});
