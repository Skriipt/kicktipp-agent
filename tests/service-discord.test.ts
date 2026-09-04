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
import {
  deliverDiscord,
  discordRequest,
  DiscordPayloadTooLargeError,
  resolveDiscordTarget,
  validateDiscordWebhookUrl,
} from '../src/service/discord.js';
import { runReminderOnce } from '../src/service/delivery.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';
import {
  readServiceConfiguration,
  readServiceState,
  setupService,
  type ServiceState,
} from '../src/service/store.js';
import {
  addDiscordTarget,
  listTargets,
  targetRevision,
  type DiscordTarget,
} from '../src/service/targets.js';

const NOW = new Date('2026-09-04T11:30:00.000Z');
const WEBHOOK_URL = 'https://discord.com/api/webhooks/123456789012345678/token_value.secret';
const SECRET_CANARY = 'discord-secret-canary';

let root: string;
let paths: ServicePaths;

function target(): DiscordTarget {
  return {
    id: 'family-discord',
    name: 'Family Discord',
    enabled: true,
    provider: 'discord',
    webhookUrlRef: 'env:DISCORD_WEBHOOK_URL',
  };
}

function notification(
  content: Partial<ServiceState['notifications'][number]['content']> = {},
): ServiceState['notifications'][number] {
  return serviceNotification({
    now: NOW,
    message: 'Missing: @everyone <@123> *Alice* `Bob`',
    displayName: '@everyone',
    content,
  });
}

