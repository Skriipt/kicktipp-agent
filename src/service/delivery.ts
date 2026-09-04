import crypto from 'crypto';
import type { FetchLike } from '../browser.js';
import { createScopedClient } from '../client.js';
import type { ReminderCapability } from '../reminder-capability.js';
import { siteLabel, urlBase } from '../url.js';
import {
  deliverDiscord,
  discordRequest,
  DiscordPayloadTooLargeError,
} from './discord.js';
import { evaluateReminderDryRun } from './dry-run.js';
import type { FileLock } from './lock.js';
import {
  deliverNtfy,
  InvalidNtfyTargetError,
  ntfyRequest,
  NtfyPayloadTooLargeError,
} from './ntfy.js';
import { servicePaths, type ServicePaths } from './paths.js';
import { requestProvider, retryAfterMilliseconds, retryableTransportFailure } from './provider-http.js';
import {
  deliverTelegram,
  InvalidTelegramTargetError,
  telegramRequest,
  TelegramPayloadTooLargeError,
} from './telegram.js';
import {
  acquireServiceLock,
  readServiceConfiguration,
  readServiceState,
  writeServiceState,
  type NotificationTarget,
  type ServiceConfiguration,
  type ServiceState,
} from './store.js';
import {
  InvalidWebhookTargetError,
  SecretResolutionError,
  resolveWebhookTarget,
  targetRevision,
  type ResolvedWebhookTarget,
  type WebhookTarget,
} from './targets.js';

type ReminderNotification = ServiceState['notifications'][number];
type Delivery = ServiceState['deliveries'][number];
type AttemptOutcome = NonNullable<ServiceState['attempts'][number]['outcome']>;

export type ProviderDeliveryOutcome = AttemptOutcome & { retryAfterMilliseconds?: number };
export type WebhookDeliveryOutcome = ProviderDeliveryOutcome;

const MAX_PROVIDER_CONCURRENCY = 4;
const RETRY_DELAYS = [10_000, 60_000] as const;

export type ReminderRunResult =
  | { reliable: false; reason: string }
  | {
    reliable: true;
    outcome: 'disabled' | 'no-open-deadline-group' | 'not-due' | 'satisfied' | 'notified' | 'already-processed' | 'interrupted';
    deliveryStates: Delivery['state'][];
  };

export interface ReminderScheduleObservation {
  deadlineGroupId?: string;
  nextDeadlineAt?: string;
  nextStageAt?: string;
}

export function reminderRunExitCode(result: ReminderRunResult): 0 | 1 | 2 {
  if (!result.reliable) return 1;
  return result.deliveryStates.some((state) => ['failed', 'unknown', 'pending'].includes(state))
    ? 2
    : 0;
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function hash(value: object): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function deadlineGroupId(input: {
  site: string;
  communityId: string;
  gameIds: string[];
}): string {
  return hash({
    namespace: 'deadline-group:v1',
    site: input.site,
    communityId: input.communityId,
    gameIds: [...input.gameIds].sort(compareCodePoints),
  });
}

export function notificationId(input: {
  jobId: string;
  deadlineGroupId: string;
  stageMinutes: number;
}): string {
  return hash({
    namespace: 'notification:v1',
    jobId: input.jobId,
    deadlineGroupId: input.deadlineGroupId,
    stageMinutes: input.stageMinutes,
  });
}

export function deliveryId(input: {
  notificationId: string;
  targetId: string;
  targetRevision: string;
}): string {
  return hash({
    namespace: 'delivery:v1',
    notificationId: input.notificationId,
    targetId: input.targetId,
    targetRevision: input.targetRevision,
  });
}

function actionUrl(site: string, communityId: string): string {
  const origin = new URL(site);
  const host = origin.hostname.toLowerCase();
  if (
    origin.protocol !== 'https:'
    || ![
      host === 'kicktipp.de' || host.endsWith('.kicktipp.de'),
      host === 'kicktipp.com' || host.endsWith('.kicktipp.com'),
    ].some(Boolean)
  ) {
    throw new Error('The Reminder Job does not use an official Kicktipp HTTPS origin.');
  }
  const route = host.endsWith('kicktipp.com') ? 'predict' : 'tippabgabe';
  return new URL(`/${encodeURIComponent(communityId)}/${route}`, origin.origin).toString();
}

function localDeadline(deadlineAt: string, language: string, displayTimezone: string): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: displayTimezone,
  }).format(new Date(deadlineAt));
}

