import type { ServicePaths } from './paths.js';
import { servicePaths } from './paths.js';
import { readLocalServiceBasis, type LocalServiceBasis, type ServiceState } from './store.js';
import { nextSupervisorWake } from './supervisor.js';
import { summarizeTarget, type TargetSummary } from './targets.js';
import { localReadSafeError, safeError, type SafeError } from './safe-error.js';
import { evaluateServiceHealth, type ServiceHealth } from './health.js';

function time(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface NotificationSummary {
  id: string;
  deadlineGroupId: string;
  deadlineAt: string;
  stage: string;
  missingParticipantCount: number;
}

interface DeliverySummary {
  id: string;
  notificationId: string;
  targetId: string;
  state: ServiceState['deliveries'][number]['state'];
  current: boolean;
  attemptCount: number;
  nextAttemptAt?: string;
  error?: SafeError;
  receipt?: { provider: 'discord' | 'telegram' | 'ntfy' | 'webhook'; acceptedAt: string; messageId?: string };
}

export interface ReadableServiceStatus {
  readable: true;
  observedAt: string;
  health: ServiceHealth;
  runtime: {
    running: boolean;
    lockStatus: LocalServiceBasis['locks']['service']['status'];
    pid?: number;
    startedAt?: string;
    nextWakeAt?: string;
    nextWakeReason?: string;
  };
  job: {
    id: string;
    name: string;
    enabled: boolean;
    profileId: string;
    communityId: string;
  };
  checks: {
    lastScheduleFetchAt?: string;
    lastReliableCheckAt?: string;
    lastFailedCheckAt?: string;
    error?: SafeError;
  };
  session: { condition: 'authenticated' | 'unavailable' | 'unknown' };
  deadlineGroup: { id: string; deadlineAt?: string } | null;
  stages: ServiceState['stageOutcomes'];
  targets: TargetSummary[];
  notifications: NotificationSummary[];
  deliveries: DeliverySummary[];
  details?: {
    notifications: Array<NotificationSummary & {
      missingParticipants: Array<{ id: string; displayName: string }>;
      content: ServiceState['notifications'][number]['content'];
    }>;
  };
}

export interface UnreadableServiceStatus {
  readable: false;
  observedAt: string;
  health: ServiceHealth;
  error: SafeError;
}

export type ServiceStatus = ReadableServiceStatus | UnreadableServiceStatus;

function publicContent(content: ServiceState['notifications'][number]['content']): ServiceState['notifications'][number]['content'] {
  if (!content.actionUrl) return content;
  try {
    const url = new URL(content.actionUrl);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search
      && ['kicktipp.de', 'kicktipp.com'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      return content;
    }
  } catch { /* omit an unsafe persisted URL */ }
  const { actionUrl: _unsafe, ...safe } = content;
  return safe;
}

function publicReceipt(
  receipt: NonNullable<ServiceState['deliveries'][number]['receipt']>,
): { provider: 'discord' | 'telegram' | 'ntfy' | 'webhook'; acceptedAt: string; messageId?: string } {
  return {
    provider: receipt.provider,
    acceptedAt: receipt.acceptedAt,
    ...(receipt.provider === 'discord' && /^\d{1,32}$/.test(receipt.messageId)
      || receipt.provider === 'telegram' && /^\d{1,32}$/.test(receipt.messageId)
      || receipt.provider === 'ntfy' && /^[A-Za-z0-9]{12}$/.test(receipt.messageId)
      ? { messageId: receipt.messageId }
      : {}),
  };
}

function unreadable(error: unknown, now: Date): UnreadableServiceStatus {
  return {
    readable: false,
    observedAt: now.toISOString(),
    health: { status: 'unhealthy', reasons: ['local-data-unreadable'] },
    error: localReadSafeError(error),
  };
}

/** The only Config/State/Lock read used by Service CLI and MCP representations. */
export function getServiceStatus(options: {
  paths?: ServicePaths;
  now?: Date;
  details?: boolean;
} = {}): ServiceStatus {
  const now = options.now ?? new Date();
  try {
    const basis = readLocalServiceBasis(options.paths ?? servicePaths());
    const { configuration, state } = basis;
    const serviceLock = basis.locks.service;
    const wake = nextSupervisorWake(configuration, state, state.scheduler, now);
    const currentGroup = state.scheduler.deadlineGroupId;
    const notifications = state.notifications.map((notification) => ({
      id: notification.id,
      deadlineGroupId: notification.deadlineGroup.id,
      deadlineAt: notification.deadlineGroup.deadlineAt,
      stage: notification.stage,
      missingParticipantCount: notification.missingParticipants.length,
    }));
    return {
      readable: true,
      observedAt: now.toISOString(),
      health: evaluateServiceHealth(basis, now),
      runtime: {
        running: serviceLock.status === 'held',
        lockStatus: serviceLock.status,
        ...('pid' in serviceLock ? { pid: serviceLock.pid, startedAt: serviceLock.startedAt } : {}),
        nextWakeAt: wake.at,
        nextWakeReason: wake.reason,
      },
      job: {
        id: configuration.job.id,
        name: configuration.job.name,
        enabled: configuration.job.enabled,
        profileId: configuration.job.profileId,
        communityId: configuration.job.communityId,
      },
      checks: {
        ...(state.scheduler.lastScheduleFetchAt ? { lastScheduleFetchAt: state.scheduler.lastScheduleFetchAt } : {}),
        ...(state.scheduler.lastReliableCheckAt ? { lastReliableCheckAt: state.scheduler.lastReliableCheckAt } : {}),
        ...(state.scheduler.lastFailedCheckAt ? { lastFailedCheckAt: state.scheduler.lastFailedCheckAt } : {}),
        ...(safeError(state.scheduler.safeErrorCode) ? { error: safeError(state.scheduler.safeErrorCode) } : {}),
      },
      session: { condition: state.scheduler.sessionCondition ?? 'unknown' },
      deadlineGroup: currentGroup
        ? { id: currentGroup, ...(state.scheduler.nextDeadlineAt ? { deadlineAt: state.scheduler.nextDeadlineAt } : {}) }
        : null,
      stages: state.stageOutcomes.filter(({ deadlineGroupId }) => deadlineGroupId === currentGroup),
      targets: configuration.targets.map(summarizeTarget),
      notifications,
      deliveries: state.deliveries.map((delivery) => {
        const notification = state.notifications.find(({ id }) => id === delivery.notificationId);
        return {
          id: delivery.id,
          notificationId: delivery.notificationId,
          targetId: delivery.targetId,
          state: delivery.state,
          current: notification !== undefined
            && notification.deadlineGroup.id === currentGroup
            && time(notification.deadlineGroup.deadlineAt)! > now.getTime(),
          attemptCount: state.attempts.filter(({ deliveryId }) => deliveryId === delivery.id).length,
          ...(delivery.nextAttemptAt ? { nextAttemptAt: delivery.nextAttemptAt } : {}),
          ...(safeError(delivery.safeErrorCode) ? { error: safeError(delivery.safeErrorCode) } : {}),
          ...(delivery.receipt ? { receipt: publicReceipt(delivery.receipt) } : {}),
        };
      }),
      ...(options.details ? {
        details: {
          notifications: state.notifications.map((notification, index) => ({
            ...notifications[index],
            missingParticipants: notification.missingParticipants,
            content: publicContent(notification.content),
          })),
        },
      } : {}),
    };
  } catch (error) {
    return unreadable(error, now);
  }
}
