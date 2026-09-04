import fs from 'fs';
import type { FetchLike } from '../browser.js';
import { createScopedClient } from '../client.js';
import { AuthError } from '../core.js';
import { MissingProfileCredentialsError, SessionOnlyExpiredError } from '../config.js';
import type { ReminderCapability, ReminderCapabilityReason, ReminderSnapshot } from '../reminder-capability.js';
import { observeLock, type LockObservation } from './lock.js';
import { readProviderResponse, requestProvider } from './provider-http.js';
import { servicePaths, type ServicePaths } from './paths.js';
import { validateDiscordWebhookUrl } from './discord.js';
import { InvalidNtfyTargetError, validateNtfyServerUrl, validateNtfyToken, validateNtfyTopic } from './ntfy.js';
import { InvalidTelegramTargetError, validateTelegramBotToken } from './telegram.js';
import {
  MissingServiceFileError,
  ServiceIdentityMismatchError,
  readServiceConfiguration,
  readServiceState,
  serviceConfigurationSchema,
  type NotificationTarget,
  type ServiceConfiguration,
} from './store.js';
import {
  InvalidWebhookTargetError,
  SecretResolutionError,
  resolveSecretReference,
  resolveWebhookTarget,
} from './targets.js';

export type DoctorFindingStatus = 'passed' | 'warning' | 'blocking' | 'not-checked' | 'not-verified';

export interface DoctorFinding {
  check: string;
  status: DoctorFindingStatus;
  code: string;
  message: string;
  target?: { id: string; provider: NotificationTarget['provider'] };
}

export interface DoctorReport {
  ready: boolean;
  offline: boolean;
  findings: DoctorFinding[];
  summary: Record<DoctorFindingStatus, number>;
}

export interface DoctorOptions {
  offline?: boolean;
  paths?: ServicePaths;
  env?: NodeJS.ProcessEnv;
  kicktippFetchImpl?: FetchLike;
  providerFetchImpl?: FetchLike;
  getReminderCapability?: (profileId: string, communityId: string) => Promise<ReminderCapability>;
}

function finding(
  findings: DoctorFinding[],
  check: string,
  status: DoctorFindingStatus,
  code: string,
  message: string,
  target?: NotificationTarget,
): void {
  findings.push({
    check,
    status,
    code,
    message,
    ...(target ? { target: { id: target.id, provider: target.provider } } : {}),
  });
}

function inspectLock(findings: DoctorFinding[], name: 'service' | 'configuration', observation: LockObservation): void {
  const check = `${name}-lock`;
  if (observation.status === 'ambiguous') {
    finding(findings, check, 'blocking', `${name}-lock-ambiguous`, `The ${name === 'service' ? 'Service' : 'Service Configuration'} Lock owner is ambiguous.`);
    return;
  }
  if (name === 'configuration' && observation.status === 'held') {
    finding(findings, check, 'blocking', 'configuration-lock-held', 'Service Configuration is being changed, so diagnosis is not reliable.');
    return;
  }
  if (observation.status === 'stale') {
    finding(findings, check, 'warning', `${name}-lock-stale`, `A stale ${name === 'service' ? 'Service' : 'Service Configuration'} Lock will be reclaimed by the next writer.`);
    return;
  }
  finding(findings, check, 'passed', `${name}-lock-valid`, observation.status === 'held' ? 'The Service Lock has a live owner.' : `The ${name === 'service' ? 'Service' : 'Service Configuration'} Lock is clear.`);
}

function ownerOnly(file: string): boolean {
  if (process.platform === 'win32') return true;
  const stat = fs.statSync(file);
  return (stat.mode & 0o077) === 0
    && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}

