/**
 * Kicktipp's HTML is not what the browser shows.
 *
 * `.kicktipp-time` cells are printed in a fixed server zone and rewritten by
 * page JavaScript into the visitor's local clock. The CLI reads the HTML
 * before that rewrite:
 *
 *   kicktipp.de  →  `28.08.26 20:30`     (Europe/Berlin)
 *   kicktipp.com →  `8/28/26 1:30 PM`    (America/Chicago)
 *
 * Those two strings are the same instant. A Berlin browser on .com then
 * displays `8/28/26 8:30 PM`. Parsing the HTML as if it were already local
 * (13:30) is what made `today` lie.
 *
 * KICKTIPP_TZ (IANA) is the *display* zone, matching that JavaScript. It
 * does not change how the HTML is read.
 */
const GERMAN_DATE = /^\d{2}\.\d{2}\.\d{2}\s+\d{2}:\d{2}$/;
const US_DATE = /^\d{1,2}\/\d{1,2}\/\d{2}\s+\d{1,2}:\d{2}\s*(AM|PM)$/i;

/** Zone to show times in — the browser's local clock, unless overridden. */
export function displayTimeZone(): string {
  return (
    process.env.KICKTIPP_TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  );
}

/** Zone the HTML wall clock was printed in, inferred from its format. */
export function printedTimeZone(dateStr: string): string {
  const trimmed = dateStr.trim();
  if (GERMAN_DATE.test(trimmed)) return 'Europe/Berlin';
  if (US_DATE.test(trimmed)) return 'America/Chicago';
  return displayTimeZone();
}

/**
 * Kicktipp leaves the date cell empty on later rows that share a kickoff.
 * Carry the last printed value forward, the way the page does visually.
 */
export function inheritPrintedDate(raw: string, previous: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  return text || previous;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export type StrictTimestampResolution =
  | { resolved: true; instant: Date }
  | {
      resolved: false;
      reason:
        | 'invalid-timestamp'
        | 'unknown-source-time-zone'
        | 'ambiguous-local-timestamp'
        | 'nonexistent-local-timestamp';
    };

/** Read the wall-clock parts out of Kicktipp's German or US date formats. */
function parseWallClock(dateStr: string): Wall | null {
  const trimmed = dateStr.trim();

  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (us) {
    const [, m, d, y, h, min, ampm] = us;
    let hour = parseInt(h, 10);
    if (hour < 1 || hour > 12) return null;
    if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
    return {
      year: 2000 + parseInt(y, 10),
      month: parseInt(m, 10),
      day: parseInt(d, 10),
      hour,
      minute: parseInt(min, 10),
    };
  }

  const de = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})$/);
  if (de) {
    const [, d, m, y, h, min] = de;
    return {
      year: 2000 + parseInt(y, 10),
      month: parseInt(m, 10),
      day: parseInt(d, 10),
      hour: parseInt(h, 10),
      minute: parseInt(min, 10),
    };
  }

  return null;
}

/** Offset in minutes between UTC and `timeZone` at a given instant. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return (asUtc - instant.getTime()) / 60000;
}

function wallClockAt(instant: Date, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const get = (type: string): number =>
    Number(parts.find((value) => value.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

/**
 * Resolve a provider wall clock only when it identifies exactly one instant.
 * This strict path is for autonomous reminders; legacy interactive views keep
 * their best-effort parsing behavior through `parseMatchDate`.
 */
