import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { dataDir } from '../cache/paths.js';
import { validateChannel, type NotificationChannel } from '../notify/backends.js';

export interface ServiceConfig {
  version: 1;
  account: { email: string; password: string; community: string; player?: string; site: 'de' | 'com' };
  server: { token: string; host: string; port: number; readOnly: boolean; allowedOrigins: string[] };
  notifications: { channels: NotificationChannel[]; warnHours: number[]; everyMinutes: number };
  timeZone: string;
}

const schema = z.object({
  version: z.literal(1),
  account: z.object({
    email: z.string().trim().email(), password: z.string().min(1),
    community: z.string().trim().regex(/^[\p{L}\p{N}_-]+$/u),
    player: z.string().trim().min(1).optional(), site: z.enum(['de', 'com']),
  }).strict(),
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

export function serviceConfigFile(): string {
  return path.resolve(process.env.KICKTIPP_SERVICE_CONFIG || path.join(dataDir(), 'service.json'));
}

export function validateServiceConfig(value: unknown): ServiceConfig {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    // Never include submitted values (passwords / tokens) in diagnostics.
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || 'configuration');
    throw new Error(`Invalid configuration fields: ${[...new Set(fields)].join(', ')}.`);
  }
  const channels = parsed.data.notifications.channels.map((channel) => validateChannel(channel));
  if (new Set(channels.map((channel) => channel.id)).size !== channels.length) {
    throw new Error('Notification channel IDs must be unique.');
  }
  for (const origin of parsed.data.server.allowedOrigins) {
    if (new URL(origin).origin !== origin || !/^https?:\/\//.test(origin)) {
      throw new Error('server.allowedOrigins must contain exact HTTP(S) origins, without paths.');
    }
  }
  return {
    ...parsed.data,
    notifications: { ...parsed.data.notifications, channels,
      warnHours: [...new Set(parsed.data.notifications.warnHours)].sort((a, b) => b - a) },
  };
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

export function writeServiceConfig(config: ServiceConfig, file = serviceConfigFile()): void {
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

/** Fix an instance to one account; sessions, caches and audit logs follow that identity. */
export function applyServiceConfig(config: ServiceConfig): void {
  const file = serviceConfigFile();
  process.env.KICKTIPP_SERVICE_CONFIG = file;
  const identity = crypto.createHash('sha256')
    .update(`${config.account.site}:${config.account.email.trim().toLowerCase()}`).digest('hex').slice(0, 24);
  const root = path.join(path.dirname(file), 'accounts', identity);
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
