import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockFetch, page as htmlPage } from './helpers/mock-fetch.js';

let root: string;
let configDir: string;
let dataDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-auth-paths-'));
  configDir = path.join(root, 'config');
  dataDir = path.join(root, 'data');
  fs.mkdirSync(configDir);
  vi.stubEnv('HOME', path.join(root, 'unused-home'));
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'unused-home'));
  vi.stubEnv('KICKTIPP_CONFIG_DIR', configDir);
  vi.stubEnv('KICKTIPP_DATA_DIR', dataDir);
  vi.stubEnv('KICKTIPP_PROFILE', '');
  vi.stubEnv('KICKTIPP_BASE_URL', 'https://www.kicktipp.com');
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

const config = '[profile.work]\nemail = fixture@example.invalid\nstore = session\n';

describe('container authentication paths', () => {
  it('keeps colliding legacy names isolated through scoped clients and restores compatible cookies', async () => {
    const ids = ['a/b', 'a?b', 'a_b'];
    fs.writeFileSync(path.join(configDir, 'config.ini'), ids.map((id) =>
      `[profile.${id}]\nemail = ${id}@example.invalid\npassword = fixture-password\n`,
    ).join('\n'));
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, 'session-a_b.json'), JSON.stringify({
      cookies: [{ name: 'sid', value: 'a_b', domain: 'www.kicktipp.com' }],
    }));
    const { createScopedClient } = await import('../src/client.js');
    const { sessionFile } = await import('../src/config.js');
    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url.endsWith('/info/profil/login')) {
        if (req.method === 'GET') return htmlPage('<form method="post"><input name="kennung"><input name="passwort"></form>');
        const email = new URLSearchParams(req.body).get('kennung')!;
        return { status: 302, location: '/', setCookies: [`sid=${email.split('@')[0]}; Path=/`] };
      }
      return htmlPage(req.headers.get('cookie') || 'none');
    });
    for (const id of ids) {
      const client = createScopedClient({ profileId: id, communityId: 'fixture', fetchImpl });
      await expect(client.read(async (page) => {
        await page.goto('https://www.kicktipp.com/fixture/');
        return page.content();
      })).resolves.toContain(`sid=${id}`);
      expect(JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')).cookies[0].value).toBe(id);
    }
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('uses the crash-safe shared lock for session mutations', async () => {
    const { withAuthProfileMutation } = await import('../src/auth-profile-lock.js');
    const { FileLock, LockUnavailableError, observeLock } = await import('../src/service/lock.js');
    await withAuthProfileMutation('work', () => {
      const name = fs.readdirSync(dataDir).find((entry) => entry.endsWith('.lock'))!;
      const file = path.join(dataDir, name);
      expect(observeLock(file).status).toBe('held');
      expect(() => FileLock.acquire(file)).toThrow(LockUnavailableError);
    });
  });

  it('reads mounted config.ini while placing sessions and mutation locks in writable data', async () => {
    fs.writeFileSync(path.join(configDir, 'config.ini'), config);
    const { loadProfileCredentials, sessionFile, isProfileSessionOnly, saveUiLanguage } = await import('../src/config.js');
    const { withAuthProfileMutation } = await import('../src/auth-profile-lock.js');
    expect(isProfileSessionOnly('work')).toBe(true);
    await expect(loadProfileCredentials('work')).rejects.toThrow(/session expired/i);
    expect(sessionFile('work')).toBe(path.join(dataDir, 'session-work.json'));
    await withAuthProfileMutation('work', () => {
      expect(fs.readdirSync(dataDir).some((name) => name.endsWith('.lock'))).toBe(true);
      expect(fs.readdirSync(configDir)).toEqual(['config.ini']);
    });
    saveUiLanguage('de');
    expect(fs.readFileSync(path.join(configDir, 'config.ini'), 'utf8')).toContain('language=de');
    expect(fs.existsSync(path.join(root, 'unused-home'))).toBe(false);
  });
});