function createNotification(
  configuration: ServiceConfiguration,
  preview: Extract<ReturnType<typeof evaluateReminderDryRun>, { reliable: true }>['preview'],
  groupId: string,
  site: string,
  createdAt: string,
): ReminderNotification {
  if (!preview.deadlineGroup || !preview.stage || preview.missingParticipants.length === 0) {
    throw new Error('A Reminder Notification requires one due Stage with missing Participants.');
  }
  const deadline = localDeadline(
    preview.deadlineGroup.deadlineAt,
    configuration.job.language,
    configuration.job.displayTimezone,
  );
  const names = preview.missingParticipants.map(({ displayName }) => `• ${displayName}`).join('\n');
  const german = configuration.job.language.toLowerCase().startsWith('de');
  const content = german
    ? {
      title: `Kicktipp-Erinnerung: ${configuration.job.communityId}`,
      message: `Vor ${deadline} fehlen noch Tipps von:\n${names}`,
    }
    : {
      title: `Kicktipp reminder: ${configuration.job.communityId}`,
      message: `Predictions are still missing from the following people before ${deadline}:\n${names}`,
    };
  return {
    id: notificationId({
      jobId: configuration.job.id,
      deadlineGroupId: groupId,
      stageMinutes: preview.stage.beforeDeadlineMinutes,
    }),
    jobId: configuration.job.id,
    createdAt,
    language: configuration.job.language,
    displayTimezone: configuration.job.displayTimezone,
    content: {
      schemaVersion: 1,
      type: 'reminder',
      severity: preview.stage.severity,
      ...content,
      actionUrl: actionUrl(site, configuration.job.communityId),
    },
    deadlineGroup: {
      id: groupId,
      deadlineAt: preview.deadlineGroup.deadlineAt,
      gameIds: [...preview.deadlineGroup.gameIds],
    },
    stage: String(preview.stage.beforeDeadlineMinutes),
    missingParticipants: preview.missingParticipants.map((participant) => ({ ...participant })),
  };
}

function webhookRequest(
  notification: ReminderNotification,
  target: WebhookTarget,
  options: { env?: NodeJS.ProcessEnv; paths?: ServicePaths },
): { resolved: ResolvedWebhookTarget; body: string } {
  return {
    resolved: resolveWebhookTarget(target, options),
    body: JSON.stringify(notification),
  };
}

export async function deliverWebhook(
  request: { resolved: ResolvedWebhookTarget; body: string },
  ids: { notificationId: string; deliveryId: string },
  options: { fetchImpl?: FetchLike; now?: Date; clock?: { now(): Date }; signal?: AbortSignal } = {},
): Promise<WebhookDeliveryOutcome> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  try {
    const response = await requestProvider(request.resolved.url, {
      method: 'POST',
      signal: options.signal,
      headers: {
        ...request.resolved.headers,
        'Content-Type': 'application/json',
        'X-Kicktipp-Notification-Id': ids.notificationId,
        'X-Kicktipp-Delivery-Id': ids.deliveryId,
      },
      body: request.body,
    }, fetchImpl);
    const now = options.clock?.now() ?? options.now ?? new Date();
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      return { state: 'unknown', retryable: false, safeErrorCode: 'malformed_response' };
    }
    if (response.status >= 200 && response.status < 300) {
      return {
        state: 'confirmed',
        retryable: false,
        receipt: { provider: 'webhook', acceptedAt: now.toISOString() },
      };
    }
    if (response.status >= 500) {
      return { state: 'unknown', retryable: false, safeErrorCode: 'provider_5xx' };
    }
    if (response.status === 429 || response.status === 408 || response.status === 425) {
      const retryAfter = retryAfterMilliseconds(response, now);
      return {
        state: 'failed',
        retryable: true,
        safeErrorCode: response.status === 429 ? 'rate_limited' : 'temporary_rejection',
        ...(retryAfter === undefined ? {} : { retryAfterMilliseconds: retryAfter }),
      };
    }
    return {
      state: 'failed',
      retryable: false,
      safeErrorCode: response.status >= 300 && response.status < 400
        ? 'redirect_refused'
        : 'provider_rejected',
    };
  } catch (error) {
    if (retryableTransportFailure(error)) {
      return { state: 'failed', retryable: true, safeErrorCode: 'connection_unavailable' };
    }
    return { state: 'unknown', retryable: false, safeErrorCode: 'transport_ambiguous' };
  }
}

