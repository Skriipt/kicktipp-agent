import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchBrowser, getCommunities, Page } from '../src/browser.js';
import { CookieJar } from '../src/http/cookie-jar.js';
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

const COMMUNITY_LIST = htmlPage(`
  <div id="kicktipp-content">
    <a href="/mycomm/">MyComm</a>
    <a href="/other">Other</a>
    <a href="/mein_pool">Mein Pool</a>
    <a href="/langtipp-wc-26"><div class="menu-title-mit-tippglocke">Langtipp WC 26</div></a>
    <a href="/service">Service</a>
    <a href="/hilfe">Something Else</a>
    <a href="/info/profil/meinetipprunden">Profil</a>
    <a href="/mycomm/tippabgabe">Tippabgabe</a>
    <a href="https://example.com/">External</a>
  </div>`);

/** A small stand-in for Kicktipp: cookie-gated pages behind a login form. */
function kicktipp(): Handler {
  return (req: RecordedRequest) => {
    const authenticated = (req.headers.get('cookie') || '').includes('sid=valid');

    if (req.url === LOGIN) {
      if (req.method === 'GET') return LOGIN_FORM;
      const body = new URLSearchParams(req.body || '');
      if (body.get('kennung') === EMAIL && body.get('passwort') === PASSWORD) {
        return { status: 302, location: '/', setCookies: ['sid=valid; Path=/; HttpOnly'] };
      }
      return LOGIN_FORM; // a rejected login re-renders the form
    }

    if (!authenticated) return { status: 302, location: '/info/profil/login' };
    if (req.url === COMMUNITIES) return COMMUNITY_LIST;
    if (req.url === `${BASE}/`) return htmlPage('home');
    return undefined;
  };
}

