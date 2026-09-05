import type { BetMatch } from '../core.js';
import { readConfig } from '../config.js';
import { displayTimeZone, humanDelta, parseMatchDate } from '../helpers/match-date.js';

export interface DeadlineMatch {
  home: string;
  away: string;
  /** ISO instant, or null when the printed date could not be parsed. */
  kickoff: string | null;
  bet: string | null;
  needsBet: boolean;
  /** Kickoff already passed, so this one can no longer be bet. */
  closed: boolean;
  /** Unbetted and starting inside the warning window. */
  urgent: boolean;
}

export interface DeadlineReport {
  community: string;
  matchday: number | null;
  timeZone: string;
  now: string;
  /** Earliest kickoff still open for betting. */
  nextKickoff: string | null;
  nextKickoffIn: string | null;
  matches: DeadlineMatch[];
  openCount: number;
  needsBetCount: number;
  urgentCount: number;
  warnHours: number;
}

export function warnHoursDefault(): number {
  const raw = Number(process.env.KICKTIPP_WARN_HOURS ?? readConfig().notify?.warn_hours);
  return Number.isFinite(raw) && raw > 0 ? raw : 6;
}

/**
 * Work out which matches still need a bet and how long is left.
 *
 * Kicktipp closes each match at its own kickoff rather than the matchday as
 * a whole, so the model is per match, and the "deadline" people care about
 * is simply the earliest kickoff still open.
 */
export function buildDeadlineReport(
  community: string,
  matchday: number | null,
  matches: BetMatch[],
  options: { now?: Date; warnHours?: number; timeZone?: string } = {},
): DeadlineReport {
  const now = options.now ?? new Date();
  const warnHours = options.warnHours ?? warnHoursDefault();
  const timeZone = options.timeZone ?? displayTimeZone();
  const windowMs = warnHours * 3600_000;

  const rows: DeadlineMatch[] = matches.map((match) => {
    const kickoff = parseMatchDate(match.date);
    const hasBet = /^\d+:\d+$/.test(match.bet);
    // Without a parseable kickoff, assume the match is still open: warning
    // about a match that has started is better than staying quiet about one
    // that has not.
    const closed = kickoff !== null && kickoff.getTime() <= now.getTime();
    const needsBet = !hasBet && !closed;
    return {
      home: match.home,
      away: match.away,
      kickoff: kickoff ? kickoff.toISOString() : null,
      bet: hasBet ? match.bet : null,
      needsBet,
      closed,
      urgent:
        needsBet && kickoff !== null && kickoff.getTime() - now.getTime() <= windowMs,
    };
  });

  const openKickoffs = rows
    .filter((r) => !r.closed && r.kickoff)
    .map((r) => new Date(r.kickoff as string))
    .sort((a, b) => a.getTime() - b.getTime());
  const next = openKickoffs[0] ?? null;

  return {
    community,
    matchday,
    timeZone,
    now: now.toISOString(),
    nextKickoff: next ? next.toISOString() : null,
    nextKickoffIn: next ? humanDelta(now, next) : null,
    matches: rows,
    openCount: rows.filter((r) => !r.closed).length,
    needsBetCount: rows.filter((r) => r.needsBet).length,
    urgentCount: rows.filter((r) => r.urgent).length,
    warnHours,
  };
}

/** One-line nag for the bottom of `today` and `bets`, or null when calm. */
export function urgencyWarning(report: DeadlineReport): string | null {
  if (!report.urgentCount) return null;
  const soonest = report.matches
    .filter((m) => m.urgent && m.kickoff)
    .sort((a, b) => (a.kickoff as string).localeCompare(b.kickoff as string))[0];
  const when = soonest ? humanDelta(new Date(report.now), new Date(soonest.kickoff as string)) : 'soon';
  return (
    `WARNING: ${report.urgentCount} match(es) still need a bet, ` +
    `the first kicking off ${when}. ` +
    `Times shown in ${report.timeZone} (set KICKTIPP_TZ to override).`
  );
}
