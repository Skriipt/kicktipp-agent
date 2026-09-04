import os from 'os';
import path from 'path';

/** Preserve historical CLI paths unless deployment paths are explicitly set. */
export function authConfigDir(): string {
  return process.env.KICKTIPP_CONFIG_DIR || path.join(os.homedir(), '.config', 'kicktipp-agent');
}

/** Cookies and locks must remain writable even when Config is mounted read-only. */
export function authDataDir(): string {
  return process.env.KICKTIPP_DATA_DIR || authConfigDir();
}
