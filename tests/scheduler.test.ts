import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeadlineScheduler } from '../src/service/scheduler.js';
import { NotificationError, type NotificationChannel } from '../src/notify/backends.js';
import type { DeadlineBonusQuestion, DeadlineReport } from '../src/analytics/deadline.js';
import { AuthError } from '../src/core.js';

let directory: string;
let now: Date;
const first: NotificationChannel = { id: 'first', kind: 'webhook', url: 'https://example.test/first-secret' };
const second: NotificationChannel = { id: 'second', kind: 'telegram', botToken: '123:second-secret', chatId: '456' };

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-scheduler-'));
  now = new Date('2026-10-28T12:00:00Z');
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});

function report(hours = 4): DeadlineReport {
  return {
    community: 'test', matchday: 9, timeZone: 'Europe/Berlin', now: now.toISOString(),
    nextKickoff: new Date(now.getTime() + hours * 3600000).toISOString(), nextKickoffIn: null,
    openCount: 1, needsBetCount: 1, urgentCount: 1, warnHours: 24,
    matches: [{ home: 'Bayern', away: 'BVB', bet: null, needsBet: true, closed: false, urgent: true,
      kickoff: new Date(now.getTime() + hours * 3600000).toISOString() }],
  };
}

function make(data: DeadlineReport | DeadlineReport[] = report(), options: Partial<ConstructorParameters<typeof DeadlineScheduler>[0]> = {}) {
  const send = vi.fn(async () => {});
  const fetchReport = vi.fn(async () => data);
  const scheduler = new DeadlineScheduler({
    channels: [first, second], warnHours: [24, 6, 1], everyMinutes: 15,
    stateFile: path.join(directory, 'state.json'), fetchReport, send, now: () => now, ...options,
  });
  return { scheduler, send, fetchReport };
}

describe('multiple subscribed groups', () => {
  it('delivers identical fixtures and bonus questions separately for each group and persists both', async () => {
    const firstGroup = { ...bonusReport(), matches: report().matches };
    const secondGroup = { ...structuredClone(firstGroup), community: 'another-group' };
    const data = [firstGroup, secondGroup];
    const { scheduler, send } = make(data, { channels: [first] });
    await scheduler.runOnce();
    expect(send.mock.calls).toEqual([
      [first, expect.objectContaining({ event: 'missing_tips', community: 'test' })],
      [first, expect.objectContaining({ event: 'missing_bonus', community: 'test' })],
      [first, expect.objectContaining({ event: 'missing_tips', community: 'another-group' })],
      [first, expect.objectContaining({ event: 'missing_bonus', community: 'another-group' })],
    ]);
    expect(scheduler.status()).toMatchObject({ lastSuccess: '2026-10-28T12:00:00.000Z', lastError: null });
    const restarted = make(data, { channels: [first] });
    await restarted.scheduler.runOnce();
    expect(restarted.send).not.toHaveBeenCalled();
  });

  it('delivers a healthy group despite another group failing, and only records complete recovery as successful', async () => {
    const healthy = report();
    const failed = { ...report(), community: 'failed-group', readError: 'check_failed' as const };
    const data: DeadlineReport[] = [failed, healthy];
    const { scheduler, send } = make(data, { channels: [first] });
    await scheduler.runOnce();
    expect(send.mock.calls).toEqual([
      [first, expect.objectContaining({ event: 'service_error', code: 'check_failed' })],
      [first, expect.objectContaining({ event: 'missing_tips', community: 'test' })],
    ]);
    expect(scheduler.status()).toMatchObject({ lastError: 'check_failed', lastSuccess: null });
    now = new Date('2026-10-28T12:15:00Z');
    await scheduler.runOnce();
    expect(send).toHaveBeenCalledTimes(2);
    delete data[0].readError;
    now = new Date('2026-10-28T12:30:00Z');
    await scheduler.runOnce();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2]).toMatchObject([first, { event: 'missing_tips', community: 'failed-group' }]);
    expect(scheduler.status()).toMatchObject({ lastError: null, lastSuccess: '2026-10-28T12:30:00.000Z' });
    data[0].readError = 'check_failed';
    now = new Date('2026-10-28T12:45:00Z');
    await scheduler.runOnce();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[3]).toMatchObject([first, { event: 'service_error', code: 'check_failed' }]);
    expect(scheduler.status().lastSuccess).toBe('2026-10-28T12:30:00.000Z');
  });

  it('prefers an authentication alert and aggregates unknown deadlines only from readable groups', async () => {
    const data: DeadlineReport[] = [
      { ...bonusReport({ deadline: null }), community: 'failed-group', readError: 'check_failed' },
      { ...bonusReport({ deadline: null }), community: 'expired-session', readError: 'auth_required' },
      { ...bonusReport({ deadline: null }), community: 'readable-group' },
      { ...bonusReport({ deadline: 'unknown' }), community: 'partial-bonus-group', bonusCheckFailed: true },
    ];
    const { scheduler, send } = make(data, { channels: [first] });
    await scheduler.runOnce();
    expect(send.mock.calls).toEqual([[first, expect.objectContaining({ event: 'service_error', code: 'auth_required' })]]);
    expect(scheduler.status()).toMatchObject({ lastError: 'auth_required', lastSuccess: null, unresolvedBonusQuestions: 2 });
    const restarted = make(data, { channels: [first] });
    await restarted.scheduler.runOnce();
    expect(restarted.send).not.toHaveBeenCalled();
  });
});