type ProviderRequest =
  | { provider: 'webhook'; value: ReturnType<typeof webhookRequest> }
  | { provider: 'discord'; value: ReturnType<typeof discordRequest> }
  | { provider: 'telegram'; value: ReturnType<typeof telegramRequest> }
  | { provider: 'ntfy'; value: ReturnType<typeof ntfyRequest> };

function buildProviderRequest(
  notification: ReminderNotification,
  target: NotificationTarget,
  options: { env?: NodeJS.ProcessEnv; paths: ServicePaths },
): ProviderRequest {
  switch (target.provider) {
    case 'webhook': return { provider: target.provider, value: webhookRequest(notification, target, options) };
    case 'discord': return { provider: target.provider, value: discordRequest(notification, target, options) };
    case 'telegram': return { provider: target.provider, value: telegramRequest(notification, target, options) };
    case 'ntfy': return { provider: target.provider, value: ntfyRequest(notification, target, options) };
  }
}

function deliverProvider(
  request: ProviderRequest,
  ids: { notificationId: string; deliveryId: string },
  options: { fetchImpl?: FetchLike; now?: Date; clock?: { now(): Date }; signal?: AbortSignal },
): Promise<ProviderDeliveryOutcome> {
  switch (request.provider) {
    case 'webhook': return deliverWebhook(request.value, ids, options);
    case 'discord': return deliverDiscord(request.value, options);
    case 'telegram': return deliverTelegram(request.value, options);
    case 'ntfy': return deliverNtfy(request.value, options);
  }
}

export function recoverOpenAttempts(state: ServiceState, recoveredAt = new Date()): boolean {
  let changed = false;
  for (const attempt of state.attempts) {
    if (attempt.outcome) continue;
    attempt.completedAt = recoveredAt.toISOString();
    attempt.outcome = {
      state: 'unknown',
      retryable: false,
      safeErrorCode: 'interrupted_attempt',
    };
    const delivery = state.deliveries.find(({ id }) => id === attempt.deliveryId);
    if (delivery) {
      delivery.state = 'unknown';
      delivery.safeErrorCode = 'interrupted_attempt';
      delete delivery.nextAttemptAt;
      delete delivery.receipt;
    }
    changed = true;
  }
  return changed;
}

function addStageOutcome(
  state: ServiceState,
  deadlineGroupIdValue: string,
  stageMinutes: number,
  outcome: ServiceState['stageOutcomes'][number]['state'],
): void {
  if (state.stageOutcomes.some((stage) =>
    stage.deadlineGroupId === deadlineGroupIdValue && stage.stageMinutes === stageMinutes)) return;
  state.stageOutcomes.push({ deadlineGroupId: deadlineGroupIdValue, stageMinutes, state: outcome });
}

function currentDeliveryStates(state: ServiceState, notificationIdValue?: string): Delivery['state'][] {
  return notificationIdValue
    ? state.deliveries
      .filter(({ notificationId }) => notificationId === notificationIdValue)
      .map(({ state: deliveryState }) => deliveryState)
    : [];
}

function deterministicDeliveryFailure(
  state: ServiceState,
  delivery: Delivery,
  code: string,
  lock: Parameters<typeof writeServiceState>[1],
  paths: ServicePaths,
): void {
  delivery.state = 'failed';
  delivery.safeErrorCode = code;
  writeServiceState(state, lock, paths);
}

function cancelDelivery(
  state: ServiceState,
  delivery: Delivery,
  code: string,
  lock: Parameters<typeof writeServiceState>[1],
  paths: ServicePaths,
): void {
  delivery.state = 'cancelled';
  delivery.safeErrorCode = code;
  delete delivery.nextAttemptAt;
  delete delivery.receipt;
  writeServiceState(state, lock, paths);
}

function deliveryAttempts(state: ServiceState, delivery: Delivery): ServiceState['attempts'] {
  return state.attempts.filter(({ deliveryId: id }) => id === delivery.id);
}

