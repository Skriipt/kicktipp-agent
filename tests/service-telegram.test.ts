import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/browser.js';
import { registerTargetsCommand } from '../src/commands/targets.js';
import { setJsonMode } from '../src/helpers/output.js';
import type { ReminderCapability } from '../src/reminder-capability.js';
import {
  SERVICE_JOB_ID as JOB_ID,
  serviceCapability,
  serviceConfiguration as configuration,
  serviceNotification,
} from './helpers/service-fixtures.js';
import { runReminderOnce } from '../src/service/delivery.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';
import {
  deliverTelegram,
  resolveTelegramTarget,
  telegramRequest,
  TelegramPayloadTooLargeError,
} from '../src/service/telegram.js';
import {
  readServiceConfiguration,
  readServiceState,
  setupService,
  type ServiceState,
} from '../src/service/store.js';
import {
  addTelegramTarget,
  listTargets,
  targetRevision,
  type TelegramTarget,
} from '../src/service/targets.js';

const NOW = new Date('2026-09-04T11:30:00.000Z');
const BOT_TOKEN = '123456789:telegram_bot_token-value';
const SECRET_CANARY = 'telegram-secret-canary';
const SEND_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

let root: string;
let paths: ServicePaths;

function target(overrides: Partial<TelegramTarget> = {}): TelegramTarget {
  return {
    id: 'family-telegram',
    name: 'Family Telegram',
    enabled: true,
    provider: 'telegram',
    botTokenRef: 'env:TELEGRAM_BOT_TOKEN',
    chatId: '-1001234567890',
    ...overrides,
  };
}

function notification(
  content: Partial<ServiceState['notifications'][number]['content']> = {},
): ServiceState['notifications'][number] {
  return serviceNotification({
    now: NOW,
    message: 'Missing: @alice @everyone <b>Bob</b> _Carol_',
    displayName: '@alice',
    content,
  });
}