function checkOwnerOnlyFile(
  findings: DoctorFinding[],
  file: string,
  check: string,
  label: string,
  required: boolean,
): void {
  if (!fs.existsSync(file)) {
    if (required) finding(findings, check, 'blocking', `${check}-missing`, `${label} is missing.`);
    return;
  }
  try {
    if (!ownerOnly(file)) {
      finding(findings, check, 'blocking', `${check}-unsafe`, `${label} is not owner-only.`);
      return;
    }
    finding(findings, check, 'passed', `${check}-valid`, `${label} has owner-only permissions.`);
  } catch {
    finding(findings, check, 'blocking', `${check}-unreadable`, `${label} permissions could not be checked reliably.`);
  }
}

function checkDataDirectory(findings: DoctorFinding[], paths: ServicePaths): void {
  try {
    if (!fs.statSync(paths.dataDir).isDirectory()) throw new Error();
    fs.accessSync(paths.dataDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    finding(findings, 'data-directory', 'passed', 'data-directory-writable', 'The Service data directory is writable.');
  } catch {
    finding(findings, 'data-directory', 'blocking', 'data-directory-not-writable', 'The Service data directory is not reliably writable.');
  }
}

function secretReferences(target: NotificationTarget): string[] {
  switch (target.provider) {
    case 'discord': return [target.webhookUrlRef];
    case 'telegram': return [target.botTokenRef];
    case 'ntfy': return target.tokenRef ? [target.tokenRef] : [];
    case 'webhook': return [target.urlRef, ...Object.values(target.headers ?? {})];
  }
}

function effectiveSecretFile(reference: string, env: NodeJS.ProcessEnv): string | undefined {
  if (reference.startsWith('file:')) return reference.slice('file:'.length);
  if (!reference.startsWith('env:')) return undefined;
  const name = reference.slice('env:'.length);
  return !Object.hasOwn(env, name) && Object.hasOwn(env, `${name}_FILE`)
    ? env[`${name}_FILE`]
    : undefined;
}

function checkMountedSecretPermissions(
  findings: DoctorFinding[],
  target: NotificationTarget,
  env: NodeJS.ProcessEnv,
): void {
  const files = new Set(secretReferences(target).map((reference) => effectiveSecretFile(reference, env)).filter(Boolean));
  for (const file of files) {
    try {
      if (!ownerOnly(file!)) {
        finding(findings, 'secret-file-permissions', 'warning', 'secret-file-permissions-broad', 'A mounted Secret file is readable by users other than its owner.', target);
      } else {
        finding(findings, 'secret-file-permissions', 'passed', 'secret-file-permissions-valid', 'A mounted Secret file has owner-only permissions.', target);
      }
    } catch {
      finding(findings, 'secret-file-permissions', 'blocking', 'secret-file-permissions-unreadable', 'A mounted Secret file could not be inspected reliably.', target);
    }
  }
}

function secretFailure(findings: DoctorFinding[], target: NotificationTarget, error: unknown): void {
  if (error instanceof SecretResolutionError) {
    const details: Record<SecretResolutionError['code'], [string, string]> = {
      invalid_reference: ['secret-reference-invalid', 'A Secret Reference is invalid.'],
      ambiguous_source: ['secret-source-ambiguous', 'A Secret has both direct and file-backed environment sources configured.'],
      unavailable: ['secret-unavailable', 'A required Secret could not be resolved.'],
      empty: ['secret-empty', 'A resolved Secret is empty.'],
      insecure_local_store: ['local-secret-store-permissions', 'The local Secret store is not owner-only.'],
    };
    const [code, message] = details[error.code];
    finding(findings, 'target-local-validation', 'blocking', code, message, target);
    return;
  }
  if (error instanceof InvalidWebhookTargetError) {
    const code = error.code === 'invalid_header_value'
      ? 'webhook-header-value-invalid'
      : error.code === 'insecure_http'
        ? 'insecure-http-not-allowed'
        : 'target-url-invalid';
    const message = error.code === 'invalid_header_value'
      ? 'A resolved Generic Webhook header value contains unsafe control characters.'
      : error.code === 'insecure_http'
        ? 'Plain HTTP was not explicitly allowed for this Notification Target.'
        : 'The resolved Notification Target URL is invalid.';
    finding(findings, 'target-local-validation', 'blocking', code, message, target);
    return;
  }
  if (error instanceof InvalidTelegramTargetError || error instanceof InvalidNtfyTargetError) {
    finding(findings, 'target-local-validation', 'blocking', error.code.includes('token') ? 'target-auth-format-invalid' : 'target-url-or-destination-invalid', 'The resolved provider Auth or destination value is invalid.', target);
    return;
  }
  finding(findings, 'target-local-validation', 'blocking', 'target-invalid', 'The Notification Target failed safe local validation.', target);
}

type ValidatedTarget =
  | { target: Extract<NotificationTarget, { provider: 'discord' }>; url: string }
  | { target: Extract<NotificationTarget, { provider: 'telegram' }>; token: string }
  | { target: Extract<NotificationTarget, { provider: 'ntfy' }> }
  | { target: Extract<NotificationTarget, { provider: 'webhook' }> };

function validateTarget(
  findings: DoctorFinding[],
  target: NotificationTarget,
  paths: ServicePaths,
  env: NodeJS.ProcessEnv,
): ValidatedTarget | undefined {
  try {
    checkMountedSecretPermissions(findings, target, env);
    if (target.provider === 'discord') {
      const url = validateDiscordWebhookUrl(resolveSecretReference(target.webhookUrlRef, { paths, env }));
      finding(findings, 'target-local-validation', 'passed', 'target-valid', 'Discord Webhook URL and Secret resolution are valid.', target);
      return { target, url };
    }
    if (target.provider === 'telegram') {
      const token = validateTelegramBotToken(resolveSecretReference(target.botTokenRef, { paths, env }));
      finding(findings, 'target-local-validation', 'passed', 'target-valid', 'Telegram Bot Token and destination structure are valid.', target);
      return { target, token };
    }
    if (target.provider === 'ntfy') {
      const url = validateNtfyServerUrl(target.serverUrl, target.allowInsecureHttp);
      validateNtfyTopic(target.topic);
      if (target.tokenRef) validateNtfyToken(resolveSecretReference(target.tokenRef, { paths, env }));
      finding(findings, 'target-local-validation', 'passed', 'target-valid', 'ntfy URL, topic, Auth, and Secret resolution are valid.', target);
      if (new URL(url).protocol === 'http:') {
        finding(findings, 'target-transport', 'warning', 'insecure-http-allowed', 'Plain HTTP is explicitly allowed for this Notification Target.', target);
      }
      return { target };
    }
    const resolved = resolveWebhookTarget(target, { paths, env });
    finding(findings, 'target-local-validation', 'passed', 'target-valid', 'Generic Webhook URL, headers, and Secret resolution are valid.', target);
    if (new URL(resolved.url).protocol === 'http:') {
      finding(findings, 'target-transport', 'warning', 'insecure-http-allowed', 'Plain HTTP is explicitly allowed for this Notification Target.', target);
    }
    return { target };
  } catch (error) {
    secretFailure(findings, target, error);
    return undefined;
  }
}

type ProviderProbeResult =
  | 'valid'
  | 'authentication-failed'
  | 'permission-denied'
  | 'invalid-target'
  | 'redirect-refused'
  | 'invalid-response'
  | 'unreliable';

async function jsonResponse(response: Response): Promise<unknown | undefined> {
  const body = await readProviderResponse(response);
  if (!body.ok) return undefined;
  try {
    return JSON.parse(body.text);
  } catch {
    return undefined;
  }
}

function rejectedProbe(response: Response): ProviderProbeResult | undefined {
  if (response.status >= 200 && response.status < 300) return undefined;
  if (response.status >= 300 && response.status < 400) return 'redirect-refused';
  if (response.status === 401) return 'authentication-failed';
  if (response.status === 403) return 'permission-denied';
  if (response.status === 404) return 'invalid-target';
  return 'unreliable';
}

async function checkDiscordMetadata(target: Extract<ValidatedTarget, { target: { provider: 'discord' } }>, fetchImpl?: FetchLike): Promise<ProviderProbeResult> {
  try {
    const response = await requestProvider(target.url, { method: 'GET' }, fetchImpl);
    const rejected = rejectedProbe(response);
    if (rejected) return rejected;
    const value = await jsonResponse(response);
    const expectedId = new URL(target.url).pathname.split('/').filter(Boolean).at(-2);
    return !!value && typeof value === 'object' && 'id' in value && value.id === expectedId
      ? 'valid'
      : 'invalid-response';
  } catch {
    return 'unreliable';
  }
}

async function checkTelegramBot(target: Extract<ValidatedTarget, { target: { provider: 'telegram' } }>, fetchImpl?: FetchLike): Promise<ProviderProbeResult> {
  try {
    const response = await requestProvider(
      `https://api.telegram.org/bot${target.token}/getMe`,
      { method: 'GET' },
      fetchImpl,
    );
    const rejected = rejectedProbe(response);
    if (rejected) return rejected;
    const value = await jsonResponse(response);
    if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true || !('result' in value)) return 'invalid-response';
    const result = value.result;
    return !!result && typeof result === 'object' && 'id' in result
      && Number.isSafeInteger(result.id) && Number(result.id) > 0
      && 'is_bot' in result && result.is_bot === true
      ? 'valid'
      : 'invalid-response';
  } catch {
    return 'unreliable';
  }
}