let tmpDir: string;
let sessionFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-test-'));
  sessionFile = path.join(tmpDir, 'session.json');
  vi.stubEnv('KICKTIPP_EMAIL', EMAIL);
  vi.stubEnv('KICKTIPP_PASSWORD', PASSWORD);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('launchBrowser', () => {
  it('logs in and reaches an authenticated page', async () => {
    const { fetchImpl, calls } = mockFetch(kicktipp());
    const page = await launchBrowser({ sessionFile, fetchImpl });

    expect(calls.some((c) => c.method === 'POST' && c.url === LOGIN)).toBe(true);
    await expect(getCommunities(page)).resolves.toContain('mycomm');
  });

  it('sends the login form complete with its hidden fields', async () => {
    const { fetchImpl, calls } = mockFetch(kicktipp());
    await launchBrowser({ sessionFile, fetchImpl });

    const post = calls.find((c) => c.method === 'POST')!;
    const body = new URLSearchParams(post.body || '');
    expect(body.get('csrf')).toBe('tok');
    expect(body.get('kennung')).toBe(EMAIL);
    expect(body.get('submitbutton')).toBe('Anmelden');
  });

  it('reports a rejected login as a plain error', async () => {
    vi.stubEnv('KICKTIPP_PASSWORD', 'wrong');
    const { fetchImpl } = mockFetch(kicktipp());

    await expect(launchBrowser({ sessionFile, fetchImpl })).rejects.toThrow(/Login failed/);
  });

  it('writes the session file with owner-only permissions', async () => {
    const { fetchImpl } = mockFetch(kicktipp());
    await launchBrowser({ sessionFile, fetchImpl });

    expect(fs.existsSync(sessionFile)).toBe(true);
    expect(fs.statSync(sessionFile).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    expect(stored.cookies).toContainEqual(
      expect.objectContaining({ name: 'sid', value: 'valid' }),
    );
  });

  it('keeps the session in memory when asked to', async () => {
    const { fetchImpl } = mockFetch(kicktipp());
    await launchBrowser({ sessionFile: null, fetchImpl });

    expect(fs.existsSync(sessionFile)).toBe(false);
  });

  it('reuses a stored session instead of logging in again', async () => {
    const first = mockFetch(kicktipp());
    await launchBrowser({ sessionFile, fetchImpl: first.fetchImpl });

    const second = mockFetch(kicktipp());
    const page = await launchBrowser({ sessionFile, fetchImpl: second.fetchImpl });

    expect(second.calls.some((c) => c.method === 'POST')).toBe(false);
    await expect(getCommunities(page)).resolves.toContain('mycomm');
  });

  it('logs in again when the stored session has expired', async () => {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ cookies: [{ name: 'sid', value: 'expired', domain: 'www.kicktipp.com' }] }),
    );

    const { fetchImpl, calls } = mockFetch(kicktipp());
    const page = await launchBrowser({ sessionFile, fetchImpl });

    expect(calls.some((c) => c.method === 'POST' && c.url === LOGIN)).toBe(true);
    await expect(getCommunities(page)).resolves.toContain('mycomm');
  });

  it('logs in again when the stored session file is corrupt', async () => {
    fs.writeFileSync(sessionFile, 'not json at all');

    const { fetchImpl, calls } = mockFetch(kicktipp());
    await launchBrowser({ sessionFile, fetchImpl });

    expect(calls.some((c) => c.method === 'POST' && c.url === LOGIN)).toBe(true);
  });

  it('accepts a Playwright storageState file left over from an older version', async () => {
    const first = mockFetch(kicktipp());
    await launchBrowser({ sessionFile, fetchImpl: first.fetchImpl });
    // Same shape Playwright wrote, with its extra fields.
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        cookies: [
          {
            name: 'sid',
            value: 'valid',
            domain: '.kicktipp.com',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      }),
    );

    const second = mockFetch(kicktipp());
    await launchBrowser({ sessionFile, fetchImpl: second.fetchImpl });
    expect(second.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('session-only storage', () => {
  let home: string;
  let stdinTty: boolean | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-session-only-'));
    stdinTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    vi.unstubAllEnvs();
    delete process.env.KICKTIPP_EMAIL;
    delete process.env.KICKTIPP_PASSWORD;
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('asks to reconnect instead of logging in again when the cookie is dead', async () => {
    const dir = path.join(home, '.config', 'kicktipp-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.ini'), '[auth]\nemail = me@example.com\nstore = session\n');
    fs.writeFileSync(
      path.join(dir, 'session.json'),
      JSON.stringify({ cookies: [{ name: 'sid', value: 'expired', domain: 'www.kicktipp.com' }] }),
    );

    const { launchBrowser: launch } = await import('../src/browser.js');
    const { SessionOnlyExpiredError } = await import('../src/config.js');
    const { mockFetch: mf } = await import('./helpers/mock-fetch.js');
    const { fetchImpl } = mf(kicktipp());

    await expect(launch({ fetchImpl })).rejects.toBeInstanceOf(SessionOnlyExpiredError);
  });
});

describe('getCommunities', () => {
  it('lists single-segment community links and skips the rest', async () => {
    const { fetchImpl } = mockFetch(kicktipp());
    const page = await launchBrowser({ sessionFile: null, fetchImpl });

    // Nested pages, the reserved /service link and external links are not
    // communities; /mycomm and /other are.
    await expect(getCommunities(page)).resolves.toEqual([
      'mycomm',
      'other',
      'mein_pool',
      'langtipp-wc-26',
    ]);
  });

  it('leaves out single-segment links that are not communities', async () => {
    const { fetchImpl } = mockFetch(kicktipp());
    const page = await launchBrowser({ sessionFile: null, fetchImpl });

    const found = await getCommunities(page);
    // /service is reserved; /hilfe's label does not match its slug.
    expect(found).not.toContain('service');
    expect(found).not.toContain('hilfe');
  });

  it('decodes an escaped community slug', async () => {
    const handler: Handler = (req) =>
      req.url === COMMUNITIES
        ? htmlPage('<div id="kicktipp-content"><a href="/my%20comm/">My Comm</a></div>')
        : kicktipp()(req);
    const { fetchImpl } = mockFetch(handler);
    const page = await launchBrowser({ sessionFile: null, fetchImpl });

    await expect(getCommunities(page)).resolves.toEqual(['my comm']);
  });

  it('says the session is unauthenticated rather than returning nothing', async () => {
    const { fetchImpl } = mockFetch(kicktipp());
    const page = await launchBrowser({ sessionFile: null, fetchImpl });
    await page.close();

    const loggedOut = new Page(
      new CookieJar(),
      mockFetch((req) =>
        req.url === LOGIN
          ? LOGIN_FORM
          : { status: 302, location: '/info/profil/login' },
      ).fetchImpl,
    );

    await expect(getCommunities(loggedOut)).rejects.toThrow(/not authenticated/i);
  });
});

describe('expired session with no stored password', () => {
  let home: string;
  let stdinTty: boolean | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-nologin-'));
    stdinTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    vi.unstubAllEnvs();
    delete process.env.KICKTIPP_EMAIL;
    delete process.env.KICKTIPP_PASSWORD;
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdinTty });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('errors instead of waiting for a hidden login prompt', async () => {
    const session = path.join(home, '.config', 'kicktipp-agent', 'session.json');
    fs.mkdirSync(path.dirname(session), { recursive: true });
    fs.writeFileSync(
      session,
      JSON.stringify({ cookies: [{ name: 'sid', value: 'expired', domain: 'www.kicktipp.com' }] }),
    );

    const { launchBrowser: launch } = await import('../src/browser.js');
    const { mockFetch: mf } = await import('./helpers/mock-fetch.js');
    const { fetchImpl } = mf(kicktipp());

    await expect(launch({ fetchImpl })).rejects.toThrow(/No credentials found/i);
  });
});
