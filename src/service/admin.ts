import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { sendNotification, validateChannel, type NotificationChannel } from '../notify/backends.js';
import { SerialQueue } from './queue.js';
import { configuredCommunities, validateServiceConfig, serviceProfileIdSchema, serviceProfileNameSchema, type ServiceConfig, type ServiceProfile } from './settings.js';

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
  status: (profile?: string) => unknown;
  overview: (profile?: string) => Promise<unknown>;
  /** Read-only refresh, without dispatching scheduler reminders. */
  check: (profile?: string) => Promise<unknown>;
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
  revision: z.string().min(1), profile: serviceProfileIdSchema.optional(), name: serviceProfileNameSchema.optional(),
  account: accountSchema.optional(),
  notifications: z.object({
    channels: z.array(channelSchema).max(20),
    warnHours: z.array(z.number().positive().max(168)).max(10),
    everyMinutes: z.number().min(1).max(1440),
  }).strict().optional(),
  timeZone: z.string().optional(), readOnly: z.boolean().optional(),
}).strict();
const checkAccountSchema = z.object({
  profile: serviceProfileIdSchema.optional(),
  account: z.object({
    email: z.string().trim().email(), password: z.string().optional(), site: z.enum(['de', 'com']),
  }).strict(),
}).strict();
const testNotificationSchema = z.object({
  profile: serviceProfileIdSchema.optional(),
  channel: channelSchema, language: z.enum(['en', 'de']).default('en'),
}).strict();
const selectionSchema = z.object({ profile: serviceProfileIdSchema.optional() }).strict();
const createSchema = z.object({ revision: z.string().min(1), name: serviceProfileNameSchema, account: accountSchema }).strict();
const removeSchema = z.object({ revision: z.string().min(1), profile: serviceProfileIdSchema }).strict();

type ChannelInput = z.infer<typeof channelSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown, code = 'invalid_config'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AdminError(code);
  return result.data;
}

function sameIdentity(current: ServiceProfile['account'] | undefined, email: string, site: string): boolean {
  return !!current && current.site === site && current.email.trim().toLowerCase() === email.trim().toLowerCase();
}

