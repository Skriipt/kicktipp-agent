import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/browser.js';
import { registerTargetsCommand } from '../src/commands/targets.js';
import { setJsonMode } from '../src/helpers/output.js';
import type { ReminderCapability } from '../src/reminder-capability.js';
import { runReminderOnce } from '../src/service/delivery.js';
import {
  deliverNtfy,
  ntfyRequest,
  NtfyPayloadTooLargeError,
  validateNtfyServerUrl,
  validateNtfyToken,
  validateNtfyTopic,
} from '../src/service/ntfy.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';
import {
  readServiceConfiguration,
  readServiceState,
  setupService,
  type ServiceConfiguration,
  type ServiceState,
} from '../src/service/store.js';
import { getServiceStatus } from '../src/service/status.js';
import {
  addNtfyTarget,
  listTargets,
  targetRevision,
  type NtfyTarget,
} from '../src/service/targets.js';

const NOW = new Date('2026-09-04T11:30:00.000Z');
const JOB_ID = '9e90818e-a71f-472c-b4ad-c82f67f5195c';
const TOKEN = 'tk_12345678901234567890123456789';
const SECRET_CANARY = '12345678901234567890123456789';

let root: string;
let paths: ServicePaths;

function target(overrides: Partial<NtfyTarget> = {}): NtfyTarget {
  return {
    id: 'family-ntfy',
    name: 'Family ntfy',
    enabled: true,
    provider: 'ntfy',
    serverUrl: 'https://ntfy.example/',
    topic: 'family_reminders',
    ...overrides,
  };
}

function configuration(targets: ServiceConfiguration['targets'] = []): ServiceConfiguration {
  return {
    schemaVersion: 1,
    job: {
      id: JOB_ID,
      name: 'community-reminder',
      enabled: targets.length > 0,
      profileId: 'service-profile',
      communityId: 'family',
      language: 'en',
      displayTimezone: 'Europe/Berlin',
      policy: {
        matchSelection: 'next-deadline-group',
        completion: 'all-games-in-group',
        excludeParticipantIds: [],
        stages: [{ beforeDeadlineMinutes: 60, severity: 'urgent' }],
      },
      targetIds: targets.map(({ id }) => id),
    },
    targets,
  };
}

function notification(
  content: Partial<ServiceState['notifications'][number]['content']> = {},
): ServiceState['notifications'][number] {
  return {
    id: 'a'.repeat(64),
    jobId: JOB_ID,
    createdAt: NOW.toISOString(),
    language: 'en',
    displayTimezone: 'Europe/Berlin',
    content: {
      schemaVersion: 1,
      type: 'reminder',
      severity: 'warning',
      title: 'Kicktipp reminder: Family',
      message: 'Predictions are missing from Alice.',
      actionUrl: 'https://www.kicktipp.com/family/predict',
      ...content,
    },
    deadlineGroup: {
      id: 'b'.repeat(64),
      deadlineAt: '2026-09-04T12:00:00.000Z',
      gameIds: ['game-1'],
    },
    stage: '60',
    missingParticipants: [{ id: 'alice', displayName: 'Alice' }],
  };
}

