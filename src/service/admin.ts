import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { sendNotification, validateChannel, type NotificationChannel } from '../notify/backends.js';
import { SerialQueue } from './queue.js';
import { configuredCommunities, validateServiceConfig, type ServiceConfig } from './settings.js';

/** Safe, stable error identifiers for the browser; never include submitted secrets. */
export class AdminError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
    this.name = 'AdminError';
  }
}

export interface AdminControllerOptions {
  getConfig: () => ServiceConfig | null;
  /** Persist and activate atomically, or reject without changing the active config. */
  applyConfig: (config: ServiceConfig) => Promise<void>;
  status: () => unknown;
  overview: () => Promise<unknown>;
  /** Read-only refresh, without dispatching scheduler reminders. */
  check: () => Promise<unknown>;
  /** Isolated login check: must not replace the active account/session. */
  checkAccount: (account: { email: string; password: string; site: 'de' | 'com' }) => Promise<string[]>;
  sendNotification?: typeof sendNotification;
  serverDefaults?: { host: string; port: number };
}

const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const channelSchema = z.discriminatedUnion('kind', [
  z.object({ id: idSchema.optional(), kind: z.literal('telegram'), botToken: z.string().optional(), chatId: z.string().optional() }).strict(),
  z.object({ id: idSchema.optional(), kind: z.literal('discord'), url: z.string().optional() }).strict(),
  z.object({ id: idSchema.optional(), kind: z.literal('webhook'), url: z.string().optional() }).strict(),
]);
const accountSchema = z.object({
  email: z.string().trim().email().optional(), password: z.string().optional(),
  community: z.string().trim().regex(/^[\p{L}\p{N}_-]+$/u).optional(),
  communities: z.array(z.string().trim().regex(/^[\p{L}\p{N}_-]+$/u)).min(1).max(50).optional(),
  site: z.enum(['de', 'com']).optional(), player: z.string().trim().optional(),
}).strict();
const patchSchema = z.object({
  revision: z.string().min(1),
  account: accountSchema.optional(),
  notifications: z.object({
    channels: z.array(channelSchema).max(20),
    warnHours: z.array(z.number().positive().max(168)).max(10),
    everyMinutes: z.number().min(1).max(1440),
  }).strict().optional(),
  timeZone: z.string().optional(), readOnly: z.boolean().optional(),
}).strict();
const checkAccountSchema = z.object({
  account: z.object({
    email: z.string().trim().email(), password: z.string().optional(), site: z.enum(['de', 'com']),
  }).strict(),
}).strict();
const testNotificationSchema = z.object({
  channel: channelSchema, language: z.enum(['en', 'de']).default('en'),
}).strict();
const emptySchema = z.object({}).strict();

type ChannelInput = z.infer<typeof channelSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown, code = 'invalid_config'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AdminError(code);
  return result.data;
}

function sameIdentity(current: ServiceConfig['account'] | undefined, email: string, site: string): boolean {
  return !!current && current.site === site && current.email.trim().toLowerCase() === email.trim().toLowerCase();
}

function resolvePassword(current: ServiceConfig['account'] | undefined, account: { email: string; password?: string; site: string }): string {
  if (account.password) return account.password;
  if (sameIdentity(current, account.email, account.site)) return current!.password;
  throw new AdminError('account_required');
}