async function checkProvider(
  findings: DoctorFinding[],
  validated: ValidatedTarget,
  offline: boolean,
  fetchImpl?: FetchLike,
): Promise<void> {
  const { target } = validated;
  if (target.provider === 'discord' || target.provider === 'telegram') {
    if (offline) {
      finding(findings, 'target-online-validation', 'not-checked', 'target-online-not-checked', 'The non-delivering provider identity check was not checked in offline mode.', target);
    } else {
      const result = target.provider === 'discord'
        ? await checkDiscordMetadata(validated as Extract<ValidatedTarget, { target: { provider: 'discord' } }>, fetchImpl)
        : await checkTelegramBot(validated as Extract<ValidatedTarget, { target: { provider: 'telegram' } }>, fetchImpl);
      const diagnostics: Record<ProviderProbeResult, [DoctorFindingStatus, string, string]> = {
        valid: ['passed', target.provider === 'discord' ? 'discord-webhook-metadata-valid' : 'telegram-bot-valid', `The ${target.provider === 'discord' ? 'Discord Webhook metadata' : 'Telegram Bot identity'} check succeeded.`],
        'authentication-failed': ['blocking', 'target-authentication-failed', 'The provider rejected the configured credentials.'],
        'permission-denied': ['blocking', 'target-permission-denied', 'The provider denied the non-delivering identity check.'],
        'invalid-target': ['blocking', 'target-not-found', 'The provider could not find the configured Notification Target identity.'],
        'redirect-refused': ['blocking', 'target-redirect-refused', 'The provider attempted to redirect the non-delivering check.'],
        'invalid-response': ['blocking', 'target-metadata-invalid', 'The provider returned invalid identity metadata.'],
        unreliable: ['blocking', 'target-online-check-unreliable', 'The non-delivering provider identity check did not complete reliably.'],
      };
      const [status, code, message] = diagnostics[result];
      finding(
        findings,
        'target-online-validation',
        status,
        code,
        message,
        target,
      );
    }
  }
  finding(findings, 'target-delivery', 'not-verified', 'destination-delivery-not-verified', 'Destination delivery is not verified; use kicktipp targets test <id> to send one explicit test.', target);
}