function retryIsDue(state: ServiceState, delivery: Delivery, now: Date): boolean {
  const attempts = deliveryAttempts(state, delivery);
  return delivery.state === 'pending'
    && attempts.length > 0
    && delivery.nextAttemptAt !== undefined
    && Date.parse(delivery.nextAttemptAt) <= now.getTime();
}

function currentTarget(configuration: ServiceConfiguration, delivery: Delivery): NotificationTarget | undefined {
  const target = configuration.targets.find(({ id }) => id === delivery.targetId);
  return target
    && target.enabled
    && configuration.job.targetIds.includes(target.id)
    && targetRevision(target) === delivery.targetRevision
    ? target
    : undefined;
}

function cancelObsoleteDeliveries(
  state: ServiceState,
  configuration: ServiceConfiguration,
  lock: Parameters<typeof writeServiceState>[1],
  paths: ServicePaths,
): void {
  let changed = false;
  for (const delivery of state.deliveries.filter(({ state: deliveryState }) => deliveryState === 'pending')) {
    const code = !configuration.job.enabled
      ? 'job_disabled'
      : currentTarget(configuration, delivery) ? undefined : 'target_changed';
    if (!code) continue;
    delivery.state = 'cancelled';
    delivery.safeErrorCode = code;
    delete delivery.nextAttemptAt;
    changed = true;
  }
  if (changed) writeServiceState(state, lock, paths);
}

function cancelRetriesPastDeadline(
  state: ServiceState,
  lock: Parameters<typeof writeServiceState>[1],
  paths: ServicePaths,
  now: Date,
): void {
  let changed = false;
  for (const delivery of state.deliveries.filter(({ state: deliveryState }) => deliveryState === 'pending')) {
    if (deliveryAttempts(state, delivery).length === 0) continue;
    const notification = state.notifications.find(({ id }) => id === delivery.notificationId);
    if (!notification) continue;
    const nextAttemptAt = delivery.nextAttemptAt ? Date.parse(delivery.nextAttemptAt) : Number.POSITIVE_INFINITY;
    const deadlineAt = Date.parse(notification.deadlineGroup.deadlineAt);
    if (now.getTime() < deadlineAt && nextAttemptAt < deadlineAt) continue;
    delivery.state = 'cancelled';
    delivery.safeErrorCode = 'retry_deadline_reached';
    delete delivery.nextAttemptAt;
    changed = true;
  }
  if (changed) writeServiceState(state, lock, paths);
}

function cancelDueRetriesWithoutSnapshot(
  state: ServiceState,
  lock: Parameters<typeof writeServiceState>[1],
  paths: ServicePaths,
  now: Date,
): void {
  let changed = false;
  for (const delivery of state.deliveries) {
    if (!deliveryIsUnattempted(state, delivery.id) && !retryIsDue(state, delivery, now)) continue;
    delivery.state = 'cancelled';
    delivery.safeErrorCode = 'retry_validation_failed';
    delete delivery.nextAttemptAt;
    changed = true;
  }
  if (changed) writeServiceState(state, lock, paths);
}

function retrySnapshotMatches(
  notification: ReminderNotification,
  configuration: ServiceConfiguration,
  preview: Extract<ReturnType<typeof evaluateReminderDryRun>, { reliable: true }>['preview'],
  groupId: string | undefined,
  now: Date,
): boolean {
  if (
    !configuration.job.enabled
    || notification.jobId !== configuration.job.id
    || preview.job.profileId !== configuration.job.profileId
    || preview.job.communityId !== configuration.job.communityId
    || !preview.deadlineGroup
    || groupId !== notification.deadlineGroup.id
    || preview.deadlineGroup.deadlineAt !== notification.deadlineGroup.deadlineAt
    || now.getTime() >= Date.parse(notification.deadlineGroup.deadlineAt)
  ) return false;
  const currentMissing = preview.missingParticipants.map(({ id }) => id).sort(compareCodePoints);
  const originalMissing = notification.missingParticipants.map(({ id }) => id).sort(compareCodePoints);
  return currentMissing.length === originalMissing.length
    && currentMissing.every((id, index) => id === originalMissing[index]);
}

