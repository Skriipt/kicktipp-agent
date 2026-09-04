import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ReminderCapability, ReminderSnapshot } from '../src/reminder-capability.js';
import { evaluateReminderDryRun, runReminderDryRun } from '../src/service/dry-run.js';
import { FileLock, LockUnavailableError } from '../src/service/lock.js';
import { servicePaths, type ServicePaths } from '../src/service/paths.js';
import { setupService, type ServiceConfiguration } from '../src/service/store.js';

const JOB_ID = '9e90818e-a71f-472c-b4ad-c82f67f5195c';
const SCHEDULE = fs.readFileSync(
  new URL('./fixtures/reminder-schedule-com.html', import.meta.url),
  'utf8',
);
const PREDICTIONS = fs.readFileSync(
  new URL('./fixtures/tip-status.html', import.meta.url),
  'utf8',
);

let root: string;
let paths: ServicePaths;

function configuration(): ServiceConfiguration {
  return {
    schemaVersion: 1,
    job: {
      id: JOB_ID,
      name: 'community-reminder',
      enabled: true,
      profileId: 'service-profile',
      communityId: 'family',
      language: 'de',
      displayTimezone: 'Europe/Berlin',
      policy: {
        excludeParticipantIds: ['excluded'],
        stages: [
          { beforeDeadlineMinutes: 60, severity: 'urgent' },
          { beforeDeadlineMinutes: 1440, severity: 'info' },
          { beforeDeadlineMinutes: 360, severity: 'warning' },
        ],
      },
      targetIds: ['second', 'first'],
    },
    targets: [
      { id: 'first', enabled: true, provider: 'webhook', urlRef: 'env:FIRST_URL' },
      { id: 'second', enabled: true, provider: 'telegram', botTokenRef: 'env:BOT', chatId: '1' },
      { id: 'unused', enabled: true, provider: 'webhook', urlRef: 'env:UNUSED_URL' },
    ],
  };
}

function snapshot(overrides: Partial<ReminderSnapshot> = {}): ReminderSnapshot {
  const participants = [
    { id: 'emoji', displayName: '😀' },
    { id: 'accent-b', displayName: 'é' },
    { id: 'private', displayName: '\uE000' },
    { id: 'accent-a', displayName: 'é' },
    { id: 'excluded', displayName: 'Excluded' },
  ];
  const games = [
    { id: 'later', deadlineAt: '2026-09-04T18:00:00.000Z', deadlineSource: 'event' as const },
    { id: 'early-b', deadlineAt: '2026-09-04T12:00:00.000Z', deadlineSource: 'event' as const },
    { id: 'early-a', deadlineAt: '2026-09-04T12:00:00.000Z', deadlineSource: 'community-rule' as const },
  ];
  return {
    profileId: 'service-profile',
    communityId: 'family',
    sourceTimeZone: 'Europe/Berlin',
    participants,
    games,
    cells: participants.flatMap((participant) => games.map((game) => ({
      participantId: participant.id,
      gameId: game.id,
      status: 'missing' as const,
    }))),
    ...overrides,
  };
}

