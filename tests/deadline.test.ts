import { describe, it, expect } from 'vitest';
import { parseMatchDate, humanDelta, assumedTimeZone } from '../src/helpers/match-date.js';
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

  it('honours a different zone entirely', () => {
    expect(parseMatchDate('21.08.26 20:30', 'UTC')?.toISOString()).toBe('2026-08-21T20:30:00.000Z');
  });

  it('rejects anything it does not recognise', () => {
    expect(parseMatchDate('tomorrow', TZ)).toBeNull();
    expect(parseMatchDate('', TZ)).toBeNull();
  });

  it('falls back to a usable zone name', () => {
    expect(typeof assumedTimeZone()).toBe('string');
    expect(assumedTimeZone().length).toBeGreaterThan(0);
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
  });

  it('stays quiet when nothing is urgent', () => {
    const report = buildDeadlineReport('c', 3, [bet({ bet: '2:1' })], { now, timeZone: TZ });
    expect(urgencyWarning(report)).toBeNull();
  });
});
