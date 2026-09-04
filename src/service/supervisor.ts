import { AuthError } from '../core.js';
import { MissingProfileCredentialsError, SessionOnlyExpiredError } from '../config.js';
import type { FetchLike } from '../browser.js';
import type { ReminderCapability } from '../reminder-capability.js';
import {
  recoverOpenAttempts,
  runReminderOnce,
  type ReminderScheduleObservation,
} from './delivery.js';
import { servicePaths, type ServicePaths } from './paths.js';
import {
  acquireServiceLock,
  readLocalServiceBasis,
  readServiceConfiguration,
  readServiceState,
  writeServiceState,
  type ServiceConfiguration,
  type ServiceState,
} from './store.js';
import { evaluateServiceHealth, type HealthLevel } from './health.js';
import { createServiceLogger, type LogFormat, type ServiceLogger } from './logging.js';
import { localReadSafeError, safeError } from './safe-error.js';

const CONFIGURATION_HORIZON = 60_000;
const NO_DEADLINE_REFRESH = 24 * 60 * 60_000;
const SCHEDULE_REFRESH = 6 * 60 * 60_000;
const CAPABILITY_BACKOFF = 60 * 60_000;
const NETWORK_BACKOFFS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export interface SupervisorClock {
  now(): Date;
  sleep(milliseconds: number, signal: AbortSignal): Promise<'elapsed' | 'aborted'>;
}

export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface SupervisorWake {
  at: string;
  reason: 'configuration' | 'stage' | 'deadline' | 'schedule-fetch' | 'delivery-retry' | 'kicktipp-backoff';
}

type Scheduler = ServiceState['scheduler'];

const systemClock: SupervisorClock = {
  now: () => new Date(),
  sleep(milliseconds, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve('aborted');
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', aborted);
        resolve('elapsed');
      }, milliseconds);
      const aborted = (): void => {
        clearTimeout(timer);
        resolve('aborted');
      };
      signal.addEventListener('abort', aborted, { once: true });
    });
  },
};

function instant(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nextRetry(state: ServiceState): number | undefined {
  const retries = state.deliveries
    .filter(({ state: deliveryState, nextAttemptAt }) =>
      deliveryState === 'pending' && nextAttemptAt !== undefined)
    .map(({ nextAttemptAt }) => instant(nextAttemptAt)!)
    .filter(Number.isFinite);
  return retries.length > 0 ? Math.min(...retries) : undefined;
}

export function nextSupervisorWake(
  configuration: ServiceConfiguration,
  state: ServiceState,
  scheduler: Scheduler,
  now: Date,
): SupervisorWake {
  const nowMs = now.getTime();
  const candidates: Array<{ at: number; reason: SupervisorWake['reason'] }> = [
    { at: nowMs + CONFIGURATION_HORIZON, reason: 'configuration' },
  ];
  if (!configuration.job.enabled) {
    return { at: new Date(candidates[0].at).toISOString(), reason: 'configuration' };
  }

  const backoff = instant(scheduler.kicktippBackoffUntil);
  const retry = nextRetry(state);
  const dependentWork = [
    { at: instant(scheduler.nextStageAt), reason: 'stage' as const },
    { at: instant(scheduler.nextDeadlineAt), reason: 'deadline' as const },
    { at: retry, reason: 'delivery-retry' as const },
  ];
  if (backoff !== undefined && backoff > nowMs) {
    for (const work of dependentWork) {
      if (work.at !== undefined && work.at > nowMs && work.at < backoff) candidates.push(work as { at: number; reason: SupervisorWake['reason'] });
    }
    candidates.push({ at: backoff, reason: 'kicktipp-backoff' });
  } else {
    for (const work of dependentWork) {
      if (work.at !== undefined) candidates.push({ at: Math.max(nowMs, work.at), reason: work.reason });
    }
    const lastFetch = instant(scheduler.lastScheduleFetchAt);
    const refreshAfter = scheduler.nextDeadlineAt ? SCHEDULE_REFRESH : NO_DEADLINE_REFRESH;
    candidates.push({
      at: lastFetch === undefined ? nowMs : Math.max(nowMs, lastFetch + refreshAfter),
      reason: 'schedule-fetch',
    });
  }

  const next = candidates.reduce((earliest, candidate) => candidate.at < earliest.at ? candidate : earliest);
  return { at: new Date(next.at).toISOString(), reason: next.reason };
}

function configurationRevision(configuration: ServiceConfiguration): string {
  return JSON.stringify(configuration);
}

function refreshStageSchedule(
  configuration: ServiceConfiguration,
  state: ServiceState,
  scheduler: Scheduler,
  now: Date,
): boolean {
  const deadline = instant(scheduler.nextDeadlineAt);
  if (deadline === undefined || !scheduler.deadlineGroupId) {
    delete scheduler.nextStageAt;
    return false;
  }
  const pending = configuration.job.policy.stages
    .filter((stage) => !state.stageOutcomes.some((outcome) =>
      outcome.deadlineGroupId === scheduler.deadlineGroupId
      && outcome.stageMinutes === stage.beforeDeadlineMinutes))
    .map(({ beforeDeadlineMinutes }) => deadline - beforeDeadlineMinutes * 60_000);
  const future = pending.filter((at) => at > now.getTime());
  if (future.length > 0) scheduler.nextStageAt = new Date(Math.min(...future)).toISOString();
  else delete scheduler.nextStageAt;
  return pending.some((at) => at <= now.getTime());
}

function networkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== 'object' || !('cause' in error)) return false;
  const cause = error.cause;
  return !!cause && typeof cause === 'object' && 'code' in cause
    && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(String(cause.code));
}

