import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetup, discoverTelegramChats, type SetupIO } from '../src/setup-cli.js';
import { readServiceConfig, writeServiceConfig, type LegacyServiceConfig } from '../src/service/settings.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-setup-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function ioWith(answers: string[]) {
  const output: string[] = [];
  const questions: Array<{ question: string; secret?: boolean }> = [];
  const io: SetupIO = {
    log: (message) => output.push(message),
    async ask(question, options = {}) {
      questions.push({ question, secret: options.secret });
      if (!answers.length) throw new Error(`Unexpected question: ${question}`);
      return answers.shift() || options.default || '';
    },
  };
  return { io, output, questions };
}

it('guides fresh setup through account, Discord, automatic Telegram chat selection and generic webhook', async () => {
  const file = path.join(root, 'service.json');
  const inputs = [
    'person@example.com', 'fixture-password', '1', '1', 'Player', 'n', '',
    'j', '1', 'https://discord.com/api/webhooks/123/fake-token', 'j',
    'j', '2', '123:fake-bot-token', '', '1', 'j',
    'j', '3', 'https://example.com/webhook-token', 'j',
    'n', '24,6,1', '15',
  ];
  const { io, output, questions } = ioWith(inputs);
  const send = vi.fn().mockResolvedValue(undefined);
  const communities = vi.fn().mockResolvedValue(['my-pool', 'other-pool']);
  const chats = vi.fn().mockResolvedValue([{ id: '1234', label: 'Me' }]);
  await runSetup({ file, io, communities, telegramChats: chats, send });
  expect(inputs).toEqual([]);
  expect(communities).toHaveBeenCalledWith('person@example.com', 'fixture-password', 'de');
  expect(chats).toHaveBeenCalledWith('123:fake-bot-token');
  const config = readServiceConfig(file);
  expect(config.profiles[0].readOnly).toBe(true);
  expect(config.server.token.length).toBeGreaterThanOrEqual(32);
  expect(config.profiles[0].notifications.channels.map((c) => c.kind)).toEqual(['discord', 'telegram', 'webhook']);
  expect(send).toHaveBeenCalledTimes(3);
  expect(output.join('\n')).not.toMatch(/fixture-password|fake-token|fake-bot-token|webhook-token/);
  expect(questions.filter((q) => /Passwort|Token|Webhook-URL/.test(q.question)).every((q) => q.secret)).toBe(true);
});

it('edits notification settings without reconnecting or rotating the access key', async () => {
  const file = path.join(root, 'service.json');
  const config: LegacyServiceConfig = {
    version: 1, account: { email: 'person@example.com', password: 'old-password', community: 'my-pool', site: 'de' },
    server: { token: 'a'.repeat(43), host: '0.0.0.0', port: 8787, readOnly: false, allowedOrigins: [] },
    timeZone: 'Europe/Berlin', notifications: { channels: [{ id: 'hook', kind: 'webhook', url: 'https://example.com/hook' }], warnHours: [6], everyMinutes: 15 },
  };
  writeServiceConfig(config, file);
  const { io } = ioWith(['j', 'n', '12,2', '5']);
  const communities = vi.fn();
  await runSetup({ file, io, notificationsOnly: true, communities });
  expect(communities).not.toHaveBeenCalled();
  expect(readServiceConfig(file).profiles[0]).toMatchObject({ account: config.account, readOnly: false, notifications: { warnHours: [12, 2], everyMinutes: 5 } });
  expect(readServiceConfig(file).server.token).toBe(config.server.token);
});

it('does not save an account after failed login', async () => {
  const file = path.join(root, 'service.json');
  const { io } = ioWith(['person@example.com', 'password', '1']);
  await expect(runSetup({ file, io, communities: async () => { throw new Error('login failed'); } })).rejects.toThrow('login failed');
  expect(fs.existsSync(file)).toBe(false);
});

