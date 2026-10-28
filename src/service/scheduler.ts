import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DeadlineMatch, DeadlineReport } from '../analytics/deadline.js';
import { AuthError } from '../core.js';
import { SessionOnlyExpiredError } from '../config.js';
import { NotificationError, sendNotification, validateChannel, type NotificationChannel, type NotificationPayload } from '../notify/backends.js';

const DAY = 86_400_000;
const ALERT_COOLDOWN = 6 * 3600_000;
const MAX_RECORDS = 10_000;

interface DeliveryRecord {
  expiresAt: number;
  failures: number;
  sentAt?: number;
  nextAttemptAt?: number;
}

interface SchedulerState {
  version: 1;
  deliveries: Record<string, DeliveryRecord>;
}

export interface SchedulerStatus {
  running: boolean;
  lastCheck: string | null;
  lastSuccess: string | null;
  nextCheck: string | null;
  lastError: 'auth_required' | 'check_failed' | 'delivery_failed' | 'state_failed' | null;
  failedChannels: string[];
  deliveredCount: number;
}

export interface SchedulerOptions {
  channels: NotificationChannel[];
  warnHours: number[];
  everyMinutes: number;
  stateFile: string;
  /** The caller serializes this read with all other Kicktipp operations. */
  fetchReport: () => Promise<DeadlineReport>;
  send?: typeof sendNotification;
  now?: () => Date;
}

class StateError extends Error {}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readState(file: string): SchedulerState {
  if (!fs.existsSync(file)) return { version: 1, deliveries: {} };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as SchedulerState;
    if (value.version !== 1 || !value.deliveries || typeof value.deliveries !== 'object' || Array.isArray(value.deliveries)) {
      throw new Error('Invalid state');
    }
    if (Object.keys(value.deliveries).length > MAX_RECORDS) throw new Error('Too many records');
    for (const [key, row] of Object.entries(value.deliveries)) {
      if (!/^(?:alert:)?[a-f0-9]{64}$/.test(key) || !row || typeof row !== 'object' ||
        !Number.isFinite(row.expiresAt) || !Number.isInteger(row.failures) || row.failures < 0 ||
        (row.sentAt !== undefined && !Number.isFinite(row.sentAt)) ||
        (row.nextAttemptAt !== undefined && !Number.isFinite(row.nextAttemptAt))) throw new Error('Invalid record');
    }
    return value;
  } catch {
    throw new StateError('Reminder state cannot be read. Restore the state file from backup or move it aside to start a new reminder history.');
  }
}