function cancelInvalidDueRetries(
  state: ServiceState,
  configuration: ServiceConfiguration,
  preview: Extract<ReturnType<typeof evaluateReminderDryRun>, { reliable: true }>['preview'],
  groupId: string | undefined,
  lock: Parameters<typeof writeServiceState>[1],
  paths: ServicePaths,
  now: Date,
): void {
  let changed = false;
  for (const delivery of state.deliveries) {
    if (!deliveryIsUnattempted(state, delivery.id) && !retryIsDue(state, delivery, now)) continue;
    const notification = state.notifications.find(({ id }) => id === delivery.notificationId);
    if (notification && retrySnapshotMatches(notification, configuration, preview, groupId, now)) continue;
    delivery.state = 'cancelled';
    delivery.safeErrorCode = 'retry_validation_failed';
    delete delivery.nextAttemptAt;
    changed = true;
  }
  if (changed) writeServiceState(state, lock, paths);
}

function supersedeOlderDeliveries(
  state: ServiceState,
  notification: ReminderNotification,
  lock: Parameters<typeof writeServiceState>[1],
  paths: ServicePaths,
): void {
  const targetIds = new Set(state.deliveries
    .filter(({ notificationId }) => notificationId === notification.id)
    .map(({ targetId }) => targetId));
  const olderNotificationIds = new Set(state.notifications
    .filter((candidate) =>
      candidate.id !== notification.id
      && candidate.deadlineGroup.id === notification.deadlineGroup.id
      && Number(candidate.stage) > Number(notification.stage))
    .map(({ id }) => id));
  let changed = false;
  for (const delivery of state.deliveries) {
    if (
      delivery.state !== 'pending'
      || !olderNotificationIds.has(delivery.notificationId)
      || !targetIds.has(delivery.targetId)
    ) continue;
    delivery.state = 'cancelled';
    delivery.safeErrorCode = 'superseded_by_later_stage';
    delete delivery.nextAttemptAt;
    changed = true;
  }
  if (changed) writeServiceState(state, lock, paths);
}

