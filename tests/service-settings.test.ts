import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyServiceConfig, configuredCommunities, readServiceConfig, writeServiceConfig, validateServiceConfig, profileServiceConfig, resolveServiceProfile, serviceProfileDataDir, type LegacyServiceConfig } from '../src/service/settings.js';

export function exampleConfig(): LegacyServiceConfig {
  return {
    version: 1, account: { email: 'person@example.com', password: 'fixture-password', community: 'my-pool', site: 'de' },
    server: { token: 'a'.repeat(43), host: '127.0.0.1', port: 8787, readOnly: true, allowedOrigins: [] },
    timeZone: 'Europe/Berlin', notifications: { channels: [], everyMinutes: 15, warnHours: [24, 6, 1] },
  };
}
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-settings-')); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('service configuration', () => {
  it('keeps legacy single-pool files unchanged while exposing their tracked group', () => {
    const legacy = exampleConfig();
    const valid = validateServiceConfig(legacy);
    expect(profileServiceConfig(valid, valid.profiles[0])).toEqual(legacy);
    expect(configuredCommunities(valid.profiles[0])).toEqual(['my-pool']);
    expect(valid.profiles[0].account).not.toHaveProperty('communities');
  });

  it('persists normalized tracked groups with a primary and rejects invalid group sets', () => {
    const config = exampleConfig();
    config.account.communities = [' my-pool ', 'work'];
    const valid = validateServiceConfig(config);
    expect(configuredCommunities(valid.profiles[0])).toEqual(['my-pool', 'work']);
    const file = path.join(root, 'multiple-groups.json');
    writeServiceConfig(valid, file);
    expect(readServiceConfig(file)).toEqual(valid);
    const copy = configuredCommunities(valid.profiles[0]);
    copy.push('untracked');
    expect(valid.profiles[0].account.communities).toEqual(['my-pool', 'work']);
    for (const groups of [[], ['work'], ['my-pool', 'my-pool'], ['my-pool', ' my-pool '], ['my-pool', '../other'], Array.from({ length: 51 }, (_, i) => i ? `pool-${i}` : 'my-pool')]) {
      config.account.communities = groups;
      expect(() => validateServiceConfig(config)).toThrow(/account/);
    }
  });

  it('round trips restricted secret file and reports missing/invalid config without values', () => {
    const file = path.join(root, 'service.json');
    expect(() => readServiceConfig(file)).toThrow(/setup/);
    writeServiceConfig(exampleConfig(), file);
    expect(readServiceConfig(file)).toEqual(validateServiceConfig(exampleConfig()));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    fs.writeFileSync(file, 'not-json-secret');
    expect(() => readServiceConfig(file)).toThrow(/syntax/);
    expect(() => readServiceConfig(file)).not.toThrow(/not-json-secret/);
  });

  it('rejects invalid cadence, token, timezone, channels and browser origins', () => {
    for (const mutate of [
      (c: any) => { c.notifications.warnHours = [0]; },
      (c: any) => { c.notifications.everyMinutes = -1; },
      (c: any) => { c.server.token = 'secret'; },
      (c: any) => { c.timeZone = 'not/a-zone'; },
      (c: any) => { c.server.allowedOrigins = ['https://example.com/path']; },
      (c: any) => { c.notifications.channels = [{ id: 'telegram', kind: 'telegram', botToken: 'secret', chatId: '1' }]; },
    ]) {
      const config = exampleConfig(); mutate(config);
      expect(() => validateServiceConfig(config)).toThrow();
      try { validateServiceConfig(config); } catch (error) { expect(String(error)).not.toContain('secret'); }
    }
  });

  it('rejects duplicate channel IDs and normalizes warning times', () => {
    const config = exampleConfig();
    config.notifications.warnHours = [1, 24, 6, 1];
    expect(validateServiceConfig(config).profiles[0].notifications.warnHours).toEqual([24, 6, 1]);
    config.notifications.channels = [1, 2].map(() => ({ id: 'same', kind: 'webhook', url: 'https://example.com/hook' }));
    expect(() => validateServiceConfig(config)).toThrow(/unique/);
  });

  it('keeps service config discoverable and isolates account sessions and data', async () => {
    for (const key of ['KICKTIPP_SERVICE_CONFIG', 'KICKTIPP_CONFIG_DIR', 'KICKTIPP_DATA_DIR', 'KICKTIPP_EMAIL', 'KICKTIPP_PASSWORD', 'KICKTIPP_COMMUNITY', 'KICKTIPP_PLAYER', 'KICKTIPP_SITE', 'KICKTIPP_TZ', 'KICKTIPP_READ_ONLY', 'KICKTIPP_PROFILE']) vi.stubEnv(key, process.env[key]);
    const file = path.join(root, 'service.json');
    vi.stubEnv('KICKTIPP_SERVICE_CONFIG', file);
    const config = exampleConfig();
    writeServiceConfig(config, file);
    applyServiceConfig(config);
    const first = process.env.KICKTIPP_DATA_DIR;
    const { sessionFile } = await import('../src/config.js');
    const session = sessionFile();
    expect(process.env.KICKTIPP_READ_ONLY).toBe('1');
    expect(readServiceConfig()).toEqual(validateServiceConfig(config));
    applyServiceConfig(config);
    expect(process.env.KICKTIPP_DATA_DIR).toBe(first);
    applyServiceConfig({ ...config, account: { ...config.account, email: 'other@example.com' } });
    expect(process.env.KICKTIPP_DATA_DIR).not.toBe(first);
    expect(sessionFile()).not.toBe(session);
  });
});

