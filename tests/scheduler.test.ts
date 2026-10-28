import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeadlineScheduler } from '../src/service/scheduler.js';
import { NotificationError, type NotificationChannel } from '../src/notify/backends.js';
import type { DeadlineReport } from '../src/analytics/deadline.js';
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

function make(data = report(), options: Partial<ConstructorParameters<typeof DeadlineScheduler>[0]> = {}) {
  const send = vi.fn(async () => {});
  const fetchReport = vi.fn(async () => data);
  const scheduler = new DeadlineScheduler({
    channels: [first, second], warnHours: [24, 6, 1], everyMinutes: 15,
    stateFile: path.join(directory, 'state.json'), fetchReport, send, now: () => now, ...options,
  });
  return { scheduler, send, fetchReport };
}

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
