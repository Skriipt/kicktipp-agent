import { afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep every test worker, including child CLIs, away from real accounts and data.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-test-'));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('KICKTIPP_') || key.startsWith('XDG_')) delete process.env[key];
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