function resolveChannel(input: ChannelInput, current: NotificationChannel[]): NotificationChannel {
  const previous = input.id ? current.find((channel) => channel.id === input.id && channel.kind === input.kind) : undefined;
  const id = input.id ?? `${input.kind}-${randomBytes(6).toString('hex')}`;
  try {
    if (input.kind === 'telegram') {
      return validateChannel({ id, kind: input.kind,
        botToken: input.botToken?.trim() || (previous?.kind === 'telegram' ? previous.botToken : ''),
        chatId: input.chatId?.trim() || (previous?.kind === 'telegram' ? previous.chatId : ''),
      });
    }
    return validateChannel({ id, kind: input.kind,
      url: input.url?.trim() || (previous && previous.kind !== 'telegram' ? previous.url : ''),
    });
  } catch {
    throw new AdminError('invalid_channel');
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

/** Only the explicitly requested connection route exposes the MCP credential. */
function publicConfig(config: ServiceConfig) {
  return {
    account: { email: config.account.email, community: config.account.community, communities: configuredCommunities(config), site: config.account.site,
      ...(config.account.player ? { player: config.account.player } : {}), hasPassword: !!config.account.password },
    notifications: {
      channels: config.notifications.channels.map((channel) => ({ id: channel.id, kind: channel.kind,
        hasSecret: true, ...(channel.kind === 'telegram' ? { chatId: channel.chatId } : {}) })),
      warnHours: [...config.notifications.warnHours], everyMinutes: config.notifications.everyMinutes,
    },
    timeZone: config.timeZone, readOnly: config.server.readOnly,
  };
}

/**
 * Local administrator operations only. The HTTP layer authenticates the separate
 * admin token and enforces origin/body limits before entering this controller.
 */
export function createAdminController(options: AdminControllerOptions) {
  const queue = new SerialQueue();
  // A keyed digest avoids making revisions an offline oracle for low-entropy
  // account passwords. Restarting also invalidates stale browser revisions.
  const revisionKey = randomBytes(32);
  const revision = (config: ServiceConfig | null) => createHmac('sha256', revisionKey)
    .update(JSON.stringify(canonical(config))).digest('base64url');
  const snapshot = () => {
    const config = options.getConfig();
    return { revision: revision(config), configured: !!config,
      config: config ? publicConfig(config) : null, status: options.status() };
  };
  const requireConfig = () => {
    const config = options.getConfig();
    if (!config) throw new AdminError('setup_required', 409);
    return config;
  };

  async function save(body: unknown) {
    const patch = parse(patchSchema, body);
    const current = options.getConfig();
    if (patch.revision !== revision(current)) throw new AdminError('config_conflict', 409);
    const base: ServiceConfig = current ? structuredClone(current) : {
      version: 1,
      account: { email: '', password: '', community: '', site: 'de' },
      server: { token: randomBytes(32).toString('base64url'),
        host: options.serverDefaults?.host ?? '0.0.0.0', port: options.serverDefaults?.port ?? 8787,
        readOnly: true, allowedOrigins: [] },
      notifications: { channels: [], warnHours: [], everyMinutes: 15 }, timeZone: 'Europe/Berlin',
    };
    if (!current && !patch.account) throw new AdminError('account_required');
    if (patch.account) {
      const account = { ...base.account, ...patch.account };
      account.password = resolvePassword(current?.account, { ...account, password: patch.account.password });
      if (!sameIdentity(current?.account, account.email, account.site)) {
        // Membership and player selection belong to the verified account, never
        // to the previous account whose secrets/settings supplied the base.
        account.community = patch.account.community ?? '';
        account.communities = patch.account.communities;
        account.player = patch.account.player;
      }
      account.player = account.player || undefined;
      base.account = account;
    }
    if (patch.notifications) {
      base.notifications = { ...patch.notifications,
        channels: patch.notifications.channels.map((channel) => resolveChannel(channel, current?.notifications.channels ?? [])) };
    }
    if (patch.timeZone !== undefined) base.timeZone = patch.timeZone;
    if (patch.readOnly !== undefined) base.server.readOnly = patch.readOnly;
    let valid: ServiceConfig;
    try { valid = validateServiceConfig(base); }
    catch { throw new AdminError('invalid_config'); }
    const sameAccount = sameIdentity(current?.account, valid.account.email, valid.account.site);
    const previousGroups = new Set(current && sameAccount ? configuredCommunities(current) : []);
    const groups = configuredCommunities(valid);
    if (groups.some((community) => !previousGroups.has(community))) {
      let memberships: string[];
      try {
        memberships = await options.checkAccount({ email: valid.account.email, password: valid.account.password, site: valid.account.site });
      } catch { throw new AdminError('login_failed', 502); }
      if (groups.some((community) => !memberships.includes(community))) throw new AdminError('community_not_found');
    }
    try { await options.applyConfig(valid); }
    catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError('request_failed', 500);
    }
    return snapshot();
  }

  async function dispatch(path: string, method: string, body: unknown) {
    const methods: Record<string, readonly string[]> = {
      '/api/admin/config': ['GET', 'POST'], '/api/admin/connection': ['GET'],
      '/api/admin/overview': ['GET'], '/api/admin/check': ['POST'],
      '/api/admin/account/check': ['POST'], '/api/admin/notifications/test': ['POST'],
    };
    if (!methods[path]) throw new AdminError('not_found', 404);
    if (!methods[path].includes(method)) throw new AdminError('method_not_allowed', 405);
    if (path === '/api/admin/config') return method === 'GET' ? snapshot() : save(body);
    if (path === '/api/admin/connection') {
      const config = requireConfig();
      return { url: '/mcp', token: config.server.token, readOnly: config.server.readOnly };
    }
    if (path === '/api/admin/overview' || path === '/api/admin/check') {
      requireConfig();
      if (method === 'POST') parse(emptySchema, body ?? {});
      try { return await (method === 'GET' ? options.overview() : options.check()); }
      catch { throw new AdminError('check_failed', 502); }
    }
    if (path === '/api/admin/account/check') {
      const { account } = parse(checkAccountSchema, body);
      const password = resolvePassword(options.getConfig()?.account, account);
      try { return { communities: await options.checkAccount({ ...account, password }) }; }
      catch { throw new AdminError('login_failed', 502); }
    }
    const { channel, language } = parse(testNotificationSchema, body, 'invalid_channel');
    const target = resolveChannel(channel, options.getConfig()?.notifications.channels ?? []);
    try {
      await (options.sendNotification ?? sendNotification)(target, {
        event: 'test', summary: language === 'de'
          ? 'Kicktipp: Deine Benachrichtigungen funktionieren.'
          : 'Kicktipp: Your notifications are working.',
      });
    } catch { throw new AdminError('delivery_failed', 502); }
    return { ok: true };
  }

  return {
    handle(path: string, method: string, body?: unknown): Promise<unknown> {
      // CAS and apply must remain one operation even when called outside HTTP.
      return queue.run(() => dispatch(path, method, body));
    },
  };
}
