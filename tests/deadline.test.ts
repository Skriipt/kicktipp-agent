import { describe, it, expect } from 'vitest';
import {
  parseMatchDate,
  resolveMatchDateStrict,
  humanDelta,
  displayTimeZone,
  inheritPrintedDate,
  localizePrintedDate,
  formatKickoffTime,
  isSameCalendarDay,
} from '../src/helpers/match-date.js';
import { buildDeadlineReport, urgencyWarning } from '../src/analytics/deadline.js';
import type { BetMatch } from '../src/core.js';

const TZ = 'Europe/Berlin';

function bet(over: Partial<BetMatch> = {}): BetMatch {
  return {
    date: '21.08.26 20:30',
    home: 'Bayern',
    away: 'BVB',
    bet: '',
    odds: { home: '1.5', draw: '4.2', away: '6.0' },
    ...over,
  };
}

describe('parseMatchDate', () => {
  it.each(['0:30 AM', '13:30 AM', '0:30 PM', '24:30 PM'])('rejects invalid 12-hour clocks: %s', (clock) => {
    const date = `8/21/26 ${clock}`;
    expect(parseMatchDate(date)).toBeNull();
    expect(resolveMatchDateStrict(date, 'America/Chicago')).toEqual({ resolved: false, reason: 'invalid-timestamp' });
  });
  it('reads the German format in a named zone', () => {
    // 20:30 Berlin in August is UTC+2, so 18:30Z.
    expect(parseMatchDate('21.08.26 20:30', TZ)?.toISOString()).toBe('2026-08-21T18:30:00.000Z');
  });

  it('reads the US format', () => {
    expect(parseMatchDate('8/21/26 8:30 PM', TZ)?.toISOString()).toBe('2026-08-21T18:30:00.000Z');
    expect(parseMatchDate('8/21/26 12:30 AM', TZ)?.toISOString()).toBe('2026-08-20T22:30:00.000Z');
    expect(parseMatchDate('8/21/26 12:30 PM', TZ)?.toISOString()).toBe('2026-08-21T10:30:00.000Z');
  });

  it('applies winter offset on the other side of the DST boundary', () => {
    // January in Berlin is UTC+1, so the same wall clock is an hour earlier.
    expect(parseMatchDate('15.01.27 20:30', TZ)?.toISOString()).toBe('2027-01-15T19:30:00.000Z');
  });

  it('infers Europe/Berlin from a German date when no zone is given', () => {
    expect(parseMatchDate('21.08.26 20:30')?.toISOString()).toBe('2026-08-21T18:30:00.000Z');
  });

  it('infers America/Chicago from a US date when no zone is given', () => {
    // kicktipp.com HTML is Central Time: 1:30 PM CDT is 18:30Z, 20:30 in Berlin.
    expect(parseMatchDate('8/21/26 1:30 PM')?.toISOString()).toBe('2026-08-21T18:30:00.000Z');
  });

  it('treats the live Bayern–Stuttgart HTML clock as 20:30 Berlin', () => {
    expect(parseMatchDate('8/28/26 1:30 PM')?.toISOString()).toBe('2026-08-28T18:30:00.000Z');
    expect(localizePrintedDate('8/28/26 1:30 PM', 'Europe/Berlin')).toBe('8/28/26 8:30 PM');
    const instant = parseMatchDate('8/28/26 1:30 PM')!;
    expect(formatKickoffTime(instant, 'Europe/Berlin')).toBe('20:30');
  });

  it('does not let KICKTIPP_TZ change how the HTML is read', () => {
    const previous = process.env.KICKTIPP_TZ;
    process.env.KICKTIPP_TZ = 'UTC';
    try {
      // 1:30 PM is still Chicago, not 13:30 UTC.
      expect(parseMatchDate('8/28/26 1:30 PM')?.toISOString()).toBe('2026-08-28T18:30:00.000Z');
      expect(localizePrintedDate('8/28/26 1:30 PM', 'UTC')).toBe('8/28/26 6:30 PM');
    } finally {
      if (previous === undefined) delete process.env.KICKTIPP_TZ;
      else process.env.KICKTIPP_TZ = previous;
    }
  });

  it('rejects anything it does not recognise', () => {
    expect(parseMatchDate('tomorrow', TZ)).toBeNull();
    expect(parseMatchDate('', TZ)).toBeNull();
  });

  it('carries a blank Kicktipp date cell forward from the row above', () => {
    expect(inheritPrintedDate('', '8/28/26 1:30 PM')).toBe('8/28/26 1:30 PM');
    expect(inheritPrintedDate('  ', '8/28/26 1:30 PM')).toBe('8/28/26 1:30 PM');
    expect(inheritPrintedDate('8/29/26 8:30 AM', '8/28/26 1:30 PM')).toBe('8/29/26 8:30 AM');
  });

  it('falls back to a usable zone name', () => {
    expect(typeof displayTimeZone()).toBe('string');
    expect(displayTimeZone().length).toBeGreaterThan(0);
  });

  it('compares calendar days in a named zone', () => {
    const kickoff = parseMatchDate('8/28/26 1:30 PM')!;
    const berlinAfternoon = new Date('2026-08-28T12:00:00.000Z');
    const berlinNextDay = new Date('2026-08-28T22:30:00.000Z'); // 00:30 on the 29th in Berlin
    expect(isSameCalendarDay(kickoff, berlinAfternoon, 'Europe/Berlin')).toBe(true);
    expect(isSameCalendarDay(kickoff, berlinNextDay, 'Europe/Berlin')).toBe(false);
  });
});

