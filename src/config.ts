import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as ini from 'ini';
import readline from 'readline';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'kicktipp-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.ini');

// ── Profiles ────────────────────────────────────────────────────────

/**
 * A profile is one Kicktipp account plus its saved community and player,
 * stored as a [profile.<name>] section. The classic un-prefixed [auth],
 * [community] and [player] sections remain the default profile, so existing
 * configs keep working untouched.
 */
let activeProfile: string | null = null;

export function setActiveProfile(name: string | null): void {
  activeProfile = name;
}

export function getActiveProfile(): string | null {
  return activeProfile ?? process.env.KICKTIPP_PROFILE ?? null;
}

/** Community override for a single invocation (the --community flag). */
let communityOverride: string | null = null;

export function setCommunityOverride(name: string | null): void {
  communityOverride = name;
}

/**
 * `ini` nests dotted section names, so [profile.work] parses to
 * config.profile.work. The flat key is still accepted for robustness.
 */
function readProfileSection(config: Record<string, any>, name: string): Record<string, any> | undefined {
  return config.profile?.[name] ?? config[`profile.${name}`];
}

function writeProfileSection(
  config: Record<string, any>,
  name: string,
  patch: Record<string, any>,
): void {
  const existing = readProfileSection(config, name) ?? {};
  const merged = { ...existing, ...patch };
  if (config[`profile.${name}`]) config[`profile.${name}`] = merged;
  else config.profile = { ...(config.profile ?? {}), [name]: merged };
}

function profileSection(config: Record<string, any>): Record<string, any> | null {
  const name = getActiveProfile();
  if (!name) return null;
  const section = readProfileSection(config, name);
  if (!section) {
    throw new Error(
      `No profile '${name}' in the config. Add a [profile.${name}] section, or run \`kicktipp profiles\` to see what exists.`,
    );
  }
  return section;
}

