import type { LeaderboardData } from '../core.js';
import { toNumber } from './season.js';

/**
 * Points difference between two players *before* the given matchday.
 *
 * A matchday leaderboard reports the season total including that matchday,
 * so this subtracts the matchday's own points back out. That keeps the
 * figure independent of matches inside the matchday, which the swing
 * calculation accounts for separately.
 */
export function gapBeforeMatchday(
  leaderboard: LeaderboardData | undefined,
  player: string,
  rival: string,
): number | null {
  if (!leaderboard) return null;

  const before = (name: string): number | null => {
    const row = leaderboard.rankings.find((r) => r.name === name);
    if (!row) return null;
    const total = toNumber(row.total);
    const matchday = toNumber(row.matchdayPoints) ?? 0;
    return total === null ? null : total - matchday;
  };

  const mine = before(player);
  const theirs = before(rival);
  if (mine === null || theirs === null) return null;
  return mine - theirs;
}
