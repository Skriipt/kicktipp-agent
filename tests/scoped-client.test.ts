import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FetchLike } from '../src/http/page.js';

const BASE = 'https://www.kicktipp.com';
const LOGIN = `${BASE}/info/profil/login`;
const COMMUNITIES = `${BASE}/info/profil/meinetipprunden`;
const LOGIN_FORM = `<!doctype html><form method="post" action="/info/profil/login">
  <input name="kennung"><input name="passwort"><button name="submitbutton" value="Anmelden">Login</button>
</form>`;

let home: string;
let configDir: string;

function session(profileId: string, value: string): void {
  fs.writeFileSync(
    path.join(configDir, `session-${profileId}.json`),
    JSON.stringify({ cookies: [{ name: 'sid', value, domain: 'www.kicktipp.com' }] }),
  );
}

function fakeKicktipp() {
  const calls: Array<{ url: string; method: string; email?: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const cookie = headers.get('cookie') ?? '';
    calls.push({ url, method });

    if (url === LOGIN && method === 'GET') return new Response(LOGIN_FORM);
    if (url === LOGIN && method === 'POST') {
      const body = new URLSearchParams(String(init.body));
      const email = body.get('kennung') ?? '';
      calls.at(-1)!.email = email;
      const account = email.startsWith('a@') ? 'a' : email.startsWith('b@') ? 'b' : '';
      return new Response('', {
        status: 302,
        headers: account
          ? { location: '/', 'set-cookie': `sid=${account}; Path=/; HttpOnly` }
          : { location: '/info/profil/login' },
      });
    }

    const account = cookie.match(/sid=([ab])/)?.[1];
    if (!account) return new Response('', { status: 302, headers: { location: '/info/profil/login' } });
    if (url === `${BASE}/`) return new Response('home');
    if (url === COMMUNITIES) return new Response(`<div id="kicktipp-content">${account}</div>`);
    return new Response(account);
  };
  return { calls, fetchImpl };
}

async function modules() {
  const config = await import('../src/config.js');
  const client = await import('../src/client.js');
  const core = await import('../src/core.js');
  return { config, client, core };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-scoped-'));
  configDir = path.join(home, '.config', 'kicktipp-agent');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.ini'), `[profile.a]
email = a@example.com
password = a-pass
community = interactive-a

[profile.b]
email = b@example.com
password = b-pass
community = interactive-b
`);
  vi.unstubAllEnvs();
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('scoped Kicktipp client', () => {
  it('stays on its Auth Profile and Community after interactive selection changes', async () => {
    const { config, client } = await modules();
    const fake = fakeKicktipp();
    const scoped = client.createScopedClient({
      profileId: 'a',
      communityId: 'service-community',
      fetchImpl: fake.fetchImpl,
    });

    config.setActiveProfile('b');
    const result = await scoped.read(async (page, communityId) => {
      await page.goto(`${BASE}/${communityId}/probe`);
      return { account: (await page.content()).includes('a') ? 'a' : 'b', communityId };
    });

    expect(result).toEqual({ account: 'a', communityId: 'service-community' });
    expect(fake.calls.filter((call) => call.method === 'POST')).toEqual([
      expect.objectContaining({ email: 'a@example.com' }),
    ]);
    expect(config.loadCommunity()).toBe('interactive-b');
  });

  it('serializes one expired-session refresh while reads remain parallel', async () => {
    const { client } = await modules();
    const fake = fakeKicktipp();
    const scoped = client.createScopedClient({ profileId: 'a', communityId: 'pool', fetchImpl: fake.fetchImpl });
    session('a', 'expired');

    await Promise.all([
      scoped.read(async (_page, community) => community),
      scoped.read(async (_page, community) => community),
    ]);
    expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(1);

    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    const read = () => scoped.read(async () => {
      arrived += 1;
      if (arrived === 2) release();
      await bothArrived;
      return arrived;
    });
    await expect(Promise.all([read(), read()])).resolves.toHaveLength(2);
  });

  it('does not make a mutation for one Auth Profile wait on another', async () => {
    const { withAuthProfileMutation } = await import('../src/auth-profile-lock.js');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const profileA = withAuthProfileMutation('a', async () => {
      entered();
      await held;
    });
    await started;

    await expect(withAuthProfileMutation('b', () => 'profile-b')).resolves.toBe('profile-b');
    release();
    await profileA;
  });

  it('refreshes a session that expires during a read through the same profile path', async () => {
    const { client, core } = await modules();
    const fake = fakeKicktipp();
    session('a', 'a');
    const scoped = client.createScopedClient({ profileId: 'a', communityId: 'pool', fetchImpl: fake.fetchImpl });
    let attempts = 0;

    const result = await scoped.read(async () => {
      attempts += 1;
      if (attempts === 1) {
        session('a', 'expired');
        throw new core.AuthError('expired');
      }
      return 'refreshed';
    });

    expect(result).toBe('refreshed');
    expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'session-a.json'), 'utf8'))).toEqual(
      expect.objectContaining({ cookies: expect.any(Array) }),
    );
  });

  it('fails closed when a saved session cannot be validated', async () => {
    const { client } = await modules();
    session('a', 'a');
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push(String(input));
      throw new Error('network unavailable');
    };
    const scoped = client.createScopedClient({ profileId: 'a', communityId: 'pool', fetchImpl });

    await expect(scoped.read(async () => 'unreachable')).rejects.toThrow('network unavailable');
    expect(calls).toEqual([COMMUNITIES]);
  });
});
