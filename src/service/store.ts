import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { FileLock, observeLock, syncDirectory, type LockObservation } from './lock.js';
import { servicePaths, type ServicePaths } from './paths.js';

const id = z.string().trim().min(1);
const targetId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const secretReferenceSchema = z.string()
  .regex(/^(env|file|local):[^\r\n\0]+$/)
  .superRefine((reference, context) => {
    const separator = reference.indexOf(':');
    const source = reference.slice(0, separator);
    const identifier = reference.slice(separator + 1);
    const valid = source === 'env'
      ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)
      : source === 'file'
        ? path.isAbsolute(identifier)
        : /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identifier);
    if (!valid) context.addIssue({ code: 'custom', message: 'Invalid Secret Reference' });
  });
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
export const ntfyServerUrlSchema = z.url().superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid ntfy server URL' });
    return;
  }
  if (
    /[\u0000-\u0020\u007f]/u.test(value)
    || url.username
    || url.password
    || url.hash
    || url.search
    || url.pathname !== '/'
    || !['http:', 'https:'].includes(url.protocol)
  ) context.addIssue({ code: 'custom', message: 'Invalid ntfy server URL' });
});
export const ntfyTopicSchema = z.string().regex(/^[-_A-Za-z0-9]{1,64}$/);
const reservedWebhookHeaders = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'content-type',
  'user-agent',
  'x-kicktipp-notification-id',
  'x-kicktipp-delivery-id',
]);

const targetBase = {
  id: targetId,
  name: z.string().trim().min(1).optional(),
  enabled: z.boolean(),
};

export const notificationTargetSchema = z.discriminatedUnion('provider', [
  z.object({
    ...targetBase,
    provider: z.literal('discord'),
    webhookUrlRef: secretReferenceSchema,
  }).strict(),
  z.object({
    ...targetBase,
    provider: z.literal('telegram'),
    botTokenRef: secretReferenceSchema,
    chatId: id,
    topicId: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    ...targetBase,
    provider: z.literal('ntfy'),
    serverUrl: ntfyServerUrlSchema,
    topic: ntfyTopicSchema,
    tokenRef: secretReferenceSchema.optional(),
    allowInsecureHttp: z.boolean().optional(),
  }).strict().superRefine((target, context) => {
    if (/^http:/iu.test(target.serverUrl) && !target.allowInsecureHttp) {
      context.addIssue({ code: 'custom', path: ['serverUrl'], message: 'Plain HTTP requires explicit opt-in' });
    }
  }),
  z.object({
    ...targetBase,
    provider: z.literal('webhook'),
    urlRef: secretReferenceSchema,
    headers: z.record(headerName, secretReferenceSchema).optional(),
    allowInsecureHttp: z.boolean().optional(),
  }).strict().superRefine((target, context) => {
    const names = new Set<string>();
    for (const name of Object.keys(target.headers ?? {})) {
      const canonical = name.toLowerCase();
      if (reservedWebhookHeaders.has(canonical)) {
        context.addIssue({ code: 'custom', path: ['headers', name], message: 'Reserved Webhook header' });
      }
      if (names.has(canonical)) {
        context.addIssue({ code: 'custom', path: ['headers', name], message: 'Duplicate Webhook header' });
      }
      names.add(canonical);
    }
  }),
]);

const stageSchema = z.object({
  beforeDeadlineMinutes: z.number().int().positive(),
  severity: z.enum(['info', 'warning', 'urgent']),
}).strict();

