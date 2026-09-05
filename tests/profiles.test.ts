import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

let home: string;
let configFile: string;

/**
 * config.ts reads HOME at module load, so each case re-imports it against a
 * fresh temporary home.
 */
async function loadConfig(contents: string) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, contents);
  vi.resetModules();
  return import('../src/config.js');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-profile-'));
  configFile = path.join(home, '.config', 'kicktipp-agent', 'config.ini');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(home, { recursive: true, force: true });
});

const CLASSIC = `[auth]
email = me@example.com
password = secret
[community]
name = default-pool
[player]
name = Me
`;

const WITH_PROFILES = `${CLASSIC}
[profile.work]
email = work@example.com
password = workpass
community = office-pool
player = Chris

[profile.family]
email = family@example.com
password = familypass
community = family-pool
player = Papa
`;

describe('a config with no profiles behaves exactly as before', () => {
  it('reads the classic sections', async () => {
    const config = await loadConfig(CLASSIC);
    expect(config.loadCommunity()).toBe('default-pool');
    expect(config.loadPlayer()).toBe('Me');
    expect(config.hasCredentials()).toBe(true);
    expect(config.listProfiles()).toEqual([]);
    expect(config.sessionFile().endsWith('session.json')).toBe(true);
  });
});

describe('profiles', () => {
  it('are listed by name', async () => {
    const config = await loadConfig(WITH_PROFILES);
    expect(config.listProfiles()).toEqual(['family', 'work']);
  });

  it('override community, player and credentials when active', async () => {
    const config = await loadConfig(WITH_PROFILES);
    config.setActiveProfile('work');
    expect(config.loadCommunity()).toBe('office-pool');
    expect(config.loadPlayer()).toBe('Chris');
    await expect(config.loadCredentials()).resolves.toMatchObject({
      email: 'work@example.com',
    });
  });

  it('fall back to the default sections when switched off again', async () => {
    const config = await loadConfig(WITH_PROFILES);
    config.setActiveProfile('family');
    expect(config.loadCommunity()).toBe('family-pool');
    config.setActiveProfile(null);
    expect(config.loadCommunity()).toBe('default-pool');
  });

  it('get their own session file, so two accounts never share cookies', async () => {
    const config = await loadConfig(WITH_PROFILES);
    config.setActiveProfile('work');
    const work = config.sessionFile();
    config.setActiveProfile('family');
    const family = config.sessionFile();
    expect(work).not.toBe(family);
    expect(work).toMatch(/session-work\.json$/);
  });

  it('never aliases profile names through lossy filename sanitization', async () => {
    const config = await loadConfig(WITH_PROFILES);
    const names = ['a/b', 'a?b', 'a_b', 'a%2Fb', 'ü', '_', '../work', '.._work'];
    const files = names.map((name) => config.sessionFile(name));
    expect(new Set(files).size).toBe(names.length);
    for (const file of files) expect(path.dirname(file)).toBe(path.dirname(configFile));
    expect(config.sessionFile(null)).toBe(path.join(path.dirname(configFile), 'session.json'));
    expect(config.sessionFile('work')).toBe(path.join(path.dirname(configFile), 'session-work.json'));
  });

  it('report a name that does not exist instead of silently using defaults', async () => {
    const config = await loadConfig(WITH_PROFILES);
    config.setActiveProfile('nope');
    expect(() => config.loadCommunity()).toThrow(/No profile 'nope'/);
  });

  it('are selectable through KICKTIPP_PROFILE', async () => {
    const config = await loadConfig(WITH_PROFILES);
    vi.stubEnv('KICKTIPP_PROFILE', 'work');
    expect(config.getActiveProfile()).toBe('work');
    expect(config.loadCommunity()).toBe('office-pool');
  });

  it('save the community into the active profile', async () => {
    const config = await loadConfig(WITH_PROFILES);
    config.setActiveProfile('work');
    config.saveCommunity('new-pool');
    expect(config.loadCommunity()).toBe('new-pool');
    config.setActiveProfile(null);
    // The default profile is untouched.
    expect(config.loadCommunity()).toBe('default-pool');
  });

  it('never falls back to the default account for a selected session-only profile', async () => {
    const config = await loadConfig(WITH_PROFILES.replace('password = workpass', 'store = session'));
    config.setActiveProfile('work');
    expect(config.hasCredentials()).toBe(false);
    await expect(config.loadCredentials()).rejects.toMatchObject({ name: 'SessionOnlyExpiredError' });
  });

  it('keeps unrelated settings and other profiles when logging out one profile', async () => {
    const config = await loadConfig(`${WITH_PROFILES}\n[ui]\nlanguage = de\n`);
    config.setActiveProfile('work');
    fs.writeFileSync(config.sessionFile(), '{}');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await config.logout();

    expect(fs.existsSync(path.join(path.dirname(configFile), 'session-work.json'))).toBe(false);
    config.setActiveProfile(null);
    expect(config.loadCommunity()).toBe('default-pool');
    expect(config.listProfiles()).toEqual(['family']);
    expect(config.readUiLanguage()).toBe('de');
  });
});