function capability(displayName = '@everyone <@123> *Alice*'): ReminderCapability {
  return serviceCapability(displayName);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-discord-'));
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

describe('Discord Notification Target', () => {
  it('accepts only official Discord HTTPS execute-webhook endpoints', () => {
    expect(validateDiscordWebhookUrl(WEBHOOK_URL)).toBe(WEBHOOK_URL);
    expect(validateDiscordWebhookUrl('https://discord.com/api/v10/webhooks/123/token'))
      .toBe('https://discord.com/api/v10/webhooks/123/token');
    for (const value of [
      'http://discord.com/api/webhooks/123/token',
      'https://discord.com.evil.test/api/webhooks/123/token',
      'https://user:password@discord.com/api/webhooks/123/token',
      'https://discord.com/api/webhooks/123/token?wait=false',
      'https://discord.com/api/webhooks/123/token#fragment',
      'https://discord.com/channels/123/token',
    ]) expect(() => validateDiscordWebhookUrl(value)).toThrow(expect.objectContaining({ code: 'invalid_url' }));
  });

  it('stores only the Secret Reference and redacts it from summaries and errors', () => {
    setupService(configuration(), paths);
    addDiscordTarget({ id: 'family-discord', webhookUrlRef: 'env:DISCORD_WEBHOOK_URL' }, paths);
    expect(readServiceConfiguration(paths).targets).toEqual([{
      id: 'family-discord',
      enabled: true,
      provider: 'discord',
      webhookUrlRef: 'env:DISCORD_WEBHOOK_URL',
    }]);
    expect(listTargets(paths)).toEqual([expect.objectContaining({
      id: 'family-discord',
      provider: 'discord',
      secrets: [{ purpose: 'webhook-url', configured: true, sourceClass: 'env' }],
    })]);
    expect(JSON.stringify(listTargets(paths))).not.toContain('DISCORD_WEBHOOK_URL');

    let thrown: unknown;
    try {
      resolveDiscordTarget(target(), {
        env: { DISCORD_WEBHOOK_URL: `https://${SECRET_CANARY}.test/api/webhooks/123/token` },
        paths,
      });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).not.toContain(SECRET_CANARY);
  });

  it('hashes the Secret Reference but not display metadata or enabled state', () => {
    const first = target();
    expect(targetRevision({ ...first, name: 'Renamed', enabled: false })).toBe(targetRevision(first));
    expect(targetRevision({ ...first, webhookUrlRef: 'env:OTHER_DISCORD_WEBHOOK' }))
      .not.toBe(targetRevision(first));
  });

  it('supports Discord add, list, test, disable, enable, and remove through the CLI', async () => {
    setupService(configuration(), paths);
    vi.stubEnv('KICKTIPP_CONFIG_DIR', paths.configDir);
    vi.stubEnv('KICKTIPP_DATA_DIR', paths.dataDir);
    vi.stubEnv('DISCORD_WEBHOOK_URL', WEBHOOK_URL);
    const providerFetch = vi.fn<FetchLike>(async () => new Response('{"id":"123456789012345678"}', { status: 200 }));
    vi.stubGlobal('fetch', providerFetch);
    const program = new Command().exitOverride();
    registerTargetsCommand(program);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync([
      'node', 'test', 'targets', 'add', 'family-discord',
      '--provider', 'discord',
      '--webhook-url-ref', 'env:DISCORD_WEBHOOK_URL',
    ]);
    await program.parseAsync(['node', 'test', 'targets', 'list', '--json']);
    await program.parseAsync(['node', 'test', 'targets', 'test', 'family-discord']);
    await program.parseAsync(['node', 'test', 'targets', 'disable', 'family-discord']);
    await program.parseAsync(['node', 'test', 'targets', 'enable', 'family-discord']);
    await program.parseAsync(['node', 'test', 'targets', 'remove', 'family-discord']);

    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('Discord');
    expect(output).toContain('confirmed');
    expect(output).not.toContain('DISCORD_WEBHOOK_URL');
    expect(output).not.toContain('token_value');
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(readServiceConfiguration(paths)).toMatchObject({ targets: [], job: { targetIds: [] } });
  });
});

describe('Discord adapter contract', () => {
  it.each([
    ['info', 0x5865f2],
    ['warning', 0xfee75c],
    ['urgent', 0xed4245],
  ] as const)('renders a mention-safe, JSON-encoded %s Embed', (severity, color) => {
    const request = discordRequest(notification({ severity }), target(), {
      env: { DISCORD_WEBHOOK_URL: WEBHOOK_URL },
      paths,
    });
    const payload = JSON.parse(request.body);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds).toEqual([expect.objectContaining({
      title: 'Kicktipp reminder: Family',
      description: 'Missing: @everyone <@123\\> \\*Alice\\* \\`Bob\\`',
      color,
      url: 'https://www.kicktipp.com/family/predict',
    })]);
    expect(request.body).not.toContain('"content"');
  });

  it('rejects unsafe action URLs and payloads that do not fit without truncating', () => {
    expect(() => discordRequest(notification({ actionUrl: 'https://evil.test/phish' }), target(), {
      env: { DISCORD_WEBHOOK_URL: WEBHOOK_URL }, paths,
    })).toThrow(expect.objectContaining({ code: 'invalid_url' }));
    expect(() => discordRequest(notification({ message: 'a'.repeat(4097) }), target(), {
      env: { DISCORD_WEBHOOK_URL: WEBHOOK_URL }, paths,
    })).toThrow(DiscordPayloadTooLargeError);
  });

  it('sets wait=true and confirms only a valid Discord Message receipt', async () => {
    const providerFetch = vi.fn<FetchLike>(async (input, init) => {
      expect(input).toBe(`${WEBHOOK_URL}?wait=true`);
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        'User-Agent': 'kicktipp-agent/1.3.0 service',
      });
      return new Response('{"id":"123456789012345678"}', { status: 200 });
    });
    const outcome = await deliverDiscord({ url: WEBHOOK_URL, body: '{}' }, {
      fetchImpl: providerFetch,
      now: NOW,
    });
    expect(outcome).toEqual({
      state: 'confirmed',
      retryable: false,
      receipt: {
        provider: 'discord',
        messageId: '123456789012345678',
        acceptedAt: NOW.toISOString(),
      },
    });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it('composes supervisor cancellation with the provider timeout', async () => {
    const controller = new AbortController();
    const outcome = deliverDiscord({ url: WEBHOOK_URL, body: '{}' }, {
      signal: controller.signal,
      fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      }),
    });
    controller.abort();
    await expect(outcome).resolves.toMatchObject({
      state: 'unknown',
      retryable: false,
      safeErrorCode: 'transport_ambiguous',
    });
  });

  it.each([
    ['', 'malformed_receipt'],
    ['{}', 'malformed_receipt'],
    ['{"id":"not-a-snowflake"}', 'malformed_receipt'],
    ['{"id":"99999999999999999999"}', 'malformed_receipt'],
    ['not-json', 'malformed_receipt'],
  ])('classifies a possibly accepted malformed receipt as unknown', async (body, safeErrorCode) => {
    expect(await deliverDiscord({ url: WEBHOOK_URL, body: '{}' }, {
      fetchImpl: async () => new Response(body, { status: 200 }),
    })).toMatchObject({ state: 'unknown', retryable: false, safeErrorCode });
  });

  it('caps a possibly accepted provider response at 64 KiB', async () => {
    expect(await deliverDiscord({ url: WEBHOOK_URL, body: '{}' }, {
      fetchImpl: async () => new Response('x'.repeat(64 * 1024 + 1), { status: 200 }),
    })).toMatchObject({ state: 'unknown', retryable: false, safeErrorCode: 'response_too_large' });
  });

  it.each([
    [401, 'authentication_failed', false, 'failed'],
    [403, 'permission_denied', false, 'failed'],
    [404, 'invalid_target', false, 'failed'],
    [429, 'rate_limited', true, 'failed'],
    [503, 'provider_5xx', false, 'unknown'],
    [302, 'redirect_refused', false, 'failed'],
  ] as const)('conservatively classifies HTTP %s', async (status, safeErrorCode, retryable, state) => {
    const providerFetch = vi.fn<FetchLike>(async () => new Response(null, {
      status,
      headers: status === 429 ? { 'Retry-After': '2.5' } : undefined,
    }));
    const outcome = await deliverDiscord({ url: WEBHOOK_URL, body: '{}' }, { fetchImpl: providerFetch, now: NOW });
    expect(outcome).toMatchObject({ state, retryable, safeErrorCode });
    if (status === 429) expect(outcome).toMatchObject({ retryAfterMilliseconds: 2500 });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it('retries only transport failures proving that acceptance did not occur', async () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']) {
      expect(await deliverDiscord({ url: WEBHOOK_URL, body: '{}' }, {
        fetchImpl: async () => { throw Object.assign(new TypeError('secret'), { cause: { code } }); },
      })).toMatchObject({ state: 'failed', retryable: true, safeErrorCode: 'connection_unavailable' });
    }
    for (const code of ['ETIMEDOUT', 'ECONNRESET']) {
      expect(await deliverDiscord({ url: WEBHOOK_URL, body: '{}' }, {
        fetchImpl: async () => { throw Object.assign(new TypeError('secret'), { cause: { code } }); },
      })).toMatchObject({ state: 'unknown', retryable: false, safeErrorCode: 'transport_ambiguous' });
    }
  });
});

