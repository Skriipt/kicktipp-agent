import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerServiceCommand } from '../src/commands/service.js';
import { setJsonMode } from '../src/helpers/output.js';
import { FileLock } from '../src/service/lock.js';
import { createServiceLogger } from '../src/service/logging.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';
import { getServiceStatus } from '../src/service/status.js';
import {
  acquireServiceLock,
  readServiceConfiguration,
  readServiceState,
  setupService,
  writeServiceState,
  type ServiceConfiguration,
  type ServiceState,
} from '../src/service/store.js';

const JOB_ID = '9e90818e-a71f-472c-b4ad-c82f67f5195c';
const GROUP_ID = 'a'.repeat(64);
const NOTIFICATION_ID = 'b'.repeat(64);
const DELIVERY_ID = 'c'.repeat(64);
const REVISION = 'd'.repeat(64);
const NOW = new Date('2026-09-04T12:00:00.000Z');
const PARTICIPANT_NAME = 'Private Participant Canary';
const NOTIFICATION_TEXT = 'Private notification text canary';
const SECRET_REFERENCE_NAME = 'PRIVATE_WEBHOOK_CANARY';
const CREDENTIAL_CANARY = 'credential-url-canary';

let root: string;
let paths: ServicePaths;

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
        stages: [{ beforeDeadlineMinutes: 60, severity: 'urgent' }],
      },
      targetIds: enabled ? ['family-hook'] : [],
    },
    targets: enabled ? [{
      id: 'family-hook',
      enabled: true,
      provider: 'webhook',
      urlRef: `env:${SECRET_REFERENCE_NAME}`,
    }] : [],
  };
}

function currentState(deliveryState: ServiceState['deliveries'][number]['state'] = 'confirmed'): ServiceState {
  const state = readServiceState(readServiceConfiguration(paths), paths);
  state.scheduler = {
    kicktippNetworkFailures: 0,
    lastScheduleFetchAt: NOW.toISOString(),
    lastReliableCheckAt: NOW.toISOString(),
    reminderCapabilityAvailable: true,
    sessionCondition: 'authenticated',
    deadlineGroupId: GROUP_ID,
    nextDeadlineAt: '2026-09-04T18:00:00.000Z',
    nextStageAt: '2026-09-04T17:00:00.000Z',
  };
  state.notifications = [{
    id: NOTIFICATION_ID,
    jobId: JOB_ID,
    createdAt: NOW.toISOString(),
    language: 'en',
    displayTimezone: 'Europe/Berlin',
    content: {
      schemaVersion: 1,
      type: 'reminder',
      severity: 'urgent',
      title: 'Private title canary',
      message: NOTIFICATION_TEXT,
      actionUrl: `https://www.kicktipp.com/family/?token=${CREDENTIAL_CANARY}`,
    },
    deadlineGroup: {
      id: GROUP_ID,
      deadlineAt: '2026-09-04T18:00:00.000Z',
      gameIds: ['game-a'],
    },
    stage: '60',
    missingParticipants: [{ id: 'participant-private', displayName: PARTICIPANT_NAME }],
  }];
    state.deliveries = [{
    id: DELIVERY_ID,
    notificationId: NOTIFICATION_ID,
    targetId: 'family-hook',
    targetRevision: REVISION,
      state: deliveryState,
      safeErrorCode: SECRET_REFERENCE_NAME,
      receipt: {
        provider: 'webhook',
        acceptedAt: NOW.toISOString(),
        messageId: CREDENTIAL_CANARY,
      },
  }];
  return state;
}