describe('shared config mutation lock', () => {
  it('can save credentials while its caller owns the session lock', async () => {
    const config = await loadConfig(CLASSIC);
    const { withAuthProfileMutation } = await import('../src/auth-profile-lock.js');
    await withAuthProfileMutation(null, () => config.saveAuth({ email: 'new@example.test', password: 'new-secret' }));
    expect(await config.loadCredentials()).toEqual({ email: 'new@example.test', password: 'new-secret' });
  });

  it('fails fast while another process owns the shared config lock', async () => {
    const config = await loadConfig(CLASSIC);
    const lockFile = path.join(
      path.dirname(configFile),
      `config-${crypto.createHash('sha256').update(configFile).digest('hex').slice(0, 16)}.lock`,
    );
    const moduleUrl = pathToFileURL(fileURLToPath(new URL('../dist/service/lock.js', import.meta.url))).href;
    const child = fork(fileURLToPath(new URL('./helpers/config-mutation-child.mjs', import.meta.url)),
      [moduleUrl, lockFile], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
      const [message] = await once(child, 'message');
      expect(message).toEqual({ status: 'held' });
      expect(() => config.saveCommunity('blocked')).toThrow(/lock is already held/i);
      expect(config.loadCommunity()).toBe('default-pool');
    } finally {
      if (child.connected) child.send('release');
      await once(child, 'exit');
    }
  });
});

describe('community override', () => {
  it('wins over both the profile and the default', async () => {
    const config = await loadConfig(WITH_PROFILES);
    config.setCommunityOverride('one-off');
    expect(config.loadCommunity()).toBe('one-off');
    config.setActiveProfile('work');
    expect(config.loadCommunity()).toBe('one-off');
    config.setCommunityOverride(null);
    expect(config.loadCommunity()).toBe('office-pool');
  });

  it('can also come from the environment', async () => {
    const config = await loadConfig(CLASSIC);
    vi.stubEnv('KICKTIPP_COMMUNITY', 'from-env');
    expect(config.loadCommunity()).toBe('from-env');
  });
});

describe('[ui] language and site', () => {
  it('are missing until saved, then persist together', async () => {
    const config = await loadConfig(CLASSIC);
    expect(config.readUiLanguage()).toBeNull();
    expect(config.readUiSite()).toBeNull();
    config.saveUiLanguage('de');
    config.saveUiSite('de');
    expect(config.readUiLanguage()).toBe('de');
    expect(config.readUiSite()).toBe('de');
    const ini = fs.readFileSync(configFile, 'utf8');
    expect(ini).toMatch(/\[ui\]/);
    expect(ini).toMatch(/language\s*=\s*de/);
    expect(ini).toMatch(/site\s*=\s*de/);
  });
});