function capability(displayName = '@alice <b>Bob</b>'): ReminderCapability {
  return serviceCapability(displayName);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-telegram-'));
  paths = servicePaths({
    KICKTIPP_CONFIG_DIR: path.join(root, 'config'),
    KICKTIPP_DATA_DIR: path.join(root, 'data'),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setJsonMode(false);
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Telegram Notification Target', () => {
  it('uses only the official Bot API endpoint and redacts the bot token', () => {
    expect(resolveTelegramTarget(target(), {
      env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, paths,
    })).toEqual({ url: SEND_URL });

    let thrown: unknown;
    try {
      resolveTelegramTarget(target(), {
        env: { TELEGRAM_BOT_TOKEN: `123:${SECRET_CANARY}/../evil` }, paths,
      });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).not.toContain(SECRET_CANARY);
  });

  it('stores only the Secret Reference and revisions include chat and Topic configuration', () => {
    setupService(configuration(), paths);
    addTelegramTarget({
      id: 'family-telegram',
      botTokenRef: 'env:TELEGRAM_BOT_TOKEN',
      chatId: '-1001234567890',
      topicId: 42,
    }, paths);
    expect(readServiceConfiguration(paths).targets).toEqual([{
      id: 'family-telegram',
      enabled: true,
      provider: 'telegram',
      botTokenRef: 'env:TELEGRAM_BOT_TOKEN',
      chatId: '-1001234567890',
      topicId: 42,
    }]);
    expect(listTargets(paths)).toEqual([expect.objectContaining({
      id: 'family-telegram',
      provider: 'telegram',
      secrets: [{ purpose: 'bot-token', configured: true, sourceClass: 'env' }],
    })]);
    expect(JSON.stringify(listTargets(paths))).not.toContain('TELEGRAM_BOT_TOKEN');

    const first = target();
    expect(targetRevision({ ...first, name: 'Renamed', enabled: false })).toBe(targetRevision(first));
    expect(targetRevision({ ...first, botTokenRef: 'env:OTHER_BOT_TOKEN' })).not.toBe(targetRevision(first));
    expect(targetRevision({ ...first, chatId: '-100999' })).not.toBe(targetRevision(first));
    expect(targetRevision({ ...first, topicId: 42 })).not.toBe(targetRevision(first));
  });

  it('supports add, redacted list, explicit test, disable, enable, and remove through the CLI', async () => {
    setupService(configuration(), paths);
    vi.stubEnv('KICKTIPP_CONFIG_DIR', paths.configDir);
    vi.stubEnv('KICKTIPP_DATA_DIR', paths.dataDir);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', BOT_TOKEN);
    const providerFetch = vi.fn<FetchLike>(async () => new Response(
      '{"ok":true,"result":{"message_id":123}}',
      { status: 200 },
    ));
    vi.stubGlobal('fetch', providerFetch);
    const program = new Command().exitOverride();
    registerTargetsCommand(program);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync([
      'node', 'test', 'targets', 'add', 'family-telegram',
      '--provider', 'telegram',
      '--bot-token-ref', 'env:TELEGRAM_BOT_TOKEN',
      '--chat-id', '-1001234567890',
      '--topic-id', '42',
    ]);
    await program.parseAsync(['node', 'test', 'targets', 'list', '--json']);
    await program.parseAsync(['node', 'test', 'targets', 'test', 'family-telegram']);
    await program.parseAsync(['node', 'test', 'targets', 'disable', 'family-telegram']);
    await program.parseAsync(['node', 'test', 'targets', 'enable', 'family-telegram']);
    await program.parseAsync(['node', 'test', 'targets', 'remove', 'family-telegram']);

    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('Telegram');
    expect(output).toContain('confirmed');
    expect(output).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(output).not.toContain(BOT_TOKEN);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(readServiceConfiguration(paths)).toMatchObject({ targets: [], job: { targetIds: [] } });
  });
});

describe('Telegram adapter contract', () => {
  it.each([
    ['info', 'ℹ️'],
    ['warning', '⚠️'],
    ['urgent', '🚨'],
  ] as const)('renders mention-neutral plain text with a fixed %s marker and URL button', (severity, marker) => {
    const request = telegramRequest(notification({ severity }), target(), {
      env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, paths,
    });
    const payload = JSON.parse(request.body);
    expect(payload).toEqual({
      chat_id: '-1001234567890',
      text: `${marker} Kicktipp reminder: Family\n\nMissing: @\u200calice @\u200ceveryone <b>Bob</b> _Carol_`,
      reply_markup: {
        inline_keyboard: [[{
          text: 'Kicktipp',
          url: 'https://www.kicktipp.com/family/predict',
        }]],
      },
    });
    expect(payload).not.toHaveProperty('parse_mode');
    expect(payload.text).not.toMatch(/@[A-Za-z0-9_]/u);
  });

  it('routes chat and Topic messages through the same sendMessage endpoint', async () => {
    for (const telegramTarget of [target(), target({ topicId: 42 })]) {
      const request = telegramRequest(notification(), telegramTarget, {
        env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, paths,
      });
      const providerFetch = vi.fn<FetchLike>(async (input, init) => {
        expect(input).toBe(SEND_URL);
        expect(JSON.parse(String(init.body))).toMatchObject({
          chat_id: '-1001234567890',
          ...(telegramTarget.topicId ? { message_thread_id: 42 } : {}),
        });
        return new Response('{"ok":true,"result":{"message_id":123}}', { status: 200 });
      });
      await expect(deliverTelegram(request, { fetchImpl: providerFetch, now: NOW })).resolves
        .toMatchObject({ state: 'confirmed' });
      expect(providerFetch).toHaveBeenCalledOnce();
    }
  });

  it('rejects unsafe action URLs and payloads that do not fit without truncating', () => {
    expect(() => telegramRequest(notification({ actionUrl: 'https://evil.test/phish' }), target(), {
      env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, paths,
    })).toThrow(expect.objectContaining({ code: 'invalid_action_url' }));
    expect(() => telegramRequest(notification({ message: 'a'.repeat(4097) }), target(), {
      env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, paths,
    })).toThrow(TelegramPayloadTooLargeError);
  });

  it('uses the shared transport and confirms only ok=true with a valid message receipt', async () => {
    const providerFetch = vi.fn<FetchLike>(async (input, init) => {
      expect(input).toBe(SEND_URL);
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        'User-Agent': 'kicktipp-agent/1.3.0 service',
      });
      return new Response('{"ok":true,"result":{"message_id":123}}', { status: 200 });
    });
    await expect(deliverTelegram({ url: SEND_URL, body: '{}' }, {
      fetchImpl: providerFetch,
      now: NOW,
    })).resolves.toEqual({
      state: 'confirmed',
      retryable: false,
      receipt: { provider: 'telegram', messageId: '123', acceptedAt: NOW.toISOString() },
    });
  });

  it.each([
    ['', 'malformed_receipt'],
    ['{}', 'malformed_receipt'],
    ['{"ok":true}', 'malformed_receipt'],
    ['{"ok":true,"result":{"message_id":0}}', 'malformed_receipt'],
    ['{"ok":true,"result":{"message_id":"123"}}', 'malformed_receipt'],
    ['not-json', 'malformed_receipt'],
  ])('classifies a possibly accepted malformed receipt as unknown', async (body, safeErrorCode) => {
    await expect(deliverTelegram({ url: SEND_URL, body: '{}' }, {
      fetchImpl: async () => new Response(body, { status: 200 }),
    })).resolves.toMatchObject({ state: 'unknown', retryable: false, safeErrorCode });
  });

  it('caps a possibly accepted provider response at 64 KiB', async () => {
    await expect(deliverTelegram({ url: SEND_URL, body: '{}' }, {
      fetchImpl: async () => new Response('x'.repeat(64 * 1024 + 1), { status: 200 }),
    })).resolves.toMatchObject({ state: 'unknown', retryable: false, safeErrorCode: 'response_too_large' });
  });

  it.each([
    [400, 'invalid_target', false, 'failed'],
    [401, 'authentication_failed', false, 'failed'],
    [403, 'permission_denied', false, 'failed'],
    [404, 'authentication_failed', false, 'failed'],
    [429, 'rate_limited', true, 'failed'],
    [503, 'provider_5xx', false, 'unknown'],
    [302, 'redirect_refused', false, 'failed'],
  ] as const)('conservatively classifies HTTP %s', async (status, safeErrorCode, retryable, state) => {
    const body = status === 429
      ? '{"ok":false,"error_code":429,"description":"secret","parameters":{"retry_after":3}}'
      : `{"ok":false,"error_code":${status},"description":"${SECRET_CANARY}"}`;
    const providerFetch = vi.fn<FetchLike>(async () => new Response(body, { status }));
    const outcome = await deliverTelegram({ url: SEND_URL, body: '{}' }, { fetchImpl: providerFetch, now: NOW });
    expect(outcome).toMatchObject({ state, retryable, safeErrorCode });
    expect(JSON.stringify(outcome)).not.toContain(SECRET_CANARY);
    if (status === 429) expect(outcome).toMatchObject({ retryAfterMilliseconds: 3000 });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it('classifies an explicit Bot API rejection carried by HTTP 200', async () => {
    await expect(deliverTelegram({ url: SEND_URL, body: '{}' }, {
      fetchImpl: async () => new Response(
        '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}',
        { status: 200 },
      ),
    })).resolves.toMatchObject({ state: 'failed', retryable: false, safeErrorCode: 'invalid_target' });
  });

  it('does not confirm a receipt carried by a rejected HTTP response', async () => {
    await expect(deliverTelegram({ url: SEND_URL, body: '{}' }, {
      fetchImpl: async () => new Response('{"ok":true,"result":{"message_id":123}}', { status: 400 }),
    })).resolves.toMatchObject({ state: 'failed', retryable: false, safeErrorCode: 'invalid_target' });
  });

  it('retries only transport failures proving that acceptance did not occur', async () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']) {
      await expect(deliverTelegram({ url: SEND_URL, body: '{}' }, {
        fetchImpl: async () => { throw Object.assign(new TypeError('secret'), { cause: { code } }); },
      })).resolves.toMatchObject({ state: 'failed', retryable: true, safeErrorCode: 'connection_unavailable' });
    }
    for (const code of ['ETIMEDOUT', 'ECONNRESET']) {
      await expect(deliverTelegram({ url: SEND_URL, body: '{}' }, {
        fetchImpl: async () => { throw Object.assign(new TypeError('secret'), { cause: { code } }); },
      })).resolves.toMatchObject({ state: 'unknown', retryable: false, safeErrorCode: 'transport_ambiguous' });
    }
  });
});