function replaceState(state: ServiceState): void {
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.chmodSync(paths.stateFile, 0o600);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-status-'));
  paths = servicePaths({
    KICKTIPP_CONFIG_DIR: path.join(root, 'config'),
    KICKTIPP_DATA_DIR: path.join(root, 'data'),
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network must not be used'); }));
  vi.stubEnv('KICKTIPP_CONFIG_DIR', paths.configDir);
  vi.stubEnv('KICKTIPP_DATA_DIR', paths.dataDir);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setJsonMode(false);
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('shared local Service Status', () => {
  it('keeps summary output free of Participant names, Notification text, and Secret References', () => {
    setupService(configuration(), paths);
    const lock = acquireServiceLock(paths);
    try {
      replaceState(currentState());
      const summary = getServiceStatus({ paths, now: NOW });
      const encoded = JSON.stringify(summary);
      expect(summary).toMatchObject({
        readable: true,
        health: { status: 'healthy' },
        notifications: [{ missingParticipantCount: 1 }],
        targets: [{ secrets: [{ configured: true, sourceClass: 'env' }] }],
      });
      expect(encoded).not.toContain(PARTICIPANT_NAME);
      expect(encoded).not.toContain(NOTIFICATION_TEXT);
      expect(encoded).not.toContain(SECRET_REFERENCE_NAME);
      expect(encoded).not.toContain('env:');
      expect(encoded).not.toContain(CREDENTIAL_CANARY);
      expect(fetch).not.toHaveBeenCalled();

      const details = JSON.stringify(getServiceStatus({ paths, now: NOW, details: true }));
      expect(details).toContain(PARTICIPANT_NAME);
      expect(details).toContain(NOTIFICATION_TEXT);
      expect(details).not.toContain(SECRET_REFERENCE_NAME);
      expect(details).not.toContain(CREDENTIAL_CANARY);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      lock.release();
    }
  });

  it('applies current Health, Retry, missed-Stage, and Schedule-freshness rules', () => {
    setupService(configuration(), paths);
    const lock = acquireServiceLock(paths);
    try {
      const healthy = currentState('pending');
      healthy.deliveries[0].nextAttemptAt = '2026-09-04T12:00:01.000Z';
      replaceState(healthy);
      expect(getServiceStatus({ paths, now: NOW }).health.status).toBe('healthy');

      healthy.deliveries[0].nextAttemptAt = '2026-09-04T11:59:59.000Z';
      replaceState(healthy);
      expect(getServiceStatus({ paths, now: NOW }).health).toMatchObject({ status: 'degraded', reasons: ['retry-overdue'] });

      const failed = currentState('failed');
      replaceState(failed);
      expect(getServiceStatus({ paths, now: NOW }).health.status).toBe('degraded');

      failed.deliveries[0].state = 'unknown';
      replaceState(failed);
      expect(getServiceStatus({ paths, now: NOW }).health.status).toBe('degraded');

      failed.deliveries[0].state = 'cancelled';
      replaceState(failed);
      expect(getServiceStatus({ paths, now: NOW }).health.status).toBe('healthy');

      failed.deliveries[0].state = 'failed';
      failed.scheduler.deadlineGroupId = 'e'.repeat(64);
      replaceState(failed);
      expect(getServiceStatus({ paths, now: NOW }).health.status).toBe('healthy');

      const missed = currentState();
      missed.scheduler.nextStageAt = '2026-09-04T11:00:00.000Z';
      missed.scheduler.lastReliableCheckAt = '2026-09-04T10:00:00.000Z';
      replaceState(missed);
      expect(getServiceStatus({ paths, now: NOW }).health).toMatchObject({ status: 'unhealthy', reasons: ['missed-stage'] });
      missed.scheduler.lastReliableCheckAt = NOW.toISOString();
      replaceState(missed);
      expect(getServiceStatus({ paths, now: NOW }).health.status).toBe('healthy');

      const stale = currentState();
      stale.scheduler.lastScheduleFetchAt = '2026-09-03T11:59:59.000Z';
      replaceState(stale);
      expect(getServiceStatus({ paths, now: NOW }).health).toMatchObject({ status: 'unhealthy', reasons: ['schedule-stale'] });
      delete stale.scheduler.nextDeadlineAt;
      stale.scheduler.lastScheduleFetchAt = '2026-09-02T13:00:01.000Z';
      replaceState(stale);
      expect(getServiceStatus({ paths, now: NOW }).health.status).toBe('healthy');
      stale.scheduler.lastScheduleFetchAt = '2026-09-02T11:59:59.000Z';
      replaceState(stale);
      expect(getServiceStatus({ paths, now: NOW }).health.status).toBe('unhealthy');

      const auth = currentState();
      auth.scheduler.sessionCondition = 'unavailable';
      replaceState(auth);
      expect(getServiceStatus({ paths, now: NOW }).health.reasons).toContain('authentication-unavailable');

      const overdueCheck = currentState();
      overdueCheck.scheduler.safeErrorCode = 'kicktipp_network_failure';
      overdueCheck.scheduler.kicktippBackoffUntil = NOW.toISOString();
      replaceState(overdueCheck);
      expect(getServiceStatus({ paths, now: NOW }).health.reasons).toContain('check-overdue');
    } finally {
      lock.release();
    }
    expect(getServiceStatus({ paths, now: NOW }).health).toMatchObject({ status: 'unhealthy' });
    expect(getServiceStatus({ paths, now: NOW }).health.reasons).toContain('service-not-running');
  });

  it('uses the shared model for CLI JSON and honors Status and Health exit codes', async () => {
    setupService(configuration(), paths);
    const initial = readServiceState(readServiceConfiguration(paths), paths);
    replaceState(currentState());
    const lock = FileLock.acquire(paths.serviceLockFile);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));
    try {
      const expected = getServiceStatus();
      const program = new Command().exitOverride();
      registerServiceCommand(program);
      await program.parseAsync(['node', 'test', 'service', 'status', '--json']);
      expect(JSON.parse(lines.join('\n'))).toEqual(expected);
      expect(process.exitCode).toBe(0);

      lines.length = 0;
      await program.parseAsync(['node', 'test', 'service', 'health', '--json']);
      expect(JSON.parse(lines.join('\n'))).toEqual(expected.health);
      expect(process.exitCode).toBe(0);

      replaceState(initial);
      lines.length = 0;
      await program.parseAsync(['node', 'test', 'service', 'health', '--json']);
      expect(JSON.parse(lines.join('\n')).status).toBe('degraded');
      expect(process.exitCode).toBe(0);
    } finally {
      lock.release();
    }

    lines.length = 0;
    const unhealthy = new Command().exitOverride();
    registerServiceCommand(unhealthy);
    await unhealthy.parseAsync(['node', 'test', 'service', 'health', '--json']);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await unhealthy.parseAsync(['node', 'test', 'service', 'status', '--json']);
    expect(process.exitCode).toBe(0);

    fs.writeFileSync(paths.stateFile, '{invalid', { mode: 0o600 });
    process.exitCode = undefined;
    await unhealthy.parseAsync(['node', 'test', 'service', 'status', '--json']);
    expect(process.exitCode).toBe(1);
  });
});

describe('privacy-safe Service logging', () => {
  it('serializes only allowed fields and reconstructs safe errors', () => {
    const lines: string[] = [];
    const logger = createServiceLogger('json', {
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    logger.log({
      event: 'check_completed',
      at: NOW.toISOString(),
      jobId: JOB_ID,
      durationMs: 12,
      reliable: false,
      error: {
        code: 'unknown-secret-code',
        safeMessage: `${PARTICIPANT_NAME} ${NOTIFICATION_TEXT}`,
        category: 'internal',
        retryable: false,
      },
      participantName: PARTICIPANT_NAME,
      responseBody: NOTIFICATION_TEXT,
      secretReference: `env:${SECRET_REFERENCE_NAME}`,
      environmentName: SECRET_REFERENCE_NAME,
      secretPath: `/run/secrets/${SECRET_REFERENCE_NAME}`,
      credentialUrl: `https://user:${CREDENTIAL_CANARY}@example.test/`,
      cookies: `sid=${CREDENTIAL_CANARY}`,
      rawHtml: `<p>${CREDENTIAL_CANARY}</p>`,
      exception: new Error(CREDENTIAL_CANARY),
    } as never);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('service_operation_failure');
    expect(lines[0]).not.toContain(PARTICIPANT_NAME);
    expect(lines[0]).not.toContain(NOTIFICATION_TEXT);
    expect(lines[0]).not.toContain(SECRET_REFERENCE_NAME);
    expect(lines[0]).not.toContain(CREDENTIAL_CANARY);
  });
});