function bonusReport(overrides: Partial<DeadlineBonusQuestion> = {}): DeadlineReport {
  return {
    ...report(), matches: [],
    bonusQuestions: [{
      id: 'relegation-222', question: 'Wer steigt ab?', deadline: '2026-10-28T16:00:00.000Z',
      missingAnswers: 2, editable: true, ...overrides,
    }],
  };
}

describe('bonus question reminders', () => {
  it('reminds about a partially answered question at the most urgent window and deduplicates across restart', async () => {
    const data = bonusReport();
    const { scheduler, send } = make(data);
    await scheduler.runOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toMatchObject([first, {
      event: 'missing_bonus', community: 'test', matchday: 9, timeZone: 'Europe/Berlin',
      checkedAt: '2026-10-28T12:00:00.000Z', warnHours: 6,
      bonusQuestions: [{ id: 'relegation-222', question: 'Wer steigt ab?', missingAnswers: 2 }],
      summary: expect.stringContaining('Abgabefrist'),
    }]);
    expect(send.mock.calls[0][1]).toMatchObject({ summary: expect.stringContaining('17:00') });
    const restarted = make(data);
    await restarted.scheduler.runOnce();
    expect(restarted.send).not.toHaveBeenCalled();
    now = new Date('2026-10-28T15:30:00Z');
    await restarted.scheduler.runOnce();
    expect(restarted.send).toHaveBeenCalledTimes(2);
    expect(restarted.send.mock.calls[0]).toMatchObject([first, { event: 'missing_bonus', warnHours: 1 }]);
    const state = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
    expect(state).not.toContain('secret');
    expect(state).not.toContain('Wer steigt ab');
  });

  it.each([
    ['complete', { missingAnswers: 0 }],
    ['closed', { editable: false }],
    ['unknown deadline', { deadline: null }],
    ['unparseable deadline', { deadline: 'unknown' }],
    ['past deadline', { deadline: '2026-10-28T11:59:00Z' }],
    ['deadline now', { deadline: '2026-10-28T12:00:00Z' }],
    ['outside warning windows', { deadline: '2026-10-30T12:00:00Z' }],
  ] as const)('skips %s questions', async (_label, overrides) => {
    const { scheduler, send } = make(bonusReport(overrides));
    await scheduler.runOnce();
    expect(send).not.toHaveBeenCalled();
    expect(scheduler.status().unresolvedBonusQuestions).toBe(
      ['unknown deadline', 'unparseable deadline'].includes(_label) ? 1 : 0,
    );
  });

  it('resets the unresolved question count once a deadline can be read', async () => {
    const data = bonusReport({ deadline: null });
    const { scheduler, send } = make(data);
    await scheduler.runOnce();
    expect(scheduler.status().unresolvedBonusQuestions).toBe(1);
    data.bonusQuestions![0].deadline = '2026-10-28T16:00:00Z';
    await scheduler.runOnce();
    expect(scheduler.status().unresolvedBonusQuestions).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps match reminders working when bonus checks fail and persists the operational alert cooldown', async () => {
    const data = report();
    data.bonusCheckFailed = true;
    const { scheduler, send } = make(data, { channels: [first] });
    await scheduler.runOnce();
    expect(scheduler.status()).toMatchObject({ lastError: 'check_failed', lastSuccess: null });
    expect(send.mock.calls).toEqual([
      [first, expect.objectContaining({ event: 'service_error', code: 'check_failed' })],
      [first, expect.objectContaining({ event: 'missing_tips' })],
    ]);
    now = new Date('2026-10-28T12:15:00Z');
    const restarted = make(data, { channels: [first] });
    await restarted.scheduler.runOnce();
    expect(restarted.send).not.toHaveBeenCalled();
    expect(restarted.scheduler.status()).toMatchObject({ lastError: 'check_failed', lastSuccess: null });
    data.bonusCheckFailed = false;
    await restarted.scheduler.runOnce();
    expect(restarted.scheduler.status()).toMatchObject({ lastError: null, lastSuccess: '2026-10-28T12:15:00.000Z' });
    data.bonusCheckFailed = true;
    now = new Date('2026-10-28T12:30:00Z');
    await restarted.scheduler.runOnce();
    expect(restarted.send.mock.calls).toEqual([[first, expect.objectContaining({ event: 'service_error', code: 'check_failed' })]]);
    expect(restarted.scheduler.status().lastSuccess).toBe('2026-10-28T12:15:00.000Z');
  });

  it('does not send when a question closes while the report is being fetched', async () => {
    const data = bonusReport({ deadline: '2026-10-28T12:00:30Z' });
    const { scheduler, send } = make(data, { fetchReport: async () => {
      now = new Date('2026-10-28T12:01:00Z');
      return data;
    } });
    await scheduler.runOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('retries only the failed destination and stops subsequent reminders once all answers are filled', async () => {
    const data = bonusReport();
    const send = vi.fn(async (channel: NotificationChannel) => {
      if (channel.id === 'second') throw new Error('provider secret');
    });
    const { scheduler } = make(data, { send });
    await scheduler.runOnce();
    expect(scheduler.status()).toMatchObject({ lastError: 'delivery_failed', failedChannels: ['second'] });
    const restarted = make(data);
    await restarted.scheduler.runOnce();
    expect(restarted.send).not.toHaveBeenCalled();
    expect(restarted.scheduler.status().failedChannels).toEqual(['second']);
    now = new Date('2026-10-28T12:15:00Z');
    await restarted.scheduler.runOnce();
    expect(restarted.send).toHaveBeenCalledTimes(1);
    expect(restarted.send.mock.calls[0]).toMatchObject([second, { event: 'missing_bonus' }]);
    data.bonusQuestions![0].missingAnswers = 0;
    now = new Date('2026-10-28T15:30:00Z');
    await restarted.scheduler.runOnce();
    expect(restarted.send).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending retry when the latest report has all answers filled', async () => {
    const data = bonusReport();
    const send = vi.fn(async () => { throw new Error('temporary provider failure'); });
    await make(data, { channels: [first], send }).scheduler.runOnce();
    data.bonusQuestions![0].missingAnswers = 0;
    now = new Date('2026-10-28T12:15:00Z');
    const restarted = make(data, { channels: [first] });
    await restarted.scheduler.runOnce();
    expect(restarted.send).not.toHaveBeenCalled();
    expect(restarted.scheduler.status().failedChannels).toEqual([]);
  });

  it('keeps question and community identities separate and deduplicates repeated rows', async () => {
    const data = bonusReport();
    data.matches = report().matches;
    data.bonusQuestions!.push({ ...data.bonusQuestions![0] });
    const firstRun = make(data, { channels: [first] });
    await firstRun.scheduler.runOnce();
    expect(firstRun.send).toHaveBeenCalledTimes(2);
    expect(firstRun.send.mock.calls[0]).toMatchObject([first, { event: 'missing_tips' }]);
    expect(firstRun.send.mock.calls[1]).toMatchObject([first, { event: 'missing_bonus', bonusQuestions: [data.bonusQuestions![0]] }]);
    data.community = 'another-group';
    const otherGroup = make(data, { channels: [first] });
    await otherGroup.scheduler.runOnce();
    expect(otherGroup.send).toHaveBeenCalledTimes(2);
    data.matches = [];
    data.bonusQuestions = [{ ...data.bonusQuestions![0], id: 'another-question' }];
    const otherQuestion = make(data, { channels: [first] });
    await otherQuestion.scheduler.runOnce();
    expect(otherQuestion.send).toHaveBeenCalledTimes(1);
    data.bonusQuestions![0].deadline = '2026-10-28T17:00:00Z';
    const movedDeadline = make(data, { channels: [first] });
    await movedDeadline.scheduler.runOnce();
    expect(movedDeadline.send).toHaveBeenCalledTimes(1);
  });
});

describe('durable deadline scheduler', () => {
  it('checks immediately, repeats on its interval, and stops scheduling on shutdown', async () => {
    vi.useFakeTimers();
    const { scheduler, fetchReport } = make();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchReport).toHaveBeenCalledTimes(1);
    expect(scheduler.status()).toMatchObject({ running: true, nextCheck: '2026-10-28T12:15:00.000Z' });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(fetchReport).toHaveBeenCalledTimes(2);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchReport).toHaveBeenCalledTimes(2);
    expect(scheduler.status()).toMatchObject({ running: false, nextCheck: null });
  });

  it('sends only the most urgent crossed window and persists success independently per channel', async () => {
    const data = report(4);
    const { scheduler, send } = make(data);
    await scheduler.runOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toMatchObject([first, { event: 'missing_tips', warnHours: 6, community: 'test' }]);
    await scheduler.runOnce();
    expect(send).toHaveBeenCalledTimes(2);
    const restarted = make(data);
    await restarted.scheduler.runOnce();
    expect(restarted.send).not.toHaveBeenCalled();
    const state = fs.readFileSync(path.join(directory, 'state.json'), 'utf8');
    expect(state).not.toContain('secret');
    expect(state).not.toContain('Bayern');
  });

  it('sends the next warning window and ignores completed or unparseable fixtures', async () => {
    const data = report(4);
    data.matches.push({ ...data.matches[0], home: 'Tipped', needsBet: false, bet: '1:1' });
    data.matches.push({ ...data.matches[0], home: 'Unknown', kickoff: null });
    const { scheduler, send } = make(data);
    await scheduler.runOnce();
    now = new Date(now.getTime() + 3.5 * 3600000);
    await scheduler.runOnce();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[2]).toMatchObject([first, { warnHours: 1, matches: [{ home: 'Bayern' }] }]);
    now = new Date(now.getTime() + 3600000);
    await scheduler.runOnce();
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('retries only the failed channel after its persisted backoff', async () => {
    const data = report(4);
    const send = vi.fn(async (channel: NotificationChannel) => {
      if (channel.id === 'second') throw new Error('provider secret');
    });
    const { scheduler } = make(data, { send });
    await scheduler.runOnce();
    expect(scheduler.status()).toMatchObject({ lastError: 'delivery_failed', failedChannels: ['second'] });
    const next = make(data);
    await next.scheduler.runOnce();
    expect(next.send).not.toHaveBeenCalled();
    expect(next.scheduler.status()).toMatchObject({ lastError: 'delivery_failed', failedChannels: ['second'] });
    now = new Date(now.getTime() + 15 * 60000);
    await next.scheduler.runOnce();
    expect(next.send).toHaveBeenCalledTimes(1);
    expect(next.send.mock.calls[0][0]).toEqual(second);
  });

  it('respects provider retry delays even after restarting', async () => {
    const data = report(4);
    const send = vi.fn(async () => { throw new NotificationError('rate limited', 3600000); });
    await make(data, { send }).scheduler.runOnce();
    now = new Date(now.getTime() + 30 * 60000);
    const next = make(data);
    await next.scheduler.runOnce();
    expect(next.send).not.toHaveBeenCalled();
    now = new Date(now.getTime() + 30 * 60000);
    await next.scheduler.runOnce();
    expect(next.send).toHaveBeenCalledTimes(2);
  });

  it('treats a changed kickoff or changed channel destination as a new reminder', async () => {
    const data = report(4);
    await make(data).scheduler.runOnce();
    data.matches[0].kickoff = new Date(now.getTime() + 5 * 3600000).toISOString();
    const moved = make(data);
    await moved.scheduler.runOnce();
    expect(moved.send).toHaveBeenCalledTimes(2);
    const changed = make(data, { channels: [{ ...first, url: 'https://example.test/replacement' }] });
    await changed.scheduler.runOnce();
    expect(changed.send).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping checks and waits for an in-flight check during shutdown', async () => {
    let finish: (value: DeadlineReport) => void = () => {};
    const fetchReport = vi.fn(() => new Promise<DeadlineReport>((resolve) => { finish = resolve; }));
    const { scheduler, send } = make(report(), { fetchReport });
    const a = scheduler.runOnce();
    const b = scheduler.runOnce();
    expect(a).toBe(b);
    const stopping = scheduler.stop();
    expect(fetchReport).toHaveBeenCalledTimes(1);
    finish(report());
    await Promise.all([a, b, stopping]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(scheduler.status().running).toBe(false);
  });

  it('does not send reminders for a game that starts while the fetch is pending', async () => {
    const data = report(0.01);
    const { scheduler, send } = make(data, { fetchReport: async () => {
      now = new Date(now.getTime() + 60_000);
      return data;
    } });
    await scheduler.runOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a sanitized login failure alert with restart-persistent cooldown', async () => {
    const fetchReport = async () => { throw new AuthError('bad credentials: secret@example.test'); };
    const { scheduler, send } = make(report(), { fetchReport });
    await scheduler.runOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]).toMatchObject([first, { event: 'service_error', code: 'auth_required' }]);
    expect(JSON.stringify(send.mock.calls)).not.toContain('secret@example.test');
    expect(scheduler.status()).toMatchObject({ lastError: 'auth_required', lastSuccess: null });
    const restarted = make(report(), { fetchReport });
    await restarted.scheduler.runOnce();
    expect(restarted.send).not.toHaveBeenCalled();
    now = new Date(now.getTime() + 6 * 3600000);
    await restarted.scheduler.runOnce();
    expect(restarted.send).toHaveBeenCalledTimes(2);
  });

  it('refuses corrupt state instead of silently replaying all reminders', () => {
    fs.writeFileSync(path.join(directory, 'state.json'), 'not json');
    expect(() => make()).toThrow('Reminder state cannot be read');
  });

  it('does not send when persistence cannot be written', async () => {
    const { scheduler, send } = make();
    fs.rmSync(directory, { recursive: true });
    fs.writeFileSync(directory, 'not a directory');
    await scheduler.runOnce();
    expect(send).not.toHaveBeenCalled();
    expect(scheduler.status().lastError).toBe('state_failed');
  });

  it('prunes expired history and deduplicates duplicate fixture rows', async () => {
    const data = report(4);
    data.matches.push({ ...data.matches[0] });
    const { scheduler, send } = make(data);
    await scheduler.runOnce();
    expect(send.mock.calls[0]).toMatchObject([first, { matches: [{ home: 'Bayern' }] }]);
    now = new Date(now.getTime() + 8 * 86400000);
    await scheduler.runOnce();
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'state.json'), 'utf8')).deliveries).toEqual({});
  });
});