describe('Telegram through the shared Delivery engine', () => {
  it('persists the receipt without provider bodies or secrets and does not send again', async () => {
    const config = configuration([target()]);
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>(async (_input, init) => {
      const payload = JSON.parse(String(init.body));
      expect(payload.text).not.toMatch(/@[A-Za-z0-9_]/u);
      return new Response(
        `{"ok":true,"result":{"message_id":123,"text":"${SECRET_CANARY}"}}`,
        { status: 200 },
      );
    });
    const run = () => runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN },
      getReminderCapability: async () => capability(),
      providerFetchImpl: providerFetch,
    });

    expect(await run()).toMatchObject({ reliable: true, outcome: 'notified', deliveryStates: ['confirmed'] });
    expect(await run()).toMatchObject({ reliable: true, outcome: 'already-processed', deliveryStates: ['confirmed'] });
    expect(providerFetch).toHaveBeenCalledOnce();
    const state = readServiceState(config, paths);
    expect(state).toMatchObject({
      deliveries: [{ state: 'confirmed', receipt: { provider: 'telegram', messageId: '123' } }],
      attempts: [{ outcome: { state: 'confirmed', receipt: { provider: 'telegram' } } }],
    });
    expect(JSON.stringify(state)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(state)).not.toContain(SECRET_CANARY);
  });

  it('fails an oversized payload locally without a Delivery Attempt', async () => {
    const config = configuration([target()]);
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>();
    const result = await runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN },
      getReminderCapability: async () => capability('x'.repeat(4097)),
      providerFetchImpl: providerFetch,
    });

    expect(result).toMatchObject({ reliable: true, deliveryStates: ['failed'] });
    expect(readServiceState(config, paths)).toMatchObject({
      deliveries: [{ state: 'failed', safeErrorCode: 'payload_too_large' }],
      attempts: [],
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
