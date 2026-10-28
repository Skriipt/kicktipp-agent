import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DeadlineBonusQuestion, DeadlineMatch, DeadlineReport } from '../analytics/deadline.js';
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
  unresolvedBonusQuestions: number;
}

export interface SchedulerOptions {
  channels: NotificationChannel[];
  warnHours: number[];
  everyMinutes: number;
  stateFile: string;
  /** The caller serializes this read with all other Kicktipp operations. */
  fetchReport: () => Promise<DeadlineReport | DeadlineReport[]>;
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

function bonusReminderSummary(report: DeadlineReport, questions: DeadlineBonusQuestion[], warnHours: number): string {
  const format = new Intl.DateTimeFormat('de-DE', {
    timeZone: report.timeZone, dateStyle: 'short', timeStyle: 'short',
  });
  return [
    `Kicktipp (${report.community}): ${questions.length} Bonusfrage${questions.length === 1 ? ' ist' : 'n sind'} noch nicht vollständig beantwortet.`,
    `Abgabefrist innerhalb von ${warnHours} Stunde${warnHours === 1 ? '' : 'n'}:`,
    ...questions.map((question) => `${question.question}: ${format.format(new Date(question.deadline!))} (${question.missingAnswers} Antwort${question.missingAnswers === 1 ? '' : 'en'} offen)`),
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
    lastError: null, failedChannels: [], deliveredCount: 0, unresolvedBonusQuestions: 0,
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

  private async remindBonus(report: DeadlineReport, channel: NotificationChannel): Promise<void> {
    const now = this.clock().getTime();
    const groups = new Map<number, { question: DeadlineBonusQuestion; key: string; expiresAt: number }[]>();
    const seen = new Set<string>();
    for (const question of report.bonusQuestions ?? []) {
      if (!question.editable || question.missingAnswers <= 0 || !question.deadline) continue;
      const deadline = Date.parse(question.deadline);
      const remaining = deadline - now;
      if (!Number.isFinite(deadline) || remaining <= 0) continue;
      const window = this.windows.find((hours) => remaining <= hours * 3600_000);
      if (window === undefined) continue;
      // Preserve existing fixture keys; bonus identities live in their own namespace.
      const key = hash(['bonus', channel, report.community, question.id, question.deadline, window]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!this.ready(key, now)) {
        if (this.state.deliveries[key]?.failures && !this.snapshot.failedChannels.includes(channel.id)) {
          this.snapshot.failedChannels.push(channel.id);
        }
        continue;
      }
      const group = groups.get(window) ?? [];
      group.push({ question, key, expiresAt: deadline + 7 * DAY });
      groups.set(window, group);
    }
    for (const [window, entries] of groups) {
      const deliveryTime = this.clock().getTime();
      // Earlier provider calls may have consumed the remaining time.
      const pending = entries.filter(({ question }) => Date.parse(question.deadline!) > deliveryTime);
      if (!pending.length) continue;
      const bonusQuestions = pending.map(({ question }) => question);
      await this.deliver(channel, {
        event: 'missing_bonus', community: report.community, matchday: report.matchday,
        timeZone: report.timeZone, checkedAt: report.now, warnHours: window, bonusQuestions,
        summary: bonusReminderSummary(report, bonusQuestions, window),
      }, pending, deliveryTime);
    }
  }

  private async check(): Promise<void> {
    const now = this.clock().getTime();
    this.snapshot.lastCheck = new Date(now).toISOString();
    this.snapshot.lastError = null;
    this.snapshot.failedChannels = [];
    this.snapshot.unresolvedBonusQuestions = 0;
    try {
      for (const [key, row] of Object.entries(this.state.deliveries)) {
        if (row.expiresAt <= now) delete this.state.deliveries[key];
      }
      // Verify writable persistence before any delivery, including on first boot.
      this.save();
      let reports: DeadlineReport[];
      try {
        const result = await this.options.fetchReport();
        reports = Array.isArray(result) ? result : [result];
      } catch (error) {
        const kind = error instanceof AuthError || error instanceof SessionOnlyExpiredError ? 'auth_required' : 'check_failed';
        this.snapshot.lastError = kind;
        await this.alert(kind, now);
        return;
      }
      const readableReports = reports.filter((report) => !report.readError);
      this.snapshot.unresolvedBonusQuestions = readableReports.reduce((count, report) =>
        count + (report.bonusQuestions ?? []).filter((question) =>
          question.editable && question.missingAnswers > 0 &&
          (!question.deadline || !Number.isFinite(Date.parse(question.deadline))),
        ).length, 0);
      const readFailure = reports.some((report) => report.readError === 'auth_required')
        ? 'auth_required'
        : reports.some((report) => report.readError || report.bonusCheckFailed) ? 'check_failed' : null;
      if (readFailure) {
        this.snapshot.lastError = readFailure;
        await this.alert(readFailure, now);
      } else {
        this.snapshot.lastSuccess = this.clock().toISOString();
        for (const key of Object.keys(this.state.deliveries)) {
          if (key.startsWith('alert:')) delete this.state.deliveries[key];
        }
      }
      this.save();
      for (const report of readableReports) {
        // Refresh time after a potentially slow read or another group's delivery.
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
          await this.remindBonus(report, channel);
        }
      }
      if (this.snapshot.failedChannels.length) this.snapshot.lastError = 'delivery_failed';
    } catch (error) {
      this.snapshot.lastError = error instanceof StateError ? 'state_failed' : 'check_failed';
    }
  }
}