async function deliverPending(
  state: ServiceState,
  notification: ReminderNotification,
  lock: Parameters<typeof writeServiceState>[1],
  options: {
    paths: ServicePaths;
    env?: NodeJS.ProcessEnv;
    providerFetchImpl?: FetchLike;
    clock: { now(): Date };
    preview: Extract<ReturnType<typeof evaluateReminderDryRun>, { reliable: true }>['preview'];
    groupId?: string;
    stopSignal?: AbortSignal;
    providerAbortSignal?: AbortSignal;
    afterAttemptStarted?: (delivery: Delivery) => void | Promise<void>;
  },
): Promise<void> {
  const candidates = state.deliveries.filter((candidate) =>
    candidate.notificationId === notification.id
    && (deliveryIsUnattempted(state, candidate.id) || retryIsDue(state, candidate, options.clock.now())));
  const deliverOne = async (delivery: Delivery): Promise<void> => {
    if (options.stopSignal?.aborted) return;
    if (delivery.state !== 'pending') return;
    // Only gate NEW attempts: other workers may already have provider I/O in flight.
    const latestConfiguration = readServiceConfiguration(options.paths);
    if (!latestConfiguration.job.enabled) {
      cancelDelivery(state, delivery, 'job_disabled', lock, options.paths);
      return;
    }
    const priorAttempts = deliveryAttempts(state, delivery);
    const retry = priorAttempts.length > 0;
    const target = currentTarget(latestConfiguration, delivery);
    if (!target) {
      cancelDelivery(state, delivery, 'target_changed', lock, options.paths);
      return;
    }
    const now = options.clock.now();
    if (!retrySnapshotMatches(notification, latestConfiguration, options.preview, options.groupId, now)) {
      cancelDelivery(state, delivery, 'retry_validation_failed', lock, options.paths);
      return;
    }
    if (retry && priorAttempts.length >= 3) {
      deterministicDeliveryFailure(state, delivery, 'retry_budget_exhausted', lock, options.paths);
      return;
    }
    let request: ProviderRequest;
    try {
      request = buildProviderRequest(notification, target, { env: options.env, paths: options.paths });
    } catch (error) {
      if (
        error instanceof SecretResolutionError
        || error instanceof InvalidWebhookTargetError
        || error instanceof InvalidTelegramTargetError
        || error instanceof InvalidNtfyTargetError
        || error instanceof DiscordPayloadTooLargeError
        || error instanceof TelegramPayloadTooLargeError
        || error instanceof NtfyPayloadTooLargeError
      ) {
        deterministicDeliveryFailure(
          state,
          delivery,
          error instanceof DiscordPayloadTooLargeError
            || error instanceof TelegramPayloadTooLargeError
            || error instanceof NtfyPayloadTooLargeError
            ? 'payload_too_large'
            : 'invalid_target',
          lock,
          options.paths,
        );
        return;
      }
      throw error;
    }

    const attempt: ServiceState['attempts'][number] = {
      id: crypto.randomUUID(),
      deliveryId: delivery.id,
      startedAt: now.toISOString(),
    };
    state.attempts.push(attempt);
    writeServiceState(state, lock, options.paths);
    if (options.afterAttemptStarted) await options.afterAttemptStarted(delivery);

    // A write-ahead marker is not proof that HTTP dispatch has begun.
    const dispatchConfiguration = readServiceConfiguration(options.paths);
    const dispatchTime = options.clock.now();
    const cancellation = !dispatchConfiguration.job.enabled
      ? 'job_disabled'
      : !currentTarget(dispatchConfiguration, delivery)
        ? 'target_changed'
        : !retrySnapshotMatches(notification, dispatchConfiguration, options.preview, options.groupId, dispatchTime)
          ? 'retry_validation_failed'
          : undefined;
    if (cancellation) {
      attempt.completedAt = dispatchTime.toISOString();
      attempt.outcome = { state: 'failed', retryable: false, safeErrorCode: cancellation };
      cancelDelivery(state, delivery, cancellation, lock, options.paths);
      return;
    }

    let responseReceivedAt: Date | undefined;
    const providerFetch = options.providerFetchImpl ?? ((input, init) => fetch(input, init));
    const adapterOutcome = await deliverProvider(request, {
      notificationId: notification.id,
      deliveryId: delivery.id,
    }, {
      fetchImpl: async (input, init) => {
        const response = await providerFetch(input, init);
        responseReceivedAt = options.clock.now();
        return response;
      },
      clock: options.clock,
      signal: options.providerAbortSignal,
    });
    const { retryAfterMilliseconds: retryAfter, ...outcome } = adapterOutcome;
    const completedAt = options.clock.now();
    attempt.completedAt = completedAt.toISOString();
    attempt.outcome = outcome;
    delivery.safeErrorCode = outcome.safeErrorCode;
    delete delivery.nextAttemptAt;
    delete delivery.receipt;
    if (outcome.state === 'confirmed') {
      delivery.state = 'confirmed';
      delivery.receipt = outcome.receipt;
    } else if (outcome.state === 'unknown') {
      delivery.state = 'unknown';
    } else if (outcome.retryable) {
      const attemptNumber = priorAttempts.length + 1;
      if (attemptNumber >= 3) {
        delivery.state = 'failed';
      } else {
        const retryOrigin = retryAfter === undefined ? completedAt : responseReceivedAt ?? completedAt;
        const nextAttemptAt = retryOrigin.getTime() + (retryAfter ?? RETRY_DELAYS[attemptNumber - 1]);
        if (nextAttemptAt >= Date.parse(notification.deadlineGroup.deadlineAt)) {
          delivery.state = 'cancelled';
          delivery.safeErrorCode = 'retry_deadline_reached';
        } else {
          delivery.state = 'pending';
          delivery.nextAttemptAt = new Date(nextAttemptAt).toISOString();
        }
      }
    } else {
      delivery.state = 'failed';
    }
    writeServiceState(state, lock, options.paths);
  };

  const errors: unknown[] = [];
  for (let index = 0; index < candidates.length; index += MAX_PROVIDER_CONCURRENCY) {
    if (options.stopSignal?.aborted) break;
    const settled = await Promise.allSettled(
      candidates.slice(index, index + MAX_PROVIDER_CONCURRENCY).map(deliverOne),
    );
    for (const result of settled) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
  }
  if (errors.length > 0) throw errors[0];
}

function deliveryIsUnattempted(state: ServiceState, deliveryIdValue: string): boolean {
  const delivery = state.deliveries.find(({ id }) => id === deliveryIdValue);
  return delivery?.state === 'pending'
    && !state.attempts.some(({ deliveryId: id }) => id === deliveryIdValue);
}