describe('Discord through the shared Delivery engine', () => {
  it('persists the receipt and does not send a terminal Delivery again', async () => {
    const config = configuration([target()]);
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>(async (_input, init) => {
      const payload = JSON.parse(String(init.body));
      expect(payload.allowed_mentions).toEqual({ parse: [] });
      return new Response('{"id":"123456789012345678"}', { status: 200 });
    });
    const run = () => runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: { DISCORD_WEBHOOK_URL: WEBHOOK_URL },
      getReminderCapability: async () => capability(),
      providerFetchImpl: providerFetch,
    });

    expect(await run()).toMatchObject({ reliable: true, outcome: 'notified', deliveryStates: ['confirmed'] });
    expect(await run()).toMatchObject({ reliable: true, outcome: 'already-processed', deliveryStates: ['confirmed'] });
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(readServiceState(config, paths)).toMatchObject({
      deliveries: [{ state: 'confirmed', receipt: { provider: 'discord', messageId: '123456789012345678' } }],
      attempts: [{ outcome: { state: 'confirmed', receipt: { provider: 'discord' } } }],
    });
  });

  it('fails an oversized payload locally without a Delivery Attempt', async () => {
    const config = configuration([target()]);
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>();
    const result = await runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: { DISCORD_WEBHOOK_URL: WEBHOOK_URL },
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
