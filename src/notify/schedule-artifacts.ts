import type { DeadlineReport } from '../analytics/deadline.js';

export interface ArtifactOptions {
  /** How the CLI is invoked; defaults to whatever is on PATH. */
  binary?: string;
  everyMinutes?: number;
  warnHours?: number;
}

function checkCommand(opts: ArtifactOptions): string {
  const parts = [opts.binary ?? 'kicktipp', 'deadline', '--check'];
  if (opts.warnHours !== undefined) parts.push('--warn-hours', String(opts.warnHours));
  return parts.join(' ');
}

function notifyCommand(opts: ArtifactOptions): string {
  return `${opts.binary ?? 'kicktipp'} notify`;
}

/**
 * A crontab line that notifies only when something actually needs a bet:
 * `deadline --check` exits 2 in that case, and `||` fires the notifier.
 */
export function cronLine(opts: ArtifactOptions = {}): string {
  const every = opts.everyMinutes ?? 60;
  const schedule = every >= 60 ? `0 */${Math.round(every / 60)} * * *` : `*/${every} * * * *`;
  return `${schedule} ${checkCommand(opts)} >/dev/null || ${notifyCommand(opts)}`;
}

export interface SystemdUnits {
  service: string;
  timer: string;
}

export function systemdUnits(opts: ArtifactOptions = {}): SystemdUnits {
  const every = opts.everyMinutes ?? 60;
  const service = [
    '[Unit]',
    'Description=Check kicktipp for matches that still need a bet',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=/bin/sh -c '${checkCommand(opts)} >/dev/null || ${notifyCommand(opts)}'`,
    '',
  ].join('\n');

  const timer = [
    '[Unit]',
    'Description=Periodic kicktipp deadline check',
    '',
    '[Timer]',
    `OnUnitActiveSec=${every}min`,
    'OnBootSec=5min',
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');

  return { service, timer };
}

function icsTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(value: string): string {
  return value.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}

/**
 * A calendar file with one alarmed event per open kickoff, for people who
 * would rather their calendar did the nagging.
 */
export function icsCalendar(report: DeadlineReport, alarmMinutes = 120): string {
  const events = report.matches
    .filter((m) => m.kickoff && !m.closed)
    .map((m, index) =>
      [
        'BEGIN:VEVENT',
        `UID:kicktipp-${report.community}-${report.matchday ?? 'current'}-${index}@kicktipp-agent`,
        `DTSTAMP:${icsTimestamp(report.now)}`,
        `DTSTART:${icsTimestamp(m.kickoff as string)}`,
        `SUMMARY:${escapeText(`Kicktipp deadline: ${m.home} vs ${m.away}`)}`,
        `DESCRIPTION:${escapeText(m.bet ? `Your bet: ${m.bet}` : 'No bet placed yet for this match.')}`,
        'BEGIN:VALARM',
        `TRIGGER:-PT${alarmMinutes}M`,
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(`Bet on ${m.home} vs ${m.away}`)}`,
        'END:VALARM',
        'END:VEVENT',
      ].join('\r\n'),
    );

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//kicktipp-agent//EN',
    'CALSCALE:GREGORIAN',
    ...events,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}
