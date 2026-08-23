import path from 'path';
import os from 'os';

/**
 * Where the season history lives. Follows the XDG data spec on Linux and
 * the platform convention on macOS/Windows, and stays separate from the
 * config directory: config is settings the user owns, this is derived data
 * that can be deleted and rebuilt with `kicktipp sync`.
 */
export function dataDir(): string {
  const override = process.env.KICKTIPP_DATA_DIR;
  if (override) return override;

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kicktipp-agent');
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'kicktipp-agent');
  }
  const xdg = process.env.XDG_DATA_HOME;
  return xdg
    ? path.join(xdg, 'kicktipp-agent')
    : path.join(os.homedir(), '.local', 'share', 'kicktipp-agent');
}

export function cacheDir(): string {
  return path.join(dataDir(), 'cache');
}

/**
 * Community names come from Kicktipp URL slugs, but a slug can still contain
 * characters that are awkward in a path, so keep the directory name tame.
 */
export function communityDir(community: string): string {
  const safe = community.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(cacheDir(), safe);
}
