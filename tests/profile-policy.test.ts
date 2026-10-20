import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;
let file: string;
const CONFIG = `[auth]
email=default@example.invalid
password=default-password
[community]
name=default-pool
[player]
name=Default Player
[profile.ha-account]
email=ha@example.invalid
password=ha-password
community=ha-pool
player=HA Player
[profile.chat-account]
email=chat@example.invalid
password=chat-password
community=chat-pool
`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-policy-'));
  file = path.join(root, 'config.ini');
  fs.writeFileSync(file, CONFIG);
  vi.stubEnv('KICKTIPP_CONFIG_DIR', root);
  vi.stubEnv('KICKTIPP_PROFILE_LOCK', 'ha-account');
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('optional process profile policy', () => {
  it('pins selection and hides other profiles while ignoring environment account overrides', async () => {
    const config = await import('../src/config.js');
    vi.stubEnv('KICKTIPP_PROFILE', 'chat-account');
    vi.stubEnv('KICKTIPP_EMAIL', 'wrong@example.invalid');
    vi.stubEnv('KICKTIPP_PASSWORD', 'wrong');
    vi.stubEnv('KICKTIPP_COMMUNITY', 'wrong-pool');
    vi.stubEnv('KICKTIPP_PLAYER', 'Wrong Player');
    config.setCommunityOverride('also-wrong');
    expect(config.getActiveProfile()).toBe('ha-account');
    expect(config.listProfiles()).toEqual(['ha-account']);
    expect(config.loadCommunity()).toBe('ha-pool');
    expect(config.loadPlayer()).toBe('HA Player');
    await expect(config.loadCredentials()).resolves.toEqual({ email: 'ha@example.invalid', password: 'ha-password' });
    expect(() => config.setActiveProfile('chat-account')).toThrow(/not allowed/);
    expect(() => config.setActiveProfile(null)).toThrow(/not allowed/);
    expect(() => config.sessionFile('chat-account')).toThrow(/not allowed/);
    await expect(config.loadProfileCredentials('chat-account')).rejects.toThrow(/not allowed/);
    config.setActiveProfile('ha-account');
  });

  it('never falls back to classic credentials or settings for an empty locked profile', async () => {
    fs.writeFileSync(file, CONFIG.replace(/\[profile.ha-account\][\s\S]*?(?=\[profile.chat-account\])/, '[profile.ha-account]\nstore=password\n'));
    vi.stubEnv('KICKTIPP_EMAIL', 'override@example.invalid');
    vi.stubEnv('KICKTIPP_PASSWORD', 'override');
    const config = await import('../src/config.js');
    expect(config.loadCommunity()).toBeNull();
    expect(config.loadPlayer()).toBeNull();
    expect(config.hasCredentials()).toBe(false);
    expect(config.hasUsableAuth()).toBe(false);
    await expect(config.loadCredentials()).rejects.toThrow(/no stored credentials/);
  });

  it('does not replace a session-only account with environment credentials', async () => {
    fs.writeFileSync(file, CONFIG.replace('password=ha-password', 'store=session'));
    vi.stubEnv('KICKTIPP_EMAIL', 'override@example.invalid');
    vi.stubEnv('KICKTIPP_PASSWORD', 'override');
    const config = await import('../src/config.js');
    expect(config.isSessionOnly()).toBe(true);
    expect(config.hasUsableAuth()).toBe(true);
    await expect(config.loadCredentials()).rejects.toBeInstanceOf(config.SessionOnlyExpiredError);
  });

  it('blocks account setup, credential replacement, and logout without changing disk', async () => {
    const config = await import('../src/config.js');
    const { startSetupListener } = await import('../src/setup/listener.js');
    await expect(config.saveAuth({ email: 'new@example.invalid', password: 'new' })).rejects.toThrow(/locked/);
    await expect(config.logout()).rejects.toThrow(/locked/);
    expect(() => startSetupListener()).toThrow(/locked/);
    expect(fs.readFileSync(file, 'utf8')).toBe(CONFIG);
  });

  it('blocks other explicit clients, sessions and admin actions before network access', async () => {
    const { createScopedClient } = await import('../src/client.js');
    const { launchBrowser, Page } = await import('../src/browser.js');
    const { fetchMembers, fetchBetsForMember, placeBetsForMember } = await import('../src/core.js');
    const fetchImpl = vi.fn();
    expect(() => createScopedClient({ profileId: 'chat-account', communityId: 'pool', fetchImpl })).toThrow(/not allowed/);
    await expect(launchBrowser({ profileId: 'chat-account', fetchImpl })).rejects.toThrow(/not allowed/);
    await expect(launchBrowser({ profileId: 'ha-account', sessionFile: path.join(root, 'session-chat-account.json'), fetchImpl })).rejects.toThrow(/another session file/);
    const page = new Page(undefined, fetchImpl);
    const member = { name: 'Other', tipperId: '2', tippsaisonId: '1', dummy: false };
    await expect(fetchMembers(page, 'pool')).rejects.toThrow(/locked/);
    await expect(fetchBetsForMember(page, 'pool', member)).rejects.toThrow(/locked/);
    await expect(placeBetsForMember(page, 'pool', member, ['A vs B=1:0'], 1, false)).rejects.toThrow(/locked/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('decrypts only under the original hostname and OS user identity', async () => {
    vi.stubEnv('KICKTIPP_PROFILE_LOCK', '');
    vi.spyOn(os, 'hostname').mockReturnValue('source-container');
    const config = await import('../src/config.js');
    config.setActiveProfile('ha-account');
    await config.saveAuth({ email: 'ha@example.invalid', password: 'encrypted-password' });
    expect(fs.readFileSync(file, 'utf8')).toContain('enc.');
    vi.stubEnv('KICKTIPP_PROFILE_LOCK', 'ha-account');
    await expect(config.loadCredentials()).resolves.toMatchObject({ password: 'encrypted-password' });
    vi.mocked(os.hostname).mockReturnValue('different-container');
    await expect(config.loadCredentials()).rejects.toThrow();
    vi.mocked(os.hostname).mockReturnValue('source-container');
    vi.spyOn(os, 'userInfo').mockReturnValue({ ...os.userInfo(), username: 'different-user' });
    await expect(config.loadCredentials()).rejects.toThrow();
  });

  it('keeps the existing multi-profile behavior when the policy is absent', async () => {
    vi.stubEnv('KICKTIPP_PROFILE_LOCK', '');
    const config = await import('../src/config.js');
    config.setActiveProfile('chat-account');
    expect(config.getActiveProfile()).toBe('chat-account');
    expect(config.listProfiles()).toEqual(['chat-account', 'ha-account']);
    config.setActiveProfile(null);
    expect(config.loadCommunity()).toBe('default-pool');
  });
});