const jobSchema = z.object({
  id: z.uuid(),
  name: id,
  enabled: z.boolean(),
  profileId: id,
  communityId: id,
  language: id.refine((value) => {
    try {
      new Intl.DateTimeFormat(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid language locale'),
  displayTimezone: id.refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid display timezone'),
  policy: z.object({
    matchSelection: z.literal('next-deadline-group').optional(),
    completion: z.literal('all-games-in-group').optional(),
    excludeParticipantIds: z.array(id),
    stages: z.array(stageSchema).min(1),
  }).strict(),
  targetIds: z.array(id),
}).strict();

export const serviceConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  job: jobSchema,
  targets: z.array(notificationTargetSchema),
}).strict().superRefine((configuration, context) => {
  const targetIds = new Set<string>();
  for (const [index, target] of configuration.targets.entries()) {
    if (targetIds.has(target.id)) {
      context.addIssue({ code: 'custom', path: ['targets', index, 'id'], message: 'Duplicate Target ID' });
    }
    targetIds.add(target.id);
  }
  const referencedIds = new Set<string>();
  for (const [index, targetId] of configuration.job.targetIds.entries()) {
    if (referencedIds.has(targetId)) {
      context.addIssue({ code: 'custom', path: ['job', 'targetIds', index], message: 'Duplicate Target reference' });
    }
    referencedIds.add(targetId);
    if (!targetIds.has(targetId)) {
      context.addIssue({ code: 'custom', path: ['job', 'targetIds', index], message: 'Unknown Target reference' });
    }
  }
  const stageMinutes = new Set<number>();
  for (const [index, stage] of configuration.job.policy.stages.entries()) {
    if (stageMinutes.has(stage.beforeDeadlineMinutes)) {
      context.addIssue({ code: 'custom', path: ['job', 'policy', 'stages', index], message: 'Duplicate Stage' });
    }
    stageMinutes.add(stage.beforeDeadlineMinutes);
  }
  const activeTargets = configuration.targets.filter(
    (target) => target.enabled && referencedIds.has(target.id),
  );
  if (configuration.job.enabled && activeTargets.length === 0) {
    context.addIssue({ code: 'custom', path: ['job', 'targetIds'], message: 'An enabled Job requires an active Target' });
  }
});

const notificationContentSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal('reminder'),
  severity: z.enum(['info', 'warning', 'urgent']),
  title: z.string(),
  message: z.string(),
  actionUrl: z.url().optional(),
}).strict();

const reminderNotificationSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  jobId: z.uuid(),
  createdAt: z.iso.datetime(),
  language: id,
  displayTimezone: id,
  content: notificationContentSchema,
  deadlineGroup: z.object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    deadlineAt: z.iso.datetime(),
    gameIds: z.array(id).min(1),
  }).strict(),
  stage: id,
  missingParticipants: z.array(z.object({
    id,
    displayName: id,
  }).strict()).min(1),
}).strict();

const deliveryReceiptSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('discord'),
    messageId: id,
    acceptedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    provider: z.literal('telegram'),
    messageId: id,
    acceptedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    provider: z.literal('ntfy'),
    messageId: id,
    acceptedAt: z.iso.datetime(),
  }).strict(),
  z.object({
    provider: z.literal('webhook'),
    messageId: id.optional(),
    acceptedAt: z.iso.datetime(),
  }).strict(),
]);

const deliverySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  notificationId: z.string().regex(/^[a-f0-9]{64}$/),
  targetId,
  targetRevision: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['pending', 'confirmed', 'unknown', 'failed', 'cancelled']),
  nextAttemptAt: z.iso.datetime().optional(),
  safeErrorCode: id.optional(),
  receipt: deliveryReceiptSchema.optional(),
}).strict();

