import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let home: string;
let configFile: string;

async function load(contents = '') {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  if (contents) fs.writeFileSync(configFile, contents);
  vi.resetModules();
  const config = await import('../src/config.js');
  const backends = await import('../src/notify/backends.js');
  return { config, backends };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-notify-'));
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

describe('applyNotifierSettings', () => {
  it('writes [notify] into config.ini', async () => {
    const { backends } = await load();
    backends.applyNotifierSettings('webhook', 'https://ntfy.sh/topic');
    const ini = fs.readFileSync(configFile, 'utf8');
    expect(ini).toMatch(/\[notify\]/);
    expect(ini).toMatch(/kind\s*=\s*webhook/);
    expect(ini).toMatch(/target\s*=\s*https:\/\/ntfy\.sh\/topic/);
  });

  it('clears a previous webhook target when switching to desktop', async () => {
    const { backends } = await load();
    backends.applyNotifierSettings('webhook', 'https://ntfy.sh/topic');
    backends.applyNotifierSettings('desktop');
    const ini = fs.readFileSync(configFile, 'utf8');
    expect(ini).toMatch(/kind\s*=\s*desktop/);
    expect(ini).not.toMatch(/ntfy/);
  });
});
