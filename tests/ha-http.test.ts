import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { FetchLike } from '../src/browser.js';

const TOKEN = 'fixture-token-for-local-tests-only-123456789';
let root: string;
let server: Server | undefined;
let base: string;
let calls: Array<{ url: string; method: string; cookie: string; body: string }>;
let failSubmission: boolean;
let submissionResponse: 'ok' | 'http-error' | 'auth-redirect';
let upstream: FetchLike;

function form(account: string): string {
  return `<div id="kicktipp-content"><div class="pagetitle">${account}</div>
    <form method="post" action="/ha-pool/predict"><input type="hidden" name="token" value="fixture-csrf">
    <table id="tippabgabeSpiele"><tbody><tr><td>21.10.26 20:30</td><td>Home</td><td>Away</td>
    <td><input id="r1_heimTipp" name="r1_heimTipp" value=""><input id="r1_gastTipp" name="r1_gastTipp" value=""></td>
    </tr></tbody></table><button type="submit" name="submitbutton" value="save">Save</button></form></div>`;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-ha-'));
  fs.writeFileSync(path.join(root, 'config.ini'), `[profile.ha-account]
email=ha@example.invalid
password=ha-password
community=ha-pool
[profile.chat-account]
email=chat@example.invalid
password=chat-password
community=chat-pool
`);
  for (const name of ['ha-account', 'chat-account']) {
    fs.writeFileSync(path.join(root, `session-${name}.json`), JSON.stringify({
      cookies: [{ name: 'sid', value: name, domain: 'www.kicktipp.com' }],
    }));
  }
  vi.stubEnv('KICKTIPP_CONFIG_DIR', root);
  vi.stubEnv('KICKTIPP_DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('KICKTIPP_PROFILE', 'ha-account');
  vi.stubEnv('KICKTIPP_PROFILE_LOCK', 'ha-account');
  vi.stubEnv('KICKTIPP_READ_ONLY', '0');
  vi.resetModules();
  failSubmission = false;
  submissionResponse = 'ok';
  calls = [];
  upstream = async (input, init) => {
    const url = String(input);
    const cookie = new Headers(init.headers).get('cookie') ?? '';
    const method = init.method ?? 'GET';
    calls.push({ url, cookie, method, body: String(init.body ?? '') });
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (method === 'POST' && failSubmission) throw new Error('private-upstream-token /private/config/path');
    if (method === 'POST' && submissionResponse === 'http-error') return new Response('private error', { status: 500 });
    if (method === 'POST' && submissionResponse === 'auth-redirect') return new Response('', { status: 302, headers: { location: '/info/profil/login' } });
    return new Response(url.includes('/predict') ? form(cookie) : '<div id="kicktipp-content"></div>');
  };
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
    server = undefined;
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

async function start(token = TOKEN): Promise<void> {
  const { createHaServer } = await import('../src/ha/http.js');
  server = createHaServer({ token, fetchImpl: upstream });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  base = `http://127.0.0.1:${address.port}`;
}

function request(route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${route}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } });
}