const deliveryAttemptSchema = z.object({
  id: z.uuid(),
  deliveryId: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  outcome: z.object({
    state: z.enum(['confirmed', 'failed', 'unknown']),
    retryable: z.boolean(),
    safeErrorCode: id.optional(),
    receipt: deliveryReceiptSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((attempt, context) => {
  if ((attempt.completedAt === undefined) !== (attempt.outcome === undefined)) {
    context.addIssue({ code: 'custom', message: 'Attempt completion and outcome must be stored together' });
  }
});

const reminderStageOutcomeSchema = z.object({
  deadlineGroupId: z.string().regex(/^[a-f0-9]{64}$/),
  stageMinutes: z.number().int().positive(),
  state: z.enum(['notified', 'skipped', 'satisfied']),
}).strict();

const serviceSchedulerSchema = z.object({
  lastScheduleFetchAt: z.iso.datetime().optional(),
  lastReliableCheckAt: z.iso.datetime().optional(),
  lastFailedCheckAt: z.iso.datetime().optional(),
  reminderCapabilityAvailable: z.boolean().optional(),
  sessionCondition: z.enum(['authenticated', 'unavailable', 'unknown']).optional(),
  deadlineGroupId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  nextDeadlineAt: z.iso.datetime().optional(),
  nextStageAt: z.iso.datetime().optional(),
  kicktippNetworkFailures: z.number().int().nonnegative().default(0),
  kicktippBackoffUntil: z.iso.datetime().optional(),
  safeErrorCode: id.optional(),
}).strict();

export const serviceStateSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
  initializedAt: z.iso.datetime(),
  stageOutcomes: z.array(reminderStageOutcomeSchema).default([]),
  notifications: z.array(reminderNotificationSchema).default([]),
  deliveries: z.array(deliverySchema).default([]),
  attempts: z.array(deliveryAttemptSchema).default([]),
  scheduler: serviceSchedulerSchema.default({ kicktippNetworkFailures: 0 }),
}).strict().superRefine((state, context) => {
  for (const [pathName, values] of [
    ['notification', state.notifications.map(({ id }) => id)],
    ['delivery', state.deliveries.map(({ id }) => id)],
    ['attempt', state.attempts.map(({ id }) => id)],
    ['stage', state.stageOutcomes.map(({ deadlineGroupId, stageMinutes }) => `${deadlineGroupId}:${stageMinutes}`)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: `Duplicate ${pathName} identity` });
    }
  }
  const notificationIds = new Set(state.notifications.map(({ id }) => id));
  const deliveryIds = new Set(state.deliveries.map(({ id }) => id));
  if (state.deliveries.some(({ notificationId }) => !notificationIds.has(notificationId))) {
    context.addIssue({ code: 'custom', message: 'Delivery references an unknown Notification' });
  }
  if (state.attempts.some(({ deliveryId }) => !deliveryIds.has(deliveryId))) {
    context.addIssue({ code: 'custom', message: 'Attempt references an unknown Delivery' });
  }
});

export type ServiceConfiguration = z.infer<typeof serviceConfigurationSchema>;
export type ServiceState = z.infer<typeof serviceStateSchema>;
export type NotificationTarget = ServiceConfiguration['targets'][number];

export class MissingServiceFileError extends Error {
  constructor(readonly kind: 'configuration' | 'state') {
    super(`Service ${kind} is missing.`);
    this.name = 'MissingServiceFileError';
  }
}

export class InvalidServiceFileError extends Error {
  constructor(readonly kind: 'configuration' | 'state') {
    super(`Service ${kind} is invalid or incompatible.`);
    this.name = 'InvalidServiceFileError';
  }
}

export class ServiceIdentityMismatchError extends Error {
  constructor() {
    super('Service State belongs to a different Reminder Job.');
    this.name = 'ServiceIdentityMismatchError';
  }
}

export class ServiceAlreadyInitializedError extends Error {
  constructor(readonly kind: 'configuration' | 'state') {
    super(`Service ${kind} already exists; refusing to overwrite it.`);
    this.name = 'ServiceAlreadyInitializedError';
  }
}

export class StateInitializationAcknowledgementError extends Error {
  constructor() {
    super('State initialization requires acknowledgement of possible duplicate reminders.');
    this.name = 'StateInitializationAcknowledgementError';
  }
}

export class ConfigurationConflictError extends Error {
  constructor() {
    super('Service configuration changed concurrently; no update was written.');
    this.name = 'ConfigurationConflictError';
  }
}

export class InvalidServiceStateTransitionError extends Error {
  constructor() {
    super('Service State transition would change immutable delivery history.');
    this.name = 'InvalidServiceStateTransitionError';
  }
}

function parseFile<T>(file: string, schema: z.ZodType<T>, kind: 'configuration' | 'state'): T {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MissingServiceFileError(kind);
    throw error;
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new InvalidServiceFileError(kind);
  }
}