describe('humanDelta', () => {
  const base = new Date('2026-08-21T12:00:00Z');
  const at = (ms: number) => new Date(base.getTime() + ms);

  it('describes the future', () => {
    expect(humanDelta(base, at(30 * 60000))).toBe('in 30m');
    expect(humanDelta(base, at(150 * 60000))).toBe('in 2h 30m');
    expect(humanDelta(base, at(50 * 3600_000))).toBe('in 2d 2h');
    expect(humanDelta(base, at(10_000))).toBe('in less than a minute');
  });

  it('describes the past', () => {
    expect(humanDelta(base, at(-30 * 60000))).toBe('30m ago');
  });
});

describe('buildDeadlineReport', () => {
  const now = new Date('2026-08-21T12:00:00Z'); // 14:00 Berlin
  const options = { now, timeZone: TZ, warnHours: 6 };

  it('flags an unbetted match inside the window', () => {
    // 16:00 Berlin is 14:00Z, two hours after "now".
    const report = buildDeadlineReport('c', 3, [bet({ date: '21.08.26 16:00' })], options);
    expect(report.matches[0]).toMatchObject({ needsBet: true, urgent: true, closed: false });
    expect(report.needsBetCount).toBe(1);
    expect(report.urgentCount).toBe(1);
    expect(report.nextKickoffIn).toBe('in 2h 0m');
  });

  it('leaves an unbetted match just outside the window un-flagged', () => {
    // 20:30 Berlin is 6h30m away, past the 6h window.
    const report = buildDeadlineReport('c', 3, [bet()], options);
    expect(report.matches[0]).toMatchObject({ needsBet: true, urgent: false });
    expect(report.urgentCount).toBe(0);
  });

  it('does not flag a match that already has a bet', () => {
    const report = buildDeadlineReport('c', 3, [bet({ bet: '2:1' })], options);
    expect(report.matches[0]).toMatchObject({ needsBet: false, urgent: false, bet: '2:1' });
    expect(report.urgentCount).toBe(0);
  });

  it('treats a kicked-off match as closed, not as needing a bet', () => {
    const report = buildDeadlineReport('c', 3, [bet({ date: '21.08.26 10:00' })], options);
    expect(report.matches[0]).toMatchObject({ closed: true, needsBet: false, urgent: false });
    expect(report.openCount).toBe(0);
    expect(report.nextKickoff).toBeNull();
  });

  it('counts a distant match as needing a bet but not urgent', () => {
    const report = buildDeadlineReport('c', 3, [bet({ date: '25.08.26 20:30' })], options);
    expect(report.matches[0]).toMatchObject({ needsBet: true, urgent: false });
  });

  it('respects a wider window', () => {
    const report = buildDeadlineReport('c', 3, [bet({ date: '22.08.26 20:30' })], {
      ...options,
      warnHours: 48,
    });
    expect(report.matches[0].urgent).toBe(true);
  });

  it('assumes an unparseable date is still open rather than staying quiet', () => {
    const report = buildDeadlineReport('c', 3, [bet({ date: 'sometime' })], options);
    expect(report.matches[0]).toMatchObject({ kickoff: null, closed: false, needsBet: true });
    // Urgency needs a real time, so it stays off.
    expect(report.matches[0].urgent).toBe(false);
  });

  it('reports the earliest still-open kickoff', () => {
    const report = buildDeadlineReport(
      'c',
      3,
      [bet({ date: '23.08.26 15:30' }), bet({ date: '22.08.26 18:30' }), bet({ date: '20.08.26 20:30' })],
      options,
    );
    expect(report.nextKickoff).toBe('2026-08-22T16:30:00.000Z');
    expect(report.openCount).toBe(2);
  });

  it('records the zone it assumed', () => {
    expect(buildDeadlineReport('c', 3, [bet()], options).timeZone).toBe(TZ);
  });
});

describe('urgencyWarning', () => {
  const now = new Date('2026-08-21T12:00:00Z');

  it('names the count and the soonest kickoff', () => {
    // 8h window so both the 20:30 (6h30m out) and the 16:00 (2h out) count.
    const report = buildDeadlineReport('c', 3, [bet(), bet({ date: '21.08.26 16:00' })], {
      now,
      timeZone: TZ,
      warnHours: 8,
    });
    const warning = urgencyWarning(report);
    expect(warning).toMatch(/2 match\(es\) still need a bet/);
    expect(warning).toMatch(/in 2h 0m/);
    expect(warning).toMatch(/Europe\/Berlin/);
  });

  it('stays quiet when nothing is urgent', () => {
    const report = buildDeadlineReport('c', 3, [bet({ bet: '2:1' })], { now, timeZone: TZ });
    expect(urgencyWarning(report)).toBeNull();
  });
});
