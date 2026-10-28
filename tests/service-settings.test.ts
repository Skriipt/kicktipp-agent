import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyServiceConfig, readServiceConfig, writeServiceConfig, validateServiceConfig, type ServiceConfig } from '../src/service/settings.js';

export function exampleConfig(): ServiceConfig {
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
  it('round trips restricted secret file and reports missing/invalid config without values', () => {
    const file = path.join(root, 'service.json');
    expect(() => readServiceConfig(file)).toThrow(/setup/);
    writeServiceConfig(exampleConfig(), file);
    expect(readServiceConfig(file)).toEqual(exampleConfig());
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
    expect(validateServiceConfig(config).notifications.warnHours).toEqual([24, 6, 1]);
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
    expect(readServiceConfig()).toEqual(config);
    applyServiceConfig(config);
    expect(process.env.KICKTIPP_DATA_DIR).toBe(first);
    applyServiceConfig({ ...config, account: { ...config.account, email: 'other@example.com' } });
    expect(process.env.KICKTIPP_DATA_DIR).not.toBe(first);
    expect(sessionFile()).not.toBe(session);
  });
});
