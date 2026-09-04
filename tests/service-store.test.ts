import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ConfigurationConflictError,
  InvalidServiceFileError,
  MissingServiceFileError,
  ServiceAlreadyInitializedError,
  ServiceIdentityMismatchError,
  StateInitializationAcknowledgementError,
  acquireServiceLock,
  initializeServiceState,
  mutateServiceConfiguration,
  readLocalServiceBasis,
  readServiceConfiguration,
  readServiceState,
  serviceConfigurationSchema,
  setupService,
  writeServiceState,
  type ServiceConfiguration,
} from '../src/service/store.js';
import { AmbiguousLockError, FileLock, LockUnavailableError, observeLock } from '../src/service/lock.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';

const JOB_ID = '9e90818e-a71f-472c-b4ad-c82f67f5195c';

let root: string;
let paths: ServicePaths;

function configuration(enabled = false): ServiceConfiguration {
  return {
    schemaVersion: 1,
    job: {
      id: JOB_ID,
      name: 'community-reminder',
      enabled,
      profileId: 'private',
      communityId: 'family',
      language: 'de',
      displayTimezone: 'Europe/Berlin',
      policy: {
        matchSelection: 'next-deadline-group',
        completion: 'all-games-in-group',
        excludeParticipantIds: [],
        stages: [
          { beforeDeadlineMinutes: 1440, severity: 'info' },
          { beforeDeadlineMinutes: 360, severity: 'warning' },
          { beforeDeadlineMinutes: 60, severity: 'urgent' },
        ],
      },
      targetIds: enabled ? ['family-webhook'] : [],
    },
    targets: enabled
      ? [{
        id: 'family-webhook',
        enabled: true,
        provider: 'webhook',
        urlRef: 'env:FAMILY_WEBHOOK',
      }]
      : [],
  };
}

function writeOwnerOnly(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-service-'));
  paths = servicePaths({
    KICKTIPP_CONFIG_DIR: path.join(root, 'config'),
    KICKTIPP_DATA_DIR: path.join(root, 'data'),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Service configuration schema', () => {
  it('accepts exactly one Job with the fixed MVP policy', () => {
    expect(serviceConfigurationSchema.parse(configuration(true)).job.policy.matchSelection)
      .toBe('next-deadline-group');
    expect(() => serviceConfigurationSchema.parse({
      ...configuration(),
      extra: true,
    })).toThrow();
    expect(() => serviceConfigurationSchema.parse({
      ...configuration(),
      job: { ...configuration().job, policy: { ...configuration().job.policy, completion: 'some-games' } },
    })).toThrow();
  });

  it('requires an enabled Job to reference an enabled Target', () => {
    const missing = configuration();
    missing.job.enabled = true;
    expect(() => serviceConfigurationSchema.parse(missing)).toThrow(/active Target/);

    const disabledTarget = configuration(true);
    disabledTarget.targets[0].enabled = false;
    expect(() => serviceConfigurationSchema.parse(disabledTarget)).toThrow(/active Target/);
    expect(() => serviceConfigurationSchema.parse(configuration(false))).not.toThrow();
  });

  it('rejects duplicate Stage identities and unknown Target references', () => {
    const duplicateStage = configuration();
    duplicateStage.job.policy.stages.push({ beforeDeadlineMinutes: 60, severity: 'info' });
    expect(() => serviceConfigurationSchema.parse(duplicateStage)).toThrow(/Duplicate Stage/);

    const unknownTarget = configuration();
    unknownTarget.job.targetIds = ['missing'];
    expect(() => serviceConfigurationSchema.parse(unknownTarget)).toThrow(/Unknown Target/);
  });
});

describe('Service setup and explicit State initialization', () => {
  it('uses independently configurable platform directories', () => {
    expect(paths.configFile).toBe(path.join(root, 'config', 'service.json'));
    expect(paths.stateFile).toBe(path.join(root, 'data', 'service-state.json'));
  });

  it('durably creates configuration before initial State with owner-only files', () => {
    const fsync = vi.spyOn(fs, 'fsyncSync');
    const state = setupService(configuration(), paths);
    expect(readServiceConfiguration(paths)).toEqual(configuration());
    expect(readServiceState(configuration(), paths)).toEqual(state);
    expect(fsync).toHaveBeenCalled();
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.configFile).mode & 0o777).toBe(0o600);
      expect(fs.statSync(paths.stateFile).mode & 0o777).toBe(0o600);
    }
  });

  it('leaves committed configuration after an interrupted State commit', () => {
    const link = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      if (target === paths.stateFile) throw Object.assign(new Error('disk failure'), { code: 'EIO' });
      return link(source, target);
    });

    expect(() => setupService(configuration(), paths)).toThrow(/disk failure/);
    expect(readServiceConfiguration(paths)).toEqual(configuration());
    expect(() => readServiceState(configuration(), paths)).toThrow(MissingServiceFileError);
    expect(fs.readdirSync(paths.dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(() => setupService(configuration(), paths)).toThrow(ServiceAlreadyInitializedError);
  });

  it('requires acknowledgement and never replaces existing State', () => {
    writeOwnerOnly(paths.configFile, configuration());
    expect(() => initializeServiceState(false, paths))
      .toThrow(StateInitializationAcknowledgementError);
    const state = initializeServiceState(true, paths);
    const bytes = fs.readFileSync(paths.stateFile);
    expect(state.jobId).toBe(JOB_ID);
    expect(() => initializeServiceState(true, paths)).toThrow(ServiceAlreadyInitializedError);
    expect(fs.readFileSync(paths.stateFile)).toEqual(bytes);
  });

  it('does not create configuration over orphaned State', () => {
    writeOwnerOnly(paths.stateFile, {
      schemaVersion: 1,
      jobId: JOB_ID,
      initializedAt: new Date().toISOString(),
    });
    expect(() => setupService(configuration(), paths)).toThrow(ServiceAlreadyInitializedError);
    expect(fs.existsSync(paths.configFile)).toBe(false);
  });
});

