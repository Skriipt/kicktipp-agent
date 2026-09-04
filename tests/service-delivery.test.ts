import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FetchLike } from '../src/browser.js';
import type { ReminderCapability, ReminderSnapshot } from '../src/reminder-capability.js';
import {
  deadlineGroupId,
  deliverWebhook,
  deliveryId,
  notificationId,
  reminderRunExitCode,
  runReminderOnce,
  testNotificationTarget,
} from '../src/service/delivery.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';
import {
  InvalidServiceStateTransitionError,
  acquireServiceLock,
  mutateServiceConfiguration,
  readServiceConfiguration,
  readServiceState,
  setupService,
  writeServiceState,
  type ServiceConfiguration,
} from '../src/service/store.js';

const JOB_ID = '9e90818e-a71f-472c-b4ad-c82f67f5195c';
const NOW = new Date('2026-09-04T11:30:00.000Z');
const EARLY = new Date('2026-09-04T07:00:00.000Z');
const SECRET_CANARY = 'Bearer secret-canary';

let root: string;
let paths: ServicePaths;

function configuration(targetCount = 1): ServiceConfiguration {
  const targets: ServiceConfiguration['targets'] = Array.from({ length: targetCount }, (_, index) => ({
    id: `family-hook-${index + 1}`,
    enabled: true,
    provider: 'webhook' as const,
    urlRef: `env:WEBHOOK_URL_${index + 1}`,
    headers: { Authorization: 'env:AUTHORIZATION' },
    allowInsecureHttp: true,
  }));
  return {
    schemaVersion: 1,
    job: {
      id: JOB_ID,
      name: 'community-reminder',
      enabled: true,
      profileId: 'service-profile',
      communityId: 'family',
      language: 'en',
      displayTimezone: 'Europe/Berlin',
      policy: {
        matchSelection: 'next-deadline-group',
        completion: 'all-games-in-group',
        excludeParticipantIds: [],
        stages: [
          { beforeDeadlineMinutes: 360, severity: 'warning' },
          { beforeDeadlineMinutes: 60, severity: 'urgent' },
        ],
      },
      targetIds: targets.map(({ id }) => id),
    },
    targets,
  };
}

function snapshot(missing = true): ReminderSnapshot {
  return {
    profileId: 'service-profile',
    communityId: 'family',
    sourceTimeZone: 'Europe/Berlin',
    participants: [
      { id: 'bob', displayName: 'Bob' },
      { id: 'alice', displayName: 'Alice' },
    ],
    games: [
      { id: 'game-b', deadlineAt: '2026-09-04T12:00:00.000Z', deadlineSource: 'event' },
      { id: 'game-a', deadlineAt: '2026-09-04T12:00:00.000Z', deadlineSource: 'event' },
    ],
    cells: ['bob', 'alice'].flatMap((participantId) => ['game-b', 'game-a'].map((gameId) => ({
      participantId,
      gameId,
      status: missing ? 'missing' as const : 'predicted' as const,
    }))),
  };
}

function available(missing = true): ReminderCapability {
  return { available: true, snapshot: snapshot(missing) };
}