function safeFailure(error: unknown): { network: boolean; code: string } {
  if (error instanceof AuthError || error instanceof SessionOnlyExpiredError || error instanceof MissingProfileCredentialsError) {
    return { network: false, code: 'kicktipp_auth_unavailable' };
  }
  if (networkFailure(error)) return { network: true, code: 'kicktipp_network_failure' };
  return { network: false, code: 'kicktipp_operation_failure' };
}

function withKicktippAbort(fetchImpl: FetchLike | undefined, signal: AbortSignal): FetchLike {
  const request = fetchImpl ?? ((input, init) => fetch(input, init));
  return (input, init) => request(input, {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000), signal])
      : AbortSignal.any([AbortSignal.timeout(30_000), signal]),
  });
}

function due(wake: SupervisorWake, now: Date): boolean {
  return Date.parse(wake.at) <= now.getTime() && wake.reason !== 'configuration';
}

export async function runServiceSupervisor(options: {
  paths?: ServicePaths;
  clock?: SupervisorClock;
  signals?: SignalSource;
  shutdownGraceMilliseconds?: number;
  site?: string;
  env?: NodeJS.ProcessEnv;
  kicktippFetchImpl?: FetchLike;
  providerFetchImpl?: FetchLike;
  getReminderCapability?: (
    profileId: string,
    communityId: string,
    signal?: AbortSignal,
  ) => Promise<ReminderCapability>;
  afterAttemptStarted?: () => void | Promise<void>;
  logFormat?: LogFormat;
  logger?: ServiceLogger;
} = {}): Promise<0> {
  const paths = options.paths ?? servicePaths();
  const clock = options.clock ?? systemClock;
  const signals = options.signals ?? process;
  const lock = acquireServiceLock(paths);
  const stop = new AbortController();
  const abortIo = new AbortController();
  const cancelGrace = new AbortController();
  const logger = options.logger ?? createServiceLogger(options.logFormat ?? 'text');
  let loggedJobId: string | undefined;
  let currentHealth: HealthLevel = 'unhealthy';
  let grace: Promise<void> | undefined;
  const requestShutdown = (): void => {
    if (stop.signal.aborted) return;
    stop.abort();
    grace = clock.sleep(options.shutdownGraceMilliseconds ?? 30_000, cancelGrace.signal)
      .then((result) => {
        if (result === 'elapsed') abortIo.abort();
      });
  };

  try {
    const initialBasis = readLocalServiceBasis(paths);
    let configuration = initialBasis.configuration;
    let state = initialBasis.state;
    loggedJobId = configuration.job.id;
    if (recoverOpenAttempts(state, clock.now())) writeServiceState(state, lock, paths);
    let scheduler: Scheduler = structuredClone(state.scheduler);
    let revision = configurationRevision(configuration);
    let forceCheck = configuration.job.enabled;
    let wasEnabled = configuration.job.enabled;
    currentHealth = evaluateServiceHealth(initialBasis, clock.now()).status;
    logger.log({ event: 'service_started', at: clock.now().toISOString(), jobId: loggedJobId, health: currentHealth });
    signals.on('SIGINT', requestShutdown);
    signals.on('SIGTERM', requestShutdown);

    while (!stop.signal.aborted) {
      const now = clock.now();
      try {
        const reloaded = readServiceConfiguration(paths);
        state = readServiceState(reloaded, paths);
        const nextRevision = configurationRevision(reloaded);
        const scopeChanged = reloaded.job.profileId !== configuration.job.profileId
          || reloaded.job.communityId !== configuration.job.communityId;
        configuration = reloaded;
        if (nextRevision !== revision && configuration.job.enabled) {
          forceCheck ||= scopeChanged || !wasEnabled
            || refreshStageSchedule(configuration, state, scheduler, now);
        }
        revision = nextRevision;
        wasEnabled = configuration.job.enabled;
      } catch (error) {
        logger.log({
          event: 'check_completed',
          at: now.toISOString(),
          jobId: loggedJobId,
          durationMs: 0,
          reliable: false,
          error: localReadSafeError(error),
        });
        if (currentHealth !== 'unhealthy') {
          logger.log({ event: 'health_transition', at: now.toISOString(), jobId: loggedJobId, from: currentHealth, to: 'unhealthy', reasons: ['local-data-unreadable'] });
          currentHealth = 'unhealthy';
        }
        await clock.sleep(CONFIGURATION_HORIZON, stop.signal);
        continue;
      }

      if (!configuration.job.enabled) {
        await clock.sleep(CONFIGURATION_HORIZON, stop.signal);
        continue;
      }

      const wake = nextSupervisorWake(configuration, state, scheduler, now);
      const backoff = instant(scheduler.kicktippBackoffUntil);
      const mayContactKicktipp = backoff === undefined || backoff <= now.getTime();
      if (forceCheck || (due(wake, now) && mayContactKicktipp)) {
        forceCheck = false;
        const beforeState = state;
        const started = clock.now().getTime();
        let observation: ReminderScheduleObservation | undefined;
        let reliable = false;
        let outcome: Extract<Parameters<ServiceLogger['log']>[0], { event: 'check_completed' }>['outcome'];
        try {
          const result = await runReminderOnce({
            paths,
            lock,
            now,
            site: options.site,
            env: options.env,
            kicktippFetchImpl: withKicktippAbort(options.kicktippFetchImpl, abortIo.signal),
            providerFetchImpl: options.providerFetchImpl,
            getReminderCapability: options.getReminderCapability,
            stopSignal: stop.signal,
            providerAbortSignal: abortIo.signal,
            afterAttemptStarted: options.afterAttemptStarted,
            observeSchedule: (value) => { observation = value; },
          });
          if (result.reliable && result.outcome === 'interrupted') continue;
          if (result.reliable) {
            reliable = true;
            outcome = result.outcome;
            scheduler = {
              kicktippNetworkFailures: 0,
              lastScheduleFetchAt: now.toISOString(),
              lastReliableCheckAt: now.toISOString(),
              lastFailedCheckAt: scheduler.lastFailedCheckAt,
              reminderCapabilityAvailable: true,
              sessionCondition: 'authenticated',
              ...observation,
            };
          } else {
            outcome = 'unreliable';
            scheduler.lastFailedCheckAt = now.toISOString();
            scheduler.reminderCapabilityAvailable = false;
            scheduler.kicktippBackoffUntil = new Date(now.getTime() + CAPABILITY_BACKOFF).toISOString();
            scheduler.safeErrorCode = `reminder_capability_${result.reason}`;
          }
        } catch (error) {
          if (stop.signal.aborted) continue;
          const failure = safeFailure(error);
          if (failure.network) scheduler.kicktippNetworkFailures += 1;
          scheduler.lastFailedCheckAt = now.toISOString();
          if (failure.code === 'kicktipp_auth_unavailable') {
            scheduler.reminderCapabilityAvailable = false;
            scheduler.sessionCondition = 'unavailable';
          }
          const delay = failure.network
            ? NETWORK_BACKOFFS[Math.min(scheduler.kicktippNetworkFailures - 1, NETWORK_BACKOFFS.length - 1)]
            : CAPABILITY_BACKOFF;
          scheduler.kicktippBackoffUntil = new Date(now.getTime() + delay).toISOString();
          scheduler.safeErrorCode = failure.code;
        }

        try {
          const currentConfiguration = readServiceConfiguration(paths);
          const currentState = readServiceState(currentConfiguration, paths);
          currentState.scheduler = structuredClone(scheduler);
          writeServiceState(currentState, lock, paths);
          state = currentState;
          logger.log({
            event: 'check_completed',
            at: now.toISOString(),
            jobId: configuration.job.id,
            durationMs: Math.max(0, clock.now().getTime() - started),
            reliable,
            ...(outcome ? { outcome } : {}),
            ...(!reliable && safeError(scheduler.safeErrorCode) ? { error: safeError(scheduler.safeErrorCode) } : {}),
          });
          for (const delivery of state.deliveries) {
            const before = beforeState.deliveries.find(({ id }) => id === delivery.id);
            if (before?.state === delivery.state && before.nextAttemptAt === delivery.nextAttemptAt) continue;
            const target = configuration.targets.find(({ id }) => id === delivery.targetId);
            const notification = state.notifications.find(({ id }) => id === delivery.notificationId);
            logger.log({
              event: 'delivery_transition',
              at: now.toISOString(),
              jobId: configuration.job.id,
              deliveryId: delivery.id,
              targetId: delivery.targetId,
              provider: target?.provider ?? 'unknown',
              from: before?.state ?? 'created',
              to: delivery.state,
              attemptCount: state.attempts.filter(({ deliveryId }) => deliveryId === delivery.id).length,
              missingCount: notification?.missingParticipants.length ?? 0,
              ...(delivery.nextAttemptAt ? { nextRetryAt: delivery.nextAttemptAt } : {}),
              ...(safeError(delivery.safeErrorCode) ? { error: safeError(delivery.safeErrorCode) } : {}),
            });
          }
          const health = evaluateServiceHealth(readLocalServiceBasis(paths), clock.now());
          if (health.status !== currentHealth) {
            logger.log({
              event: 'health_transition',
              at: clock.now().toISOString(),
              jobId: configuration.job.id,
              from: currentHealth,
              to: health.status,
              reasons: health.reasons,
            });
            currentHealth = health.status;
          }
        } catch {
          // State/configuration is rechecked locally on the next horizon.
        }
        continue;
      }

      const milliseconds = Math.max(0, Date.parse(wake.at) - now.getTime());
      await clock.sleep(milliseconds, stop.signal);
    }
    return 0;
  } finally {
    cancelGrace.abort();
    await grace;
    signals.off('SIGINT', requestShutdown);
    signals.off('SIGTERM', requestShutdown);
    lock.release();
    if (loggedJobId) logger.log({ event: 'service_stopped', at: clock.now().toISOString(), jobId: loggedJobId });
  }
}
