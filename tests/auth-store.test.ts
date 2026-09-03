import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
