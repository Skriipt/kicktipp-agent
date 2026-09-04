import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/browser.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';
import {
  readServiceState,
  setupService,
  type ServiceConfiguration,
} from '../src/service/store.js';

const NOW = new Date('2026-08-28T18:00:00.000Z');
const SECRET_CANARY = 'release-secret-canary';
const SECRET_REFERENCE = 'RELEASE_AUTHORIZATION';
const SCHEDULE = fs.readFileSync(
  new URL('./fixtures/reminder-schedule-com.html', import.meta.url),
  'utf8',
);
const PREDICTIONS = fs.readFileSync(
  new URL('./fixtures/tip-status.html', import.meta.url),
  'utf8',
);

let root: string;
let paths: ServicePaths;

function configuration(): ServiceConfiguration {
  return {
    schemaVersion: 1,
    job: {
      id: '9e90818e-a71f-472c-b4ad-c82f67f5195c',
      name: 'release-proof',
      enabled: true,
      profileId: 'service-profile',
      communityId: 'family',
      language: 'en',
      displayTimezone: 'UTC',
      policy: {
        excludeParticipantIds: [],
        stages: [{ beforeDeadlineMinutes: 60, severity: 'urgent' }],
      },
      targetIds: ['fake-provider'],
    },
    targets: [{
      id: 'fake-provider',
      enabled: true,
      provider: 'webhook',
      urlRef: 'env:RELEASE_PROVIDER_URL',
      headers: { Authorization: `env:${SECRET_REFERENCE}` },
    }],
  };
}

function fakeKicktipp(): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = vi.fn(async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect(new Headers(init.headers).get('cookie')).toContain('sid=service-profile');
    if (url.endsWith('/info/profil/meinetipprunden')) {
      return new Response('<div id="kicktipp-content">authenticated</div>');
    }
    if (url.endsWith('/family/schedule')) return new Response(SCHEDULE);
    if (url.endsWith('/family/leaderboard')) return new Response(PREDICTIONS);
    throw new Error(`Unexpected fake Kicktipp request: ${url}`);
  });
  return { fetch, calls };
}

async function releaseModules() {
  const [{ runReminderOnce }, { getServiceStatus }, { runDoctor }, config, url] = await Promise.all([
    import('../src/service/delivery.js'),
    import('../src/service/status.js'),
    import('../src/service/doctor.js'),
    import('../src/config.js'),
    import('../src/url.js'),
  ]);
  url.setUrlBase('https://www.kicktipp.com');
  config.setActiveProfile('interactive-profile');
  return { runReminderOnce, getServiceStatus, runDoctor };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-release-contract-'));
  const configDir = path.join(root, '.config', 'kicktipp-agent');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.ini'), `[profile.service-profile]
email = service@example.test
store = session
community = service-community

[profile.interactive-profile]
email = interactive@example.test
store = session
community = interactive-community
`);
  fs.writeFileSync(path.join(configDir, 'session-service-profile.json'), JSON.stringify({
    cookies: [{ name: 'sid', value: 'service-profile', domain: 'www.kicktipp.com' }],
  }), { mode: 0o600 });
  paths = servicePaths({
    KICKTIPP_CONFIG_DIR: configDir,
    KICKTIPP_DATA_DIR: path.join(root, 'data'),
  });
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(os, 'homedir').mockReturnValue(root);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Service release contract', () => {
  it('confirms once through fake Kicktipp and a fake provider, then restarts without a duplicate', async () => {
    const config = configuration();
    setupService(config, paths);
    const kicktipp = fakeKicktipp();
    const provider = vi.fn<FetchLike>(async (input, init) => {
      expect(String(input)).toBe('https://provider.test/reminders');
      expect(new Headers(init.headers).get('Authorization')).toBe(SECRET_CANARY);
      expect(String(init.body)).not.toContain(SECRET_CANARY);
      return new Response(null, { status: 204 });
    });
    const env = {
      RELEASE_PROVIDER_URL: 'https://provider.test/reminders',
      [SECRET_REFERENCE]: SECRET_CANARY,
    };
    let modules = await releaseModules();

    await expect(modules.runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env,
      kicktippFetchImpl: kicktipp.fetch,
      providerFetchImpl: provider,
    })).resolves.toMatchObject({ reliable: true, outcome: 'notified', deliveryStates: ['confirmed'] });
    expect(provider).toHaveBeenCalledOnce();
    const confirmedBytes = fs.readFileSync(paths.stateFile);

    vi.resetModules();
    modules = await releaseModules();
    await expect(modules.runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env,
      kicktippFetchImpl: kicktipp.fetch,
      providerFetchImpl: provider,
    })).resolves.toMatchObject({ reliable: true, outcome: 'already-processed', deliveryStates: ['confirmed'] });

    expect(provider).toHaveBeenCalledOnce();
    expect(kicktipp.calls.filter((url) => url.endsWith('/family/schedule'))).toHaveLength(2);
    expect(fs.readFileSync(paths.stateFile)).toEqual(confirmedBytes);
    const state = readServiceState(config, paths);
    expect(state).toMatchObject({
      stageOutcomes: [{ state: 'notified' }],
      deliveries: [{ state: 'confirmed' }],
      attempts: [{ outcome: { state: 'confirmed' } }],
    });
    expect(state.notifications[0].missingParticipants).toEqual([
      { id: '9002', displayName: 'Alex' },
    ]);

    const status = modules.getServiceStatus({ paths, now: NOW, details: true });
    const doctor = await modules.runDoctor({ offline: true, paths, env });
    for (const localOutput of [confirmedBytes.toString('utf8'), JSON.stringify(status), JSON.stringify(doctor)]) {
      expect(localOutput).not.toContain(SECRET_CANARY);
      expect(localOutput).not.toContain(SECRET_REFERENCE);
    }
  });

  it('recovers a durable open Attempt as unknown and never retries it', async () => {
    const config = configuration();
    setupService(config, paths);
    const kicktipp = fakeKicktipp();
    const provider = vi.fn<FetchLike>();
    const options = {
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: {
        RELEASE_PROVIDER_URL: 'https://provider.test/reminders',
        [SECRET_REFERENCE]: SECRET_CANARY,
      },
      kicktippFetchImpl: kicktipp.fetch,
      providerFetchImpl: provider,
    };
    let modules = await releaseModules();

    await expect(modules.runReminderOnce({
      ...options,
      afterAttemptStarted: () => { throw new Error('simulated crash'); },
    })).rejects.toThrow('simulated crash');
    expect(provider).not.toHaveBeenCalled();
    expect(readServiceState(config, paths).attempts[0].outcome).toBeUndefined();

    vi.resetModules();
    modules = await releaseModules();
    await expect(modules.runReminderOnce({
      ...options,
      now: new Date(NOW.getTime() + 1_000),
    })).resolves.toMatchObject({ reliable: true, outcome: 'already-processed', deliveryStates: ['unknown'] });

    const recovered = readServiceState(config, paths);
    expect(provider).not.toHaveBeenCalled();
    expect(recovered.deliveries[0]).toMatchObject({ state: 'unknown', safeErrorCode: 'interrupted_attempt' });
    expect(recovered.attempts).toEqual([
      expect.objectContaining({
        completedAt: '2026-08-28T18:00:01.000Z',
        outcome: { state: 'unknown', retryable: false, safeErrorCode: 'interrupted_attempt' },
      }),
    ]);
  });
});