export function reminderSummary(report: DeadlineReport, matches: DeadlineMatch[], warnHours: number): string {
  const format = new Intl.DateTimeFormat('de-DE', {
    timeZone: report.timeZone,
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return [
    `Kicktipp (${report.community}): ${matches.length} Tipp${matches.length === 1 ? '' : 's'} fehlen.`,
    `Anstoß innerhalb von ${warnHours} Stunde${warnHours === 1 ? '' : 'n'}:`,
    ...matches.map((match) => `${match.home} – ${match.away}: ${format.format(new Date(match.kickoff!))}`),
    `Zeitzone: ${report.timeZone}`,
  ].join('\n');
}

/**
 * A single instance runs one check at a time. Successful sends are checkpointed
 * separately for each channel/match/window, so a normal restart does not replay
 * reminders. A process crash between provider acceptance and the checkpoint can
 * still duplicate a message; external delivery and a local file are not atomic.
 */
export class DeadlineScheduler {
  private readonly channels: NotificationChannel[];
  private readonly windows: number[];
  private readonly interval: number;
  private readonly state: SchedulerState;
  private readonly clock: () => Date;
  private readonly send: typeof sendNotification;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private snapshot: SchedulerStatus = {
    running: false, lastCheck: null, lastSuccess: null, nextCheck: null,
    lastError: null, failedChannels: [], deliveredCount: 0,
  };

  constructor(private readonly options: SchedulerOptions) {
    this.channels = options.channels.map(validateChannel);
    if (new Set(this.channels.map((channel) => channel.id)).size !== this.channels.length) {
      throw new Error('Notification channel ids must be unique.');
    }
    if (!Number.isFinite(options.everyMinutes) || options.everyMinutes < 1 || options.everyMinutes > 1440) {
      throw new Error('Reminder check interval must be between 1 and 1440 minutes.');
    }
    if ((!options.warnHours.length && this.channels.length > 0) || options.warnHours.some((n) => !Number.isFinite(n) || n <= 0 || n > 168)) {
      throw new Error('Reminder windows must be greater than zero and at most 168 hours.');
    }
    this.windows = [...new Set(options.warnHours)].sort((a, b) => a - b);
    this.interval = options.everyMinutes * 60_000;
    this.clock = options.now ?? (() => new Date());
    this.send = options.send ?? sendNotification;
    this.state = readState(options.stateFile);
  }

  status(): SchedulerStatus {
    return { ...this.snapshot, failedChannels: [...this.snapshot.failedChannels] };
  }

  start(): void {
    if (this.snapshot.running) return;
    this.snapshot.running = true;
    this.snapshot.nextCheck = this.clock().toISOString();
    void this.runAndSchedule();
  }

  async stop(): Promise<void> {
    this.snapshot.running = false;
    this.snapshot.nextCheck = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  private async runAndSchedule(): Promise<void> {
    await this.runOnce();
    if (!this.snapshot.running) return;
    this.snapshot.nextCheck = new Date(this.clock().getTime() + this.interval).toISOString();
    this.timer = setTimeout(() => { void this.runAndSchedule(); }, this.interval);
    this.timer.unref();
  }

  runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.check().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private save(): void {
    const directory = path.dirname(this.options.stateFile);
    const temp = `${this.options.stateFile}.tmp`;
    try {
      if (Object.keys(this.state.deliveries).length > MAX_RECORDS) throw new Error('Reminder history too large');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(temp, this.options.stateFile);
    } catch {
      throw new StateError('Reminder state could not be saved.');
    }
  }

  private ready(key: string, now: number, alert = false): boolean {
    const row = this.state.deliveries[key];
    if (!row) return true;
    if (row.sentAt !== undefined && (!alert || now - row.sentAt < ALERT_COOLDOWN)) return false;
    return row.nextAttemptAt === undefined || row.nextAttemptAt <= now;
  }

  private async deliver(
    channel: NotificationChannel,
    payload: NotificationPayload,
    keys: { key: string; expiresAt: number }[],
    now: number,
  ): Promise<void> {
    try {
      await this.send(channel, payload);
    } catch (error) {
      for (const { key, expiresAt } of keys) {
        const failures = Math.min((this.state.deliveries[key]?.failures ?? 0) + 1, 8);
        const delay = Math.max(
          this.interval * Math.min(2 ** (failures - 1), 8),
          error instanceof NotificationError ? error.retryAfterMs ?? 0 : 0,
        );
        this.state.deliveries[key] = { failures, expiresAt, nextAttemptAt: now + delay };
      }
      if (!this.snapshot.failedChannels.includes(channel.id)) this.snapshot.failedChannels.push(channel.id);
      this.save();
      return;
    }
    for (const { key, expiresAt } of keys) {
      this.state.deliveries[key] = { expiresAt, sentAt: now, failures: 0 };
    }
    this.save();
    this.snapshot.deliveredCount++;
  }

  private async alert(kind: 'auth_required' | 'check_failed', now: number): Promise<void> {
    const payload: NotificationPayload = {
      event: 'service_error', code: kind,
      summary: kind === 'auth_required'
        ? 'Kicktipp: Anmeldung fehlgeschlagen oder Sitzung abgelaufen. Zugangsdaten mit „docker compose run --rm kicktipp setup“ prüfen. Erinnerungen können momentan nicht geprüft werden.'
        : 'Kicktipp: Die Fristen konnten nicht geprüft werden. Der Dienst versucht es beim nächsten Prüfintervall erneut. Status mit „docker compose exec kicktipp node dist/service/main.js status“ prüfen.',
    };
    for (const channel of this.channels) {
      const key = `alert:${hash([channel, kind])}`;
      if (this.ready(key, now, true)) await this.deliver(channel, payload, [{ key, expiresAt: now + 7 * DAY }], now);
    }
  }

  private async check(): Promise<void> {
    const now = this.clock().getTime();
    this.snapshot.lastCheck = new Date(now).toISOString();
    this.snapshot.lastError = null;
    this.snapshot.failedChannels = [];
    try {
      for (const [key, row] of Object.entries(this.state.deliveries)) {
        if (row.expiresAt <= now) delete this.state.deliveries[key];
      }
      // Verify writable persistence before any delivery, including on first boot.
      this.save();
      let report: DeadlineReport;
      try {
        report = await this.options.fetchReport();
      } catch (error) {
        const kind = error instanceof AuthError || error instanceof SessionOnlyExpiredError ? 'auth_required' : 'check_failed';
        this.snapshot.lastError = kind;
        await this.alert(kind, now);
        return;
      }
      this.snapshot.lastSuccess = this.clock().toISOString();
      for (const key of Object.keys(this.state.deliveries)) {
        if (key.startsWith('alert:')) delete this.state.deliveries[key];
      }
      this.save();
      // Refresh time after a potentially slow network request: do not warn about
      // matches that kicked off while the report was being fetched.
      const deliveryTime = this.clock().getTime();
      for (const channel of this.channels) {
        const groups = new Map<number, { match: DeadlineMatch; key: string; expiresAt: number }[]>();
        const seen = new Set<string>();
        for (const match of report.matches) {
          if (!match.needsBet || match.closed || !match.kickoff) continue;
          const kickoff = Date.parse(match.kickoff);
          const remaining = kickoff - deliveryTime;
          if (!Number.isFinite(kickoff) || remaining <= 0) continue;
          // At first boot send the most urgent crossed window, not every overdue window.
          const window = this.windows.find((hours) => remaining <= hours * 3600_000);
          if (window === undefined) continue;
          const key = hash([channel, report.community, match.home, match.away, match.kickoff, window]);
          if (seen.has(key)) continue;
          if (!this.ready(key, deliveryTime)) {
            // Waiting for a retry is still degraded, including after a restart.
            if (this.state.deliveries[key]?.failures && !this.snapshot.failedChannels.includes(channel.id)) {
              this.snapshot.failedChannels.push(channel.id);
            }
            continue;
          }
          seen.add(key);
          const group = groups.get(window) ?? [];
          group.push({ match, key, expiresAt: kickoff + 7 * DAY });
          groups.set(window, group);
        }
        for (const [window, entries] of groups) {
          const matches = entries.map((entry) => entry.match);
          await this.deliver(channel, {
            event: 'missing_tips', community: report.community, matchday: report.matchday,
            timeZone: report.timeZone, checkedAt: report.now, warnHours: window, matches,
            summary: reminderSummary(report, matches, window),
          }, entries, deliveryTime);
        }
      }
      if (this.snapshot.failedChannels.length) this.snapshot.lastError = 'delivery_failed';
    } catch (error) {
      this.snapshot.lastError = error instanceof StateError ? 'state_failed' : 'check_failed';
    }
  }
}