function post(body: unknown, route = '/v1/bets'): Promise<Response> {
  return request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('HA HTTP boundary', () => {
  it('requires an explicit configured profile, a matching lock, and a strong bearer token', async () => {
    const { createHaServer, requiredHaProfile } = await import('../src/ha/http.js');
    vi.stubEnv('KICKTIPP_PROFILE', '');
    expect(requiredHaProfile).toThrow(/KICKTIPP_PROFILE is required/);
    vi.stubEnv('KICKTIPP_PROFILE', 'ha-account');
    vi.stubEnv('KICKTIPP_PROFILE_LOCK', 'chat-account');
    expect(() => createHaServer({ token: TOKEN })).toThrow(/profile lock/);
    vi.stubEnv('KICKTIPP_PROFILE_LOCK', 'ha-account');
    expect(() => createHaServer({ token: '' })).toThrow(/bearer token/);
  });

  it('authenticates every route before any upstream access, including health and unknown routes', async () => {
    await start();
    for (const route of ['/v1/health', '/v1/status', '/v1/bets', '/v1/tip-status', '/unknown']) {
      const response = await fetch(`${base}${route}`);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect((await request('/v1/bets', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/v1/bets?token=${TOKEN}`)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('returns local health and status without credentials, paths, or network calls', async () => {
    await start();
    expect(await (await request('/v1/health')).json()).toEqual({ ok: true, profile: 'ha-account', community: 'ha-pool' });
    const response = await request('/v1/status');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ profile: 'ha-account', community: 'ha-pool', read_only: false, credentials_saved: true, session_only: false });
    expect(calls).toEqual([]);
  });

  it('reads own bets through the existing parser and pins the community despite overrides', async () => {
    vi.stubEnv('KICKTIPP_COMMUNITY', 'chat-pool');
    await start();
    const response = await request('/v1/bets?matchday=4');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile: 'ha-account', community: 'ha-pool', matchday: 4,
      data: { title: 'sid=ha-account', matches: [{ home: 'Home', away: 'Away', bet: '-' }] } });
    expect(calls.at(-1)?.url).toContain('/ha-pool/predict?spieltagIndex=4');
    expect(calls.every((call) => call.cookie === 'sid=ha-account')).toBe(true);
  });

  it('provides tip status through the existing read logic', async () => {
    await start();
    expect((await request('/v1/tip-status?matchday=3')).status).toBe(200);
    expect(calls.some((call) => call.url.includes('/ha-pool/leaderboard?spieltagIndex=3'))).toBe(true);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('has no account selection, generic tool dispatch, admin surface, or browser access', async () => {
    await start();
    for (const route of ['/v1/bets?profile=chat-account', '/v1/bets?community=chat-pool', '/v1/bets?member=Other', '/v1/bets?matchday=1&matchday=2', '/v1/bets?matchday=0']) {
      expect((await request(route)).status).toBe(400);
    }
    for (const route of ['/v1/set_profile', '/v1/place_bets_for_member', '/v1/tools']) {
      expect((await post({ name: 'chat-account' }, route)).status).toBe(404);
    }
    for (const field of ['profile', 'profileId', 'community', 'member', 'tipperId']) {
      expect((await post({ bets: ['Home vs Away=1:0'], [field]: 'chat-account' })).status).toBe(400);
    }
    expect((await request('/v1/bets', { headers: { Origin: 'https://example.invalid' } })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('defaults to dry run, requires explicit confirmation and respects read-only mode', async () => {
    await start();
    const preview = await post({ bets: ['Home vs Away=2:1'] });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ dry_run: true, placed: [{ homeGoals: 2, awayGoals: 1 }] });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    calls.length = 0;
    expect((await post({ bets: ['Home vs Away=2:1'], dry_run: false })).status).toBe(400);
    vi.stubEnv('KICKTIPP_READ_ONLY', '1');
    expect((await post({ bets: ['Home vs Away=2:1'], dry_run: false, confirm: true })).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await post({ bets: ['Home vs Away=2:1'] })).status).toBe(200);
  });

  it('submits only the explicit slip with the profile cookie, preserves CSRF, and audits the source', async () => {
    await start();
    const response = await post({ bets: ['Home vs Away=2:1'], matchday: 4, dry_run: false, confirm: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ profile: 'ha-account', dry_run: false });
    const submitted = calls.filter((call) => call.method === 'POST');
    expect(submitted).toHaveLength(1);
    expect(submitted[0].cookie).toBe('sid=ha-account');
    expect(new URLSearchParams(submitted[0].body).get('token')).toBe('fixture-csrf');
    expect(new URLSearchParams(submitted[0].body).get('r1_heimTipp')).toBe('2');
    const { readAudit } = await import('../src/audit/log.js');
    expect(readAudit('ha-pool').at(-1)).toMatchObject({ source: 'ha:place_bets', outcome: 'submitted' });
  });

  it('keeps parallel reads and serialized writes on independent pages of the configured account', async () => {
    await start();
    const responses = await Promise.all([
      request('/v1/bets?matchday=1'),
      request('/v1/bets?matchday=2'),
      post({ bets: ['Home vs Away=3:0'], matchday: 3, dry_run: false, confirm: true }),
      post({ bets: ['Home vs Away=0:1'], matchday: 4, dry_run: false, confirm: true }),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(calls.every((call) => call.cookie === 'sid=ha-account')).toBe(true);
    const writes = calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes.map((call) => new URLSearchParams(call.body).get('r1_heimTipp'))).toEqual(['3', '0']);
    expect(fs.readFileSync(path.join(root, 'session-chat-account.json'), 'utf8')).toContain('chat-account');
  });

  it('never retries a failed submission and returns only a safe indeterminate result', async () => {
    failSubmission = true;
    await start();
    const response = await post({ bets: ['Home vs Away=1:1'], dry_run: false, confirm: true });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'submission_unknown' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    failSubmission = false;
    expect((await post({ bets: ['Home vs Away=1:1'] })).status).toBe(200);
  });

  it.each(['http-error', 'auth-redirect'] as const)('does not mark an upstream %s as a successful submission', async (failure) => {
    submissionResponse = failure;
    await start();
    const response = await post({ bets: ['Home vs Away=1:1'], dry_run: false, confirm: true });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'submission_unknown' });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const { readAudit } = await import('../src/audit/log.js');
    expect(readAudit('ha-pool').some((record) => record.outcome === 'submitted')).toBe(false);
    expect(readAudit('ha-pool').at(-1)?.outcome).toMatch(/^failed:/);
  });

  it('rejects malformed, oversized, and non-JSON slips without contacting Kicktipp', async () => {
    await start();
    for (const bets of [[], ['Home vs Away=1x:0'], ['Home vs Away=-1:0'], ['Home vs Away=1:0:2']]) {
      expect((await post({ bets })).status).toBe(400);
    }
    expect((await request('/v1/bets', { method: 'POST', body: '{}' })).status).toBe(415);
    expect((await request('/v1/bets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
    const tooLarge = await post({ bets: ['x'.repeat(17_000)] });
    expect(tooLarge.status).toBe(413);
    expect((await request('/v1/status', { method: 'DELETE' })).status).toBe(405);
    expect(calls).toEqual([]);
  });
});
