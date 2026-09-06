import crypto from 'node:crypto';
import { getActiveProfile, readConfig } from './config.js';
import { urlBase } from './url.js';

/** Never attribute legacy shared data, or another account's data, to this user. */
export function accountDataKey(): string {
  const profile = getActiveProfile();
  const config = readConfig();
  const auth = profile ? config.profile?.[profile] ?? config['profile.' + profile] : config.auth;
  const email = process.env.KICKTIPP_EMAIL && process.env.KICKTIPP_PASSWORD
    ? process.env.KICKTIPP_EMAIL : auth?.email ?? null;
  return crypto.createHash('sha256').update(JSON.stringify([urlBase(), profile, email])).digest('hex');
}
