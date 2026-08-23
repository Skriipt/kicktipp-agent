import type { LeaderboardData, MatchdayBets } from '../core.js';
import { multiplierFor, parseScore, scoreBet, type ScoringRules } from '../rules/scoring.js';
import { toNumber } from './season.js';

/** A hypothetical (or already known) result for one fixture. */
export interface HypotheticalResult {
  home: string;
  away: string;
  result: string;
}

export interface ProjectedPlayer {
  player: string;
  pointsBefore: number;
  /** Points from this matchday under the scenario; a range when partial. */
  matchdayBest: number;
  matchdayWorst: number;
  totalBest: number;
  totalWorst: number;
  rankBest: number;
  rankWorst: number;
  /** Set when every open match is pinned, so the projection is exact. */
  exact: boolean;
}

export interface ScenarioProjection {
  matchday: number | null;
  /** Matches whose outcome the caller supplied or which are already played. */
  specified: number;
  unspecified: number;
  exact: boolean;
  players: ProjectedPlayer[];
  rules: ScoringRules;
  note?: string;
}

/** Points each player had before this matchday, from the leaderboard. */
function pointsBefore(leaderboard: LeaderboardData): Map<string, number> {
  const before = new Map<string, number>();
  for (const row of leaderboard.rankings) {
    const total = toNumber(row.total);
    const matchday = toNumber(row.matchdayPoints) ?? 0;
    if (total !== null) before.set(row.name, total - matchday);
  }
  return before;
}

function findResult(
  match: { home: string; away: string; result: string },
  supplied: HypotheticalResult[],
): string | null {
  if (/^\d+:\d+$/.test(match.result)) return match.result;
  const hit = supplied.find(
    (s) =>
      s.home.toLowerCase() === match.home.toLowerCase() &&
      s.away.toLowerCase() === match.away.toLowerCase(),
  );
  return hit && parseScore(hit.result) ? hit.result : null;
}

/**
 * Rank a list by points, highest first, sharing a rank on ties.
 * `optimistic` decides which side of an unknown a player is placed on.
 */
function rankBy(values: { player: string; points: number }[]): Map<string, number> {
  const sorted = [...values].sort((a, b) => b.points - a.points);
  const ranks = new Map<string, number>();
  sorted.forEach((entry, index) => {
    const tiedWith = sorted.findIndex((e) => e.points === entry.points);
    ranks.set(entry.player, tiedWith + 1 <= index + 1 ? tiedWith + 1 : index + 1);
  });
  return ranks;
}

/**
 * Project the leaderboard under a set of hypothetical results.
 *
 * Matches left unspecified contribute a range rather than a number: each
 * player is given their best and their worst possible score for them, so the
 * projected rank comes out as a band that tightens to a single value once
 * every match is pinned.
 */