describe('multiple service profiles', () => {
  it('migrates a legacy file without losing settings or rewriting it during a read', () => {
    const legacy = exampleConfig();
    legacy.server.readOnly = false;
    legacy.account.player = 'Player';
    legacy.account.communities = ['my-pool', 'work'];
    legacy.notifications.channels = [{ id: 'hook', kind: 'webhook', url: 'https://example.com/private' }];
    const file = path.join(root, 'service.json');
    const contents = JSON.stringify(legacy);
    fs.writeFileSync(file, contents);
    const migrated = readServiceConfig(file);
    expect(migrated).toMatchObject({ version: 2, profiles: [{ id: 'default', name: 'Default', readOnly: false }] });
    expect(profileServiceConfig(migrated, migrated.profiles[0])).toEqual(legacy);
    expect(fs.readFileSync(file, 'utf8')).toBe(contents);
    writeServiceConfig(migrated, file);
    expect(readServiceConfig(file)).toEqual(migrated);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(2);
  });

  it('requires explicit selection with multiple profiles and never falls back for unknown IDs', () => {
    const config = validateServiceConfig(exampleConfig());
    expect(resolveServiceProfile(config).id).toBe('default');
    config.profiles.push({ ...structuredClone(config.profiles[0]), id: 'family', name: 'Family' });
    expect(() => resolveServiceProfile(config)).toThrow(/Profile required/);
    expect(() => resolveServiceProfile(config, 'unknown')).toThrow(/Unknown profile/);
    expect(resolveServiceProfile(config, 'family').name).toBe('Family');
    config.profiles = [];
    expect(() => resolveServiceProfile(config)).toThrow(/Setup required/);
  });

  it('has no arbitrary profile-count limit and rejects conflicting IDs or names', () => {
    const config = validateServiceConfig(exampleConfig());
    config.profiles = Array.from({ length: 150 }, (_, index) => ({ ...structuredClone(config.profiles[0]), id: `profile-${index}`, name: `Profile ${index}` }));
    expect(validateServiceConfig(config).profiles).toHaveLength(150);
    config.profiles[1].name = ' PROFILE 0 ';
    expect(() => validateServiceConfig(config)).toThrow(/unique/);
    config.profiles[1].name = 'Family';
    config.profiles[1].id = config.profiles[0].id;
    expect(() => validateServiceConfig(config)).toThrow(/unique/);
    config.profiles[1].id = '../other-profile';
    expect(() => validateServiceConfig(config)).toThrow();
  });

  it('separates two profiles of the same account while preserving legacy state for default', () => {
    const file = path.join(root, 'service.json');
    vi.stubEnv('KICKTIPP_SERVICE_CONFIG', file);
    for (const key of ['KICKTIPP_CONFIG_DIR', 'KICKTIPP_DATA_DIR', 'KICKTIPP_EMAIL', 'KICKTIPP_PASSWORD', 'KICKTIPP_COMMUNITY', 'KICKTIPP_PLAYER', 'KICKTIPP_SITE', 'KICKTIPP_TZ', 'KICKTIPP_READ_ONLY', 'KICKTIPP_PROFILE']) vi.stubEnv(key, process.env[key]);
    const config = validateServiceConfig(exampleConfig());
    const first = config.profiles[0];
    const second = { ...structuredClone(first), id: 'family', name: 'Family' };
    config.profiles.push(second);
    applyServiceConfig(exampleConfig());
    const legacyDir = process.env.KICKTIPP_DATA_DIR;
    expect(serviceProfileDataDir(config, first, file)).toBe(legacyDir);
    applyServiceConfig(profileServiceConfig(config, first), first.id);
    expect(process.env.KICKTIPP_DATA_DIR).toBe(legacyDir);
    applyServiceConfig(profileServiceConfig(config, second), second.id);
    expect(process.env.KICKTIPP_DATA_DIR).toBe(serviceProfileDataDir(config, second, file));
    expect(process.env.KICKTIPP_DATA_DIR).not.toBe(legacyDir);
    const originalSecond = process.env.KICKTIPP_DATA_DIR;
    second.name = 'Renamed';
    expect(serviceProfileDataDir(config, second, file)).toBe(originalSecond);
    second.account.email = 'other@example.com';
    expect(serviceProfileDataDir(config, second, file)).not.toBe(originalSecond);
  });
});
