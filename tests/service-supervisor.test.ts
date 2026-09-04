import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '../src/browser.js';
import type { ReminderCapability } from '../src/reminder-capability.js';
import { runReminderOnce } from '../src/service/delivery.js';
import { FileLock, LockUnavailableError } from '../src/service/lock.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';
import {
  readServiceConfiguration,
  readServiceState,
  setupService,
  type ServiceConfiguration,
  type ServiceState,
} from '../src/service/store.js';
import {
  nextSupervisorWake,
  runServiceSupervisor,
  type SignalSource,
  type SupervisorClock,
} from '../src/service/supervisor.js';

const JOB_ID = '9e90818e-a71f-472c-b4ad-c82f67f5195c';
const START = '2026-09-04T11:00:00.000Z';

class FakeClock implements SupervisorClock {
  private current = Date.parse(START);
  readonly requestedSleeps: number[] = [];
  private sleepers: Array<{
    at: number;
    signal: AbortSignal;
    resolve: (value: 'elapsed' | 'aborted') => void;
  }> = [];

  now(): Date {
    return new Date(this.current);
  }

  sleep(milliseconds: number, signal: AbortSignal): Promise<'elapsed' | 'aborted'> {
    this.requestedSleeps.push(milliseconds);
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve('aborted');
        return;
      }
      const sleeper = { at: this.current + milliseconds, signal, resolve };
      this.sleepers.push(sleeper);
      signal.addEventListener('abort', () => {
        this.sleepers = this.sleepers.filter((candidate) => candidate !== sleeper);
        resolve('aborted');
      }, { once: true });
    });
  }

  async advance(milliseconds: number): Promise<void> {
    this.current += milliseconds;
    const due = this.sleepers.filter(({ at }) => at <= this.current);
    this.sleepers = this.sleepers.filter(({ at }) => at > this.current);
    for (const sleeper of due) sleeper.resolve('elapsed');
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function configuration(enabled = true): ServiceConfiguration {
  return {
    schemaVersion: 1,
    job: {
      id: JOB_ID,
      name: 'community-reminder',
      enabled,
      profileId: 'service-profile',
      communityId: 'family',
      language: 'en',
      displayTimezone: 'Europe/Berlin',
      policy: {
        excludeParticipantIds: [],
        stages: [
          { beforeDeadlineMinutes: 360, severity: 'warning' },
          { beforeDeadlineMinutes: 60, severity: 'urgent' },
        ],
      },
      targetIds: enabled ? ['family-hook'] : [],
    },
    targets: enabled
      ? [{ id: 'family-hook', enabled: true, provider: 'webhook', urlRef: 'env:HOOK_URL' }]
      : [],
  };
}

function capability(options: { deadline?: string; missing?: boolean } = {}): ReminderCapability {
  const deadline = options.deadline ?? '2026-09-04T12:00:00.000Z';
  return {
    available: true,
    snapshot: {
      profileId: 'service-profile',
      communityId: 'family',
      sourceTimeZone: 'Europe/Berlin',
      participants: [{ id: 'alice', displayName: 'Alice' }],
      games: [{ id: 'game-a', deadlineAt: deadline, deadlineSource: 'event' }],
      cells: [{
        participantId: 'alice',
        gameId: 'game-a',
        status: options.missing === false ? 'predicted' : 'missing',
      }],
    },
  };
}

let root: string;
let paths: ServicePaths;
let clock: FakeClock;
let signals: EventEmitter;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-supervisor-'));
  paths = servicePaths({
    KICKTIPP_CONFIG_DIR: path.join(root, 'config'),
    KICKTIPP_DATA_DIR: path.join(root, 'data'),
  });
  clock = new FakeClock();
  signals = new EventEmitter();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function start(options: Parameters<typeof runServiceSupervisor>[0] = {}): Promise<0> {
  return runServiceSupervisor({
    paths,
    clock,
    signals: signals as unknown as SignalSource,
    env: { HOOK_URL: 'https://hooks.example.test/reminders' },
    site: 'https://www.kicktipp.com',
    logger: { log: vi.fn() },
    ...options,
  });
}

describe('Service scheduling', () => {
  it('chooses the earliest Stage, Deadline, Schedule refresh, Retry, or local configuration horizon', () => {
    const config = configuration();
    const state = setupService(config, paths);
    const scheduler: ServiceState['scheduler'] = {
      kicktippNetworkFailures: 0,
      lastScheduleFetchAt: START,
      nextStageAt: '2026-09-04T11:00:45.000Z',
      nextDeadlineAt: '2026-09-04T12:00:00.000Z',
    };
    state.deliveries = [{
      id: 'a'.repeat(64),
      notificationId: 'b'.repeat(64),
      targetId: 'family-hook',
      targetRevision: 'c'.repeat(64),
      state: 'pending',
      nextAttemptAt: '2026-09-04T11:00:10.000Z',
    }];

    expect(nextSupervisorWake(config, state, scheduler, clock.now())).toEqual({
      at: '2026-09-04T11:00:10.000Z',
      reason: 'delivery-retry',
    });
    state.deliveries = [];
    expect(nextSupervisorWake(config, state, scheduler, clock.now()).reason).toBe('stage');
    delete scheduler.nextStageAt;
    expect(nextSupervisorWake(config, state, scheduler, clock.now()).reason).toBe('configuration');
  });

  it('uses the 24-hour Schedule horizon when no future Deadline is known', () => {
    const config = configuration();
    const state = setupService(config, paths);
    const now = new Date('2026-09-05T10:59:01.000Z');
    const wake = nextSupervisorWake(config, state, {
      kicktippNetworkFailures: 0,
      lastScheduleFetchAt: START,
    }, now);
    expect(wake).toEqual({ at: '2026-09-05T11:00:00.000Z', reason: 'schedule-fetch' });
  });

  it('refreshes a known Schedule six hours after its last successful fetch', () => {
    const config = configuration();
    const state = setupService(config, paths);
    const wake = nextSupervisorWake(config, state, {
      kicktippNetworkFailures: 0,
      lastScheduleFetchAt: START,
      nextDeadlineAt: '2026-09-06T12:00:00.000Z',
    }, new Date('2026-09-04T16:59:30.000Z'));
    expect(wake).toEqual({ at: '2026-09-04T17:00:00.000Z', reason: 'schedule-fetch' });
  });
});

describe('continuous supervision', () => {
  it('does not send when a slow snapshot query crosses the deadline', async () => {
    const config = configuration();
    setupService(config, paths);
    const provider = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const running = start({ getReminderCapability: async () => {
      await clock.advance(2_000);
      return capability({ deadline: '2026-09-04T11:00:01.000Z' });
    }, providerFetchImpl: provider });
    await flush();
    await flush();
    signals.emit('SIGTERM');
    await running;
    expect(provider).not.toHaveBeenCalled();
    expect(readServiceState(config, paths).attempts).toHaveLength(0);
  });

  it.each(['60', 'Fri, 04 Sep 2026 11:01:12 GMT'])('anchors Retry-After %s after 12 seconds of provider latency', async (retryAfter) => {
    const config = configuration();
    setupService(config, paths);
    const running = start({ getReminderCapability: async () => capability(), providerFetchImpl: async () => {
      await clock.advance(12_000);
      return new Response(null, { status: 429, headers: { 'Retry-After': retryAfter } });
    } });
    await flush();
    signals.emit('SIGTERM');
    await running;
    const state = readServiceState(config, paths);
    expect(state.deliveries[0].nextAttemptAt).toBe('2026-09-04T11:01:12.000Z');
    expect(state.attempts[0].completedAt).toBe('2026-09-04T11:00:12.000Z');
  });

  it('checks immediately, owns the Service Lock for its lifetime, and exits zero on SIGTERM', async () => {
    setupService(configuration(), paths);
    const getReminderCapability = vi.fn(async () => capability({ missing: false }));
    const running = start({ getReminderCapability });
    await flush();

    expect(getReminderCapability).toHaveBeenCalledOnce();
    expect(fs.existsSync(paths.serviceLockFile)).toBe(true);
    signals.emit('SIGTERM');
    await expect(running).resolves.toBe(0);
    expect(clock.requestedSleeps).toContain(30_000);
    expect(fs.existsSync(paths.serviceLockFile)).toBe(false);
  });

  it('logs bounded check, Delivery, and Health transitions without private content', async () => {
    setupService(configuration(), paths);
    const log = vi.fn();
    const privateName = 'Private Participant Log Canary';
    const running = start({
      logger: { log },
      getReminderCapability: async () => {
        const value = capability();
        if (value.available) value.snapshot.participants[0].displayName = privateName;
        return value;
      },
      providerFetchImpl: async () => new Response(null, { status: 204 }),
    });
    await flush();
    signals.emit('SIGTERM');
    await running;

    const events = log.mock.calls.map(([event]) => event);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'check_completed', reliable: true }),
      expect.objectContaining({ event: 'delivery_transition', from: 'created', to: 'confirmed', missingCount: 1 }),
      expect.objectContaining({ event: 'health_transition', from: 'degraded', to: 'healthy' }),
    ]));
    const encoded = JSON.stringify(events);
    expect(encoded).not.toContain(privateName);
    expect(encoded).not.toContain('HOOK_URL');
    expect(encoded).not.toContain('hooks.example.test');
  });

  it('fails immediately when another Service writer owns the Lock', async () => {
    setupService(configuration(), paths);
    const lock = FileLock.acquire(paths.serviceLockFile);
    const getReminderCapability = vi.fn(async () => capability());
    try {
      await expect(start({ getReminderCapability })).rejects.toThrow(LockUnavailableError);
      expect(getReminderCapability).not.toHaveBeenCalled();
    } finally {
      lock.release();
    }
  });

  it('keeps a disabled Job on local wakes with no evaluation or provider I/O', async () => {
    setupService(configuration(false), paths);
    const getReminderCapability = vi.fn(async () => capability());
    const provider = vi.fn<FetchLike>();
    const running = start({ getReminderCapability, providerFetchImpl: provider });
    await flush();
    await clock.advance(120_000);

    expect(getReminderCapability).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    signals.emit('SIGINT');
    await running;
  });

  it('pauses on invalid configuration without using stale settings and resumes within 60 seconds', async () => {
    const config = configuration();
    setupService(config, paths);
    const bytes = fs.readFileSync(paths.configFile);
    const getReminderCapability = vi.fn(async () => capability({ deadline: '2026-09-04T18:00:00.000Z' }));
    const provider = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const running = start({ getReminderCapability, providerFetchImpl: provider });
    await flush();
    expect(getReminderCapability).toHaveBeenCalledOnce();

    fs.writeFileSync(paths.configFile, '{invalid');
    await clock.advance(60_000);
    await clock.advance(60_000);
    expect(getReminderCapability).toHaveBeenCalledOnce();

    fs.writeFileSync(paths.configFile, bytes);
    await clock.advance(60_000);
    expect(getReminderCapability).toHaveBeenCalledOnce();

    const dueConfiguration = configuration();
    dueConfiguration.job.policy.stages[0].beforeDeadlineMinutes = 420;
    fs.writeFileSync(paths.configFile, `${JSON.stringify(dueConfiguration)}\n`);
    await clock.advance(60_000);
    expect(getReminderCapability).toHaveBeenCalledTimes(2);
    signals.emit('SIGTERM');
    await running;
  });

  it('applies 1, 5, 15, and 60 minute Kicktipp network backoffs without resetting early', async () => {
    setupService(configuration(), paths);
    const getReminderCapability = vi.fn(async () => { throw new TypeError('network unavailable'); });
    const running = start({ getReminderCapability });
    await flush();
    expect(getReminderCapability).toHaveBeenCalledTimes(1);

    for (const [before, due, calls] of [
      [59_000, 1_000, 2],
      [299_000, 1_000, 3],
      [899_000, 1_000, 4],
      [3_599_000, 1_000, 5],
    ] as const) {
      await clock.advance(before);
      expect(getReminderCapability).toHaveBeenCalledTimes(calls - 1);
      await clock.advance(due);
      expect(getReminderCapability).toHaveBeenCalledTimes(calls);
    }
    expect(readServiceState(readServiceConfiguration(paths), paths).scheduler).toMatchObject({
      kicktippNetworkFailures: 5,
      safeErrorCode: 'kicktipp_network_failure',
    });
    signals.emit('SIGTERM');
    await running;
  });

  it('rechecks Reminder Capability failures hourly and stays alive', async () => {
    setupService(configuration(), paths);
    const getReminderCapability = vi.fn()
      .mockResolvedValueOnce({ available: false, reason: 'incomplete-matrix' })
      .mockResolvedValue(capability({ missing: false }));
    const running = start({ getReminderCapability });
    await flush();

    await clock.advance(59 * 60_000);
    expect(getReminderCapability).toHaveBeenCalledOnce();
    await clock.advance(60_000);
    expect(getReminderCapability).toHaveBeenCalledTimes(2);
    expect(readServiceState(readServiceConfiguration(paths), paths).scheduler).toMatchObject({
      kicktippNetworkFailures: 0,
      lastScheduleFetchAt: '2026-09-04T12:00:00.000Z',
      lastReliableCheckAt: '2026-09-04T12:00:00.000Z',
      lastFailedCheckAt: '2026-09-04T11:00:00.000Z',
      reminderCapabilityAvailable: true,
      sessionCondition: 'authenticated',
    });
    signals.emit('SIGTERM');
    await running;
  });

  it('keeps provider Retry timing independent from a later Kicktipp backoff', async () => {
    setupService(configuration(), paths);
    const getReminderCapability = vi.fn()
      .mockResolvedValueOnce(capability())
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValue(capability());
    const provider = vi.fn<FetchLike>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const running = start({ getReminderCapability, providerFetchImpl: provider });
    await flush();
    const config = readServiceConfiguration(paths);
    expect(readServiceState(config, paths).deliveries[0].nextAttemptAt)
      .toBe('2026-09-04T11:00:10.000Z');

    await clock.advance(10_000);
    expect(getReminderCapability).toHaveBeenCalledTimes(2);
    expect(provider).toHaveBeenCalledOnce();
    expect(readServiceState(config, paths).deliveries[0].nextAttemptAt)
      .toBe('2026-09-04T11:00:10.000Z');

    await clock.advance(60_000);
    expect(getReminderCapability).toHaveBeenCalledTimes(3);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(readServiceState(config, paths).deliveries[0].state).toBe('confirmed');
    signals.emit('SIGINT');
    await running;
  });

  it('lets current provider I/O finish gracefully without starting further work', async () => {
    setupService(configuration(), paths);
    let finish!: (response: Response) => void;
    let providerSignal: AbortSignal | undefined;
    const provider = vi.fn<FetchLike>(async (_input, init) => {
      providerSignal = init.signal ?? undefined;
      return new Promise<Response>((resolve) => { finish = resolve; });
    });
    const running = start({
      getReminderCapability: async () => capability(),
      providerFetchImpl: provider,
    });
    await flush();
    expect(provider).toHaveBeenCalledOnce();

    signals.emit('SIGTERM');
    finish(new Response(null, { status: 204 }));
    await expect(running).resolves.toBe(0);
    expect(providerSignal?.aborted).toBe(false);
    expect(readServiceState(readServiceConfiguration(paths), paths).deliveries[0].state).toBe('confirmed');
  });

  it('starts no further Delivery Attempts once shutdown begins', async () => {
    const config = configuration();
    config.targets = Array.from({ length: 5 }, (_, index) => ({
      id: `hook-${index}`,
      enabled: true as const,
      provider: 'webhook' as const,
      urlRef: 'env:HOOK_URL',
    }));
    config.job.targetIds = config.targets.map(({ id }) => id);
    setupService(config, paths);
    const provider = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    let attempts = 0;
    const running = start({
      getReminderCapability: async () => capability(),
      providerFetchImpl: provider,
      afterAttemptStarted: () => {
        attempts += 1;
        if (attempts === 1) signals.emit('SIGTERM');
      },
    });
    await expect(running).resolves.toBe(0);

    const state = readServiceState(config, paths);
    expect(state.attempts).toHaveLength(1);
    expect(provider).toHaveBeenCalledOnce();
    expect(state.deliveries.filter(({ state: deliveryState }) => deliveryState === 'pending')).toHaveLength(4);
  });

  it('aborts provider I/O after the grace period and durably records the ambiguous outcome', async () => {
    setupService(configuration(), paths);
    const provider = vi.fn<FetchLike>(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const running = start({
      shutdownGraceMilliseconds: 1_000,
      getReminderCapability: async () => capability(),
      providerFetchImpl: provider,
    });
    await flush();
    signals.emit('SIGINT');
    await clock.advance(1_000);
    await expect(running).resolves.toBe(0);

    const state = readServiceState(readServiceConfiguration(paths), paths);
    expect(state.deliveries[0]).toMatchObject({ state: 'unknown', safeErrorCode: 'transport_ambiguous' });
    expect(state.attempts[0].outcome?.state).toBe('unknown');
    expect(provider).toHaveBeenCalledOnce();
  });

  it('recovers an unfinished write-ahead Attempt before checking and never resends it', async () => {
    const config = configuration();
    setupService(config, paths);
    await expect(runReminderOnce({
      paths,
      now: clock.now(),
      site: 'https://www.kicktipp.com',
      env: { HOOK_URL: 'https://hooks.example.test/reminders' },
      getReminderCapability: async () => capability(),
      providerFetchImpl: vi.fn(),
      afterAttemptStarted: () => { throw new Error('crash'); },
    })).rejects.toThrow('crash');

    const provider = vi.fn<FetchLike>();
    const running = start({
      getReminderCapability: async () => capability(),
      providerFetchImpl: provider,
    });
    await flush();
    expect(provider).not.toHaveBeenCalled();
    expect(readServiceState(config, paths).deliveries[0].state).toBe('unknown');
    signals.emit('SIGTERM');
    await running;
  });
});