export function projectStandings(
  grid: MatchdayBets,
  leaderboard: LeaderboardData,
  rules: ScoringRules,
  supplied: HypotheticalResult[] = [],
): ScenarioProjection {
  const matchday = grid.matchday ?? null;

  if (!grid.players.length) {
    return {
      matchday,
      specified: 0,
      unspecified: grid.matches.length,
      exact: false,
      players: [],
      rules,
      note:
        grid.note ??
        'Per-player bets are not published for this matchday yet, so the standings cannot be projected.',
    };
  }

  const resolved = grid.matches.map((match) => findResult(match, supplied));
  const specified = resolved.filter((r) => r !== null).length;
  const unspecified = resolved.length - specified;
  const multiplier = multiplierFor(matchday, rules);
  const before = pointsBefore(leaderboard);

  const rows = grid.players.map((entry) => {
    let best = 0;
    let worst = 0;
    entry.bets.forEach((bet, i) => {
      const result = resolved[i];
      if (result !== null) {
        const points = scoreBet(bet, result, rules);
        best += points;
        worst += points;
        return;
      }
      // Unknown match: at best this bet is exactly right, at worst it misses.
      if (parseScore(bet)) best += rules.exact;
    });

    const start = before.get(entry.player) ?? 0;
    return {
      player: entry.player,
      pointsBefore: start,
      matchdayBest: best * multiplier,
      matchdayWorst: worst * multiplier,
      totalBest: start + best * multiplier,
      totalWorst: start + worst * multiplier,
    };
  });

  // Best rank: this player at their best while everyone else is at their worst.
  const players: ProjectedPlayer[] = rows.map((row) => {
    const bestCase = rows.map((other) => ({
      player: other.player,
      points: other.player === row.player ? other.totalBest : other.totalWorst,
    }));
    const worstCase = rows.map((other) => ({
      player: other.player,
      points: other.player === row.player ? other.totalWorst : other.totalBest,
    }));
    return {
      ...row,
      rankBest: rankBy(bestCase).get(row.player) ?? 0,
      rankWorst: rankBy(worstCase).get(row.player) ?? 0,
      exact: unspecified === 0,
    };
  });

  players.sort((a, b) => b.totalBest - a.totalBest || a.player.localeCompare(b.player));

  return {
    matchday,
    specified,
    unspecified,
    exact: unspecified === 0,
    players,
    rules,
    note: unspecified
      ? `${unspecified} match(es) left open, so ranks are given as a range.`
      : undefined,
  };
}

export interface TargetCombination {
  results: HypotheticalResult[];
  rank: number;
}

export interface TargetSearch {
  player: string;
  targetRank: number;
  examined: number;
  achievable: boolean;
  /** A sample of combinations that reach the target. */
  examples: TargetCombination[];
  note?: string;
}

/** Representative scorelines standing in for the outcome classes. */
const OUTCOME_SAMPLES = ['1:0', '0:0', '0:1'];

/**
 * Search the open matches for combinations that put `player` at or above a
 * target rank. Exhaustive over outcome classes rather than scorelines: the
 * scoring rules cannot tell two home wins apart beyond exactness, and the
 * space stays small enough to enumerate.
 */
export function findTargetCombinations(
  grid: MatchdayBets,
  leaderboard: LeaderboardData,
  rules: ScoringRules,
  player: string,
  targetRank: number,
  limit = 5,
): TargetSearch {
  const open = grid.matches
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => !/^\d+:\d+$/.test(match.result));

  if (!grid.players.some((p) => p.player === player)) {
    return {
      player,
      targetRank,
      examined: 0,
      achievable: false,
      examples: [],
      note: `${player} has no published bets for this matchday.`,
    };
  }

  const combinations = OUTCOME_SAMPLES.length ** open.length;
  // 3^10 is 59k projections, which is fine; beyond that, say so rather than
  // grinding.
  if (combinations > 100_000) {
    return {
      player,
      targetRank,
      examined: 0,
      achievable: false,
      examples: [],
      note: `Too many combinations (${combinations}) to enumerate; pin some results first.`,
    };
  }

  const examples: TargetCombination[] = [];
  let examined = 0;

  for (let n = 0; n < combinations; n++) {
    let rest = n;
    const results: HypotheticalResult[] = open.map(({ match }) => {
      const sample = OUTCOME_SAMPLES[rest % OUTCOME_SAMPLES.length];
      rest = Math.floor(rest / OUTCOME_SAMPLES.length);
      return { home: match.home, away: match.away, result: sample };
    });

    examined++;
    const projection = projectStandings(grid, leaderboard, rules, results);
    const row = projection.players.find((p) => p.player === player);
    if (row && row.rankBest <= targetRank) {
      examples.push({ results, rank: row.rankBest });
      if (examples.length >= limit) break;
    }
  }

  return {
    player,
    targetRank,
    examined,
    achievable: examples.length > 0,
    examples,
    note: examples.length
      ? undefined
      : `No combination of the ${open.length} open match(es) reaches rank ${targetRank}.`,
  };
}
