import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { dataDir } from '../cache/paths.js';
import { validateChannel, type NotificationChannel } from '../notify/backends.js';

export interface LegacyServiceConfig {
  version: 1;
  account: { email: string; password: string; community: string; communities?: string[]; player?: string; site: 'de' | 'com' };
  server: { token: string; host: string; port: number; readOnly: boolean; allowedOrigins: string[] };
  notifications: { channels: NotificationChannel[]; warnHours: number[]; everyMinutes: number };
  timeZone: string;
}

export interface ServiceProfile {
  id: string;
  name: string;
  account: LegacyServiceConfig['account'];
  notifications: LegacyServiceConfig['notifications'];
  timeZone: string;
  readOnly: boolean;
}

export interface ServiceConfig {
  version: 2;
  server: Omit<LegacyServiceConfig['server'], 'readOnly'>;
  profiles: ServiceProfile[];
}

export const serviceProfileIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
export const serviceProfileNameSchema = z.string().trim().min(1).max(100);

const communitySchema = z.string().trim().regex(/^[\p{L}\p{N}_-]+$/u);

const legacySchema = z.object({
  version: z.literal(1),
  account: z.object({
    email: z.string().trim().email(), password: z.string().min(1),
    community: communitySchema,
    communities: z.array(communitySchema).min(1).max(50).optional(),
    player: z.string().trim().min(1).optional(), site: z.enum(['de', 'com']),
  }).strict().refine((account) => account.communities === undefined || (
    new Set(account.communities).size === account.communities.length && account.communities.includes(account.community)
  ), { path: ['communities'], message: 'Tracked communities must be unique and include the primary community.' }),
  server: z.object({
    token: z.string().min(32).regex(/^[A-Za-z0-9_-]+$/),
    host: z.string().min(1), port: z.number().int().min(1).max(65535),
    readOnly: z.boolean(), allowedOrigins: z.array(z.string().url()),
  }).strict(),
  notifications: z.object({
    channels: z.array(z.unknown()).max(20),
    warnHours: z.array(z.number().positive().max(168)).max(10),
    everyMinutes: z.number().min(1).max(1440),
  }).strict().refine((value) => !value.channels.length || value.warnHours.length > 0, {
    path: ['warnHours'], message: 'Notification channels require at least one reminder time.',
  }),
  timeZone: z.string().refine((value) => {
    try { new Intl.DateTimeFormat('de', { timeZone: value }); return true; } catch { return false; }
  }),
}).strict();

const schema = z.object({
  version: z.literal(2),
  server: legacySchema.shape.server.omit({ readOnly: true }),
  profiles: z.array(z.object({
    id: serviceProfileIdSchema, name: serviceProfileNameSchema,
    account: legacySchema.shape.account, notifications: legacySchema.shape.notifications,
    timeZone: legacySchema.shape.timeZone, readOnly: z.boolean(),
  }).strict()),
}).strict();

export function serviceConfigFile(): string {
  return path.resolve(process.env.KICKTIPP_SERVICE_CONFIG || path.join(dataDir(), 'service.json'));
}

/** Profiles without subscriptions continue to track their primary community. */
export function configuredCommunities(config: Pick<LegacyServiceConfig, 'account'>): string[] {
  return [...(config.account.communities ?? [config.account.community])];
}