export async function runReminderOnce(options: {
  paths?: ServicePaths;
  now?: Date;
  clock?: { now(): Date };
  site?: string;
  env?: NodeJS.ProcessEnv;
  kicktippFetchImpl?: FetchLike;
  providerFetchImpl?: FetchLike;
  getReminderCapability?: (
    profileId: string,
    communityId: string,
    signal?: AbortSignal,
  ) => Promise<ReminderCapability>;
  afterAttemptStarted?: (delivery: Delivery) => void | Promise<void>;
  lock?: FileLock;
  stopSignal?: AbortSignal;
  providerAbortSignal?: AbortSignal;
  observeSchedule?: (observation: ReminderScheduleObservation) => void;
} = {}): Promise<ReminderRunResult> {
  const paths = options.paths ?? servicePaths();
  const ownsLock = options.lock === undefined;
  const lock = options.lock ?? acquireServiceLock(paths);
  try {
    const configuration = readServiceConfiguration(paths);
    const state = readServiceState(configuration, paths);
    // A fixed `now` remains supported for deterministic one-shot callers.
    const clock = options.clock ?? { now: () => options.now ?? new Date() };
    let now = clock.now();
    if (recoverOpenAttempts(state, now)) writeServiceState(state, lock, paths);
    cancelObsoleteDeliveries(state, configuration, lock, paths);
    cancelRetriesPastDeadline(state, lock, paths, now);
    if (!configuration.job.enabled) {
      return { reliable: true, outcome: 'disabled', deliveryStates: [] };
    }
    if (options.stopSignal?.aborted) {
      return { reliable: true, outcome: 'interrupted', deliveryStates: [] };
    }
    const capability = options.getReminderCapability
      ? await options.getReminderCapability(
        configuration.job.profileId,
        configuration.job.communityId,
        options.providerAbortSignal,
      )
      : await createScopedClient({
        profileId: configuration.job.profileId,
        communityId: configuration.job.communityId,
        fetchImpl: options.kicktippFetchImpl,
      }).getReminderSnapshot();
    now = clock.now();
    const evaluation = evaluateReminderDryRun(configuration, capability, now);
    if (!evaluation.reliable) {
      cancelDueRetriesWithoutSnapshot(state, lock, paths, now);
      return { reliable: false, reason: evaluation.reason };
    }
    const preview = evaluation.preview;
    const site = options.site ?? urlBase();
    const currentGroupId = preview.deadlineGroup
      ? deadlineGroupId({
        site: siteLabel(site),
        communityId: configuration.job.communityId,
        gameIds: preview.deadlineGroup.gameIds,
      })
      : undefined;
    const observeSchedule = (): void => {
      if (!preview.deadlineGroup || !currentGroupId) {
        options.observeSchedule?.({});
        return;
      }
      const futureStages = configuration.job.policy.stages
        .filter((stage) => !state.stageOutcomes.some((outcome) =>
          outcome.deadlineGroupId === currentGroupId
          && outcome.stageMinutes === stage.beforeDeadlineMinutes))
        .map((stage) => Date.parse(preview.deadlineGroup!.deadlineAt) - stage.beforeDeadlineMinutes * 60_000)
        .filter((instant) => instant > now.getTime());
      options.observeSchedule?.({
        deadlineGroupId: currentGroupId,
        nextDeadlineAt: preview.deadlineGroup.deadlineAt,
        ...(futureStages.length > 0
          ? { nextStageAt: new Date(Math.min(...futureStages)).toISOString() }
          : {}),
      });
    };
    cancelInvalidDueRetries(state, configuration, preview, currentGroupId, lock, paths, now);
    if (!preview.deadlineGroup || !preview.stage) {
      observeSchedule();
      const outcome = preview.outcome === 'would-notify' ? 'not-due' : preview.outcome;
      return { reliable: true, outcome, deliveryStates: [] };
    }

    const groupId = currentGroupId!;
    const stageMinutes = preview.stage.beforeDeadlineMinutes;
    const existingStage = state.stageOutcomes.find((stage) =>
      stage.deadlineGroupId === groupId && stage.stageMinutes === stageMinutes);
    const existingNotificationId = notificationId({
      jobId: configuration.job.id,
      deadlineGroupId: groupId,
      stageMinutes,
    });
    const stageOutcomeCount = state.stageOutcomes.length;
    for (const skipped of preview.skippedStages) {
      addStageOutcome(state, groupId, skipped.beforeDeadlineMinutes, 'skipped');
    }

    if (existingStage) {
      if (state.stageOutcomes.length !== stageOutcomeCount) writeServiceState(state, lock, paths);
      const notification = state.notifications.find(({ id }) => id === existingNotificationId);
      if (existingStage.state === 'notified' && notification) {
        supersedeOlderDeliveries(state, notification, lock, paths);
        await deliverPending(state, notification, lock, {
          paths,
          env: options.env,
          providerFetchImpl: options.providerFetchImpl,
          clock,
          preview,
          groupId,
          stopSignal: options.stopSignal,
          providerAbortSignal: options.providerAbortSignal,
          afterAttemptStarted: options.afterAttemptStarted,
        });
      }
      observeSchedule();
      return {
        reliable: true,
        outcome: 'already-processed',
        deliveryStates: currentDeliveryStates(state, existingNotificationId),
      };
    }

    if (preview.outcome === 'satisfied') {
      addStageOutcome(state, groupId, stageMinutes, 'satisfied');
      writeServiceState(state, lock, paths);
      observeSchedule();
      return { reliable: true, outcome: 'satisfied', deliveryStates: [] };
    }

    const notification = createNotification(
      configuration,
      preview,
      groupId,
      site,
      now.toISOString(),
    );
    state.notifications.push(notification);
    for (const target of configuration.targets.filter((candidate) =>
      candidate.enabled && configuration.job.targetIds.includes(candidate.id))) {
      const revision = targetRevision(target);
      state.deliveries.push({
        id: deliveryId({
          notificationId: notification.id,
          targetId: target.id,
          targetRevision: revision,
        }),
        notificationId: notification.id,
        targetId: target.id,
        targetRevision: revision,
        state: 'pending',
      });
    }
    addStageOutcome(state, groupId, stageMinutes, 'notified');
    writeServiceState(state, lock, paths);
    supersedeOlderDeliveries(state, notification, lock, paths);

    await deliverPending(state, notification, lock, {
      paths,
      env: options.env,
      providerFetchImpl: options.providerFetchImpl,
      clock,
      preview,
      groupId,
      stopSignal: options.stopSignal,
      providerAbortSignal: options.providerAbortSignal,
      afterAttemptStarted: options.afterAttemptStarted,
    });
    observeSchedule();
    return {
      reliable: true,
      outcome: 'notified',
      deliveryStates: currentDeliveryStates(state, notification.id),
    };
  } finally {
    if (ownsLock) lock.release();
  }
}

