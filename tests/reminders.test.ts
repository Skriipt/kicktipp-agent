import { describe, it, expect, vi } from 'vitest';
import { cronLine, systemdUnits, icsCalendar } from '../src/notify/schedule-artifacts.js';
import { notify } from '../src/notify/backends.js';
import { buildDeadlineReport } from '../src/analytics/deadline.js';
import type { BetMatch } from '../src/core.js';

const now = new Date('2026-08-21T12:00:00Z');

function report() {
  const matches: BetMatch[] = [
    { date: '21.08.26 16:00', home: 'Bayern', away: 'BVB', bet: '', odds: { home: '', draw: '', away: '' } },
    { date: '22.08.26 15:30', home: 'Freiburg', away: 'VfB', bet: '2:1', odds: { home: '', draw: '', away: '' } },
    { date: '20.08.26 20:30', home: 'Koeln', away: 'Mainz', bet: '1:1', odds: { home: '', draw: '', away: '' } },
  ];
  return buildDeadlineReport('mycomm', 4, matches, { now, timeZone: 'Europe/Berlin', warnHours: 6 });
}

describe('cronLine', () => {
  it('notifies only when the check reports urgency', () => {
    const line = cronLine({ everyMinutes: 60 });
    expect(line).toBe('0 */1 * * * kicktipp deadline --check >/dev/null || kicktipp notify');
  });

  it('uses a minute schedule below the hour', () => {
    expect(cronLine({ everyMinutes: 15 })).toMatch(/^\*\/15 \* \* \* \* /);
  });

  it('passes the window through and honours a custom binary', () => {
    const line = cronLine({ everyMinutes: 120, warnHours: 12, binary: '/opt/kicktipp/bin/kicktipp' });
    expect(line).toContain('--warn-hours 12');
    expect(line).toContain('/opt/kicktipp/bin/kicktipp deadline --check');
    expect(line).toContain('/opt/kicktipp/bin/kicktipp notify');
  });
});

describe('systemdUnits', () => {
  const units = systemdUnits({ everyMinutes: 30, warnHours: 4 });

  it('produces a oneshot service running the same check', () => {
    expect(units.service).toContain('Type=oneshot');
    expect(units.service).toContain('deadline --check');
    expect(units.service).toContain('--warn-hours 4');
    expect(units.service).toContain('|| kicktipp notify');
  });

  it('produces a timer that survives downtime', () => {
    expect(units.timer).toContain('OnUnitActiveSec=30min');
    expect(units.timer).toContain('Persistent=true');
    expect(units.timer).toContain('WantedBy=timers.target');
  });
});

describe('icsCalendar', () => {
  const ics = icsCalendar(report(), 90);

  it('wraps events in a valid calendar envelope', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect(ics.split('\r\n').every((line) => !line.startsWith(' '))).toBe(true);
  });

  it('includes only kickoffs that have not happened yet', () => {
    expect(ics).toContain('Bayern vs BVB');
    expect(ics).toContain('Freiburg vs VfB');
    // Already kicked off, so no reminder is useful.
    expect(ics).not.toContain('Koeln vs Mainz');
  });

  it('carries an alarm at the requested lead time', () => {
    expect(ics).toContain('TRIGGER:-PT90M');
    expect((ics.match(/BEGIN:VALARM/g) || []).length).toBe(2);
  });

  it('formats timestamps as UTC basic form', () => {
    expect(ics).toContain('DTSTART:20260821T140000Z');
  });

  it('says whether a bet exists', () => {
    expect(ics).toContain('No bet placed yet');
    expect(ics).toContain('Your bet: 2:1');
  });
});

describe('notify', () => {
  it('posts the summary and payload to a webhook', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await notify({ kind: 'webhook', target: 'https://ntfy.example/topic' }, 'two to go', report(), {
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ntfy.example/topic');
    expect(calls[0].body).toMatchObject({ summary: 'two to go', community: 'mycomm' });
  });

  it('surfaces a failing webhook rather than swallowing it', async () => {
    const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(
      notify({ kind: 'webhook', target: 'https://x.example' }, 's', {}, { fetchImpl }),
    ).rejects.toThrow(/answered 500/);
  });

  it('refuses a webhook with no target instead of inventing one', async () => {
    await expect(notify({ kind: 'webhook' }, 's', {})).rejects.toThrow(/needs a target URL/);
  });

  it('refuses a command with no target', async () => {
    await expect(notify({ kind: 'command' }, 's', {})).rejects.toThrow(/needs a command/);
  });

  it('rejects an unknown backend', async () => {
    await expect(notify({ kind: 'sms' as never }, 's', {})).rejects.toThrow(/Unknown notifier/);
  });

  it('runs a command backend with the summary as an argument', async () => {
    // `true` ignores its arguments and exits 0 on every POSIX system.
    await expect(notify({ kind: 'command', target: 'true' }, 'summary', {})).resolves.toBeUndefined();
  });

  it('reports a command that does not exist', async () => {
    await expect(
      notify({ kind: 'command', target: 'definitely-not-a-real-binary-xyz' }, 's', {}),
    ).rejects.toThrow(/Could not run/);
  });
});