function environment(targetCount = 1): NodeJS.ProcessEnv {
  return {
    AUTHORIZATION: SECRET_CANARY,
    ...Object.fromEntries(Array.from({ length: targetCount }, (_, index) => [
      `WEBHOOK_URL_${index + 1}`,
      `http://provider.test/hook-${index + 1}`,
    ])),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-delivery-'));
  paths = servicePaths({
    KICKTIPP_CONFIG_DIR: path.join(root, 'config'),
    KICKTIPP_DATA_DIR: path.join(root, 'data'),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Service delivery identities', () => {
  it('hashes versioned named inputs without mutable content fields', () => {
    const group = deadlineGroupId({
      site: 'com',
      communityId: 'family',
      gameIds: ['game-b', 'game-a'],
    });
    expect(group).toBe('c46076d0923fd7b89f0a2db37949e22cefe42876876aab3cc969035d0deeb228');

    const notification = notificationId({
      stageMinutes: 60,
      deadlineGroupId: group,
      jobId: JOB_ID,
    });
    expect(notification).toBe('9433df206023eae5f2e855364514239bcdea7db4f2c22a90c1e3c58759c22e6b');
    expect(deliveryId({
      targetRevision: 'a'.repeat(64),
      targetId: 'family-hook',
      notificationId: notification,
    })).toBe('0636f936d4df336de9f093b4409a79bad765dee120b3c66da456a09faf090126');
  });
});

describe('restart-safe Generic Webhook delivery', () => {
  it('atomically freezes the Notification and fan-out before fixed-contract provider I/O', async () => {
    const config = configuration(2);
    setupService(config, paths);
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const providerFetch: FetchLike = vi.fn(async (input, init) => {
      const stateDuringIo = readServiceState(config, paths);
      expect(stateDuringIo.notifications).toHaveLength(1);
      expect(stateDuringIo.deliveries).toHaveLength(2);
      expect(stateDuringIo.stageOutcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({ stageMinutes: 360, state: 'skipped' }),
        expect.objectContaining({ stageMinutes: 60, state: 'notified' }),
      ]));
      expect(stateDuringIo.attempts.some(({ outcome }) => outcome === undefined)).toBe(true);
      calls.push({ input, init });
      return new Response('ignored provider body', { status: 200 });
    });

    const result = await runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: environment(2),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });

    expect(result).toMatchObject({ reliable: true, outcome: 'notified' });
    expect(result.reliable && result.deliveryStates).toEqual(['confirmed', 'confirmed']);
    expect(calls).toHaveLength(2);
    const state = readServiceState(config, paths);
    expect(state.notifications[0]).toMatchObject({
      jobId: JOB_ID,
      createdAt: NOW.toISOString(),
      language: 'en',
      displayTimezone: 'Europe/Berlin',
      stage: '60',
      deadlineGroup: {
        deadlineAt: '2026-09-04T12:00:00.000Z',
        gameIds: ['game-a', 'game-b'],
      },
      missingParticipants: [
        { id: 'alice', displayName: 'Alice' },
        { id: 'bob', displayName: 'Bob' },
      ],
      content: {
        schemaVersion: 1,
        type: 'reminder',
        severity: 'urgent',
        actionUrl: 'https://www.kicktipp.com/family/predict',
      },
    });
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts.every(({ outcome }) => outcome?.state === 'confirmed')).toBe(true);

    for (const { init } of calls) {
      expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
      const headers = init.headers as Record<string, string>;
      expect(headers).toMatchObject({
        Authorization: SECRET_CANARY,
        'Content-Type': 'application/json',
        'User-Agent': 'kicktipp-agent/1.3.0 service',
      });
      expect(headers['X-Kicktipp-Notification-Id']).toBe(state.notifications[0].id);
      expect(headers['X-Kicktipp-Delivery-Id']).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(String(init.body))).toEqual(state.notifications[0]);
    }

    await runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: environment(2),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
  });

  it('recovers an open write-ahead Attempt to unknown exactly once and never resends it', async () => {
    const config = configuration();
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));

    await expect(runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
      afterAttemptStarted: () => { throw new Error('simulated process crash'); },
    })).rejects.toThrow('simulated process crash');
    expect(providerFetch).not.toHaveBeenCalled();
    expect(readServiceState(config, paths).attempts[0].outcome).toBeUndefined();

    const recovered = await runReminderOnce({
      paths,
      now: new Date(NOW.getTime() + 1_000),
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });
    expect(recovered).toMatchObject({ reliable: true, deliveryStates: ['unknown'] });
    const recoveredBytes = fs.readFileSync(paths.stateFile);
    expect(readServiceState(config, paths).attempts[0]).toMatchObject({
      completedAt: '2026-09-04T11:30:01.000Z',
      outcome: { state: 'unknown', retryable: false, safeErrorCode: 'interrupted_attempt' },
    });

    await runReminderOnce({
      paths,
      now: new Date(NOW.getTime() + 2_000),
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(paths.stateFile)).toEqual(recoveredBytes);
  });

  it('makes a reliably satisfied Stage terminal without a Notification', async () => {
    const config = configuration();
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>();
    const result = await runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(false),
      providerFetchImpl: providerFetch,
    });
    const state = readServiceState(config, paths);
    expect(result).toMatchObject({ reliable: true, outcome: 'satisfied' });
    expect(state.stageOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageMinutes: 60, state: 'satisfied' }),
    ]));
    expect(state.notifications).toEqual([]);
    expect(state.deliveries).toEqual([]);
    expect(providerFetch).not.toHaveBeenCalled();

    const lock = acquireServiceLock(paths);
    try {
      state.stageOutcomes[0].state = 'notified';
      expect(() => writeServiceState(state, lock, paths))
        .toThrow(InvalidServiceStateTransitionError);
    } finally {
      lock.release();
    }
  });
});