export async function testNotificationTarget(
  targetIdValue: string,
  options: {
    paths?: ServicePaths;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchLike;
    now?: Date;
  } = {},
): Promise<ProviderDeliveryOutcome> {
  const paths = options.paths ?? servicePaths();
  const configuration = readServiceConfiguration(paths);
  const target: NotificationTarget | undefined = configuration.targets.find(({ id }) => id === targetIdValue);
  if (!target) throw new Error('The Notification Target does not exist.');
  const now = options.now ?? new Date();
  const notificationDiagnosticId = crypto.randomUUID();
  const deliveryDiagnosticId = crypto.randomUUID();
  const notification: ReminderNotification = {
    id: notificationDiagnosticId,
    jobId: configuration.job.id,
    createdAt: now.toISOString(),
    language: configuration.job.language,
    displayTimezone: configuration.job.displayTimezone,
    content: {
      schemaVersion: 1 as const,
      type: 'reminder' as const,
      severity: 'info' as const,
      title: 'Kicktipp Notification Target test',
      message: 'This is a one-time diagnostic test message.',
    },
    deadlineGroup: {
      id: deadlineGroupId({
        site: 'diagnostic',
        communityId: configuration.job.communityId,
        gameIds: ['diagnostic-test'],
      }),
      deadlineAt: now.toISOString(),
      gameIds: ['diagnostic-test'],
    },
    stage: 'diagnostic-test',
    missingParticipants: [{ id: 'diagnostic-test', displayName: 'Diagnostic test' }],
  };
  return deliverProvider(buildProviderRequest(notification, target, { env: options.env, paths }), {
    notificationId: notificationDiagnosticId,
    deliveryId: deliveryDiagnosticId,
  }, { fetchImpl: options.fetchImpl, now });
}
