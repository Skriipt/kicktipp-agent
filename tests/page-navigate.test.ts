import { describe, it, expect } from 'vitest';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { mockFetch, routes, page as htmlPage } from './helpers/mock-fetch.js';

const BASE = 'https://www.kicktipp.com';

describe('Page.goto', () => {
  it('loads a page and exposes its content, url and status', async () => {
    const { fetchImpl } = mockFetch(routes({
      [`${BASE}/c/rules`]: htmlPage('<h1>Regeln</h1>'),
    }));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/c/rules`);

    expect(await page.content()).toContain('Regeln');
    expect(page.url()).toBe(`${BASE}/c/rules`);
    expect(page.status()).toBe(200);
    expect(page.isNotFound()).toBe(false);
  });

  it('resolves a relative URL against the current page', async () => {
    const { fetchImpl, calls } = mockFetch(routes({
      [`${BASE}/c/rules`]: htmlPage('one'),
      [`${BASE}/c/tables`]: htmlPage('two'),
    }));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/c/rules`);
    await page.goto('/c/tables');

    expect(calls.map((c) => c.url)).toEqual([`${BASE}/c/rules`, `${BASE}/c/tables`]);
  });
});

describe('redirects', () => {
  it('follows a 302 and reports the final URL', async () => {
    const { fetchImpl } = mockFetch(routes({
      [`${BASE}/start`]: { status: 302, location: '/end' },
      [`${BASE}/end`]: htmlPage('arrived'),
    }));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/start`);

    expect(page.url()).toBe(`${BASE}/end`);
    expect(await page.content()).toContain('arrived');
  });

  it('turns a 303 after POST into a GET without a body', async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url === `${BASE}/form`) {
        return req.method === 'GET'
          ? htmlPage('<form method="post" action="/form"><input name="a" value="1"><button type="submit" name="go">Go</button></form>')
          : { status: 303, location: '/done' };
      }
      if (req.url === `${BASE}/done`) return htmlPage('saved');
      return undefined;
    });
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/form`);
    await page.click('button[name="go"]');

    const last = calls[calls.length - 1];
    expect(last.method).toBe('GET');
    expect(last.body).toBeNull();
    expect(page.url()).toBe(`${BASE}/done`);
  });

  it('preserves method and body across a 307', async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url === `${BASE}/form`) {
        return req.method === 'GET'
          ? htmlPage('<form method="post" action="/form"><input name="a" value="1"><button type="submit" name="go">Go</button></form>')
          : { status: 307, location: '/elsewhere' };
      }
      if (req.url === `${BASE}/elsewhere`) return htmlPage('ok');
      return undefined;
    });
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/form`);
    await page.click('button[name="go"]');

    const last = calls[calls.length - 1];
    expect(last.method).toBe('POST');
    expect(last.body).toContain('a=1');
  });

  it('sends a Referer for the hop it came from', async () => {
    const { fetchImpl, calls } = mockFetch(routes({
      [`${BASE}/start`]: { status: 302, location: '/end' },
      [`${BASE}/end`]: htmlPage('arrived'),
    }));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/start`);

    expect(calls[1].headers.get('referer')).toBe(`${BASE}/start`);
  });

  it('gives up after too many redirects', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 302, location: '/loop' }));
    const page = new Page(new CookieJar(), fetchImpl);

    await expect(page.goto(`${BASE}/loop`)).rejects.toThrow(/Too many redirects/);
  });
});

describe('cookies across requests', () => {
  it('stores a Set-Cookie and sends it on the next request', async () => {
    const { fetchImpl, calls } = mockFetch((req) =>
      req.url === `${BASE}/one`
        ? { ...htmlPage('one'), setCookies: ['sid=abc; Path=/'] }
        : htmlPage('two'),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/one`);
    await page.goto(`${BASE}/two`);

    expect(calls[0].headers.get('cookie')).toBeNull();
    expect(calls[1].headers.get('cookie')).toBe('sid=abc');
  });

  it('picks up a cookie set on a redirect hop', async () => {
    const { fetchImpl, calls } = mockFetch(routes({
      [`${BASE}/login`]: { status: 302, location: '/home', setCookies: ['sid=abc'] },
      [`${BASE}/home`]: htmlPage('home'),
    }));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/login`);

    expect(calls[1].headers.get('cookie')).toBe('sid=abc');
  });

  it('does not carry the session to a host outside Kicktipp', async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url === `${BASE}/one`) {
        return { ...htmlPage('one'), setCookies: ['sid=abc'] };
      }
      if (req.url === `${BASE}/away`) {
        return { status: 302, location: 'https://tracker.example.com/x' };
      }
      return htmlPage('elsewhere');
    });
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/one`);
    await page.goto(`${BASE}/away`);

    const foreign = calls.find((c) => c.url.startsWith('https://tracker.example.com'));
    expect(foreign).toBeDefined();
    expect(foreign!.headers.get('cookie')).toBeNull();
  });
});

describe('route fallback', () => {
  it('retries the German spelling when the English one is missing', async () => {
    const { fetchImpl, calls } = mockFetch(routes({
      [`${BASE}/c/tippabgabe`]: htmlPage('Tippabgabe'),
    }));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/c/predict`);

    expect(await page.content()).toContain('Tippabgabe');
    expect(page.isNotFound()).toBe(false);
    expect(calls[0].url).toBe(`${BASE}/c/predict`);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('treats a 200 "not found" body as missing too', async () => {
    const { fetchImpl } = mockFetch(routes({
      [`${BASE}/c/predict`]: {
        status: 200,
        body: '<html><body>Seite wurde nicht gefunden</body></html>',
      },
      [`${BASE}/c/tippabgabe`]: htmlPage('Tippabgabe'),
    }));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/c/predict`);

    expect(await page.content()).toContain('Tippabgabe');
  });

  it('does not retry when the first response is fine', async () => {
    const { fetchImpl, calls } = mockFetch(routes({
      [`${BASE}/c/predict`]: htmlPage('Predict'),
    }));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/c/predict`);

    expect(calls).toHaveLength(1);
  });

  it('stays missing when no spelling exists', async () => {
    const { fetchImpl } = mockFetch(() => undefined);
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/nope/predict`);

    expect(page.isNotFound()).toBe(true);
  });
});

describe('state detection', () => {
  it('recognises a bounce to the login page', async () => {
    const { fetchImpl } = mockFetch(routes({
      [`${BASE}/c/predict`]: { status: 302, location: '/info/profil/login' },
      [`${BASE}/info/profil/login`]: htmlPage('<form></form>'),
    }));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/c/predict`);

    expect(page.isAuthRedirect()).toBe(true);
    expect(page.isAdminRequired()).toBe(false);
    expect(page.isNotFound()).toBe(false);
  });

  it('recognises the Spielleiter marker', async () => {
    const { fetchImpl } = mockFetch(routes({
      [`${BASE}/c/admin`]: { status: 302, location: '/info/profil/login?spielleiter=1' },
      [`${BASE}/info/profil/login?spielleiter=1`]: htmlPage('<form></form>'),
    }));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/c/admin`);

    expect(page.isAdminRequired()).toBe(true);
  });

  it('refuses to work once closed', async () => {
    const { fetchImpl } = mockFetch(() => htmlPage('x'));
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/c/rules`);
    await page.close();

    expect(page.isClosed()).toBe(true);
    await expect(page.goto(`${BASE}/c/rules`)).rejects.toThrow(/closed/);
  });
});