/** Session cookies are per profile so two accounts never share a jar. */
export function sessionFile(): string {
  const name = getActiveProfile();
  return name
    ? path.join(CONFIG_DIR, `session-${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
    : path.join(CONFIG_DIR, 'session.json');
}

/** Kept for callers that want the default profile's path specifically. */
export const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

export function listProfiles(): string[] {
  const config = readConfig();
  const names = new Set<string>();
  for (const key of Object.keys(config.profile ?? {})) names.add(key);
  for (const key of Object.keys(config)) {
    const match = key.match(/^profile\.(.+)$/);
    if (match) names.add(match[1]);
  }
  return Array.from(names).sort();
}

// ── Password encryption ────────────────────────────────────────────

const CIPHER_ALGO = 'aes-256-gcm';

function deriveKey(): Buffer {
  const material = `kicktipp-agent:${os.hostname()}:${os.userInfo().username}`;
  return crypto.createHash('sha256').update(material).digest();
}

function encrypt(text: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CIPHER_ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return `enc.${packed.toString('base64')}`;
}

function decrypt(encoded: string): string {
  if (!encoded.startsWith('enc.')) return encoded; // backward compat: plaintext
  const packed = Buffer.from(encoded.slice(4), 'base64');
  const iv = packed.subarray(0, 16);
  const authTag = packed.subarray(16, 32);
  const ciphertext = packed.subarray(32);
  const key = deriveKey();
  const decipher = crypto.createDecipheriv(CIPHER_ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ── Config I/O ──────────────────────────────────────────────────────

export function readConfig(): Record<string, any> {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  return ini.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function writeConfig(config: Record<string, any>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmpFile = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmpFile, ini.stringify(config));
  fs.chmodSync(tmpFile, 0o600);
  fs.renameSync(tmpFile, CONFIG_FILE);
}

// ── Credentials ─────────────────────────────────────────────────────

/** How credentials are kept on disk after a successful login. */
export type AuthStore = 'password' | 'session';

/**
 * Session-only mode stored a cookie, not a password, so an expired session
 * cannot be refreshed silently. The caller should send the user back through
 * the localhost setup page.
 */
export class SessionOnlyExpiredError extends Error {
  constructor() {
    super('Kicktipp session expired. Reconnect via the setup page.');
    this.name = 'SessionOnlyExpiredError';
  }
}

function authBlock(config: Record<string, any>): Record<string, any> | undefined {
  return profileSection(config) ?? config.auth;
}

export function isSessionOnly(): boolean {
  if (process.env.KICKTIPP_PASSWORD) return false;
  const block = authBlock(readConfig());
  return block?.store === 'session' && !block?.password;
}

/**
 * True when a later command can try to talk to Kicktipp: either a password
 * is available, or a session-only login has been saved (the cookie may
 * still turn out to be expired).
 */
export function hasUsableAuth(): boolean {
  if (hasCredentials()) return true;
  const block = authBlock(readConfig());
  return !!(block?.email && block.store === 'session');
}

export function saveAuth(opts: { email: string; password?: string; store?: AuthStore }): void {
  const store = opts.store ?? 'password';
  const config = readConfig();
  const profile = getActiveProfile();
  const patch: Record<string, string> = { email: opts.email, store };

  if (store === 'password') {
    if (!opts.password) {
      throw new Error('A password is required when storing credentials.');
    }
    patch.password = encrypt(opts.password);
  }

  if (profile) {
    writeProfileSection(config, profile, patch);
    if (store === 'session') delete readProfileSection(config, profile)?.password;
  } else {
    config.auth = { ...(config.auth ?? {}), ...patch };
    if (store === 'session') delete config.auth.password;
  }
  writeConfig(config);
}

export function saveReadOnly(readOnly: boolean): void {
  const config = readConfig();
  config.server = { ...(config.server ?? {}), read_only: readOnly };
  writeConfig(config);
}

export async function loadCredentials(): Promise<{ email: string; password: string }> {
  if (process.env.KICKTIPP_EMAIL && process.env.KICKTIPP_PASSWORD) {
    return { email: process.env.KICKTIPP_EMAIL, password: process.env.KICKTIPP_PASSWORD };
  }
  const config = readConfig();
  const profile = profileSection(config);
  if (profile?.email && profile?.password) {
    return { email: profile.email, password: decrypt(profile.password) };
  }
  if (config.auth?.email && config.auth?.password) {
    const password = decrypt(config.auth.password);
    // Migrate plaintext passwords to encrypted on read
    if (!config.auth.password.startsWith('enc.')) {
      config.auth.password = encrypt(password);
      writeConfig(config);
    }
    return { email: config.auth.email, password };
  }

  if (isSessionOnly()) throw new SessionOnlyExpiredError();

  if (!process.stdin.isTTY) {
    throw new Error(
      'No credentials found. Run `kicktipp login --web`, or set KICKTIPP_EMAIL and KICKTIPP_PASSWORD.',
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log('No credentials found. Please enter your kicktipp.com login:');
  const email = await ask('Email: ');
  const password = await new Promise<string>((resolve) => {
    process.stdout.write('Password: ');
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let pwd = '';
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
        process.stdout.write('\n');
        resolve(pwd);
      } else if (c === '\u0003') {
        process.exit(1);
      } else if (c === '\u007f') {
        pwd = pwd.slice(0, -1);
      } else {
        pwd += c;
      }
    };
    stdin.resume();
    stdin.on('data', onData);
  });
  rl.close();

  const config2 = readConfig();
  config2.auth = { email, password: encrypt(password) };
  writeConfig(config2);
  console.log('Credentials saved to config.');
  return { email, password };
}

export function loadCommunity(): string | null {
  if (communityOverride) return communityOverride;
  if (process.env.KICKTIPP_COMMUNITY) return process.env.KICKTIPP_COMMUNITY;
  const config = readConfig();
  return profileSection(config)?.community || config.community?.name || null;
}

export function saveCommunity(name: string): void {
  const config = readConfig();
  const profile = getActiveProfile();
  if (profile) writeProfileSection(config, profile, { community: name });
  else config.community = { name };
  writeConfig(config);
}

export function loadPlayer(): string | null {
  if (process.env.KICKTIPP_PLAYER) return process.env.KICKTIPP_PLAYER;
  const config = readConfig();
  return profileSection(config)?.player || config.player?.name || null;
}

export function savePlayer(name: string): void {
  const config = readConfig();
  const profile = getActiveProfile();
  if (profile) writeProfileSection(config, profile, { player: name });
  else config.player = { name };
  writeConfig(config);
}

/** Replace the [notify] section. Passing no target clears a previous one. */
export function saveNotifySection(notify: { kind: string; target?: string }): void {
  const config = readConfig();
  config.notify = notify.target
    ? { kind: notify.kind, target: notify.target }
    : { kind: notify.kind };
  writeConfig(config);
}

/**
 * An explicit scoring override from config.ini, for communities whose rules
 * page cannot be parsed:
 *
 *   [scoring]
 *   exact = 4
 *   diff = 3
 *   tendency = 2
 */
export function readScoringOverride(): { exact: number; goalDiff: number; tendency: number } | null {
  const scoring = readConfig().scoring;
  if (!scoring) return null;
  const exact = Number(scoring.exact);
  const goalDiff = Number(scoring.diff ?? scoring.goalDiff);
  const tendency = Number(scoring.tendency);
  if (![exact, goalDiff, tendency].every(Number.isFinite)) return null;
  return { exact, goalDiff, tendency };
}

/** Default suggestion strategy, from [suggest] strategy or the environment. */
export function readDefaultStrategy(): string | null {
  return process.env.KICKTIPP_SUGGEST_STRATEGY || readConfig().suggest?.strategy || null;
}

export function hasCredentials(): boolean {
  if (process.env.KICKTIPP_EMAIL && process.env.KICKTIPP_PASSWORD) return true;
  const config = readConfig();
  const profile = profileSection(config);
  if (profile?.email && profile?.password) return true;
  return !!(config.auth?.email && config.auth?.password);
}

export function logout(): void {
  const removed: string[] = [];
  for (const p of [CONFIG_FILE, sessionFile()]) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed.push(path.basename(p));
    }
  }
  console.log(removed.length ? `Removed: ${removed.join(', ')}` : 'Nothing to remove.');
}