function resolvePassword(current: ServiceProfile['account'] | undefined, account: { email: string; password?: string; site: string }): string {
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
function publicConfig(config: ServiceProfile) {
  return {
    id: config.id, name: config.name,
    account: { email: config.account.email, community: config.account.community, communities: configuredCommunities(config), site: config.account.site,
      ...(config.account.player ? { player: config.account.player } : {}), hasPassword: !!config.account.password },
    notifications: {
      channels: config.notifications.channels.map((channel) => ({ id: channel.id, kind: channel.kind,
        hasSecret: true, ...(channel.kind === 'telegram' ? { chatId: channel.chatId } : {}) })),
      warnHours: [...config.notifications.warnHours], everyMinutes: config.notifications.everyMinutes,
    },
    timeZone: config.timeZone, readOnly: config.readOnly,
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
  const summaries = (config: ServiceConfig | null) => config?.profiles.map(({ id, name, account, readOnly }) => ({ id, name, community: account.community, readOnly })) ?? [];
  function select(config: ServiceConfig | null, id?: string, first = false): ServiceProfile | undefined {
    if (id !== undefined) {
      const profile = config?.profiles.find((candidate) => candidate.id === id);
      if (!profile) throw new AdminError('profile_not_found', 404);
      return profile;
    }
    if (!config?.profiles.length) return undefined;
    if (first || config.profiles.length === 1) return config.profiles[0];
    throw new AdminError('profile_required');
  }
  const snapshot = (id?: string) => {
    const config = options.getConfig();
    const profile = select(config, id, true);
    return { revision: revision(config), configured: !!config?.profiles.length,
      profiles: summaries(config), profile: profile?.id ?? null,
      config: profile ? publicConfig(profile) : null, status: options.status(profile?.id) };
  };
  const requireConfig = () => {
    const config = options.getConfig();
    if (!config?.profiles.length) throw new AdminError('setup_required', 409);
    return config;
  };
  const emptyConfig = (): ServiceConfig => ({ version: 2, profiles: [], server: {
    token: randomBytes(32).toString('base64url'), host: options.serverDefaults?.host ?? '0.0.0.0',
    port: options.serverDefaults?.port ?? 8787, allowedOrigins: [],
  } });
  const emptyProfile = (id: string, name: string): ServiceProfile => ({ id, name,
    account: { email: '', password: '', community: '', site: 'de' },
    notifications: { channels: [], warnHours: [], everyMinutes: 15 }, timeZone: 'Europe/Berlin', readOnly: true,
  });
  const checkRevision = (expected: string, config: ServiceConfig | null) => {
    if (expected !== revision(config)) throw new AdminError('config_conflict', 409);
  };
  async function apply(config: ServiceConfig, changedId?: string, previous?: ServiceProfile) {
    let valid: ServiceConfig;
    try { valid = validateServiceConfig(config); }
    catch { throw new AdminError('invalid_config'); }
    if (changedId !== undefined) {
      const changed = valid.profiles.find((profile) => profile.id === changedId)!;
      const sameAccount = sameIdentity(previous?.account, changed.account.email, changed.account.site);
      const previousGroups = new Set(previous && sameAccount ? configuredCommunities(previous) : []);
      const groups = configuredCommunities(changed);
      if (groups.some((community) => !previousGroups.has(community))) {
        let memberships: string[];
        try { memberships = await options.checkAccount({ email: changed.account.email,
          password: changed.account.password, site: changed.account.site }); }
        catch { throw new AdminError('login_failed', 502); }
        if (groups.some((community) => !memberships.includes(community))) throw new AdminError('community_not_found');
      }
    }
    try { await options.applyConfig(valid); }
    catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError('request_failed', 500);
    }
  }

  async function save(body: unknown) {
    const patch = parse(patchSchema, body);
    const current = options.getConfig();
    checkRevision(patch.revision, current);
    const selected = select(current, patch.profile);
    const base = current ? structuredClone(current) : emptyConfig();
    const profile = selected ? base.profiles.find((candidate) => candidate.id === selected.id)!
      : emptyProfile('default', patch.name ?? 'Default');
    if (!selected && !patch.account) throw new AdminError('account_required');
    if (patch.account) {
      const account = { ...profile.account, ...patch.account };
      account.password = resolvePassword(selected?.account, { ...account, password: patch.account.password });
      if (!sameIdentity(selected?.account, account.email, account.site)) {
        // Membership and player choice belong to this identity, not the prior account.
        account.community = patch.account.community ?? '';
        account.communities = patch.account.communities;
        account.player = patch.account.player;
      }
      account.player = account.player || undefined;
      profile.account = account;
    }
    if (patch.name !== undefined) profile.name = patch.name;
    if (patch.notifications) {
      profile.notifications = { ...patch.notifications,
        channels: patch.notifications.channels.map((channel) => resolveChannel(channel, selected?.notifications.channels ?? [])) };
    }
    if (patch.timeZone !== undefined) profile.timeZone = patch.timeZone;
    if (patch.readOnly !== undefined) profile.readOnly = patch.readOnly;
    if (!selected) base.profiles.push(profile);
    await apply(base, profile.id, selected);
    return snapshot(profile.id);
  }

  async function create(body: unknown) {
    const input = parse(createSchema, body);
    const current = options.getConfig();
    checkRevision(input.revision, current);
    const base = current ? structuredClone(current) : emptyConfig();
    const profile = emptyProfile(`profile-${randomBytes(8).toString('hex')}`, input.name);
    profile.account = { ...profile.account, ...input.account };
    if (!profile.account.password) throw new AdminError('account_required');
    profile.account.player = profile.account.player || undefined;
    base.profiles.push(profile);
    await apply(base, profile.id);
    return snapshot(profile.id);
  }

  async function remove(body: unknown) {
    const input = parse(removeSchema, body);
    const current = options.getConfig();
    checkRevision(input.revision, current);
    select(current, input.profile);
    const base = structuredClone(current!);
    base.profiles = base.profiles.filter((profile) => profile.id !== input.profile);
    await apply(base);
    return snapshot();
  }

  async function dispatch(address: string, method: string, body: unknown) {
    const url = new URL(address, 'http://localhost');
    const path = url.pathname;
    if ([...url.searchParams.keys()].some((key) => key !== 'profile') || url.searchParams.getAll('profile').length > 1) throw new AdminError('invalid_config');
    const query = parse(selectionSchema, Object.fromEntries(url.searchParams));
    const methods: Record<string, readonly string[]> = {
      '/api/admin/config': ['GET', 'POST'], '/api/admin/connection': ['GET'],
      '/api/admin/profiles': ['POST'], '/api/admin/profiles/remove': ['POST'],
      '/api/admin/overview': ['GET'], '/api/admin/check': ['POST'],
      '/api/admin/account/check': ['POST'], '/api/admin/notifications/test': ['POST'],
    };
    if (!methods[path]) throw new AdminError('not_found', 404);
    if (!methods[path].includes(method)) throw new AdminError('method_not_allowed', 405);
    // Mutations take their selector in the body, preventing conflicting targets.
    if (method === 'POST' && query.profile !== undefined) throw new AdminError('invalid_config');
    if (path === '/api/admin/config') return method === 'GET' ? snapshot(query.profile) : save(body);
    if (path === '/api/admin/profiles') return create(body);
    if (path === '/api/admin/profiles/remove') return remove(body);
    if (path === '/api/admin/connection') {
      const config = requireConfig();
      const profile = select(config, query.profile, true)!;
      return { url: '/mcp', token: config.server.token, readOnly: profile.readOnly, profiles: summaries(config) };
    }
    if (path === '/api/admin/overview' || path === '/api/admin/check') {
      const config = requireConfig();
      const selection = method === 'GET' ? query : parse(selectionSchema, body ?? {});
      const profile = select(config, selection.profile)!;
      try { return await (method === 'GET' ? options.overview(profile.id) : options.check(profile.id)); }
      catch { throw new AdminError('check_failed', 502); }
    }
    if (path === '/api/admin/account/check') {
      const { account, profile: id } = parse(checkAccountSchema, body);
      const current = options.getConfig();
      // New-profile login checks supply a password and need no existing selection.
      const selected = id !== undefined || !account.password ? select(current, id) : undefined;
      const password = resolvePassword(selected?.account, account);
      try { return { communities: await options.checkAccount({ ...account, password }) }; }
      catch { throw new AdminError('login_failed', 502); }
    }
    const { channel, language, profile: id } = parse(testNotificationSchema, body, 'invalid_channel');
    const selected = select(options.getConfig(), id);
    const target = resolveChannel(channel, selected?.notifications.channels ?? []);
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
