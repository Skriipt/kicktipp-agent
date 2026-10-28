import { describe, expect, it, vi } from 'vitest';
import { AdminError, createAdminController, type AdminControllerOptions } from '../src/service/admin.js';
import { validateServiceConfig, type ServiceConfig } from '../src/service/settings.js';

const PASSWORD = 'fixture-private-password';
const BOT_TOKEN = '123456:fixture_private_bot_token';
const MCP_TOKEN = 'fixture_mcp_token_that_is_at_least_32_characters';
const WEBHOOK = 'https://example.com/private-webhook-token';

function config(): ServiceConfig {
  return validateServiceConfig({
    version: 1, account: { email: 'owner@example.com', password: PASSWORD, community: 'friends', site: 'de', player: 'Owner' },
    server: { token: MCP_TOKEN, host: '127.0.0.1', port: 8787, readOnly: true, allowedOrigins: ['https://client.example'] },
    timeZone: 'Europe/Berlin',
    notifications: { channels: [
      { id: 'telegram-home', kind: 'telegram', botToken: BOT_TOKEN, chatId: '1234' },
      { id: 'webhook-home', kind: 'webhook', url: WEBHOOK },
    ], warnHours: [12, 2.5], everyMinutes: 15 },
  });
}

function setup(initial: ServiceConfig | null = config()) {
  let current = initial ? structuredClone(initial) : null;
  const applyConfig = vi.fn(async (next: ServiceConfig) => { current = structuredClone(next); });
  const checkAccount = vi.fn<AdminControllerOptions['checkAccount']>(async () => ['friends', 'work']);
  const sendNotification = vi.fn<NonNullable<AdminControllerOptions['sendNotification']>>(async () => undefined);
  const overview = vi.fn(async () => ({ status: { scheduler: { running: true } }, report: null }));
  const check = vi.fn(async () => ({ status: { scheduler: { running: true } }, report: { community: 'friends', matches: [] } }));
  const admin = createAdminController({ getConfig: () => current, applyConfig, checkAccount, sendNotification,
    status: () => ({ version: '1.3.0' }), overview, check,
    serverDefaults: { host: '127.0.0.1', port: 9123 } });
  const read = () => admin.handle('/api/admin/config', 'GET') as Promise<{
    revision: string; configured: boolean; config: ReturnType<typeof config> | null;
  }>;
  const save = async (patch: object) => {
    const { revision } = await read();
    return admin.handle('/api/admin/config', 'POST', { revision, ...patch });
  };
  return { admin, read, save, applyConfig, checkAccount, sendNotification, overview, check, current: () => current };
}

