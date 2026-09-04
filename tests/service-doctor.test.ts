import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderCapability, ReminderSnapshot } from '../src/reminder-capability.js';
import { setJsonMode } from '../src/helpers/output.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';
import {
  readServiceConfiguration,
  readServiceState,
  setupService,
  type ServiceConfiguration,
} from '../src/service/store.js';
import { mockFetch } from './helpers/mock-fetch.js';

const JOB_ID = '9e90818e-a71f-472c-b4ad-c82f67f5195c';
const PARTICIPANT_CANARY = 'Private Participant Canary';
const DISCORD_CANARY = 'discord-token-canary';
const TELEGRAM_CANARY = '123456:telegram_token_canary';
const NTFY_CANARY = 'tk_12345678901234567890123456789';
const WEBHOOK_CANARY = 'https://example.test/private-hook';

let root: string;
let paths: ServicePaths;

function configuration(targets: ServiceConfiguration['targets'] = [
  { id: 'discord', enabled: true, provider: 'discord', webhookUrlRef: 'env:PRIVATE_DISCORD' },
  { id: 'telegram', enabled: true, provider: 'telegram', botTokenRef: 'env:PRIVATE_TELEGRAM', chatId: '-10001', topicId: 7 },
  { id: 'ntfy', enabled: true, provider: 'ntfy', serverUrl: 'https://ntfy.example.test/', topic: 'family', tokenRef: 'env:PRIVATE_NTFY' },
  { id: 'webhook', enabled: true, provider: 'webhook', urlRef: 'env:PRIVATE_WEBHOOK', headers: { Authorization: 'env:PRIVATE_HEADER' } },
]): ServiceConfiguration {
  return {
    schemaVersion: 1,
    job: {
      id: JOB_ID,
      name: 'community-reminder',
      enabled: true,
      profileId: 'service-profile',
      communityId: 'family',
      language: 'en',
      displayTimezone: 'Europe/Berlin',
      policy: {
        excludeParticipantIds: [],
        stages: [{ beforeDeadlineMinutes: 60, severity: 'urgent' }],
      },
      targetIds: targets.map(({ id }) => id),
    },
    targets,
  };
}

function snapshot(): ReminderSnapshot {
  return {
    profileId: 'service-profile',
    communityId: 'family',
    sourceTimeZone: 'Europe/Berlin',
    participants: [{ id: 'participant-1', displayName: PARTICIPANT_CANARY }],
    games: [
      { id: 'game-event', deadlineAt: '2026-09-05T12:00:00.000Z', deadlineSource: 'event' },
      { id: 'game-rule', deadlineAt: '2026-09-05T12:00:00.000Z', deadlineSource: 'community-rule' },
    ],
    cells: [
      { participantId: 'participant-1', gameId: 'game-event', status: 'missing' },
      { participantId: 'participant-1', gameId: 'game-rule', status: 'predicted' },
    ],
  };
}

function available(): ReminderCapability {
  return { available: true, snapshot: snapshot() };
}