describe('Delivery retries and cancellation', () => {
  it('uses the 10s/60s retry schedule and stops after three Attempts', async () => {
    const config = configuration();
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>(async () => new Response(null, { status: 429 }));
    const runAt = (now: Date) => runReminderOnce({
      paths,
      now,
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });

    await runAt(EARLY);
    expect(readServiceState(config, paths).deliveries[0]).toMatchObject({
      state: 'pending',
      nextAttemptAt: '2026-09-04T07:00:10.000Z',
    });

    await runAt(new Date(EARLY.getTime() + 9_999));
    expect(providerFetch).toHaveBeenCalledOnce();
    await runAt(new Date(EARLY.getTime() + 10_000));
    expect(readServiceState(config, paths).deliveries[0]).toMatchObject({
      state: 'pending',
      nextAttemptAt: '2026-09-04T07:01:10.000Z',
    });

    await runAt(new Date(EARLY.getTime() + 69_999));
    expect(providerFetch).toHaveBeenCalledTimes(2);
    await runAt(new Date(EARLY.getTime() + 70_000));
    const state = readServiceState(config, paths);
    expect(state.deliveries[0]).toMatchObject({ state: 'failed', safeErrorCode: 'rate_limited' });
    expect(state.deliveries[0].nextAttemptAt).toBeUndefined();
    expect(state.attempts).toHaveLength(3);
    expect(state.attempts.every(({ outcome }) => outcome?.retryable)).toBe(true);

    await runAt(new Date(EARLY.getTime() + 130_000));
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it('uses a valid Retry-After instead of the default delay', async () => {
    const config = configuration();
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '30' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await runReminderOnce({
      paths,
      now: EARLY,
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });
    expect(readServiceState(config, paths).deliveries[0].nextAttemptAt)
      .toBe('2026-09-04T07:00:30.000Z');

    await runReminderOnce({
      paths,
      now: new Date(EARLY.getTime() + 30_000),
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });
    expect(readServiceState(config, paths).deliveries[0].state).toBe('confirmed');
  });

  it('cancels a retry scheduled at or beyond its Deadline before provider I/O', async () => {
    const config = configuration();
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>(async () => new Response(null, { status: 429 }));

    await runReminderOnce({
      paths,
      now: new Date('2026-09-04T11:59:55.000Z'),
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });

    const state = readServiceState(config, paths);
    expect(state.deliveries[0]).toMatchObject({
      state: 'cancelled',
      safeErrorCode: 'retry_deadline_reached',
    });
    expect(state.deliveries[0].nextAttemptAt).toBeUndefined();
    expect(state.attempts).toHaveLength(1);
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing Participants changed', false, (fresh: ReminderSnapshot) => {
      for (const cell of fresh.cells) if (cell.participantId === 'bob') cell.status = 'predicted';
    }],
    ['Deadline Group changed', true, (fresh: ReminderSnapshot) => {
      fresh.games[0].id = 'game-c';
      for (const cell of fresh.cells) if (cell.gameId === 'game-b') cell.gameId = 'game-c';
    }],
    ['Deadline changed', false, (fresh: ReminderSnapshot) => {
      for (const game of fresh.games) game.deadlineAt = '2026-09-04T12:30:00.000Z';
    }],
  ])('cancels without replacing the immutable Notification when %s', async (_label, createsNewGroup, mutateSnapshot) => {
    const config = configuration();
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    await runReminderOnce({
      paths,
      now: EARLY,
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });
    const originalNotification = structuredClone(readServiceState(config, paths).notifications[0]);
    const fresh = snapshot();
    mutateSnapshot(fresh);

    await runReminderOnce({
      paths,
      now: new Date(EARLY.getTime() + 10_000),
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => ({ available: true, snapshot: fresh }),
      providerFetchImpl: providerFetch,
    });

    const state = readServiceState(config, paths);
    expect(state.deliveries[0]).toMatchObject({ state: 'cancelled', safeErrorCode: 'retry_validation_failed' });
    expect(state.notifications[0]).toEqual(originalNotification);
    expect(state.notifications).toHaveLength(createsNewGroup ? 2 : 1);
    expect(providerFetch).toHaveBeenCalledTimes(createsNewGroup ? 2 : 1);
  });

  it('cancels a due Retry when fresh Reminder Capability is unavailable', async () => {
    const config = configuration();
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>(async () => new Response(null, { status: 429 }));
    await runReminderOnce({
      paths,
      now: EARLY,
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });

    const result = await runReminderOnce({
      paths,
      now: new Date(EARLY.getTime() + 10_000),
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => ({ available: false, reason: 'incomplete-matrix' }),
      providerFetchImpl: providerFetch,
    });
    expect(result).toEqual({ reliable: false, reason: 'incomplete-matrix' });
    expect(readServiceState(config, paths).deliveries[0]).toMatchObject({
      state: 'cancelled',
      safeErrorCode: 'retry_validation_failed',
    });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it('cancels pending Deliveries when the Reminder Job is disabled without external I/O', async () => {
    const config = configuration();
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>(async () => new Response(null, { status: 429 }));
    await runReminderOnce({
      paths,
      now: EARLY,
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });
    mutateServiceConfiguration((next) => {
      next.job.enabled = false;
      return next;
    }, paths);
    const getReminderCapability = vi.fn(async () => available());

    const result = await runReminderOnce({
      paths,
      now: new Date(EARLY.getTime() + 10_000),
      site: 'https://www.kicktipp.com',
      env: environment(),
      getReminderCapability,
      providerFetchImpl: providerFetch,
    });
    const disabledConfig = readServiceConfiguration(paths);
    expect(result).toEqual({ reliable: true, outcome: 'disabled', deliveryStates: [] });
    expect(readServiceState(disabledConfig, paths).deliveries[0]).toMatchObject({
      state: 'cancelled',
      safeErrorCode: 'job_disabled',
    });
    expect(getReminderCapability).not.toHaveBeenCalled();
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it.each(['removed', 'disabled', 'revision changed'] as const)(
    'cancels only the pending Delivery when its Target is %s',
    async (change) => {
      const config = configuration(2);
      setupService(config, paths);
      const providerFetch = vi.fn<FetchLike>(async (input) =>
        String(input).endsWith('hook-1')
          ? new Response(null, { status: 429 })
          : new Response(null, { status: 204 }));
      await runReminderOnce({
        paths,
        now: EARLY,
        site: 'https://www.kicktipp.com',
        env: environment(2),
        getReminderCapability: async () => available(),
        providerFetchImpl: providerFetch,
      });

      mutateServiceConfiguration((next) => {
        if (change === 'removed') {
          next.targets = next.targets.filter(({ id }) => id !== 'family-hook-1');
          next.job.targetIds = next.job.targetIds.filter((id) => id !== 'family-hook-1');
        } else if (change === 'disabled') {
          next.targets[0].enabled = false;
        } else if (next.targets[0].provider === 'webhook') {
          next.targets[0].urlRef = 'env:CHANGED_URL';
        }
        return next;
      }, paths);
      const changedConfig = readServiceConfiguration(paths);

      await runReminderOnce({
        paths,
        now: new Date(EARLY.getTime() + 10_000),
        site: 'https://www.kicktipp.com',
        env: { ...environment(2), CHANGED_URL: 'http://provider.test/changed' },
        getReminderCapability: async () => available(),
        providerFetchImpl: providerFetch,
      });
      const states = readServiceState(changedConfig, paths).deliveries;
      expect(states.find(({ targetId }) => targetId === 'family-hook-1')).toMatchObject({
        state: 'cancelled',
        safeErrorCode: 'target_changed',
      });
      expect(states.find(({ targetId }) => targetId === 'family-hook-2')?.state).toBe('confirmed');
      expect(providerFetch).toHaveBeenCalledTimes(2);
    },
  );

  it('durably supersedes only older pending Deliveries before later-stage provider I/O', async () => {
    const config = configuration(2);
    setupService(config, paths);
    let laterStage = false;
    const providerFetch = vi.fn<FetchLike>(async (input) => {
      if (laterStage) {
        const duringIo = readServiceState(config, paths);
        expect(duringIo.notifications).toHaveLength(2);
        const oldId = duringIo.notifications.find(({ stage }) => stage === '360')!.id;
        expect(duringIo.deliveries.find(({ notificationId, targetId }) =>
          notificationId === oldId && targetId === 'family-hook-1')).toMatchObject({
          state: 'cancelled',
          safeErrorCode: 'superseded_by_later_stage',
        });
        expect(duringIo.deliveries.find(({ notificationId, targetId }) =>
          notificationId === oldId && targetId === 'family-hook-2')?.state).toBe('confirmed');
        return new Response(null, { status: 204 });
      }
      return String(input).endsWith('hook-1')
        ? new Response(null, { status: 429 })
        : new Response(null, { status: 204 });
    });

    await runReminderOnce({
      paths,
      now: EARLY,
      site: 'https://www.kicktipp.com',
      env: environment(2),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });
    laterStage = true;
    await runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: environment(2),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });

    const state = readServiceState(config, paths);
    expect(state.deliveries.filter(({ state: deliveryState }) => deliveryState === 'confirmed')).toHaveLength(3);
    expect(state.deliveries.filter(({ state: deliveryState }) => deliveryState === 'cancelled')).toHaveLength(1);
    const lock = acquireServiceLock(paths);
    try {
      const changed = structuredClone(state);
      changed.deliveries.find(({ state: deliveryState }) => deliveryState === 'cancelled')!.state = 'pending';
      expect(() => writeServiceState(changed, lock, paths)).toThrow(InvalidServiceStateTransitionError);
    } finally {
      lock.release();
    }
  });
});

describe('Delivery fan-out safety', () => {
  it('keeps provider outcomes independent per Target', async () => {
    const config = configuration(4);
    setupService(config, paths);
    const providerFetch = vi.fn<FetchLike>(async (input) => {
      if (String(input).endsWith('hook-1')) return new Response(null, { status: 204 });
      if (String(input).endsWith('hook-2')) return new Response(null, { status: 400 });
      if (String(input).endsWith('hook-3')) return new Response(null, { status: 503 });
      return new Response(null, { status: 429 });
    });

    await runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: environment(4),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });
    const state = readServiceState(config, paths);
    expect(state.deliveries.map(({ state: deliveryState }) => deliveryState))
      .toEqual(['confirmed', 'failed', 'unknown', 'pending']);
    const lock = acquireServiceLock(paths);
    try {
      for (const index of [0, 1, 2]) {
        const changed = structuredClone(state);
        changed.deliveries[index].state = changed.deliveries[index].state === 'confirmed' ? 'failed' : 'confirmed';
        expect(() => writeServiceState(changed, lock, paths)).toThrow(InvalidServiceStateTransitionError);
      }
    } finally {
      lock.release();
    }
  });

  it('runs no more than four provider calls concurrently', async () => {
    const config = configuration(6);
    setupService(config, paths);
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const providerFetch = vi.fn<FetchLike>(() => new Promise((resolve) => {
      active += 1;
      maximum = Math.max(maximum, active);
      releases.push(() => {
        active -= 1;
        resolve(new Response(null, { status: 204 }));
      });
    }));

    const run = runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: environment(6),
      getReminderCapability: async () => available(),
      providerFetchImpl: providerFetch,
    });
    await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledTimes(4));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledTimes(6));
    releases.splice(0).forEach((release) => release());
    await run;
    expect(maximum).toBe(4);
  });

  it('fails known local validation without an Attempt but surfaces unexpected errors as pending', async () => {
    const invalidConfig = configuration();
    setupService(invalidConfig, paths);
    await runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: { ...environment(), WEBHOOK_URL_1: 'not a URL' },
      getReminderCapability: async () => available(),
    });
    expect(readServiceState(invalidConfig, paths)).toMatchObject({
      deliveries: [{ state: 'failed', safeErrorCode: 'invalid_target' }],
      attempts: [],
    });

    fs.rmSync(root, { recursive: true, force: true });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-delivery-'));
    paths = servicePaths({
      KICKTIPP_CONFIG_DIR: path.join(root, 'config'),
      KICKTIPP_DATA_DIR: path.join(root, 'data'),
    });
    const unexpectedConfig = configuration();
    setupService(unexpectedConfig, paths);
    const hostileEnvironment = new Proxy(environment(), {
      get(target, property, receiver) {
        if (property === 'WEBHOOK_URL_1') throw new Error('unexpected resolver failure');
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(runReminderOnce({
      paths,
      now: NOW,
      site: 'https://www.kicktipp.com',
      env: hostileEnvironment,
      getReminderCapability: async () => available(),
    })).rejects.toThrow('unexpected resolver failure');
    expect(readServiceState(unexpectedConfig, paths)).toMatchObject({
      deliveries: [{ state: 'pending' }],
      attempts: [],
    });
  });
});

