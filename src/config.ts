import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as ini from 'ini';
import readline from 'readline';
import { t } from './i18n/index.js';
import type { ScoringRules } from './rules/scoring.js';
import { withAuthProfileMutation } from './auth-profile-lock.js';
import { authConfigDir, authDataDir } from './auth-paths.js';
import { FileLock } from './service/lock.js';

const CONFIG_DIR = authConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.ini');
const CONFIG_LOCK_FILE = path.join(
  authDataDir(),
  `config-${crypto.createHash('sha256').update(CONFIG_FILE).digest('hex').slice(0, 16)}.lock`,
);

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

function deleteProfileSection(config: Record<string, any>, name: string): void {
  delete config[`profile.${name}`];
  if (!config.profile) return;
  delete config.profile[name];
  if (Object.keys(config.profile).length === 0) delete config.profile;
}

function profileSection(
  config: Record<string, any>,
  name: string | null = getActiveProfile(),
): Record<string, any> | null {
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
export function sessionFile(name: string | null = getActiveProfile()): string {
  return name
    ? path.join(authDataDir(), `session-${encodeURIComponent(name)}.json`)
    : path.join(authDataDir(), 'session.json');
}

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

function writeConfigUnlocked(config: Record<string, any>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmpFile = `${CONFIG_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, ini.stringify(config), { mode: 0o600 });
    fs.renameSync(tmpFile, CONFIG_FILE);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

/** Serialize every read-modify-write of the shared config.ini across profiles. */
export function mutateConfig<T>(mutation: (config: Record<string, any>) => T): T {
  const lock = FileLock.acquire(CONFIG_LOCK_FILE);
  try {
    const config = readConfig();
    const result = mutation(config);
    writeConfigUnlocked(config);
    return result;
  } finally {
    lock.release();
  }
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

export class MissingProfileCredentialsError extends Error {
  constructor() {
    super('The configured Auth Profile has no stored credentials.');
    this.name = 'MissingProfileCredentialsError';
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

export async function saveAuth(opts: { email: string; password?: string; store?: AuthStore }): Promise<void> {
  const store = opts.store ?? 'password';
  const profile = getActiveProfile();
  const patch: Record<string, string> = { email: opts.email, store };

  if (store === 'password') {
    if (!opts.password) {
      throw new Error('A password is required when storing credentials.');
    }
    patch.password = encrypt(opts.password);
  }

  mutateConfig((config) => {
    if (profile) {
      writeProfileSection(config, profile, patch);
      if (store === 'session') delete readProfileSection(config, profile)?.password;
    } else {
      config.auth = { ...(config.auth ?? {}), ...patch };
      if (store === 'session') delete config.auth.password;
    }
  });
}

export function saveReadOnly(readOnly: boolean): void {
  mutateConfig((config) => {
    config.server = { ...(config.server ?? {}), read_only: readOnly };
  });
}

export async function loadCredentials(): Promise<{ email: string; password: string }> {
  if (process.env.KICKTIPP_EMAIL && process.env.KICKTIPP_PASSWORD) {
    return { email: process.env.KICKTIPP_EMAIL, password: process.env.KICKTIPP_PASSWORD };
  }
  const config = readConfig();
  const activeProfile = getActiveProfile();
  const profile = profileSection(config);
  if (profile?.email && profile?.password) {
    return { email: profile.email, password: decrypt(profile.password) };
  }
  if (!activeProfile && config.auth?.email && config.auth?.password) {
    return { email: config.auth.email, password: decrypt(config.auth.password) };
  }

  if (isSessionOnly()) throw new SessionOnlyExpiredError();

  if (!process.stdin.isTTY) {
    throw new Error(t('config.noCredentialsHint'));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log(t('config.noCredentials'));
  const email = await ask(t('config.emailPrompt'));
  const password = await new Promise<string>((resolve) => {
    process.stdout.write(t('config.passwordPrompt'));
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

  await saveAuth({ email, password });
  console.log(t('config.credentialsSaved'));
  return { email, password };
}

/** Load exactly one Auth Profile, ignoring interactive environment selection. */
export async function loadProfileCredentials(
  profileId: string,
): Promise<{ email: string; password: string }> {
  let block: Record<string, any> | null;
  try {
    block = profileSection(readConfig(), profileId);
  } catch {
    throw new MissingProfileCredentialsError();
  }
  if (block?.email && block?.password) {
    return { email: block.email, password: decrypt(block.password) };
  }
  if (block?.email && block.store === 'session') throw new SessionOnlyExpiredError();
  throw new MissingProfileCredentialsError();
}

export function isProfileSessionOnly(profileId: string): boolean {
  const block = profileSection(readConfig(), profileId);
  return block?.store === 'session' && !block?.password;
}

export function loadCommunity(): string | null {
  if (communityOverride) return communityOverride;
  if (process.env.KICKTIPP_COMMUNITY) return process.env.KICKTIPP_COMMUNITY;
  const config = readConfig();
  return profileSection(config)?.community || config.community?.name || null;
}

export function saveCommunity(name: string): void {
  const profile = getActiveProfile();
  mutateConfig((config) => {
    if (profile) writeProfileSection(config, profile, { community: name });
    else config.community = { name };
  });
}

export function loadPlayer(): string | null {
  if (process.env.KICKTIPP_PLAYER) return process.env.KICKTIPP_PLAYER;
  const config = readConfig();
  return profileSection(config)?.player || config.player?.name || null;
}

export function savePlayer(name: string): void {
  const profile = getActiveProfile();
  mutateConfig((config) => {
    if (profile) writeProfileSection(config, profile, { player: name });
    else config.player = { name };
  });
}

/** Replace the [notify] section. Passing no target clears a previous one. */
export function saveNotifySection(notify: { kind: string; target?: string }): void {
  mutateConfig((config) => {
    const warn_hours = config.notify?.warn_hours;
    config.notify = { ...notify, ...(warn_hours === undefined ? {} : { warn_hours }) };
  });
}

/**
 * An explicit scoring override from config.ini, for communities whose rules
 * page cannot be parsed:
 *
 *   [scoring]
 *   exact = 4
 *   diff = 3
 *   tendency = 2
 *   draw_exact = 4
 *   draw_tendency = 2
 */
export function readScoringOverride(): ScoringRules | null {
  const scoring = readConfig().scoring;
  if (!scoring) return null;
  const exact = Number(scoring.exact);
  const goalDiff = Number(scoring.diff ?? scoring.goalDiff);
  const tendency = Number(scoring.tendency);
  if (![exact, goalDiff, tendency].every(Number.isFinite)) return null;
  const rules: ScoringRules = { exact, goalDiff, tendency };
  for (const [property, value] of [
    ['drawExact', scoring.draw_exact ?? scoring.drawExact],
    ['drawTendency', scoring.draw_tendency ?? scoring.drawTendency],
  ] as const) {
    if (value === undefined) continue;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    rules[property] = number;
  }
  return rules;
}

/** Default suggestion strategy, from [suggest] strategy or the environment. */
export function readDefaultStrategy(): string | null {
  return process.env.KICKTIPP_SUGGEST_STRATEGY || readConfig().suggest?.strategy || null;
}

function patchUi(patch: Record<string, string>): void {
  mutateConfig((config) => {
    config.ui = { ...(config.ui ?? {}), ...patch };
  });
}

/** Optional UI language from `[ui] language` in config.ini. */
export function readUiLanguage(): string | null {
  const raw = readConfig().ui?.language;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** Optional Kicktipp host from `[ui] site` (`de`, `com`, or a URL). */
export function readUiSite(): string | null {
  const raw = readConfig().ui?.site;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export function saveUiLanguage(language: string): void {
  patchUi({ language });
}

export function saveUiSite(site: string): void {
  patchUi({ site });
}

export function hasCredentials(): boolean {
  if (process.env.KICKTIPP_EMAIL && process.env.KICKTIPP_PASSWORD) return true;
  const config = readConfig();
  const profile = profileSection(config);
  if (profile) return !!(profile.email && profile.password);
  return !!(config.auth?.email && config.auth?.password);
}

export async function logout(): Promise<void> {
  const profile = getActiveProfile();
  const removed = await withAuthProfileMutation(profile, () => {
    const files: string[] = [];
    if (fs.existsSync(CONFIG_FILE)) {
      mutateConfig((config) => {
        if (profile) deleteProfileSection(config, profile);
        else delete config.auth;
      });
      files.push(path.basename(CONFIG_FILE));
    }
    const savedSession = sessionFile(profile);
    if (fs.existsSync(savedSession)) {
      fs.unlinkSync(savedSession);
      files.push(path.basename(savedSession));
    }
    return files;
  });
  console.log(removed.length ? t('logout.removed', { names: removed.join(', ') }) : t('logout.nothing'));
}