function env(): NodeJS.ProcessEnv {
  return {
    PRIVATE_DISCORD: `https://discord.com/api/webhooks/123/${DISCORD_CANARY}`,
    PRIVATE_TELEGRAM: TELEGRAM_CANARY,
    PRIVATE_NTFY: NTFY_CANARY,
    PRIVATE_WEBHOOK: WEBHOOK_CANARY,
    PRIVATE_HEADER: 'Bearer private-header-canary',
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-doctor-'));
  paths = servicePaths({
    KICKTIPP_CONFIG_DIR: path.join(root, 'config'),
    KICKTIPP_DATA_DIR: path.join(root, 'data'),
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  setJsonMode(false);
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('non-delivering Doctor', () => {
  it('validates all provider paths with GET-only metadata probes and never mutates Service data', async () => {
    setupService(configuration(), paths);
    const configBefore = fs.readFileSync(paths.configFile);
    const stateBefore = fs.readFileSync(paths.stateFile);
    const fakeKicktipp = vi.fn(async (profileId: string, communityId: string) => {
      expect({ profileId, communityId }).toEqual({ profileId: 'service-profile', communityId: 'family' });
      return available();
    });
    const provider = mockFetch((request) => {
      if (request.url === `https://discord.com/api/webhooks/123/${DISCORD_CANARY}`) {
        return { body: JSON.stringify({ id: '123', type: 1 }) };
      }
      if (request.url === `https://api.telegram.org/bot${TELEGRAM_CANARY}/getMe`) {
        return { body: JSON.stringify({ ok: true, result: { id: 123456, is_bot: true } }) };
      }
      throw new Error('Doctor attempted an unsupported provider request.');
    });
    const { runDoctor } = await import('../src/service/doctor.js');

    const report = await runDoctor({
      paths,
      env: env(),
      getReminderCapability: fakeKicktipp,
      providerFetchImpl: provider.fetchImpl,
    });

    expect(report.ready).toBe(true);
    expect(fakeKicktipp).toHaveBeenCalledOnce();
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.every(({ method, body }) => method === 'GET' && body === null)).toBe(true);
    expect(provider.calls.some(({ url }) => url.includes('ntfy.example.test'))).toBe(false);
    expect(provider.calls.some(({ url }) => url.includes('example.test/private-hook'))).toBe(false);
    expect(report.findings.filter(({ code }) => code === 'destination-delivery-not-verified')).toHaveLength(4);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'source-timezone-valid', status: 'passed' }),
      expect.objectContaining({ code: 'display-timezone-valid', status: 'passed' }),
      expect.objectContaining({ code: 'authoritative-deadlines-valid', status: 'passed' }),
      expect.objectContaining({ code: 'deadline-parser-sources-valid', message: expect.stringContaining('event=1, community-rule=1') }),
      expect.objectContaining({ code: 'reminder-snapshot-complete', message: expect.stringContaining('1 × 2') }),
    ]));
    expect(fs.readFileSync(paths.configFile)).toEqual(configBefore);
    expect(fs.readFileSync(paths.stateFile)).toEqual(stateBefore);
    expect(readServiceState(readServiceConfiguration(paths), paths)).toMatchObject({
      stageOutcomes: [], notifications: [], deliveries: [], attempts: [],
    });
    const output = JSON.stringify(report);
    for (const canary of [PARTICIPANT_CANARY, DISCORD_CANARY, TELEGRAM_CANARY, NTFY_CANARY, WEBHOOK_CANARY, 'PRIVATE_DISCORD', 'PRIVATE_HEADER']) {
      expect(output).not.toContain(canary);
    }
  });

  it('makes zero network requests offline and reports online checks as not checked', async () => {
    setupService(configuration(), paths);
    const stateBefore = fs.readFileSync(paths.stateFile);
    const getReminderCapability = vi.fn(async () => available());
    const providerFetchImpl = vi.fn(async () => { throw new Error('network must not be used'); });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network must not be used'); }));
    const { runDoctor } = await import('../src/service/doctor.js');

    const report = await runDoctor({
      paths,
      env: env(),
      offline: true,
      getReminderCapability,
      providerFetchImpl,
    });

    expect(report.ready).toBe(true);
    expect(getReminderCapability).not.toHaveBeenCalled();
    expect(providerFetchImpl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'kicktipp-online-not-checked', status: 'not-checked' }),
      expect.objectContaining({ code: 'target-online-not-checked', status: 'not-checked' }),
    ]));
    expect(fs.readFileSync(paths.stateFile)).toEqual(stateBefore);
  });

  it('uses fake Kicktipp endpoints through the configured scoped Auth Profile without publishing', async () => {
    setupService(configuration([{ id: 'webhook', enabled: true, provider: 'webhook', urlRef: 'env:PRIVATE_WEBHOOK' }]), paths);
    const stateBefore = fs.readFileSync(paths.stateFile);
    const home = path.join(root, 'home');
    const authDir = path.join(home, '.config', 'kicktipp-agent');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'config.ini'), '[profile.service-profile]\nemail = service@example.test\nstore = session\n');
    fs.writeFileSync(path.join(authDir, 'session-service-profile.json'), JSON.stringify({ cookies: [] }));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home);
    vi.resetModules();
    const schedule = fs.readFileSync(new URL('./fixtures/reminder-schedule-com.html', import.meta.url), 'utf8');
    const predictions = fs.readFileSync(new URL('./fixtures/tip-status.html', import.meta.url), 'utf8');
    const kicktipp = mockFetch((request) => {
      if (request.url.endsWith('/info/profil/meinetipprunden')) return { body: 'authenticated' };
      if (request.url.endsWith('/family/schedule')) return { body: schedule };
      if (request.url.endsWith('/family/leaderboard')) return { body: predictions };
      throw new Error('Unexpected Kicktipp request.');
    });
    const { setUrlBase } = await import('../src/url.js');
    setUrlBase('https://www.kicktipp.com');
    const { runDoctor } = await import('../src/service/doctor.js');

    const report = await runDoctor({ paths, env: { PRIVATE_WEBHOOK: WEBHOOK_CANARY }, kicktippFetchImpl: kicktipp.fetchImpl });

    expect(report.ready).toBe(true);
    expect(kicktipp.calls.length).toBeGreaterThan(0);
    expect(kicktipp.calls.every(({ method, body, url }) => method === 'GET' && body === null && new URL(url).hostname.endsWith('kicktipp.com'))).toBe(true);
    expect(fs.readFileSync(paths.stateFile)).toEqual(stateBefore);
  });

  it('reports specific blocking diagnostics, while insecure HTTP remains a warning', async () => {
    const targets: ServiceConfiguration['targets'] = [
      { id: 'ambiguous', enabled: true, provider: 'discord', webhookUrlRef: 'env:PRIVATE_DISCORD' },
      { id: 'lan', enabled: true, provider: 'ntfy', serverUrl: 'http://localhost:8080/', topic: 'family', allowInsecureHttp: true },
    ];
    setupService(configuration(targets), paths);
    const providerFetchImpl = vi.fn();
    const { runDoctor, doctorExitCode } = await import('../src/service/doctor.js');
    const report = await runDoctor({
      paths,
      env: { PRIVATE_DISCORD: DISCORD_CANARY, PRIVATE_DISCORD_FILE: '/private/path-canary' },
      providerFetchImpl,
      getReminderCapability: async () => ({ available: false, reason: 'missing-or-ambiguous-participant-id' }),
    });

    expect(report.ready).toBe(false);
    expect(doctorExitCode(report)).toBe(1);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'secret-source-ambiguous', status: 'blocking' }),
      expect.objectContaining({ code: 'stable-participant-identities-unavailable', status: 'blocking' }),
      expect.objectContaining({ code: 'insecure-http-allowed', status: 'warning' }),
    ]));
    expect(providerFetchImpl).not.toHaveBeenCalled();
    const output = JSON.stringify(report);
    expect(output).not.toContain('PRIVATE_DISCORD');
    expect(output).not.toContain(DISCORD_CANARY);
    expect(output).not.toContain('/private/path-canary');
  });

  it('reports State identity and permission failures without changing them', async () => {
    setupService(configuration(), paths);
    const state = readServiceState(readServiceConfiguration(paths), paths);
    state.jobId = '80bf67d0-8cda-471d-9cad-eaf1c93fca7d';
    fs.writeFileSync(paths.stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const before = fs.readFileSync(paths.stateFile);
    const { runDoctor } = await import('../src/service/doctor.js');
    const mismatch = await runDoctor({ paths, env: env(), offline: true });

    expect(mismatch.ready).toBe(false);
    expect(mismatch.findings).toContainEqual(expect.objectContaining({ code: 'job-identity-mismatch', status: 'blocking' }));
    expect(fs.readFileSync(paths.stateFile)).toEqual(before);

    if (process.platform === 'win32') return;
    fs.chmodSync(paths.stateFile, 0o640);
    const report = await runDoctor({ paths, env: env(), offline: true });

    expect(report.ready).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'service-state-invalid', status: 'blocking' }),
      expect.objectContaining({ code: 'state-file-permissions-unsafe', status: 'blocking' }),
    ]));
    expect(fs.readFileSync(paths.stateFile)).toEqual(before);
  });

  it('warns for broadly readable mounted Secrets and diagnoses an invalid Display Time Zone specifically', async () => {
    if (process.platform === 'win32') return;
    const mounted = path.join(root, 'mounted-secret');
    fs.writeFileSync(mounted, `${WEBHOOK_CANARY}\n`, { mode: 0o644 });
    fs.chmodSync(mounted, 0o644);
    setupService(configuration([{ id: 'webhook', enabled: true, provider: 'webhook', urlRef: `file:${mounted}` }]), paths);
    const { runDoctor } = await import('../src/service/doctor.js');
    const warning = await runDoctor({ paths, offline: true });

    expect(warning.ready).toBe(true);
    expect(warning.findings).toContainEqual(expect.objectContaining({ code: 'secret-file-permissions-broad', status: 'warning' }));
    expect(JSON.stringify(warning)).not.toContain(mounted);
    expect(JSON.stringify(warning)).not.toContain(WEBHOOK_CANARY);

    const raw = configuration();
    raw.job.displayTimezone = 'Not/A_Time_Zone';
    fs.writeFileSync(paths.configFile, JSON.stringify(raw), { mode: 0o600 });
    const invalid = await runDoctor({ paths, offline: true });
    expect(invalid.ready).toBe(false);
    expect(invalid.findings).toContainEqual(expect.objectContaining({ code: 'display-timezone-invalid', status: 'blocking' }));
  });

  it('honors CLI JSON privacy and exit codes in offline mode', async () => {
    setupService(configuration(), paths);
    for (const [name, value] of Object.entries(env())) vi.stubEnv(name, value!);
    vi.stubEnv('KICKTIPP_CONFIG_DIR', paths.configDir);
    vi.stubEnv('KICKTIPP_DATA_DIR', paths.dataDir);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));
    const { registerDoctorCommand } = await import('../src/commands/doctor.js');
    const program = new Command().exitOverride();
    registerDoctorCommand(program);

    await program.parseAsync(['node', 'test', 'doctor', '--offline', '--json']);

    const report = JSON.parse(lines.join('\n'));
    expect(report.ready).toBe(true);
    expect(process.exitCode).toBe(0);
    for (const canary of [PARTICIPANT_CANARY, DISCORD_CANARY, TELEGRAM_CANARY, NTFY_CANARY, WEBHOOK_CANARY, 'PRIVATE_DISCORD']) {
      expect(lines.join('\n')).not.toContain(canary);
    }

    fs.writeFileSync(paths.stateFile, '{invalid', { mode: 0o600 });
    lines.length = 0;
    process.exitCode = undefined;
    await program.parseAsync(['node', 'test', 'doctor', '--offline', '--json']);
    expect(JSON.parse(lines.join('\n')).ready).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