it.each([false, true])('reconciles web subscriptions during terminal setup (changed account: %s)', async (changed) => {
  const file = path.join(root, 'service.json');
  writeServiceConfig({
    version: 1, account: { email: 'person@example.com', password: 'old-password', community: 'old',
      communities: ['old', 'departed'], player: 'Old Player', site: 'de' },
    server: { token: 'a'.repeat(43), host: '0.0.0.0', port: 8787, readOnly: true, allowedOrigins: [] },
    timeZone: 'Europe/Berlin', notifications: { channels: [], warnHours: [], everyMinutes: 15 },
  }, file);
  const { io } = ioWith(['1', changed ? 'next@example.com' : 'person@example.com', 'fixture-password', '1', '1', '', 'n', '', 'n']);
  await runSetup({ file, io, communities: async () => ['new', 'old'] });
  expect(readServiceConfig(file).profiles[0].account).toMatchObject({ community: 'new', communities: changed ? ['new'] : ['old', 'new'] });
  expect(readServiceConfig(file).profiles[0].account.player).toBe(changed ? undefined : 'Old Player');
});

it('discovers Telegram chats without consuming updates and sanitizes provider errors', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: [
    { message: { chat: { id: 123, first_name: 'Me' } } }, { message: { chat: { id: 123, first_name: 'Me' } } },
    { message: { chat: { id: -123, title: 'Group' } } },
  ] })));
  await expect(discoverTelegramChats('123:token', fetchImpl)).resolves.toEqual([{ id: '123', label: 'Me' }, { id: '-123', label: 'Group' }]);
  const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(body).not.toHaveProperty('offset');
  expect(body).not.toHaveProperty('allowed_updates');
  await expect(discoverTelegramChats('123:token', async () => { throw new Error('secret URL 123:token'); })).rejects.not.toThrow('123:token');
});

it('adds a second named profile through setup while preserving the first profile and access token', async () => {
  const file = path.join(root, 'service.json');
  const legacy: LegacyServiceConfig = {
    version: 1, account: { email: 'person@example.com', password: 'old-password', community: 'my-pool', site: 'de' },
    server: { token: 'a'.repeat(43), host: '0.0.0.0', port: 8787, readOnly: false, allowedOrigins: [] },
    timeZone: 'Europe/Berlin', notifications: { channels: [{ id: 'hook', kind: 'webhook', url: 'https://example.com/hook' }], warnHours: [6], everyMinutes: 15 },
  };
  writeServiceConfig(legacy, file);
  const before = readServiceConfig(file);
  const { io } = ioWith(['2', 'Family', 'family@example.com', 'family-password', '2', '1', 'Family player', 'n', 'UTC', 'n']);
  const communities = vi.fn().mockResolvedValue(['family-pool']);
  await runSetup({ file, io, communities });
  const after = readServiceConfig(file);
  expect(after.profiles).toHaveLength(2);
  expect(after.profiles[0]).toEqual(before.profiles[0]);
  expect(after.server).toEqual(before.server);
  expect(after.profiles[1]).toMatchObject({ name: 'Family', readOnly: true, timeZone: 'UTC', account: {
    email: 'family@example.com', password: 'family-password', site: 'com', community: 'family-pool', player: 'Family player',
  } });
  expect(after.profiles[1].id).toMatch(/^profile-[a-f0-9]{16}$/);
  const { io: editIo } = ioWith(['2', 'n']);
  await runSetup({ file, io: editIo, notificationsOnly: true, communities });
  expect(communities).toHaveBeenCalledTimes(1);
  expect(readServiceConfig(file)).toEqual(after);
});

it('requires a new password when setup changes the account instead of borrowing the old password', async () => {
  const file = path.join(root, 'service.json');
  writeServiceConfig({
    version: 1, account: { email: 'person@example.com', password: 'old-password', community: 'my-pool', site: 'de' },
    server: { token: 'a'.repeat(43), host: '0.0.0.0', port: 8787, readOnly: false, allowedOrigins: [] },
    timeZone: 'Europe/Berlin', notifications: { channels: [], warnHours: [6], everyMinutes: 15 },
  }, file);
  const { io } = ioWith(['1', 'other@example.com', '', '1', 'replacement-password', '1', '', 'n', '', 'n']);
  const communities = vi.fn().mockResolvedValue(['other-pool']);
  await runSetup({ file, io, communities });
  expect(communities).toHaveBeenCalledWith('other@example.com', 'replacement-password', 'de');
  expect(readServiceConfig(file).profiles[0].account.password).toBe('replacement-password');
});
