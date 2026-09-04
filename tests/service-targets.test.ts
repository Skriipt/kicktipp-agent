import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Command } from 'commander';
import { registerTargetsCommand } from '../src/commands/targets.js';
import { setJsonMode } from '../src/helpers/output.js';
import { FileLock, LockUnavailableError } from '../src/service/lock.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';
import {
  ConfigurationConflictError,
  mutateServiceConfiguration,
  readServiceConfiguration,
  serviceConfigurationSchema,
  setupService,
  type NotificationTarget,
  type ServiceConfiguration,
} from '../src/service/store.js';
import {
  InvalidWebhookTargetError,
  SecretResolutionError,
  addWebhookTarget,
  listTargets,
  removeTarget,
  resolveSecretReference,
  resolveWebhookTarget,
  setTargetEnabled,
  targetRevision,
  writeLocalSecrets,
  type WebhookTarget,
} from '../src/service/targets.js';

const JOB_ID = '9e90818e-a71f-472c-b4ad-c82f67f5195c';
const SECRET_CANARY = 'secret-canary-value';

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
        excludeParticipantIds: [],
        stages: [{ beforeDeadlineMinutes: 60, severity: 'urgent' }],
      },
      targetIds: enabled ? ['existing'] : [],
    },
    targets: enabled ? [{
      id: 'existing',
      provider: 'webhook',
      enabled: true,
      urlRef: 'env:EXISTING_URL',
    }] : [],
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-targets-'));
  paths = servicePaths({
    KICKTIPP_CONFIG_DIR: path.join(root, 'config'),
    KICKTIPP_DATA_DIR: path.join(root, 'data'),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setJsonMode(false);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Secret References', () => {
  it('rejects ambiguous environment sources without disclosing their names or values', () => {
    let thrown: unknown;
    try {
      resolveSecretReference('env:PRIVATE_TOKEN', {
        env: { PRIVATE_TOKEN: SECRET_CANARY, PRIVATE_TOKEN_FILE: '/secret/path' },
        paths,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SecretResolutionError);
    expect((thrown as SecretResolutionError).code).toBe('ambiguous_source');
    expect(String(thrown)).not.toContain('PRIVATE_TOKEN');
    expect(String(thrown)).not.toContain(SECRET_CANARY);
    expect(String(thrown)).not.toContain('/secret/path');
  });

  it('removes exactly one final LF or CRLF from file-backed Secrets', () => {
    const file = path.join(root, 'mounted-secret');
    for (const [raw, expected] of [
      [' value \n', ' value '],
      ['value\r\n', 'value'],
      ['value\n\n', 'value\n'],
      [' value ', ' value '],
    ]) {
      fs.writeFileSync(file, raw);
      expect(resolveSecretReference(`file:${file}`, { paths })).toBe(expected);
    }
    fs.writeFileSync(file, '\n');
    expect(() => resolveSecretReference(`file:${file}`, { paths }))
      .toThrow(expect.objectContaining({ code: 'empty' }));
  });

  it('uses an environment _FILE companion and preserves direct environment whitespace', () => {
    const file = path.join(root, 'env-secret');
    fs.writeFileSync(file, `${SECRET_CANARY}\n`);
    expect(resolveSecretReference('env:PRIVATE_TOKEN', {
      env: { PRIVATE_TOKEN_FILE: file }, paths,
    })).toBe(SECRET_CANARY);
    expect(resolveSecretReference('env:PRIVATE_TOKEN', {
      env: { PRIVATE_TOKEN: ` ${SECRET_CANARY} \n` }, paths,
    })).toBe(` ${SECRET_CANARY} \n`);
  });

  it('writes local Secrets atomically with owner-only permissions and preserves values', () => {
    const fsync = vi.spyOn(fs, 'fsyncSync');
    const rename = vi.spyOn(fs, 'renameSync');
    writeLocalSecrets({ token: 'true', spaced: ` ${SECRET_CANARY} ` }, paths);

    expect(rename).toHaveBeenCalledWith(expect.stringContaining('.secrets.ini.'), paths.secretsFile);
    expect(fsync).toHaveBeenCalled();
    if (process.platform !== 'win32') {
      expect(fs.statSync(paths.secretsFile).mode & 0o777).toBe(0o600);
    }
    expect(resolveSecretReference('local:token', { paths })).toBe('true');
    expect(resolveSecretReference('local:spaced', { paths })).toBe(` ${SECRET_CANARY} `);
  });

  it('rejects a local Secret store that is not owner-only without exposing its path or key', () => {
    if (process.platform === 'win32') return;
    writeLocalSecrets({ private_key: SECRET_CANARY }, paths);
    fs.chmodSync(paths.secretsFile, 0o640);
    let thrown: unknown;
    try {
      resolveSecretReference('local:private_key', { paths });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SecretResolutionError);
    expect((thrown as SecretResolutionError).code).toBe('insecure_local_store');
    expect(String(thrown)).not.toContain('private_key');
    expect(String(thrown)).not.toContain(paths.secretsFile);
    expect(String(thrown)).not.toContain(SECRET_CANARY);
  });

  it('strictly validates Secret Reference identifiers', () => {
    for (const reference of ['env:BAD-NAME', 'file:relative', 'local:../key', 'raw-secret']) {
      expect(() => resolveSecretReference(reference, { paths }))
        .toThrow(expect.objectContaining({ code: 'invalid_reference' }));
    }
  });
});

describe('Generic Webhook validation and revision', () => {
  function target(overrides: Partial<WebhookTarget> = {}): WebhookTarget {
    return {
      id: 'family',
      name: 'Family',
      enabled: true,
      provider: 'webhook',
      urlRef: 'env:WEBHOOK_URL',
      headers: { Authorization: 'env:AUTH_TOKEN', 'X-Group': 'file:/run/secrets/group' },
      ...overrides,
    };
  }

  it('rejects reserved, invalid, and case-insensitively duplicate headers', () => {
    for (const headers of [
      { 'Content-Type': 'env:TOKEN' },
      { 'Bad Header': 'env:TOKEN' },
      { Authorization: 'env:TOKEN', authorization: 'env:OTHER' },
    ]) {
      const input = configuration();
      input.targets = [{ ...target(), headers }];
      expect(() => serviceConfigurationSchema.parse(input)).toThrow();
    }
    const input = configuration();
    input.targets = [{ ...target(), headers: { Authorization: 'env:TOKEN' } }];
    expect(() => serviceConfigurationSchema.parse(input)).not.toThrow();
  });

  it('requires safe HTTP URLs after Secret resolution', () => {
    for (const value of [
      'https://user:password@example.test/hook',
      'https://example.test/hook#fragment',
      'ftp://example.test/hook',
      ' https://example.test/hook',
    ]) {
      expect(() => resolveWebhookTarget(target(), {
        env: { WEBHOOK_URL: value, AUTH_TOKEN: 'ok' }, paths,
      })).toThrow(expect.objectContaining({ code: 'invalid_url' }));
    }
    expect(() => resolveWebhookTarget(target(), {
      env: { WEBHOOK_URL: 'http://localhost/hook', AUTH_TOKEN: 'ok' }, paths,
    })).toThrow(expect.objectContaining({ code: 'insecure_http' }));
    expect(resolveWebhookTarget(target({ allowInsecureHttp: true, headers: {} }), {
      env: { WEBHOOK_URL: 'http://localhost/hook' }, paths,
    }).url).toBe('http://localhost/hook');
  });

  it('rejects unsafe resolved header controls without exposing the value', () => {
    let thrown: unknown;
    try {
      resolveWebhookTarget(target({ headers: { Authorization: 'env:AUTH_TOKEN' } }), {
        env: { WEBHOOK_URL: 'https://example.test/hook', AUTH_TOKEN: `${SECRET_CANARY}\r\ninjected` },
        paths,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidWebhookTargetError);
    expect((thrown as InvalidWebhookTargetError).code).toBe('invalid_header_value');
    expect(String(thrown)).not.toContain(SECRET_CANARY);
  });

  it('hashes canonical delivery configuration but not display metadata or enabled state', () => {
    const first = target();
    const reordered = target({
      name: 'Renamed',
      enabled: false,
      headers: { 'x-group': 'file:/run/secrets/group', authorization: 'env:AUTH_TOKEN' },
    });
    expect(targetRevision(first)).toBe(targetRevision(reordered));
    expect(targetRevision(first)).toBe('85c070d811b3d0ea1557ba512926d7994e75ef6797b84e33c00e24bde437aaa5');
    expect(targetRevision(target({ urlRef: 'env:OTHER_URL' }))).not.toBe(targetRevision(first));
    expect(targetRevision(target({
      headers: { Authorization: 'env:OTHER_AUTH_TOKEN', 'X-Group': 'file:/run/secrets/group' },
    }))).not.toBe(targetRevision(first));
    expect(targetRevision(target({ allowInsecureHttp: true }))).not.toBe(targetRevision(first));

    const telegram: NotificationTarget = {
      id: 'chat', enabled: true, provider: 'telegram', botTokenRef: 'env:BOT', chatId: '1',
    };
    expect(targetRevision({ ...telegram, enabled: false })).toBe(targetRevision(telegram));
    expect(targetRevision({ ...telegram, chatId: '2' })).not.toBe(targetRevision(telegram));
  });
});

describe('Notification Target configuration', () => {
  beforeEach(() => setupService(configuration(), paths));

  it('accepts only Secret References in the noninteractive target API', () => {
    expect(() => addWebhookTarget({ id: 'raw-url', urlRef: `https://${SECRET_CANARY}.test` }, paths))
      .toThrow(expect.objectContaining({ code: 'invalid_reference' }));
    expect(() => addWebhookTarget({
      id: 'raw-header',
      urlRef: 'env:WEBHOOK_URL',
      headers: { Authorization: SECRET_CANARY },
    }, paths)).toThrow(expect.objectContaining({ code: 'invalid_reference' }));
    expect(readServiceConfiguration(paths).targets).toEqual([]);
  });

  it('adds, lists, disables, enables, and removes a Generic Webhook Target', () => {
    addWebhookTarget({
      id: 'family-hook',
      name: 'Family Webhook',
      urlRef: 'env:FAMILY_URL',
      headers: { Authorization: 'file:/run/secrets/family-token' },
    }, paths);
    expect(readServiceConfiguration(paths).job.targetIds).toEqual(['family-hook']);
    expect(listTargets(paths)).toEqual([expect.objectContaining({
      id: 'family-hook',
      provider: 'webhook',
      enabled: true,
      secrets: [
        { purpose: 'url', configured: true, sourceClass: 'env' },
        { purpose: 'header', configured: true, sourceClass: 'file' },
      ],
    })]);
    expect(JSON.stringify(listTargets(paths))).not.toContain('FAMILY_URL');
    expect(JSON.stringify(listTargets(paths))).not.toContain('/run/secrets');

    setTargetEnabled('family-hook', false, paths);
    expect(readServiceConfiguration(paths).targets[0].enabled).toBe(false);
    setTargetEnabled('family-hook', true, paths);
    removeTarget('family-hook', paths);
    expect(readServiceConfiguration(paths)).toMatchObject({
      job: { targetIds: [] },
      targets: [],
    });
  });

  it('cannot disable or remove the final active Target of an enabled Job', () => {
    const activePaths = servicePaths({
      KICKTIPP_CONFIG_DIR: path.join(root, 'active-config'),
      KICKTIPP_DATA_DIR: path.join(root, 'active-data'),
    });
    setupService(configuration(true), activePaths);
    for (const mutation of [
      () => setTargetEnabled('existing', false, activePaths),
      () => removeTarget('existing', activePaths),
    ]) {
      let thrown: unknown;
      try { mutation(); } catch (error) { thrown = error; }
      expect(String(thrown)).toContain('active Target');
      expect(String(thrown)).not.toContain('EXISTING_URL');
    }
    expect(readServiceConfiguration(activePaths).targets[0]).toMatchObject({ id: 'existing', enabled: true });
    expect(readServiceConfiguration(activePaths).job.targetIds).toEqual(['existing']);
  });

  it('keeps a concurrent editor version instead of overwriting it', () => {
    expect(() => mutateServiceConfiguration((draft) => {
      const editor = structuredClone(draft);
      editor.job.name = 'editor-won';
      fs.writeFileSync(paths.configFile, `${JSON.stringify(editor)}\n`, { mode: 0o600 });
      draft.job.name = 'cli-lost';
      return draft;
    }, paths)).toThrow(ConfigurationConflictError);
    expect(readServiceConfiguration(paths).job.name).toBe('editor-won');
  });

  it('rejects a concurrent configuration writer without changing configuration', () => {
    const before = fs.readFileSync(paths.configFile);
    const lock = FileLock.acquire(paths.configurationLockFile);
    try {
      expect(() => addWebhookTarget({ id: 'racing', urlRef: 'env:RACING_URL' }, paths))
        .toThrow(LockUnavailableError);
      expect(fs.readFileSync(paths.configFile)).toEqual(before);
    } finally {
      lock.release();
    }
  });

  it('treats concurrent editor deletion as a conflict instead of recreating the file', () => {
    expect(() => mutateServiceConfiguration((draft) => {
      fs.unlinkSync(paths.configFile);
      draft.job.name = 'must-not-be-written';
      return draft;
    }, paths)).toThrow(ConfigurationConflictError);
    expect(fs.existsSync(paths.configFile)).toBe(false);
  });

  it('supports the public noninteractive add and redacted list commands', async () => {
    vi.stubEnv('KICKTIPP_CONFIG_DIR', paths.configDir);
    vi.stubEnv('KICKTIPP_DATA_DIR', paths.dataDir);
    const program = new Command().exitOverride();
    registerTargetsCommand(program);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync([
      'node', 'test', 'targets', 'add', 'cli-hook',
      '--url-ref', 'env:CLI_WEBHOOK_URL',
      '--header', 'Authorization=file:/run/secrets/cli-token',
    ]);
    await program.parseAsync(['node', 'test', 'targets', 'list', '--json']);
    await program.parseAsync(['node', 'test', 'targets', 'disable', 'cli-hook']);
    await program.parseAsync(['node', 'test', 'targets', 'enable', 'cli-hook']);
    await program.parseAsync(['node', 'test', 'targets', 'remove', 'cli-hook']);

    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('cli-hook');
    expect(output).toContain('sourceClass');
    expect(output).not.toContain('CLI_WEBHOOK_URL');
    expect(output).not.toContain('/run/secrets/cli-token');
    expect(readServiceConfiguration(paths)).toMatchObject({ targets: [], job: { targetIds: [] } });
  });
});
