#!/usr/bin/env node
import fs from 'node:fs';
import { createHaServer, requiredHaProfile, validateHaToken } from './ha/http.js';
import { isProfileSessionOnly, loadProfileCredentials, readUiLanguage, readUiSite, sessionFile } from './config.js';
import { lockedProfile } from './profile-policy.js';
import { resolveLanguage, setLanguage } from './i18n/index.js';
import { resolveBaseUrl, setUrlBase } from './url.js';

async function main(): Promise<void> {
  const profile = requiredHaProfile();
  if (lockedProfile() && lockedProfile() !== profile) throw new Error('HA profile and profile lock must match.');
  process.env.KICKTIPP_PROFILE_LOCK = profile;
  const token = process.env.KICKTIPP_HA_TOKEN_FILE
    ? fs.readFileSync(process.env.KICKTIPP_HA_TOKEN_FILE, 'utf8').trim()
    : process.env.KICKTIPP_HA_TOKEN ?? '';
  validateHaToken(token);
  const host = process.env.KICKTIPP_HA_HOST || '127.0.0.1';
  const port = Number(process.env.KICKTIPP_HA_PORT || '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HA port.');
  // Fail before listening if passwords cannot be decrypted under this host/user.
  try {
    if (isProfileSessionOnly(profile)) {
      if (!fs.existsSync(sessionFile(profile))) throw new Error('Missing session');
    } else {
      await loadProfileCredentials(profile);
    }
  } catch {
    throw new Error('Profile authentication is not usable. Check hostname/user for encrypted passwords, or reconnect the profile outside the locked server.');
  }
  setLanguage(resolveLanguage({ configLanguage: readUiLanguage() }));
  setUrlBase(resolveBaseUrl({ configSite: readUiSite() }));
  const server = createHaServer({ token });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  console.error(`Kicktipp HA listening on ${host}:${port} (profile locked).`);
  const stop = () => {
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 30_000).unref();
    server.close(() => { clearTimeout(deadline); });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(() => {
  // Configuration errors may contain private paths or credential material.
  console.error('HA startup failed. KICKTIPP_PROFILE must name an existing profile with a community. Check credential hostname/user, bearer token file, host and port.');
  process.exitCode = 1;
});
