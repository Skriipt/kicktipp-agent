import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
