import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'node:crypto';

let home: string;
let configFile: string;

async function loadConfig(contents?: string) {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  if (contents !== undefined) fs.writeFileSync(configFile, contents);
  vi.resetModules();
  return import('../src/config.js');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-auth-'));
  configFile = path.join(home, '.config', 'kicktipp-agent', 'config.ini');
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  delete process.env.KICKTIPP_EMAIL;
  delete process.env.KICKTIPP_PASSWORD;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('saveAuth', () => {
  it('keeps stored credentials usable when the container hostname changes', async () => {
    const config = await loadConfig();
    config.saveAuth({ email: 'me@example.com', password: 'portable-secret' });
    vi.spyOn(os, 'hostname').mockReturnValue('replacement-container');
    expect(await config.loadCredentials()).toEqual({ email: 'me@example.com', password: 'portable-secret' });
    expect(fs.statSync(path.join(path.dirname(configFile), 'credentials.key')).mode & 0o777).toBe(0o600);
  });

  it('migrates a legacy machine-bound password on successful read', async () => {
    const key = crypto.createHash('sha256').update(`kicktipp-agent:${os.hostname()}:${os.userInfo().username}`).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update('legacy-secret'), cipher.final()]);
    const legacy = `enc.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')}`;
    const config = await loadConfig(`[auth]\nemail = me@example.com\npassword = ${legacy}\n`);
    expect(await config.loadCredentials()).toEqual({ email: 'me@example.com', password: 'legacy-secret' });
    expect(fs.readFileSync(configFile, 'utf8')).toContain('enc.v2.');
    vi.spyOn(os, 'hostname').mockReturnValue('new-container');
    expect((await config.loadCredentials()).password).toBe('legacy-secret');
  });

  it('encrypts a password by default', async () => {
    const config = await loadConfig();
    config.saveAuth({ email: 'me@example.com', password: 'secret' });
    expect(config.hasCredentials()).toBe(true);
    expect(config.hasUsableAuth()).toBe(true);
    expect(config.isSessionOnly()).toBe(false);
    const ini = fs.readFileSync(configFile, 'utf8');
    expect(ini).toContain('me@example.com');
    expect(ini).not.toContain('secret');
    expect(ini).toMatch(/enc\./);
  });

  it('drops the password when store is session', async () => {
    const config = await loadConfig();
    config.saveAuth({ email: 'me@example.com', password: 'secret', store: 'password' });
    config.saveAuth({ email: 'me@example.com', store: 'session' });
    expect(config.hasCredentials()).toBe(false);
    expect(config.hasUsableAuth()).toBe(true);
    expect(config.isSessionOnly()).toBe(true);
    const ini = fs.readFileSync(configFile, 'utf8');
    expect(ini).toMatch(/store\s*=\s*session/);
    expect(ini).not.toContain('secret');
    expect(ini).not.toMatch(/^password\s*=/m);
  });
});

describe('readScoringOverride', () => {
  it('accepts separate draw values', async () => {
    const config = await loadConfig(
      '[scoring]\nexact = 5\ndiff = 3\ntendency = 1\ndraw_exact = 5\ndraw_tendency = 2\n',
    );
    expect(config.readScoringOverride()).toEqual({
      exact: 5,
      goalDiff: 3,
      tendency: 1,
      drawExact: 5,
      drawTendency: 2,
    });
  });
});