function assertOwnerOnly(file: string, kind: 'configuration' | 'state'): void {
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) {
    throw new InvalidServiceFileError(kind);
  }
}

export function readServiceConfiguration(paths: ServicePaths = servicePaths()): ServiceConfiguration {
  try {
    return parseFile(paths.configFile, serviceConfigurationSchema, 'configuration');
  } catch (error) {
    if (error instanceof MissingServiceFileError || error instanceof InvalidServiceFileError) throw error;
    throw new InvalidServiceFileError('configuration');
  }
}

export function readServiceState(
  configuration: ServiceConfiguration,
  paths: ServicePaths = servicePaths(),
): ServiceState {
  try {
    const result = parseFile(paths.stateFile, serviceStateSchema, 'state');
    assertOwnerOnly(paths.stateFile, 'state');
    if (result.jobId !== configuration.job.id) throw new ServiceIdentityMismatchError();
    return result;
  } catch (error) {
    if (
      error instanceof MissingServiceFileError
      || error instanceof InvalidServiceFileError
      || error instanceof ServiceIdentityMismatchError
    ) throw error;
    throw new InvalidServiceFileError('state');
  }
}

export function durableReplace(file: string, contents: string): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function durableJson(
  file: string,
  value: unknown,
  replace: boolean,
  kind: 'configuration' | 'state',
): void {
  if (replace) {
    durableReplace(file, `${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ServiceAlreadyInitializedError(kind);
      }
      throw error;
    }
    fs.unlinkSync(temporary);
    fs.chmodSync(file, 0o600);
    syncDirectory(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function initialState(configuration: ServiceConfiguration): ServiceState {
  return {
    schemaVersion: 1,
    jobId: configuration.job.id,
    initializedAt: new Date().toISOString(),
    stageOutcomes: [],
    notifications: [],
    deliveries: [],
    attempts: [],
    scheduler: { kicktippNetworkFailures: 0 },
  };
}

export function setupService(
  input: ServiceConfiguration,
  paths: ServicePaths = servicePaths(),
): ServiceState {
  const configuration = serviceConfigurationSchema.parse(input);
  const configurationLock = FileLock.acquire(paths.configurationLockFile);
  let serviceLock: FileLock | undefined;
  try {
    serviceLock = FileLock.acquire(paths.serviceLockFile);
    if (fs.existsSync(paths.configFile)) throw new ServiceAlreadyInitializedError('configuration');
    if (fs.existsSync(paths.stateFile)) throw new ServiceAlreadyInitializedError('state');
    durableJson(paths.configFile, configuration, false, 'configuration');
    const state = initialState(configuration);
    durableJson(paths.stateFile, state, false, 'state');
    return state;
  } finally {
    try {
      serviceLock?.release();
    } finally {
      configurationLock.release();
    }
  }
}

export function initializeServiceState(
  acknowledgePossibleDuplicates: boolean,
  paths: ServicePaths = servicePaths(),
): ServiceState {
  if (!acknowledgePossibleDuplicates) throw new StateInitializationAcknowledgementError();
  const serviceLock = FileLock.acquire(paths.serviceLockFile);
  try {
    const configuration = readServiceConfiguration(paths);
    const state = initialState(configuration);
    durableJson(paths.stateFile, state, false, 'state');
    return state;
  } finally {
    serviceLock.release();
  }
}

export function acquireServiceLock(paths: ServicePaths = servicePaths()): FileLock {
  return FileLock.acquire(paths.serviceLockFile);
}

export function writeServiceState(
  input: ServiceState,
  lock: FileLock,
  paths: ServicePaths = servicePaths(),
): void {
  lock.assertHeld();
  if (lock.file !== paths.serviceLockFile) throw new Error('The supplied lock does not own Service State.');
  const configuration = readServiceConfiguration(paths);
  const current = readServiceState(configuration, paths);
  const state = serviceStateSchema.parse(input);
  if (state.jobId !== configuration.job.id || state.jobId !== current.jobId) {
    throw new ServiceIdentityMismatchError();
  }
  assertStateTransition(current, state);
  durableJson(paths.stateFile, state, true, 'state');
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertStateTransition(current: ServiceState, next: ServiceState): void {
  if (current.initializedAt !== next.initializedAt) throw new InvalidServiceStateTransitionError();

  for (const notification of current.notifications) {
    if (!sameValue(notification, next.notifications.find(({ id }) => id === notification.id))) {
      throw new InvalidServiceStateTransitionError();
    }
  }
  for (const stage of current.stageOutcomes) {
    const persisted = next.stageOutcomes.find((candidate) =>
      candidate.deadlineGroupId === stage.deadlineGroupId
      && candidate.stageMinutes === stage.stageMinutes);
    if (!sameValue(stage, persisted)) throw new InvalidServiceStateTransitionError();
  }
  for (const delivery of current.deliveries) {
    const persisted = next.deliveries.find(({ id }) => id === delivery.id);
    if (
      !persisted
      || persisted.notificationId !== delivery.notificationId
      || persisted.targetId !== delivery.targetId
      || persisted.targetRevision !== delivery.targetRevision
      || (delivery.state !== 'pending' && !sameValue(delivery, persisted))
    ) {
      throw new InvalidServiceStateTransitionError();
    }
  }
  for (const attempt of current.attempts) {
    const persisted = next.attempts.find(({ id }) => id === attempt.id);
    if (
      !persisted
      || persisted.deliveryId !== attempt.deliveryId
      || persisted.startedAt !== attempt.startedAt
      || (attempt.outcome && !sameValue(attempt, persisted))
    ) {
      throw new InvalidServiceStateTransitionError();
    }
  }
}

export function fileRevision(file: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readConfigurationSnapshot(paths: ServicePaths): {
  configuration: ServiceConfiguration;
  revision: string;
} {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(paths.configFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MissingServiceFileError('configuration');
    }
    throw error;
  }
  try {
    return {
      configuration: serviceConfigurationSchema.parse(JSON.parse(bytes.toString('utf8'))),
      revision: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    throw new InvalidServiceFileError('configuration');
  }
}

export function mutateServiceConfiguration(
  mutate: (configuration: ServiceConfiguration) => ServiceConfiguration,
  paths: ServicePaths = servicePaths(),
): ServiceConfiguration {
  const lock = FileLock.acquire(paths.configurationLockFile);
  try {
    const { configuration, revision } = readConfigurationSnapshot(paths);
    const next = serviceConfigurationSchema.parse(mutate(structuredClone(configuration)));

    if (fs.existsSync(paths.stateFile)) {
      const state = readServiceState(configuration, paths);
      if (next.job.id !== state.jobId) throw new ServiceIdentityMismatchError();
    }
    if (fileRevision(paths.configFile) !== revision) throw new ConfigurationConflictError();
    durableJson(paths.configFile, next, true, 'configuration');
    return next;
  } finally {
    lock.release();
  }
}

export interface LocalServiceBasis {
  configuration: ServiceConfiguration;
  state: ServiceState;
  locks: {
    service: LockObservation;
    configuration: LockObservation;
  };
}

export function readLocalServiceBasis(paths: ServicePaths = servicePaths()): LocalServiceBasis {
  const configuration = readServiceConfiguration(paths);
  return {
    configuration,
    state: readServiceState(configuration, paths),
    locks: {
      service: observeLock(paths.serviceLockFile),
      configuration: observeLock(paths.configurationLockFile),
    },
  };
}
