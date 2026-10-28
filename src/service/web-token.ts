import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { serviceConfigFile } from './settings.js';

/** Independent of the MCP bearer token: remote agents are not administrators. */
export function webTokenFile(): string {
  return path.join(path.dirname(serviceConfigFile()), 'web-admin-token');
}

export function ensureWebToken(file = webTokenFile()): string {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot create web access token. Check data directory permissions.');
  }
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) throw new Error('Invalid web access token file. Restore it or remove it to generate a new token.');
  fs.chmodSync(file, 0o600);
  return token;
}