function capability(displayName = 'Alice'): ReminderCapability {
  return {
    available: true,
    snapshot: {
      profileId: 'service-profile',
      communityId: 'family',
      sourceTimeZone: 'Europe/Berlin',
      participants: [{ id: 'alice', displayName }],
      games: [{
        id: 'game-1',
        deadlineAt: '2026-09-04T12:00:00.000Z',
        deadlineSource: 'event',
      }],
      cells: [{ participantId: 'alice', gameId: 'game-1', status: 'missing' }],
    },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-ntfy-'));
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

describe('ntfy Notification Target', () => {
  it('stores anonymous/token targets, revisions, and nonblocking HTTP Doctor metadata without secrets', () => {
    setupService(configuration(), paths);
    addNtfyTarget({
      id: 'family-ntfy',
      serverUrl: 'http://ntfy.lan',
      topic: 'family_reminders',
      tokenRef: 'env:NTFY_TOKEN',
      allowInsecureHttp: true,
    }, paths);
    expect(readServiceConfiguration(paths).targets).toEqual([{
      id: 'family-ntfy',
      enabled: true,
      provider: 'ntfy',
      serverUrl: 'http://ntfy.lan',
      topic: 'family_reminders',
      tokenRef: 'env:NTFY_TOKEN',
      allowInsecureHttp: true,
    }]);
    expect(listTargets(paths)).toEqual([expect.objectContaining({
      provider: 'ntfy',
      secrets: [{ purpose: 'token', configured: true, sourceClass: 'env' }],
      doctorWarnings: [{ code: 'insecure_http', blocking: false }],
    })]);
    expect(JSON.stringify(listTargets(paths))).not.toContain('NTFY_TOKEN');

    const first = target();
    expect(targetRevision({ ...first, name: 'Renamed', enabled: false })).toBe(targetRevision(first));
    expect(targetRevision({ ...first, serverUrl: 'https://other-ntfy.example/' })).not.toBe(targetRevision(first));
    expect(targetRevision({ ...first, topic: 'other' })).not.toBe(targetRevision(first));
    expect(targetRevision({ ...first, tokenRef: 'env:OTHER_TOKEN' })).not.toBe(targetRevision(first));
    expect(targetRevision({ ...first, allowInsecureHttp: true })).not.toBe(targetRevision(first));
  });

  it('rejects Basic/userinfo, unsafe server URLs, invalid topics, and HTTP without explicit opt-in', () => {
    for (const url of [
      'https://user:password@ntfy.example/',
      'https://ntfy.example/#fragment',
      'https://ntfy.example/?auth=Basic',
      'https://ntfy.example/topic',
      'ftp://ntfy.example/',
    ]) expect(() => validateNtfyServerUrl(url)).toThrow();
    expect(() => validateNtfyServerUrl('http://ntfy.lan/')).toThrow(expect.objectContaining({ code: 'insecure_http' }));
    expect(validateNtfyServerUrl('http://ntfy.lan/', true)).toBe('http://ntfy.lan/');
    for (const topic of ['', 'has/slash', '*', 'x'.repeat(65)]) {
      expect(() => validateNtfyTopic(topic)).toThrow();
    }
    expect(validateNtfyTopic('family-reminders_1')).toBe('family-reminders_1');
  });

  it('redacts malformed Access Tokens', () => {
    let thrown: unknown;
    try { validateNtfyToken(`tk_${SECRET_CANARY}!`); } catch (error) { thrown = error; }
    expect(String(thrown)).not.toContain(SECRET_CANARY);
  });

  it('supports add, redacted list, explicit test, disable, enable, and remove through the CLI', async () => {
    setupService(configuration(), paths);
    vi.stubEnv('KICKTIPP_CONFIG_DIR', paths.configDir);
    vi.stubEnv('KICKTIPP_DATA_DIR', paths.dataDir);
    vi.stubEnv('NTFY_TOKEN', TOKEN);
    const providerFetch = vi.fn<FetchLike>(async () => new Response('{"id":"AbCdEf123456"}', { status: 200 }));
    vi.stubGlobal('fetch', providerFetch);
    const program = new Command().exitOverride();
    registerTargetsCommand(program);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync([
      'node', 'test', 'targets', 'add', 'family-ntfy', '--provider', 'ntfy',
      '--server-url', 'https://ntfy.example', '--topic', 'family', '--token-ref', 'env:NTFY_TOKEN',
    ]);
    await program.parseAsync(['node', 'test', 'targets', 'list', '--json']);
    await program.parseAsync(['node', 'test', 'targets', 'test', 'family-ntfy']);
    await program.parseAsync(['node', 'test', 'targets', 'disable', 'family-ntfy']);
    await program.parseAsync(['node', 'test', 'targets', 'enable', 'family-ntfy']);
    await program.parseAsync(['node', 'test', 'targets', 'remove', 'family-ntfy']);

    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('ntfy');
    expect(output).toContain('confirmed');
    expect(output).not.toContain('NTFY_TOKEN');
    expect(output).not.toContain(TOKEN);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(readServiceConfiguration(paths)).toMatchObject({ targets: [], job: { targetIds: [] } });
  });
});

describe('ntfy adapter contract', () => {
  it.each([
    ['info', 3],
    ['warning', 4],
    ['urgent', 5],
  ] as const)('renders fixed title/text, priority %s, and one view action', (severity, priority) => {
    const request = ntfyRequest(notification({ severity }), target());
    expect(request.url).toBe('https://ntfy.example/');
    expect(request.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(request.body)).toEqual({
      topic: 'family_reminders',
      title: 'Kicktipp reminder: Family',
      message: 'Predictions are missing from Alice.',
      priority,
      actions: [{
        action: 'view',
        label: 'Kicktipp',
        url: 'https://www.kicktipp.com/family/predict',
      }],
    });
  });

  it('supports anonymous access and Bearer Access Tokens only', () => {
    expect(ntfyRequest(notification(), target()).headers).not.toHaveProperty('Authorization');
    const authenticated = ntfyRequest(notification(), target({ tokenRef: 'env:NTFY_TOKEN' }), {
      env: { NTFY_TOKEN: TOKEN }, paths,
    });
    expect(authenticated.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(authenticated.headers.Authorization).not.toMatch(/^Basic /u);
  });

  it('fails content that cannot fit completely without truncation or splitting', () => {
    expect(() => ntfyRequest(notification({ message: '😀'.repeat(1025) }), target()))
      .toThrow(NtfyPayloadTooLargeError);
    expect(() => ntfyRequest(notification({ title: 'a'.repeat(1025) }), target()))
      .toThrow(NtfyPayloadTooLargeError);
  });

  it('uses shared redirect/timeout policy and confirms only a valid ntfy receipt', async () => {
    const providerFetch = vi.fn<FetchLike>(async (input, init) => {
      expect(input).toBe('https://ntfy.example/');
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        'User-Agent': expect.stringMatching(/^kicktipp-agent\/\S+ service$/u),
      });
      return new Response('{"id":"AbCdEf123456","message":"ignored"}', { status: 200 });
    });
    await expect(deliverNtfy(ntfyRequest(notification(), target()), { fetchImpl: providerFetch, now: NOW }))
      .resolves.toEqual({
        state: 'confirmed',
        retryable: false,
        receipt: { provider: 'ntfy', messageId: 'AbCdEf123456', acceptedAt: NOW.toISOString() },
      });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it.each(['', '{}', '{"id":"short"}', '{"id":"invalid!!!!"}', 'not-json'])
    ('classifies a possibly accepted malformed receipt as unknown', async (body) => {
      await expect(deliverNtfy({ url: 'https://ntfy.example/', headers: {}, body: '{}' }, {
        fetchImpl: async () => new Response(body, { status: 200 }),
      })).resolves.toMatchObject({ state: 'unknown', retryable: false, safeErrorCode: 'malformed_receipt' });
    });

  it('caps a possibly accepted response at 64 KiB', async () => {
    await expect(deliverNtfy({ url: 'https://ntfy.example/', headers: {}, body: '{}' }, {
      fetchImpl: async () => new Response('x'.repeat(64 * 1024 + 1), { status: 200 }),
    })).resolves.toMatchObject({ state: 'unknown', retryable: false, safeErrorCode: 'response_too_large' });
  });

  it.each([
    [400, 'invalid_target', false, 'failed'],
    [401, 'authentication_failed', false, 'failed'],
    [403, 'permission_denied', false, 'failed'],
    [404, 'invalid_target', false, 'failed'],
    [429, 'rate_limited', true, 'failed'],
    [503, 'provider_5xx', false, 'unknown'],
    [302, 'redirect_refused', false, 'failed'],
  ] as const)('conservatively classifies HTTP %s', async (status, safeErrorCode, retryable, state) => {
    const providerFetch = vi.fn<FetchLike>(async () => new Response(SECRET_CANARY, {
      status,
      headers: status === 429 ? { 'Retry-After': '3' } : {},
    }));
    const outcome = await deliverNtfy({ url: 'https://ntfy.example/', headers: {}, body: '{}' }, {
      fetchImpl: providerFetch,
      now: NOW,
    });
    expect(outcome).toMatchObject({ state, retryable, safeErrorCode });
    expect(JSON.stringify(outcome)).not.toContain(SECRET_CANARY);
    if (status === 429) expect(outcome).toMatchObject({ retryAfterMilliseconds: 3_000 });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it('retries only transport failures proving acceptance did not occur', async () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']) {
      await expect(deliverNtfy({ url: 'https://ntfy.example/', headers: {}, body: '{}' }, {
        fetchImpl: async () => { throw Object.assign(new TypeError('secret'), { cause: { code } }); },
      })).resolves.toMatchObject({ state: 'failed', retryable: true, safeErrorCode: 'connection_unavailable' });
    }
    for (const code of ['ETIMEDOUT', 'ECONNRESET']) {
      await expect(deliverNtfy({ url: 'https://ntfy.example/', headers: {}, body: '{}' }, {
        fetchImpl: async () => { throw Object.assign(new TypeError('secret'), { cause: { code } }); },
      })).resolves.toMatchObject({ state: 'unknown', retryable: false, safeErrorCode: 'transport_ambiguous' });
    }
  });
});

describe('ntfy through the shared Delivery engine', () => {
  it('persists the receipt without provider bodies or tokens and never sends a terminal Delivery again', async () => {
    const config = configuration([target({ tokenRef: 'env:NTFY_TOKEN' })]);
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>(async (_input, init) => {
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      return new Response(`{"id":"AbCdEf123456","message":"${SECRET_CANARY}"}`, { status: 200 });
    });
    const run = () => runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: { NTFY_TOKEN: TOKEN },
      getReminderCapability: async () => capability(),
      providerFetchImpl: providerFetch,
    });

    expect(await run()).toMatchObject({ reliable: true, outcome: 'notified', deliveryStates: ['confirmed'] });
    expect(await run()).toMatchObject({ reliable: true, outcome: 'already-processed', deliveryStates: ['confirmed'] });
    expect(providerFetch).toHaveBeenCalledOnce();
    const state = readServiceState(config, paths);
    expect(state).toMatchObject({
      deliveries: [{ state: 'confirmed', receipt: { provider: 'ntfy', messageId: 'AbCdEf123456' } }],
      attempts: [{ outcome: { state: 'confirmed', receipt: { provider: 'ntfy' } } }],
    });
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(JSON.stringify(state)).not.toContain(SECRET_CANARY);
    expect(getServiceStatus({ paths, now: NOW })).toMatchObject({
      readable: true,
      deliveries: [{ receipt: { provider: 'ntfy', messageId: 'AbCdEf123456' } }],
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
      getReminderCapability: async () => capability('😀'.repeat(1025)),
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