describe('local administration controller', () => {
  it('exposes legacy groups and adds discovered memberships without losing the primary or stored secrets', async () => {
    const app = setup();
    expect((await app.read()).config!.account.communities).toEqual(['friends']);
    await app.save({ account: { communities: ['friends', 'work'] } });
    expect(app.current()!.profiles[0].account).toEqual({ ...config().profiles[0].account, communities: ['friends', 'work'] });
    expect(app.checkAccount).toHaveBeenCalledWith({ email: 'owner@example.com', password: PASSWORD, site: 'de' });
    app.checkAccount.mockResolvedValueOnce(['friends', 'work', 'family']);
    await app.save({ account: { communities: ['friends', 'work', 'family'] } });
    expect((await app.read()).config!.account.communities).toEqual(['friends', 'work', 'family']);
    expect(app.checkAccount).toHaveBeenCalledTimes(2);
    await app.save({ account: { communities: ['friends', 'work', 'family'] } });
    expect(app.checkAccount).toHaveBeenCalledTimes(2);
    await app.save({ account: { community: 'work', communities: ['work', 'family'] } });
    expect(app.current()!.profiles[0].account.community).toBe('work');
    expect(app.checkAccount).toHaveBeenCalledTimes(2);
  });

  it('rejects unverified additions and keeps the previous config and revision', async () => {
    const app = setup();
    const before = await app.read();
    await expect(app.save({ account: { communities: ['friends', 'strangers'] } })).rejects.toMatchObject({ code: 'community_not_found', status: 400 });
    expect(await app.read()).toEqual(before);
    app.checkAccount.mockRejectedValueOnce(new Error(PASSWORD));
    await expect(app.save({ account: { communities: ['friends', 'work'] } })).rejects.toMatchObject({ code: 'login_failed', status: 502 });
    expect(await app.read()).toEqual(before);
    await expect(app.save({ account: { communities: [] } })).rejects.toMatchObject({ code: 'invalid_config' });
    expect(app.applyConfig).not.toHaveBeenCalled();
  });

  it('rejects stale group updates before making a membership request', async () => {
    const app = setup();
    const { revision } = await app.read();
    await app.save({ account: { communities: ['friends', 'work'] } });
    await expect(app.admin.handle('/api/admin/config', 'POST', { revision, account: { communities: ['friends'] } })).rejects.toMatchObject({ code: 'config_conflict', status: 409 });
    expect(app.current()!.profiles[0].account.communities).toEqual(['friends', 'work']);
    expect(app.checkAccount).toHaveBeenCalledTimes(1);
  });

  it('does not carry tracked groups, primary group or player across account identities', async () => {
    const initial = config();
    initial.profiles[0].account.communities = ['friends', 'work'];
    const app = setup(initial);
    await expect(app.save({ account: { email: 'other@example.com', password: 'new-password' } })).rejects.toMatchObject({ code: 'invalid_config' });
    app.checkAccount.mockResolvedValueOnce(['new-pool']);
    await app.save({ account: { email: 'other@example.com', password: 'new-password', community: 'new-pool' } });
    expect(app.current()!.profiles[0].account).toEqual({ email: 'other@example.com', password: 'new-password', community: 'new-pool', site: 'de', player: undefined });
    expect((await app.read()).config!.account.communities).toEqual(['new-pool']);
    expect(app.checkAccount).toHaveBeenCalledWith({ email: 'other@example.com', password: 'new-password', site: 'de' });
  });

  it('returns only redacted settings and explicitly exposes the MCP token on the connection route', async () => {
    const app = setup();
    const data = await app.read();
    const text = JSON.stringify(data);
    for (const secret of [PASSWORD, BOT_TOKEN, MCP_TOKEN, WEBHOOK]) expect(text).not.toContain(secret);
    expect(data).toMatchObject({ configured: true, config: {
      account: { email: 'owner@example.com', hasPassword: true },
      notifications: { channels: [
        { id: 'telegram-home', kind: 'telegram', hasSecret: true, chatId: '1234' },
        { id: 'webhook-home', kind: 'webhook', hasSecret: true },
      ], warnHours: [12, 2.5] }, readOnly: true,
    } });
    expect(await app.admin.handle('/api/admin/connection', 'GET')).toMatchObject({ url: '/mcp', token: MCP_TOKEN, readOnly: true, profiles: [{ id: 'default', name: 'Default' }] });
    const second = setup();
    expect((await second.read()).revision).not.toBe(data.revision);
    expect((await app.read()).revision).toBe(data.revision);
  });

  it('starts without credentials or reminder presets and saves the first account with read-only access', async () => {
    const app = setup(null);
    expect(await app.read()).toMatchObject({ configured: false, config: null });
    for (const route of ['/api/admin/connection', '/api/admin/overview']) {
      await expect(app.admin.handle(route, 'GET')).rejects.toMatchObject({ code: 'setup_required', status: 409 });
    }
    await expect(app.save({ readOnly: false })).rejects.toMatchObject({ code: 'account_required' });
    app.checkAccount.mockResolvedValueOnce(['new-pool']);
    await app.save({ account: { email: 'new@example.com', password: 'new-password', community: 'new-pool', site: 'com' } });
    expect(app.current()!.profiles[0]).toMatchObject({
      account: { email: 'new@example.com', password: 'new-password', community: 'new-pool', site: 'com' },
      readOnly: true,
      notifications: { channels: [], warnHours: [], everyMinutes: 15 }, timeZone: 'Europe/Berlin',
    });
    expect(app.current()!.server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('retains blank secrets only for the same account identity and matching channel ID and kind', async () => {
    const app = setup();
    app.checkAccount.mockResolvedValueOnce(['friends', 'other-pool']);
    await app.save({ account: { email: 'OWNER@example.com', password: '', community: 'other-pool' },
      notifications: { channels: [
        { id: 'telegram-home', kind: 'telegram', botToken: '', chatId: '5678' },
        { id: 'webhook-home', kind: 'webhook', url: '' },
      ], warnHours: [0.5, 12, 2.5, 12], everyMinutes: 5 },
    });
    expect(app.current()!.profiles[0].account.password).toBe(PASSWORD);
    expect(app.current()!.profiles[0].notifications).toEqual({
      channels: [
        { id: 'telegram-home', kind: 'telegram', botToken: BOT_TOKEN, chatId: '5678' },
        { id: 'webhook-home', kind: 'webhook', url: WEBHOOK },
      ], warnHours: [12, 2.5, 0.5], everyMinutes: 5,
    });
    await expect(app.save({ account: { email: 'someone-else@example.com', password: '' } })).rejects.toMatchObject({ code: 'account_required' });
    await expect(app.save({ account: { site: 'com' } })).rejects.toMatchObject({ code: 'account_required' });
    for (const channel of [
      { id: 'webhook-home', kind: 'discord', url: '' },
      { id: 'unknown', kind: 'webhook', url: '' },
      { kind: 'telegram', botToken: '', chatId: '1' },
    ]) {
      await expect(app.save({ notifications: { channels: [channel], warnHours: [1], everyMinutes: 15 } })).rejects.toMatchObject({ code: 'invalid_channel' });
    }
  });

  it('replaces credentials explicitly and can clear the optional player without changing server credentials', async () => {
    const app = setup();
    await app.save({ account: { email: 'other@example.com', password: 'replacement-password', site: 'com', community: 'friends', player: '' }, readOnly: false });
    expect(app.current()!.profiles[0].account).toMatchObject({ email: 'other@example.com', password: 'replacement-password', site: 'com' });
    expect(app.current()!.profiles[0].account.player).toBeUndefined();
    expect(app.current()!.server).toEqual(config().server);
    expect(app.current()!.profiles[0].readOnly).toBe(false);
  });

  it('accepts custom fractional windows, generates IDs and supports complete channel removal', async () => {
    const app = setup();
    await app.save({ notifications: { channels: [{ kind: 'webhook', url: 'http://localhost:9000/hook' }], warnHours: [168, 0.25], everyMinutes: 1 } });
    expect(app.current()!.profiles[0].notifications.channels[0].id).toMatch(/^webhook-[a-f0-9]{12}$/);
    expect(app.current()!.profiles[0].notifications.warnHours).toEqual([168, 0.25]);
    await app.save({ notifications: { channels: [], warnHours: [], everyMinutes: 15 } });
    expect(app.current()!.profiles[0].notifications).toEqual({ channels: [], warnHours: [], everyMinutes: 15 });
  });

  it('rejects invalid windows and incomplete notification configuration without applying it', async () => {
    const app = setup();
    for (const warnHours of [[], [0], [-1], [169], ['2.5'], Array.from({ length: 11 }, (_, i) => i + 1)]) {
      await expect(app.save({ notifications: { channels: [{ id: 'webhook-home', kind: 'webhook' }], warnHours, everyMinutes: 15 } })).rejects.toMatchObject({ code: 'invalid_config' });
    }
    await expect(app.save({ notifications: { channels: [], warnHours: [1] } })).rejects.toMatchObject({ code: 'invalid_config' });
    expect(app.applyConfig).not.toHaveBeenCalled();
    expect(app.current()).toEqual(config());
  });

  it('rejects unknown fields, malformed payloads and hidden credential injection with safe diagnostics', async () => {
    const app = setup();
    const revision = (await app.read()).revision;
    for (const body of [
      null, [], 'secret-body', { revision, server: { token: 'leak-this-secret' } },
      { revision, account: { unknown: 'leak-this-secret' } },
      { revision, readOnly: 'false' },
      { revision, notifications: { channels: [{ kind: 'webhook', url: WEBHOOK, botToken: 'leak-this-secret' }], warnHours: [1], everyMinutes: 15 } },
      JSON.parse(`{"revision":"${revision}","__proto__":{"polluted":"leak-this-secret"}}`),
    ]) {
      try { await app.admin.handle('/api/admin/config', 'POST', body); throw new Error('unexpected acceptance'); }
      catch (error) {
        expect(error).toMatchObject({ code: 'invalid_config', status: 400 });
        expect(String(error)).not.toContain('leak-this-secret');
      }
    }
    expect(app.applyConfig).not.toHaveBeenCalled();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('protects concurrent updates with revision checks across the entire asynchronous apply', async () => {
    const app = setup();
    const revision = (await app.read()).revision;
    const realApply = app.applyConfig.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    app.applyConfig.mockImplementationOnce(async (next) => { entered(); await gate; await realApply(next); });
    const first = app.admin.handle('/api/admin/config', 'POST', { revision, readOnly: false });
    await started;
    const second = app.admin.handle('/api/admin/config', 'POST', { revision, timeZone: 'UTC' });
    const rejected = expect(second).rejects.toMatchObject({ code: 'config_conflict', status: 409 });
    release();
    await first;
    await rejected;
    expect(app.current()!.profiles[0].readOnly).toBe(false);
    expect(app.current()!.profiles[0].timeZone).toBe('Europe/Berlin');
    expect(app.applyConfig).toHaveBeenCalledTimes(1);
  });

  it('does not advance the revision or expose dependency errors on failed apply', async () => {
    const app = setup();
    const before = await app.read();
    app.applyConfig.mockRejectedValueOnce(new Error(PASSWORD));
    await expect(app.save({ readOnly: false })).rejects.toMatchObject({ code: 'request_failed', status: 500 });
    expect(await app.read()).toEqual(before);
  });

  it('preserves a safe runtime conflict instead of masking it as a server failure', async () => {
    const app = setup();
    const before = await app.read();
    app.applyConfig.mockRejectedValueOnce(new AdminError('config_conflict', 409));
    await expect(app.save({ readOnly: false })).rejects.toMatchObject({ code: 'config_conflict', status: 409 });
    expect(await app.read()).toEqual(before);
  });

  it('checks login without saving and never carries passwords across identities', async () => {
    const app = setup();
    expect(await app.admin.handle('/api/admin/account/check', 'POST', { account: { email: 'OWNER@example.com', site: 'de', password: '' } })).toEqual({ communities: ['friends', 'work'] });
    expect(app.checkAccount).toHaveBeenCalledWith({ email: 'OWNER@example.com', site: 'de', password: PASSWORD });
    await expect(app.admin.handle('/api/admin/account/check', 'POST', { account: { email: 'other@example.com', site: 'de' } })).rejects.toMatchObject({ code: 'account_required' });
    await expect(app.admin.handle('/api/admin/account/check', 'POST', { account: { email: 'owner@example.com', site: 'com' } })).rejects.toMatchObject({ code: 'account_required' });
    app.checkAccount.mockRejectedValueOnce(new Error(PASSWORD));
    await expect(app.admin.handle('/api/admin/account/check', 'POST', { account: { email: 'other@example.com', site: 'de', password: 'new-password' } })).rejects.toMatchObject({ code: 'login_failed', status: 502 });
    expect(app.applyConfig).not.toHaveBeenCalled();
    expect(app.current()).toEqual(config());
  });

  it('tests a saved or unsaved destination explicitly, with the selected message language', async () => {
    const app = setup();
    expect(await app.admin.handle('/api/admin/notifications/test', 'POST', { channel: { id: 'telegram-home', kind: 'telegram' }, language: 'de' })).toEqual({ ok: true });
    expect(app.sendNotification).toHaveBeenLastCalledWith(config().profiles[0].notifications.channels[0], { event: 'test', summary: 'Kicktipp: Deine Benachrichtigungen funktionieren.' });
    await app.admin.handle('/api/admin/notifications/test', 'POST', { channel: { kind: 'webhook', url: 'https://example.com/new-hook' } });
    expect(app.sendNotification.mock.lastCall![0]).toMatchObject({ kind: 'webhook', url: 'https://example.com/new-hook' });
    expect(app.sendNotification.mock.lastCall![1]).toEqual({ event: 'test', summary: 'Kicktipp: Your notifications are working.' });
    app.sendNotification.mockRejectedValueOnce(new Error(BOT_TOKEN));
    await expect(app.admin.handle('/api/admin/notifications/test', 'POST', { channel: { id: 'telegram-home', kind: 'telegram' } })).rejects.toMatchObject({ code: 'delivery_failed', status: 502 });
    expect(app.applyConfig).not.toHaveBeenCalled();
  });

  it('rejects invalid notification tests before dispatch', async () => {
    const app = setup();
    for (const body of [
      { channel: { id: 'telegram-home', kind: 'webhook' } },
      { channel: { kind: 'telegram', botToken: 'secret-invalid', chatId: '123' } },
      { channel: { id: 'telegram-home', kind: 'telegram' }, language: 'es' },
      { channel: { kind: 'webhook', url: WEBHOOK }, unknown: true },
    ]) await expect(app.admin.handle('/api/admin/notifications/test', 'POST', body)).rejects.toMatchObject({ code: 'invalid_channel' });
    expect(app.sendNotification).not.toHaveBeenCalled();
  });

  it('uses a read-only refresh separate from notification delivery and guards its method/body', async () => {
    const app = setup();
    expect(await app.admin.handle('/api/admin/overview', 'GET')).toMatchObject({ report: null });
    expect(await app.admin.handle('/api/admin/check', 'POST', {})).toMatchObject({ report: { community: 'friends' } });
    expect(app.overview).toHaveBeenCalledTimes(1);
    expect(app.check).toHaveBeenCalledTimes(1);
    expect(app.sendNotification).not.toHaveBeenCalled();
    await expect(app.admin.handle('/api/admin/check', 'GET')).rejects.toMatchObject({ code: 'method_not_allowed', status: 405 });
    await expect(app.admin.handle('/api/admin/check', 'POST', { submit: true })).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(app.admin.handle('/api/admin/nope', 'GET')).rejects.toMatchObject({ code: 'not_found', status: 404 });
    app.check.mockRejectedValueOnce(new Error(PASSWORD));
    await expect(app.admin.handle('/api/admin/check', 'POST', {})).rejects.toMatchObject({ code: 'check_failed', status: 502 });
  });

  it('allows no reminder times only when notifications have no destinations', () => {
    const value = config();
    value.profiles[0].notifications.warnHours = [];
    expect(() => validateServiceConfig(value)).toThrow(/warnHours/);
    value.profiles[0].notifications.channels = [];
    expect(validateServiceConfig(value).profiles[0].notifications.warnHours).toEqual([]);
  });
});

describe('multi-profile administration', () => {
  const secondAccount = { email: 'family@example.com', password: 'family-password', community: 'family-pool', site: 'com' as const };
  async function createSecond(app: ReturnType<typeof setup>, name = 'Family') {
    app.checkAccount.mockResolvedValueOnce(['family-pool']);
    return app.admin.handle('/api/admin/profiles', 'POST', {
      revision: (await app.read()).revision, name, account: secondAccount,
    }) as Promise<{ profile: string; profiles: Array<{ id: string; name: string }>; config: { id: string; name: string }; revision: string }>;
  }

  it('creates, selects, renames and removes profiles without disturbing the other account or global token', async () => {
    const app = setup();
    const before = structuredClone(app.current()!);
    const created = await createSecond(app);
    expect(created.profile).toMatch(/^profile-[a-f0-9]{16}$/);
    expect(created.config).toMatchObject({ id: created.profile, name: 'Family', account: { email: secondAccount.email }, readOnly: true, notifications: { channels: [], warnHours: [] } });
    expect(app.current()!.profiles[0]).toEqual(before.profiles[0]);
    expect(app.current()!.server).toEqual(before.server);
    const selected = await app.admin.handle(`/api/admin/config?profile=${created.profile}`, 'GET') as any;
    expect(selected.profile).toBe(created.profile);
    expect((await app.read()).profile).toBe('default');
    await app.save({ profile: created.profile, name: 'Family renamed', readOnly: false, timeZone: 'UTC' });
    expect(app.current()!.profiles[1]).toMatchObject({ id: created.profile, name: 'Family renamed', readOnly: false, timeZone: 'UTC' });
    expect(app.current()!.profiles[0]).toEqual(before.profiles[0]);
    await app.admin.handle('/api/admin/profiles/remove', 'POST', { revision: (await app.read()).revision, profile: 'default' });
    expect(app.current()!.profiles.map((profile) => profile.id)).toEqual([created.profile]);
    const empty = await app.admin.handle('/api/admin/profiles/remove', 'POST', { revision: (await app.read()).revision, profile: created.profile });
    expect(empty).toMatchObject({ profile: null, configured: false, config: null, profiles: [] });
    expect(app.current()!.server.token).toBe(before.server.token);
    const recreated = await createSecond(app, 'Recreated');
    expect(recreated.profiles).toHaveLength(1);
    expect(app.current()!.server.token).toBe(before.server.token);
  });

  it('never leaks or reuses another profile’s password or notification secrets', async () => {
    const app = setup();
    const created = await createSecond(app);
    const selected = await app.admin.handle(`/api/admin/config?profile=${created.profile}`, 'GET');
    for (const secret of [PASSWORD, secondAccount.password, BOT_TOKEN, WEBHOOK, MCP_TOKEN]) {
      expect(JSON.stringify(selected)).not.toContain(secret);
    }
    app.checkAccount.mockResolvedValueOnce(['family-pool', 'other-pool']);
    await app.save({ profile: created.profile, account: { password: '', community: 'other-pool' } });
    expect(app.current()!.profiles[1].account.password).toBe(secondAccount.password);
    await expect(app.save({ profile: created.profile, account: { email: 'owner@example.com', site: 'de', password: '' } })).rejects.toMatchObject({ code: 'account_required' });
    await expect(app.admin.handle('/api/admin/account/check', 'POST', { profile: created.profile, account: { email: 'owner@example.com', site: 'de' } })).rejects.toMatchObject({ code: 'account_required' });
    await app.admin.handle('/api/admin/account/check', 'POST', { profile: created.profile, account: { email: secondAccount.email, site: 'com' } });
    expect(app.checkAccount).toHaveBeenLastCalledWith({ email: secondAccount.email, site: 'com', password: secondAccount.password });
    await expect(app.admin.handle('/api/admin/notifications/test', 'POST', { profile: created.profile, channel: { id: 'telegram-home', kind: 'telegram' } })).rejects.toMatchObject({ code: 'invalid_channel' });
    expect(app.sendNotification).not.toHaveBeenCalled();
  });

  it('rejects ambiguous or unknown selections before any calls and passes explicit report selections through', async () => {
    const app = setup();
    const created = await createSecond(app);
    await expect(app.save({ readOnly: false })).rejects.toMatchObject({ code: 'profile_required' });
    await expect(app.save({ profile: 'missing', readOnly: false })).rejects.toMatchObject({ code: 'profile_not_found' });
    await expect(app.admin.handle('/api/admin/check', 'POST', {})).rejects.toMatchObject({ code: 'profile_required' });
    await expect(app.admin.handle('/api/admin/config?profile=missing', 'GET')).rejects.toMatchObject({ code: 'profile_not_found' });
    await expect(app.admin.handle('/api/admin/config?profile=default&profile=missing', 'GET')).rejects.toMatchObject({ code: 'invalid_config' });
    await app.admin.handle(`/api/admin/overview?profile=${created.profile}`, 'GET');
    await app.admin.handle('/api/admin/check', 'POST', { profile: created.profile });
    expect(app.overview).toHaveBeenCalledExactlyOnceWith(created.profile);
    expect(app.check).toHaveBeenCalledExactlyOnceWith(created.profile);
  });

  it('verifies subscriptions using only the selected profile’s account and preserves the other profile', async () => {
    const app = setup();
    const created = await createSecond(app);
    const first = structuredClone(app.current()!.profiles[0]);
    app.checkAccount.mockClear();
    app.checkAccount.mockResolvedValueOnce(['family-pool', 'family-extra']);
    await app.save({ profile: created.profile, account: { communities: ['family-pool', 'family-extra'] } });
    expect(app.checkAccount).toHaveBeenCalledExactlyOnceWith({ email: secondAccount.email, password: secondAccount.password, site: secondAccount.site });
    expect(app.current()!.profiles[0]).toEqual(first);
    expect(app.current()!.profiles[1].account.communities).toEqual(['family-pool', 'family-extra']);
    app.checkAccount.mockResolvedValueOnce(['friends', 'work']);
    await expect(app.save({ profile: created.profile, account: { communities: ['family-pool', 'work'] } })).rejects.toMatchObject({ code: 'community_not_found' });
    expect(app.current()!.profiles[1].account.communities).toEqual(['family-pool', 'family-extra']);
    const snapshot = await app.admin.handle(`/api/admin/config?profile=${created.profile}`, 'GET') as any;
    expect(snapshot.config.account.communities).toEqual(['family-pool', 'family-extra']);
    await app.save({ profile: created.profile, account: { community: 'family-extra', communities: ['family-extra'] } });
    expect(app.checkAccount).toHaveBeenCalledTimes(2);
    expect(app.current()!.profiles[0]).toEqual(first);
  });

  it('uses one revision across all profiles and refuses duplicate names and secretless creation', async () => {
    const app = setup();
    const stale = (await app.read()).revision;
    const created = await createSecond(app);
    await expect(app.admin.handle('/api/admin/config', 'POST', { revision: stale, profile: 'default', readOnly: false })).rejects.toMatchObject({ code: 'config_conflict' });
    await expect(app.admin.handle('/api/admin/profiles/remove', 'POST', { revision: stale, profile: created.profile })).rejects.toMatchObject({ code: 'config_conflict' });
    await expect(createSecond(app, ' FAMILY ')).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(app.save({ profile: created.profile, name: 'default' })).rejects.toMatchObject({ code: 'invalid_config' });
    await expect(app.admin.handle('/api/admin/profiles', 'POST', { revision: (await app.read()).revision, name: 'Secretless', account: { email: 'owner@example.com', community: 'friends', site: 'de' } })).rejects.toMatchObject({ code: 'account_required' });
    expect(app.current()!.profiles).toHaveLength(2);
  });
});