function available(value = snapshot()): ReminderCapability {
  return { available: true, snapshot: value };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-dry-run-'));
  paths = servicePaths({
    KICKTIPP_CONFIG_DIR: path.join(root, 'config'),
    KICKTIPP_DATA_DIR: path.join(root, 'data'),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Reminder dry-run evaluator', () => {
  it('selects the earliest open group before considering participant completion', () => {
    const value = snapshot();
    value.cells = value.cells.map((cell) => ({
      ...cell,
      status: cell.gameId.startsWith('early') ? 'predicted' : 'missing',
    }));
    const result = evaluateReminderDryRun(
      configuration(),
      available(value),
      new Date('2026-09-04T11:30:00.000Z'),
    );

    expect(result).toEqual(expect.objectContaining({
      reliable: true,
      preview: expect.objectContaining({
        outcome: 'satisfied',
        deadlineGroup: {
          deadlineAt: '2026-09-04T12:00:00.000Z',
          gameIds: ['early-a', 'early-b'],
        },
        missingParticipants: [],
      }),
    }));
  });

  it('applies ID exclusions, catch-up, deterministic ordering, and enabled Target fan-out', () => {
    const result = evaluateReminderDryRun(
      configuration(),
      available(),
      new Date('2026-09-04T11:30:00.000Z'),
    );
    expect(result.reliable).toBe(true);
    if (!result.reliable) return;

    expect(result.preview.outcome).toBe('would-notify');
    expect(result.preview.stage?.beforeDeadlineMinutes).toBe(60);
    expect(result.preview.skippedStages.map(({ beforeDeadlineMinutes }) => beforeDeadlineMinutes))
      .toEqual([1440, 360]);
    expect(result.preview.missingParticipants).toEqual([
      { id: 'accent-a', displayName: 'é' },
      { id: 'accent-b', displayName: 'é' },
      { id: 'private', displayName: '\uE000' },
      { id: 'emoji', displayName: '😀' },
    ]);
    expect(result.preview.targets.map(({ id }) => id)).toEqual(['first', 'second']);
    expect(result.preview.targets.every(({ revision }) => /^[a-f0-9]{64}$/.test(revision))).toBe(true);
  });

  it('fails closed for unavailable, wrong-scope, or incomplete snapshots', () => {
    expect(evaluateReminderDryRun(configuration(), {
      available: false,
      reason: 'ambiguous-local-timestamp',
    })).toEqual({ reliable: false, reason: 'ambiguous-local-timestamp' });
    expect(evaluateReminderDryRun(configuration(), available(snapshot({ profileId: 'active-cli-profile' }))))
      .toEqual({ reliable: false, reason: 'snapshot-scope-mismatch' });
    expect(evaluateReminderDryRun(configuration(), available(snapshot({ cells: snapshot().cells.slice(1) }))))
      .toEqual({ reliable: false, reason: 'invalid-snapshot' });
  });
});

describe('service run-once --dry-run execution', () => {
  it('holds the Service Lock, keeps State byte-for-byte unchanged, and performs no provider I/O', async () => {
    setupService(configuration(), paths);
    const stateBefore = fs.readFileSync(paths.stateFile);
    const providerFetch = vi.fn();
    vi.stubGlobal('fetch', providerFetch);
    const getReminderCapability = vi.fn(async (profileId: string, communityId: string) => {
      expect(fs.existsSync(paths.serviceLockFile)).toBe(true);
      expect({ profileId, communityId }).toEqual({
        profileId: 'service-profile',
        communityId: 'family',
      });
      return available();
    });

    const result = await runReminderDryRun({
      paths,
      now: new Date('2026-09-04T11:30:00.000Z'),
      getReminderCapability,
    });

    expect(result.reliable && result.preview.outcome).toBe('would-notify');
    expect(getReminderCapability).toHaveBeenCalledOnce();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(paths.stateFile)).toEqual(stateBefore);
    expect(fs.existsSync(paths.serviceLockFile)).toBe(false);
  });

  it('uses the real scoped Reminder Capability path without contacting a Target provider', async () => {
    setupService(configuration(), paths);
    const stateBefore = fs.readFileSync(paths.stateFile);
    const profileConfigDir = path.join(root, '.config', 'kicktipp-agent');
    fs.mkdirSync(profileConfigDir, { recursive: true });
    fs.writeFileSync(path.join(profileConfigDir, 'config.ini'), `[profile.service-profile]\nemail = service@example.test\nstore = session\n`);
    fs.writeFileSync(path.join(profileConfigDir, 'session-service-profile.json'), JSON.stringify({ cookies: [] }));
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    vi.resetModules();
    const { setUrlBase } = await import('../src/url.js');
    setUrlBase('https://www.kicktipp.com');
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/info/profil/meinetipprunden')) return new Response('authenticated');
      if (url.endsWith('/family/schedule')) return new Response(SCHEDULE);
      if (url.endsWith('/family/leaderboard')) return new Response(PREDICTIONS);
      throw new Error(`Unexpected request: ${new URL(url).origin}`);
    });
    const { runReminderDryRun: run } = await import('../src/service/dry-run.js');

    const result = await run({
      paths,
      now: new Date('2026-08-28T18:00:00.000Z'),
      fetchImpl,
    });

    expect(result.reliable).toBe(true);
    expect(calls).toEqual([
      'https://www.kicktipp.com/info/profil/meinetipprunden',
      'https://www.kicktipp.com/family/schedule',
      'https://www.kicktipp.com/family/leaderboard',
    ]);
    expect(calls.every((url) => new URL(url).hostname.endsWith('kicktipp.com'))).toBe(true);
    expect(fs.readFileSync(paths.stateFile)).toEqual(stateBefore);
  });

  it('fails immediately behind another Service writer without evaluation or mutation', async () => {
    setupService(configuration(), paths);
    const stateBefore = fs.readFileSync(paths.stateFile);
    const getReminderCapability = vi.fn(async () => available());
    const lock = FileLock.acquire(paths.serviceLockFile);
    try {
      await expect(runReminderDryRun({ paths, getReminderCapability })).rejects.toThrow(LockUnavailableError);
      expect(getReminderCapability).not.toHaveBeenCalled();
      expect(fs.readFileSync(paths.stateFile)).toEqual(stateBefore);
    } finally {
      lock.release();
    }
  });
});