export function validateServiceConfig(value: unknown): ServiceConfig {
  const parsed = value && typeof value === 'object' && 'version' in value && value.version === 1
    ? legacySchema.safeParse(value) : schema.safeParse(value);
  if (!parsed.success) {
    // Never include submitted values (passwords / tokens) in diagnostics.
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || 'configuration');
    throw new Error(`Invalid configuration fields: ${[...new Set(fields)].join(', ')}.`);
  }
  const raw = parsed.data.version === 1 ? {
    version: 2 as const,
    server: { token: parsed.data.server.token, host: parsed.data.server.host,
      port: parsed.data.server.port, allowedOrigins: parsed.data.server.allowedOrigins },
    profiles: [{ id: 'default', name: 'Default', account: parsed.data.account,
      notifications: parsed.data.notifications, timeZone: parsed.data.timeZone, readOnly: parsed.data.server.readOnly }],
  } : parsed.data;
  if (new Set(raw.profiles.map((profile) => profile.id)).size !== raw.profiles.length
    || new Set(raw.profiles.map((profile) => profile.name.toLowerCase())).size !== raw.profiles.length) {
    throw new Error('Profile IDs and names must be unique.');
  }
  for (const origin of raw.server.allowedOrigins) {
    if (new URL(origin).origin !== origin || !/^https?:\/\//.test(origin)) {
      throw new Error('server.allowedOrigins must contain exact HTTP(S) origins, without paths.');
    }
  }
  return {
    ...raw,
    profiles: raw.profiles.map((profile) => {
      const channels = profile.notifications.channels.map((channel) => validateChannel(channel));
      if (new Set(channels.map((channel) => channel.id)).size !== channels.length) {
        throw new Error('Notification channel IDs must be unique within each profile.');
      }
      return { ...profile, notifications: { ...profile.notifications, channels,
        warnHours: [...new Set(profile.notifications.warnHours)].sort((a, b) => b - a) } };
    }),
  };
}

/** Omission is unambiguous only for a single configured profile. */
export function resolveServiceProfile(config: ServiceConfig, id?: string): ServiceProfile {
  if (id !== undefined) {
    const profile = config.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new Error('Unknown profile. Call get_profiles for available profile IDs.');
    return profile;
  }
  if (config.profiles.length === 1) return config.profiles[0];
  throw new Error(config.profiles.length
    ? 'Profile required. Call get_profiles and pass the profile ID explicitly.'
    : 'Setup required: add a profile in the web interface.');
}

/** Adapt an explicitly selected profile to the existing account-bound core. */
export function profileServiceConfig(config: ServiceConfig, profile: ServiceProfile): LegacyServiceConfig {
  return { version: 1, account: profile.account, notifications: profile.notifications,
    timeZone: profile.timeZone, server: { ...config.server, readOnly: profile.readOnly } };
}

function accountRoot(config: LegacyServiceConfig, profileId: string, file: string): string {
  const identity = crypto.createHash('sha256')
    .update(`${config.account.site}:${config.account.email.trim().toLowerCase()}`).digest('hex').slice(0, 24);
  // Retain existing account history and cookie paths for migrated installations.
  const base = profileId === 'default' ? path.dirname(file) : path.join(path.dirname(file), 'profiles', serviceProfileIdSchema.parse(profileId));
  return path.join(base, 'accounts', identity);
}

export function serviceProfileDataDir(config: ServiceConfig, profile: ServiceProfile, file = serviceConfigFile()): string {
  return path.join(accountRoot(profileServiceConfig(config, profile), profile.id, file), 'data');
}

export function readServiceConfig(file = serviceConfigFile()): ServiceConfig {
  let content: unknown;
  try { content = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Setup required: run docker compose run --rm kicktipp setup (or npm run setup).');
    }
    throw new Error('Cannot read service configuration. Check its JSON syntax and file permissions.');
  }
  return validateServiceConfig(content);
}

export function writeServiceConfig(config: ServiceConfig | LegacyServiceConfig, file = serviceConfigFile()): void {
  const valid = validateServiceConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Bind a serialized operation to one profile and account. */
export function applyServiceConfig(config: LegacyServiceConfig, profileId = 'default'): void {
  const file = serviceConfigFile();
  process.env.KICKTIPP_SERVICE_CONFIG = file;
  const root = accountRoot(config, profileId, file);
  process.env.KICKTIPP_CONFIG_DIR = path.join(root, 'config');
  process.env.KICKTIPP_DATA_DIR = path.join(root, 'data');
  process.env.KICKTIPP_EMAIL = config.account.email;
  process.env.KICKTIPP_PASSWORD = config.account.password;
  process.env.KICKTIPP_COMMUNITY = config.account.community;
  process.env.KICKTIPP_PLAYER = config.account.player ?? '';
  process.env.KICKTIPP_SITE = config.account.site;
  process.env.KICKTIPP_TZ = config.timeZone;
  process.env.KICKTIPP_READ_ONLY = config.server.readOnly ? '1' : '0';
  delete process.env.KICKTIPP_PROFILE;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
}