describe('Generic Webhook transport and target tests', () => {
  it('does not follow redirects and conservatively classifies provider ambiguity', async () => {
    const redirects = vi.fn<FetchLike>(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://secret-recipient.test/' },
    }));
    const redirect = await deliverWebhook(
      { resolved: { url: 'https://provider.test/', headers: {} }, body: '{}' },
      { notificationId: 'notification', deliveryId: 'delivery' },
      { fetchImpl: redirects, now: NOW },
    );
    expect(redirect).toMatchObject({ state: 'failed', retryable: false, safeErrorCode: 'redirect_refused' });
    expect(redirects).toHaveBeenCalledOnce();
    expect(redirects.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });

    expect(await deliverWebhook(
      { resolved: { url: 'https://provider.test/', headers: {} }, body: '{}' },
      { notificationId: 'notification', deliveryId: 'delivery' },
      { fetchImpl: async () => new Response(null, { status: 503 }), now: NOW },
    )).toMatchObject({ state: 'unknown', retryable: false });
  });

  it('retries only transport failures that prove no provider acceptance', async () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']) {
      expect(await deliverWebhook(
        { resolved: { url: 'https://provider.test/', headers: {} }, body: '{}' },
        { notificationId: 'notification', deliveryId: 'delivery' },
        { fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); } },
      )).toMatchObject({ state: 'failed', retryable: true, safeErrorCode: 'connection_unavailable' });
    }
    for (const code of ['ETIMEDOUT', 'ECONNRESET']) {
      expect(await deliverWebhook(
        { resolved: { url: 'https://provider.test/', headers: {} }, body: '{}' },
        { notificationId: 'notification', deliveryId: 'delivery' },
        { fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); } },
      )).toMatchObject({ state: 'unknown', retryable: false, safeErrorCode: 'transport_ambiguous' });
    }
    expect(await deliverWebhook(
      { resolved: { url: 'https://provider.test/', headers: {} }, body: '{}' },
      { notificationId: 'notification', deliveryId: 'delivery' },
      { fetchImpl: async () => ({ status: Number.NaN, headers: new Headers() }) as Response },
    )).toMatchObject({ state: 'unknown', retryable: false, safeErrorCode: 'malformed_response' });
    for (const status of [408, 425, 429]) {
      expect(await deliverWebhook(
        { resolved: { url: 'https://provider.test/', headers: {} }, body: '{}' },
        { notificationId: 'notification', deliveryId: 'delivery' },
        { fetchImpl: async () => new Response(null, { status }) },
      )).toMatchObject({ state: 'failed', retryable: true });
    }
  });

  it('tests a disabled Target exactly once without State or Service Lock mutation', async () => {
    const config = configuration();
    config.job.enabled = false;
    config.targets[0].enabled = false;
    setupService(config, paths);
    const stateBefore = fs.readFileSync(paths.stateFile);
    const providerFetch = vi.fn<FetchLike>(async (_input, init) => {
      expect(fs.existsSync(paths.serviceLockFile)).toBe(false);
      const body = JSON.parse(String(init.body));
      expect(body.content).toMatchObject({
        schemaVersion: 1,
        type: 'reminder',
        title: 'Kicktipp Notification Target test',
      });
      expect((init.headers as Record<string, string>)['X-Kicktipp-Notification-Id']).toMatch(/^[0-9a-f-]{36}$/);
      expect((init.headers as Record<string, string>)['X-Kicktipp-Delivery-Id']).toMatch(/^[0-9a-f-]{36}$/);
      return new Response('ignored', { status: 200 });
    });

    const outcome = await testNotificationTarget('family-hook-1', {
      paths,
      env: environment(),
      fetchImpl: providerFetch,
      now: NOW,
    });
    expect(outcome.state).toBe('confirmed');
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(fs.readFileSync(paths.stateFile)).toEqual(stateBefore);
    expect(fs.existsSync(paths.serviceLockFile)).toBe(false);
  });

  it('maps run-once reliability and terminal delivery states to the public exit contract', () => {
    expect(reminderRunExitCode({ reliable: false, reason: 'no capability' })).toBe(1);
    expect(reminderRunExitCode({ reliable: true, outcome: 'satisfied', deliveryStates: [] })).toBe(0);
    expect(reminderRunExitCode({ reliable: true, outcome: 'notified', deliveryStates: ['confirmed', 'cancelled'] })).toBe(0);
    for (const state of ['failed', 'unknown', 'pending'] as const) {
      expect(reminderRunExitCode({ reliable: true, outcome: 'notified', deliveryStates: [state] })).toBe(2);
    }
  });
});