const capabilityMessages: Record<ReminderCapabilityReason, [string, string]> = {
  'missing-or-ambiguous-participant-id': ['stable-participant-identities-unavailable', 'Provider-stable Participant identities are missing or ambiguous.'],
  'missing-or-ambiguous-game-id': ['stable-game-identities-unavailable', 'Provider-stable Game identities are missing or ambiguous.'],
  'incomplete-matrix': ['reminder-snapshot-incomplete', 'The Participant-by-Game prediction matrix is incomplete.'],
  'unknown-source-time-zone': ['source-timezone-unknown', 'The Kicktipp Source Time Zone is unknown.'],
  'missing-authoritative-deadline': ['authoritative-deadline-missing', 'An authoritative Deadline is missing; kickoff was not used as a fallback.'],
  'ambiguous-local-timestamp': ['source-timestamp-ambiguous', 'A source timestamp is ambiguous in its Source Time Zone.'],
  'nonexistent-local-timestamp': ['source-timestamp-nonexistent', 'A source timestamp does not exist in its Source Time Zone.'],
  'incomplete-games': ['games-incomplete', 'The authoritative Game set is incomplete.'],
};

function validUtcInstant(value: string): boolean {
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

function inspectSnapshot(
  findings: DoctorFinding[],
  configuration: ServiceConfiguration,
  snapshot: ReminderSnapshot,
): void {
  if (snapshot.profileId !== configuration.job.profileId || snapshot.communityId !== configuration.job.communityId) {
    finding(findings, 'kicktipp-scope', 'blocking', 'snapshot-scope-mismatch', 'The Reminder Snapshot does not match the configured Auth Profile and Community.');
    return;
  }
  finding(findings, 'kicktipp-scope', 'passed', 'snapshot-scope-valid', 'The Reminder Snapshot is scoped to the configured Auth Profile and Community.');

  try {
    new Intl.DateTimeFormat('en', { timeZone: snapshot.sourceTimeZone });
    finding(findings, 'source-timezone', 'passed', 'source-timezone-valid', `Source Time Zone: ${snapshot.sourceTimeZone}.`);
  } catch {
    finding(findings, 'source-timezone', 'blocking', 'source-timezone-unknown', 'The Kicktipp Source Time Zone is unknown.');
  }

  const participantIds = new Set(snapshot.participants.map(({ id }) => id));
  const gameIds = new Set(snapshot.games.map(({ id }) => id));
  const participantsValid = snapshot.participants.length > 0
    && participantIds.size === snapshot.participants.length
    && snapshot.participants.every(({ id, displayName }) => id.trim() && displayName.trim());
  finding(findings, 'stable-participant-identities', participantsValid ? 'passed' : 'blocking', participantsValid ? 'stable-participant-identities-valid' : 'stable-participant-identities-unavailable', participantsValid ? `Provider-stable Participant identities are complete (${participantIds.size}).` : 'Provider-stable Participant identities are missing or ambiguous.');

  const gamesValid = snapshot.games.length > 0
    && gameIds.size === snapshot.games.length
    && snapshot.games.every(({ id }) => id.trim());
  finding(findings, 'stable-game-identities', gamesValid ? 'passed' : 'blocking', gamesValid ? 'stable-game-identities-valid' : 'stable-game-identities-unavailable', gamesValid ? `Provider-stable Game identities are complete (${gameIds.size}).` : 'Provider-stable Game identities are missing or ambiguous.');

  const deadlinesValid = snapshot.games.every(({ deadlineAt }) => validUtcInstant(deadlineAt));
  finding(findings, 'authoritative-deadlines', deadlinesValid && snapshot.games.length > 0 ? 'passed' : 'blocking', deadlinesValid && snapshot.games.length > 0 ? 'authoritative-deadlines-valid' : 'authoritative-deadline-invalid', deadlinesValid && snapshot.games.length > 0 ? 'All authoritative Deadlines are normalized UTC instants.' : 'An authoritative Deadline is missing or is not stored as a normalized UTC instant.');

  const sourceCounts = snapshot.games.reduce((counts, game) => {
    if (game.deadlineSource === 'event') counts.event += 1;
    if (game.deadlineSource === 'community-rule') counts.communityRule += 1;
    return counts;
  }, { event: 0, communityRule: 0 });
  const sourcesValid = sourceCounts.event + sourceCounts.communityRule === snapshot.games.length;
  finding(findings, 'deadline-parser-sources', sourcesValid && snapshot.games.length > 0 ? 'passed' : 'blocking', sourcesValid && snapshot.games.length > 0 ? 'deadline-parser-sources-valid' : 'deadline-parser-source-invalid', sourcesValid && snapshot.games.length > 0 ? `Deadline parser sources: event=${sourceCounts.event}, community-rule=${sourceCounts.communityRule}.` : 'A Deadline parser source is missing or unsupported.');

  const cellKeys = new Set(snapshot.cells.map(({ participantId, gameId }) => JSON.stringify([participantId, gameId])));
  const expectedCells = participantIds.size * gameIds.size;
  const matrixValid = participantsValid && gamesValid
    && snapshot.cells.length === expectedCells
    && cellKeys.size === expectedCells
    && snapshot.cells.every(({ participantId, gameId, status }) => participantIds.has(participantId) && gameIds.has(gameId) && (status === 'predicted' || status === 'missing'));
  finding(findings, 'reminder-snapshot', matrixValid ? 'passed' : 'blocking', matrixValid ? 'reminder-snapshot-complete' : 'reminder-snapshot-incomplete', matrixValid ? `The Participant-by-Game snapshot is complete (${snapshot.participants.length} × ${snapshot.games.length}).` : 'The Participant-by-Game prediction matrix is incomplete.');
}

async function inspectKicktipp(
  findings: DoctorFinding[],
  configuration: ServiceConfiguration,
  options: DoctorOptions,
): Promise<void> {
  if (options.offline) {
    finding(findings, 'kicktipp-online-validation', 'not-checked', 'kicktipp-online-not-checked', 'Scoped Auth, Reminder Capability, stable identities, Deadlines, Source Time Zone, and the complete Reminder Snapshot were not checked in offline mode.');
    return;
  }
  let capability: ReminderCapability;
  try {
    capability = options.getReminderCapability
      ? await options.getReminderCapability(configuration.job.profileId, configuration.job.communityId)
      : await createScopedClient({
        profileId: configuration.job.profileId,
        communityId: configuration.job.communityId,
        fetchImpl: options.kicktippFetchImpl,
      }).getReminderSnapshot();
    finding(findings, 'scoped-auth', 'passed', 'scoped-auth-valid', 'The configured Auth Profile authenticated in its configured Community scope.');
  } catch (error) {
    const auth = error instanceof AuthError
      || error instanceof SessionOnlyExpiredError
      || error instanceof MissingProfileCredentialsError;
    finding(findings, 'scoped-auth', 'blocking', auth ? 'scoped-auth-unavailable' : 'kicktipp-check-unreliable', auth ? 'The configured Auth Profile could not authenticate.' : 'The Kicktipp diagnosis did not complete reliably.');
    return;
  }
  if (!capability || typeof capability !== 'object' || !('available' in capability)) {
    finding(findings, 'reminder-capability', 'blocking', 'kicktipp-check-unreliable', 'The Kicktipp diagnosis did not return a reliable Reminder Capability result.');
    return;
  }
  if (!capability.available) {
    const diagnostic = capabilityMessages[capability.reason];
    if (!diagnostic) {
      finding(findings, 'reminder-capability', 'blocking', 'kicktipp-check-unreliable', 'The Kicktipp diagnosis did not return a reliable Reminder Capability result.');
      return;
    }
    const [code, message] = diagnostic;
    finding(findings, 'reminder-capability', 'blocking', code, message);
    return;
  }
  finding(findings, 'reminder-capability', 'passed', 'reminder-capability-available', 'Reminder Capability is available.');
  try {
    inspectSnapshot(findings, configuration, capability.snapshot);
  } catch {
    finding(findings, 'reminder-snapshot', 'blocking', 'kicktipp-check-unreliable', 'The Reminder Snapshot could not be diagnosed reliably.');
  }
}

/** Validate Service readiness without creating or mutating Service delivery data. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const findings: DoctorFinding[] = [];
  const paths = options.paths ?? servicePaths(options.env);
  const env = options.env ?? process.env;
  const offline = options.offline ?? false;

  inspectLock(findings, 'service', observeLock(paths.serviceLockFile));
  inspectLock(findings, 'configuration', observeLock(paths.configurationLockFile));
  if (fs.existsSync(paths.serviceLockFile)) {
    checkOwnerOnlyFile(findings, paths.serviceLockFile, 'service-lock-file-permissions', 'The Service Lock file', false);
  }
  if (fs.existsSync(paths.configurationLockFile)) {
    checkOwnerOnlyFile(findings, paths.configurationLockFile, 'configuration-lock-file-permissions', 'The Service Configuration Lock file', false);
  }
  checkDataDirectory(findings, paths);

  let configuration: ServiceConfiguration | undefined;
  try {
    configuration = readServiceConfiguration(paths);
    finding(findings, 'service-configuration', 'passed', 'service-configuration-valid', 'Service Configuration schema is valid.');
    finding(findings, 'display-timezone', 'passed', 'display-timezone-valid', `Display Time Zone: ${configuration.job.displayTimezone}.`);
  } catch (error) {
    finding(findings, 'service-configuration', 'blocking', error instanceof MissingServiceFileError ? 'service-configuration-missing' : 'service-configuration-invalid', error instanceof MissingServiceFileError ? 'Service Configuration is missing.' : 'Service Configuration is invalid or not reliably readable.');
    try {
      const parsed = serviceConfigurationSchema.safeParse(JSON.parse(fs.readFileSync(paths.configFile, 'utf8')));
      if (!parsed.success && parsed.error.issues.some(({ path }) => path[0] === 'job' && path[1] === 'displayTimezone')) {
        finding(findings, 'display-timezone', 'blocking', 'display-timezone-invalid', 'The configured Display Time Zone is invalid.');
      }
    } catch { /* the safe configuration finding above is authoritative */ }
  }

  if (configuration) {
    try {
      readServiceState(configuration, paths);
      finding(findings, 'service-state', 'passed', 'service-state-valid', 'Service State schema and Reminder Job identity binding are valid.');
    } catch (error) {
      const code = error instanceof MissingServiceFileError
        ? 'service-state-missing'
        : error instanceof ServiceIdentityMismatchError
          ? 'job-identity-mismatch'
          : 'service-state-invalid';
      const message = error instanceof MissingServiceFileError
        ? 'Service State is missing.'
        : error instanceof ServiceIdentityMismatchError
          ? 'Service State belongs to a different Reminder Job.'
          : 'Service State is invalid or not reliably readable.';
      finding(findings, 'service-state', 'blocking', code, message);
    }
    checkOwnerOnlyFile(findings, paths.stateFile, 'state-file-permissions', 'Service State', true);
    if (fs.existsSync(paths.secretsFile)) {
      checkOwnerOnlyFile(findings, paths.secretsFile, 'local-secret-store-permissions', 'The local Secret store', false);
    }

    const validatedTargets = configuration.targets
      .map((target) => validateTarget(findings, target, paths, env))
      .filter((target): target is ValidatedTarget => target !== undefined);
    await inspectKicktipp(findings, configuration, { ...options, offline });
    for (const target of validatedTargets) {
      await checkProvider(findings, target, offline, options.providerFetchImpl);
    }
  } else {
    finding(findings, 'kicktipp-online-validation', 'not-checked', 'kicktipp-online-not-checked', 'Online checks were not checked because Service Configuration is unavailable.');
  }

  const summary: Record<DoctorFindingStatus, number> = {
    passed: 0,
    warning: 0,
    blocking: 0,
    'not-checked': 0,
    'not-verified': 0,
  };
  for (const item of findings) summary[item.status] += 1;
  return { ready: summary.blocking === 0, offline, findings, summary };
}

export function doctorExitCode(report: DoctorReport): 0 | 1 {
  return report.ready ? 0 : 1;
}