describe('fail-closed reads and writes', () => {
  it('rejects corrupt and unsupported configuration', () => {
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(paths.configFile, '{broken', { mode: 0o600 });
    expect(() => readServiceConfiguration(paths)).toThrow(InvalidServiceFileError);

    writeOwnerOnly(paths.configFile, { ...configuration(), schemaVersion: 2 });
    expect(() => readServiceConfiguration(paths)).toThrow(InvalidServiceFileError);
  });

  it('rejects missing, corrupt, incompatible, and identity-mismatched State', () => {
    writeOwnerOnly(paths.configFile, configuration());
    expect(() => readServiceState(configuration(), paths)).toThrow(MissingServiceFileError);

    writeOwnerOnly(paths.stateFile, 'not state');
    expect(() => readServiceState(configuration(), paths)).toThrow(InvalidServiceFileError);

    writeOwnerOnly(paths.stateFile, { schemaVersion: 2, jobId: JOB_ID, initializedAt: new Date().toISOString() });
    expect(() => readServiceState(configuration(), paths)).toThrow(InvalidServiceFileError);

    writeOwnerOnly(paths.stateFile, {
      schemaVersion: 1,
      jobId: '25b856c6-0fa8-4c71-9646-b56fa262f181',
      initializedAt: new Date().toISOString(),
    });
    expect(() => readServiceState(configuration(), paths)).toThrow(ServiceIdentityMismatchError);
  });

  it('rejects State whose permissions are not owner-only', () => {
    if (process.platform === 'win32') return;
    writeOwnerOnly(paths.configFile, configuration());
    writeOwnerOnly(paths.stateFile, {
      schemaVersion: 1,
      jobId: JOB_ID,
      initializedAt: new Date().toISOString(),
    });
    fs.chmodSync(paths.stateFile, 0o644);
    expect(() => readServiceState(configuration(), paths)).toThrow(InvalidServiceFileError);
  });

  it('atomically replaces State only while the caller owns the Service Lock', () => {
    const state = setupService(configuration(), paths);
    const lock = acquireServiceLock(paths);
    const rename = vi.spyOn(fs, 'renameSync');
    try {
      writeServiceState(state, lock, paths);
      expect(rename).toHaveBeenCalledWith(expect.stringContaining(paths.dataDir), paths.stateFile);
    } finally {
      lock.release();
    }
    expect(fs.readdirSync(paths.dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the previous State when a durable replacement fails', () => {
    const state = setupService(configuration(), paths);
    const before = fs.readFileSync(paths.stateFile);
    const lock = acquireServiceLock(paths);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('rename failed'), { code: 'EIO' });
    });
    try {
      expect(() => writeServiceState(state, lock, paths)).toThrow(/rename failed/);
    } finally {
      lock.release();
    }
    expect(fs.readFileSync(paths.stateFile)).toEqual(before);
    expect(fs.readdirSync(paths.dataDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('Service and Configuration Locks', () => {
  it('rejects a concurrent Service writer immediately', () => {
    const first = FileLock.acquire(paths.serviceLockFile);
    try {
      expect(() => FileLock.acquire(paths.serviceLockFile)).toThrow(LockUnavailableError);
      expect(observeLock(paths.serviceLockFile).status).toBe('held');
    } finally {
      first.release();
    }
  });

  it('reclaims a stale lock only when its local owner is proven dead', () => {
    writeOwnerOnly(paths.serviceLockFile, {
      schemaVersion: 1,
      pid: 999999,
      hostname: os.hostname(),
      startedAt: '2026-09-04T00:00:00.000Z',
      token: 'old',
    });
    expect(observeLock(paths.serviceLockFile).status).toBe('stale');
    const lock = FileLock.acquire(paths.serviceLockFile);
    expect(observeLock(paths.serviceLockFile).status).toBe('held');
    lock.release();
  });

  it('fails closed when stale ownership is ambiguous', () => {
    writeOwnerOnly(paths.serviceLockFile, {
      schemaVersion: 1,
      pid: 999999,
      hostname: 'another-host',
      startedAt: '2026-09-04T00:00:00.000Z',
      token: 'old',
    });
    expect(observeLock(paths.serviceLockFile)).toMatchObject({ status: 'ambiguous' });
    expect(() => FileLock.acquire(paths.serviceLockFile)).toThrow(AmbiguousLockError);
    expect(fs.existsSync(paths.serviceLockFile)).toBe(true);
  });
});

describe('Configuration compare-and-swap and local read basis', () => {
  it('allows a configuration mutation while the separate Service Lock is held', () => {
    setupService(configuration(), paths);
    const serviceLock = acquireServiceLock(paths);
    try {
      const updated = mutateServiceConfiguration((draft) => {
        draft.job.name = 'new-name';
        return draft;
      }, paths);
      expect(updated.job.name).toBe('new-name');
      expect(serviceLock.file).toBe(paths.serviceLockFile);
    } finally {
      serviceLock.release();
    }
  });

  it('does not overwrite an editor change made during a mutation', () => {
    setupService(configuration(), paths);
    expect(() => mutateServiceConfiguration((draft) => {
      const editorVersion = structuredClone(draft);
      editorVersion.job.name = 'editor-won';
      writeOwnerOnly(paths.configFile, editorVersion);
      draft.job.name = 'cli-change';
      return draft;
    }, paths)).toThrow(ConfigurationConflictError);
    expect(readServiceConfiguration(paths).job.name).toBe('editor-won');
  });

  it('prevents changing the Job identity after State exists', () => {
    setupService(configuration(), paths);
    expect(() => mutateServiceConfiguration((draft) => {
      draft.job.id = '25b856c6-0fa8-4c71-9646-b56fa262f181';
      return draft;
    }, paths)).toThrow(ServiceIdentityMismatchError);
  });

  it('returns validated Config, State, and non-mutating lock observations', () => {
    setupService(configuration(), paths);
    const lock = acquireServiceLock(paths);
    try {
      const basis = readLocalServiceBasis(paths);
      expect(basis.configuration.job.id).toBe(JOB_ID);
      expect(basis.state.jobId).toBe(JOB_ID);
      expect(basis.locks.service.status).toBe('held');
      expect(basis.locks.configuration.status).toBe('absent');
    } finally {
      lock.release();
    }
  });
});
