import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { mockFetch, page as htmlPage, type Handler, type RecordedRequest } from './helpers/mock-fetch.js';

const BASE = 'https://www.kicktipp.com';
const LOGIN = `${BASE}/info/profil/login`;
const COMMUNITIES = `${BASE}/info/profil/meinetipprunden`;
const EMAIL = 'me@example.com';
const PASSWORD = 'correct horse';

const LOGIN_FORM = htmlPage(`
  <form method="post" action="/info/profil/login">
    <input type="hidden" name="csrf" value="tok">
    <input type="text" name="kennung" value="">
    <input type="password" name="passwort" value="">
    <button type="submit" name="submitbutton" value="Anmelden">Anmelden</button>
  </form>`);

function communityList(slugs: string[]): string {
  const links = slugs.map((s) => `<a href="/${s}/">${s}</a>`).join('\n');
  return htmlPage(`<div id="kicktipp-content">${links}</div>`);
}

function kicktipp(slugs: string[]): Handler {
  return (req: RecordedRequest) => {
    const url = req.url.replace('https://www.kicktipp.de', BASE);
    const authenticated = (req.headers.get('cookie') || '').includes('sid=valid');
    if (url === LOGIN) {
      if (req.method === 'GET') return LOGIN_FORM;
      const body = new URLSearchParams(req.body || '');
      if (body.get('kennung') === EMAIL && body.get('passwort') === PASSWORD) {
        return { status: 302, location: '/', setCookies: ['sid=valid; Path=/; HttpOnly'] };
      }
      return LOGIN_FORM;
    }
    if (!authenticated) return { status: 302, location: '/info/profil/login' };
    if (url === COMMUNITIES) return communityList(slugs);
    if (url === `${BASE}/`) return htmlPage('home');
    return undefined;
  };
}

function originOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function tokenOf(url: string): string {
  return new URL(url).searchParams.get('token') ?? '';
}

function post(
  url: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Origin: originOf(url),
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams({ token: tokenOf(url), ...body }).toString(),
  });
}

function rawRequest(opts: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-setup-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  delete process.env.KICKTIPP_EMAIL;
  delete process.env.KICKTIPP_PASSWORD;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(home, { recursive: true, force: true });
});

async function startListener(slugs: string[]) {
  const { startSetupListener } = await import('../src/setup/listener.js');
  const { fetchImpl } = mockFetch(kicktipp(slugs));
  return startSetupListener({ fetchImpl, timeoutMs: 8_000 });
}

