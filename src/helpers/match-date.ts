/**
 * Kicktipp prints kickoff times in the account's configured zone and never
 * includes an offset, so a parsed time is only correct if this machine runs
 * in the same zone. KICKTIPP_TZ (an IANA name such as Europe/Berlin) states
 * the site's zone explicitly; without it the local zone is assumed, and
 * every surface that shows a countdown says which was used.
 */
export function assumedTimeZone(): string {
  return (
    process.env.KICKTIPP_TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  );
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Read the wall-clock parts out of Kicktipp's German or US date formats. */
function parseWallClock(dateStr: string): Wall | null {
  const trimmed = dateStr.trim();

  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (us) {
    const [, m, d, y, h, min, ampm] = us;
    let hour = parseInt(h, 10);
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

/**
 * Turn Kicktipp's printed kickoff into an instant, interpreting the wall
 * clock in `timeZone`. Two passes settle the DST boundary: the offset is
 * looked up at a first guess, then re-checked at the corrected instant.
 */
export function parseMatchDate(dateStr: string, timeZone = assumedTimeZone()): Date | null {
  const wall = parseWallClock(dateStr);
  if (!wall) return null;

  const naiveUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let instant = new Date(naiveUtc - offsetMinutes(new Date(naiveUtc), timeZone) * 60000);
  instant = new Date(naiveUtc - offsetMinutes(instant, timeZone) * 60000);
  return instant;
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
