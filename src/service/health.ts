import type { LocalServiceBasis } from './store.js';
import { safeError } from './safe-error.js';

export type HealthLevel = 'healthy' | 'degraded' | 'unhealthy';
export type HealthReason =
  | 'operational'
  | 'service-not-running'
  | 'service-lock-ambiguous'
  | 'initial-check-pending'
  | 'temporary-check-failure'
  | 'check-overdue'
  | 'authentication-unavailable'
  | 'reminder-capability-unavailable'
  | 'missed-stage'
  | 'schedule-stale'
  | 'current-delivery-problem'
  | 'retry-overdue'
  | 'local-data-unreadable';

export interface ServiceHealth {
  status: HealthLevel;
  reasons: HealthReason[];
}

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function evaluateServiceHealth(
  basis: LocalServiceBasis,
  now = new Date(),
): ServiceHealth {
  const unhealthy = new Set<HealthReason>();
  const degraded = new Set<HealthReason>();
  const { configuration, state } = basis;
  const scheduler = state.scheduler;
  const nowMs = now.getTime();

  if (basis.locks.service.status === 'ambiguous') unhealthy.add('service-lock-ambiguous');
  else if (basis.locks.service.status !== 'held') unhealthy.add('service-not-running');

  if (configuration.job.enabled) {
    const error = safeError(scheduler.safeErrorCode);
    if (scheduler.sessionCondition === 'unavailable' || error?.category === 'authentication') {
      unhealthy.add('authentication-unavailable');
    } else if (scheduler.reminderCapabilityAvailable === false || error?.category === 'capability' && !error.retryable) {
      unhealthy.add('reminder-capability-unavailable');
    }

    const lastReliable = time(scheduler.lastReliableCheckAt);
    const nextStage = time(scheduler.nextStageAt);
    if (nextStage !== undefined && nextStage <= nowMs && (lastReliable === undefined || lastReliable < nextStage)) {
      unhealthy.add('missed-stage');
    }

    const lastSchedule = time(scheduler.lastScheduleFetchAt) ?? time(state.initializedAt)!;
    const futureDeadlineKnown = (time(scheduler.nextDeadlineAt) ?? 0) > nowMs;
    const freshnessLimit = futureDeadlineKnown ? 24 * 60 * 60_000 : 48 * 60 * 60_000;
    if (nowMs - lastSchedule > freshnessLimit) unhealthy.add('schedule-stale');

    if (lastReliable === undefined && scheduler.safeErrorCode === undefined) degraded.add('initial-check-pending');
    if (error?.retryable) {
      const backoffUntil = time(scheduler.kicktippBackoffUntil);
      if (backoffUntil !== undefined && backoffUntil <= nowMs) unhealthy.add('check-overdue');
      else degraded.add('temporary-check-failure');
    }

    const currentNotificationIds = new Set(state.notifications
      .filter(({ deadlineGroup }) => deadlineGroup.id === scheduler.deadlineGroupId && time(deadlineGroup.deadlineAt)! > nowMs)
      .map(({ id }) => id));
    for (const delivery of state.deliveries.filter(({ notificationId }) => currentNotificationIds.has(notificationId))) {
      if (delivery.state === 'failed' || delivery.state === 'unknown') degraded.add('current-delivery-problem');
      if (delivery.state === 'pending' && (time(delivery.nextAttemptAt) ?? Number.POSITIVE_INFINITY) <= nowMs) {
        degraded.add('retry-overdue');
      }
    }
  }

  if (unhealthy.size > 0) return { status: 'unhealthy', reasons: [...unhealthy] };
  if (degraded.size > 0) return { status: 'degraded', reasons: [...degraded] };
  return { status: 'healthy', reasons: ['operational'] };
}