describe('the localhost setup listener', () => {
  it('saves a login and shuts down after a successful form submit', async () => {
    const handle = await startListener(['mycomm']);
    const res = await post(handle.url, {
      step: 'login',
      email: EMAIL,
      password: PASSWORD,
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toMatch(/Connected/);
    expect(html).not.toContain(PASSWORD);
    expect(await handle.finished).toBe('saved');

    const ini = fs.readFileSync(path.join(home, '.config', 'kicktipp-agent', 'config.ini'), 'utf8');
    expect(ini).toContain(EMAIL);
    expect(ini).not.toContain(PASSWORD);
    expect(ini).toMatch(/mycomm/);
    const session = JSON.parse(
      fs.readFileSync(path.join(home, '.config', 'kicktipp-agent', 'session.json'), 'utf8'),
    );
    expect(session.cookies).toContainEqual(expect.objectContaining({ name: 'sid', value: 'valid' }));
  });

  it('lets the user pick a community when the account has more than one', async () => {
    const handle = await startListener(['alpha', 'beta']);
    const loginRes = await post(handle.url, { step: 'login', email: EMAIL, password: PASSWORD });
    expect(await loginRes.text()).toMatch(/Choose a community/);
    const save = await post(handle.url, { step: 'community', community: 'beta' });
    expect(await save.text()).toMatch(/Connected/);
    expect(await handle.finished).toBe('saved');
    const ini = fs.readFileSync(path.join(home, '.config', 'kicktipp-agent', 'config.ini'), 'utf8');
    expect(ini).toMatch(/beta/);
    expect(ini).not.toMatch(/community.*alpha/);
  });

  it('persists the chosen site and language', async () => {
    const handle = await startListener(['mycomm']);
    await post(handle.url, {
      step: 'login',
      email: EMAIL,
      password: PASSWORD,
      site: 'de',
      language: 'de',
    });
    expect(await handle.finished).toBe('saved');
    const ini = fs.readFileSync(path.join(home, '.config', 'kicktipp-agent', 'config.ini'), 'utf8');
    expect(ini).toMatch(/language\s*=\s*de/);
    expect(ini).toMatch(/site\s*=\s*de/);
  });

  it('stores a session without a password when asked', async () => {
    const handle = await startListener(['mycomm']);
    await post(handle.url, {
      step: 'login',
      email: EMAIL,
      password: PASSWORD,
      store: 'session',
    });
    expect(await handle.finished).toBe('saved');
    const ini = fs.readFileSync(path.join(home, '.config', 'kicktipp-agent', 'config.ini'), 'utf8');
    expect(ini).toMatch(/store\s*=\s*session/);
    expect(ini).not.toMatch(/^password\s*=/m);
    expect(ini).not.toContain(PASSWORD);
  });

  it('keeps the listener up after a bad password, and never echoes it', async () => {
    const handle = await startListener(['mycomm']);
    const res = await post(handle.url, {
      step: 'login',
      email: EMAIL,
      password: PASSWORD + ' no',
    });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toMatch(/Sign-in failed/);
    expect(html).not.toContain(PASSWORD);
    const again = await fetch(handle.url);
    expect(again.status).toBe(200);
    await handle.close();
  });

  it('still accepts a real submit after the browser GETs /setup without a token', async () => {
    // Browsers prefetch or request the form action (`/setup`) with no query
    // string. That used to burn the one-shot token and print "Setup did not finish."
    const handle = await startListener(['mycomm']);
    expect((await fetch(handle.url)).status).toBe(200);
    const origin = originOf(handle.url);
    const prefetch = await fetch(`${origin}/setup`);
    expect(prefetch.status).toBe(403);
    const res = await post(handle.url, { step: 'login', email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Connected/);
    expect(await handle.finished).toBe('saved');
  });

  it('accepts a loopback form POST that has no Origin header', async () => {
    const handle = await startListener(['mycomm']);
    const url = new URL(handle.url);
    const body = new URLSearchParams({
      token: tokenOf(handle.url),
      step: 'login',
      email: EMAIL,
      password: PASSWORD,
    }).toString();
    const res = await rawRequest({
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${url.port}`,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(body)),
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/Connected/);
    expect(await handle.finished).toBe('saved');
  });

  it('refuses a wrong token on POST and then shuts down', async () => {
    const handle = await startListener(['mycomm']);
    const res = await post(handle.url, {
      token: '0'.repeat(64),
      step: 'login',
      email: EMAIL,
      password: PASSWORD,
    });
    expect(res.status).toBe(403);
    expect(await handle.finished).toBe('rejected');
    await expect(fetch(handle.url)).rejects.toThrow();
  });

  it('refuses a second use of the token after success', async () => {
    const handle = await startListener(['mycomm']);
    await post(handle.url, { step: 'login', email: EMAIL, password: PASSWORD });
    expect(await handle.finished).toBe('saved');
    await expect(fetch(handle.url)).rejects.toThrow();
  });

  it('refuses a cross-origin POST without shutting the page down', async () => {
    const handle = await startListener(['mycomm']);
    const res = await post(
      handle.url,
      { step: 'login', email: EMAIL, password: PASSWORD },
      { Origin: 'http://evil.example' },
    );
    expect(res.status).toBe(403);
    const retry = await post(handle.url, { step: 'login', email: EMAIL, password: PASSWORD });
    expect(retry.status).toBe(200);
    expect(await handle.finished).toBe('saved');
  });

  it('refuses a non-loopback Host header without shutting the page down', async () => {
    const handle = await startListener(['mycomm']);
    const url = new URL(handle.url);
    const res = await rawRequest({
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      headers: { host: `example.com:${url.port}` },
    });
    expect(res.status).toBe(403);
    expect((await fetch(handle.url)).status).toBe(200);
    await handle.close();
  });

  it('times out', async () => {
    const { startSetupListener } = await import('../src/setup/listener.js');
    const handle = await startSetupListener({ timeoutMs: 30 });
    expect(await handle.finished).toBe('timeout');
  });
});