export function resolveMatchDateStrict(
  dateStr: string,
  timeZone: string,
): StrictTimestampResolution {
  const wall = parseWallClock(dateStr);
  if (!wall) return { resolved: false, reason: 'invalid-timestamp' };

  const naiveUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );
  const normalized = new Date(naiveUtc);
  if (
    normalized.getUTCFullYear() !== wall.year ||
    normalized.getUTCMonth() + 1 !== wall.month ||
    normalized.getUTCDate() !== wall.day ||
    normalized.getUTCHours() !== wall.hour ||
    normalized.getUTCMinutes() !== wall.minute
  ) {
    return { resolved: false, reason: 'invalid-timestamp' };
  }

  let offsets: Set<number>;
  try {
    offsets = new Set(
      [-86_400_000, 0, 86_400_000].map((delta) =>
        offsetMinutes(new Date(naiveUtc + delta), timeZone),
      ),
    );
  } catch {
    return { resolved: false, reason: 'unknown-source-time-zone' };
  }

  const candidates = Array.from(offsets)
    .map((offset) => new Date(naiveUtc - offset * 60_000))
    .filter((instant) => {
      const candidate = wallClockAt(instant, timeZone);
      return (Object.keys(wall) as Array<keyof Wall>).every(
        (key) => candidate[key] === wall[key],
      );
    });
  if (candidates.length === 1) return { resolved: true, instant: candidates[0] };
  return {
    resolved: false,
    reason: candidates.length
      ? 'ambiguous-local-timestamp'
      : 'nonexistent-local-timestamp',
  };
}

/**
 * Turn Kicktipp's printed kickoff into an instant. The wall clock is read in
 * the HTML's print zone, not the display zone — passing Europe/Berlin here
 * for a `.com` `1:30 PM` is how 13:30 happened.
 */
export function parseMatchDate(dateStr: string, timeZone = printedTimeZone(dateStr)): Date | null {
  const wall = parseWallClock(dateStr);
  if (!wall) return null;

  const naiveUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let instant = new Date(naiveUtc - offsetMinutes(new Date(naiveUtc), timeZone) * 60000);
  instant = new Date(naiveUtc - offsetMinutes(instant, timeZone) * 60000);
  return instant;
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

function formatParts(instant: Date, timeZone: string, hour12: boolean, locale: string): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: '2-digit',
    month: hour12 ? 'numeric' : '2-digit',
    day: hour12 ? 'numeric' : '2-digit',
    hour: hour12 ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12,
  }).formatToParts(instant);
}

/**
 * Rewrite an HTML kickoff the way Kicktipp's JavaScript does: same date
 * format, clock in `timeZone` (the visitor's zone).
 */
export function localizePrintedDate(dateStr: string, timeZone = displayTimeZone()): string {
  const trimmed = dateStr.replace(/\s+/g, ' ').trim();
  if (!trimmed) return trimmed;
  const instant = parseMatchDate(trimmed);
  if (!instant) return trimmed;

  if (GERMAN_DATE.test(trimmed)) {
    const parts = formatParts(instant, timeZone, false, 'de-DE');
    return `${part(parts, 'day')}.${part(parts, 'month')}.${part(parts, 'year')} ${part(parts, 'hour')}:${part(parts, 'minute')}`;
  }

  const parts = formatParts(instant, timeZone, true, 'en-US');
  const period = part(parts, 'dayPeriod').replace(/\./g, '').replace(/\s/g, '').toUpperCase();
  return `${part(parts, 'month')}/${part(parts, 'day')}/${part(parts, 'year')} ${part(parts, 'hour')}:${part(parts, 'minute')} ${period}`;
}

export function localizeMatchDates<T extends { date: string }>(matches: T[], timeZone = displayTimeZone()): T[] {
  return matches.map((m) => ({ ...m, date: localizePrintedDate(m.date, timeZone) }));
}

/** `20:30` in the display zone — the compact form `today` uses. */
export function formatKickoffTime(instant: Date, timeZone = displayTimeZone()): string {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const hour = part(parts, 'hour') === '24' ? '00' : part(parts, 'hour');
  return `${hour}:${part(parts, 'minute')}`;
}

export function isSameCalendarDay(a: Date, b: Date, timeZone = displayTimeZone()): boolean {
  const ymd = (instant: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  return ymd(a) === ymd(b);
}

/** "in 2h 15m", "in 3 days", "5m ago" — for countdowns. */
export function humanDelta(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  const past = ms < 0;
  const minutes = Math.floor(Math.abs(ms) / 60000);

  let text: string;
  if (minutes < 1) text = 'less than a minute';
  else if (minutes < 60) text = `${minutes}m`;
  else if (minutes < 60 * 24) text = `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  else {
    const days = Math.floor(minutes / (60 * 24));
    const hours = Math.floor((minutes % (60 * 24)) / 60);
    text = `${days}d ${hours}h`;
  }
  return past ? `${text} ago` : `in ${text}`;
}
