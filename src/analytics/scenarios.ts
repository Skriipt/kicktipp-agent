import type { LeaderboardData, MatchdayBets } from '../core.js';
import { multiplierFor, parseScore, scoreBet, type ScoringRules } from '../rules/scoring.js';
import { toNumber } from './season.js';
import { isUnknownBet, pointRange, resultRepresentatives } from '../rules/outcomes.js';

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

  const entries = [...grid.players];
  const names = new Set(entries.map((entry) => entry.player));
  for (const row of leaderboard.rankings) {
    if (!names.has(row.name)) {
      entries.push({ player: row.name, bets: grid.matches.map(() => '-:-') });
      names.add(row.name);
    }
  }
  const resolved = grid.matches.map((match) => findResult(match, supplied));
  const specified = resolved.filter((r) => r !== null).length;
  const unspecified = resolved.length - specified;
  const multiplier = multiplierFor(matchday, rules);
  const before = pointsBefore(leaderboard);

  const rows = entries.map((entry) => {
    let best = 0;
    let worst = 0;
    grid.matches.forEach((_, i) => {
      const range = pointRange(entry.bets[i], parseScore(resolved[i]), rules);
      best += range.best;
      worst += range.worst;
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

  const hidden = entries.some((entry) => grid.matches.some((_, i) => isUnknownBet(entry.bets[i])));
  const exact = unspecified === 0 && !hidden;
  // A rank is one plus the number strictly ahead; ties share the same rank.
  const players: ProjectedPlayer[] = rows.map((row) => ({
    ...row,
    rankBest: 1 + rows.filter((other) => other !== row && other.totalWorst > row.totalBest).length,
    rankWorst: 1 + rows.filter((other) => other !== row && other.totalBest > row.totalWorst).length,
    exact,
  }));

  players.sort((a, b) => b.totalBest - a.totalBest || a.player.localeCompare(b.player));

  return {
    matchday,
    specified,
    unspecified,
    exact,
    players,
    rules,
    note: hidden
      ? 'Some predictions are hidden, so points and ranks are bounds even when results are supplied.'
      : unspecified
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
  /** null means that hidden predictions or the search budget prevent a conclusion. */
  achievable: boolean | null;
  /** Whether the search established its answer (examples may still be limited). */
  complete: boolean;
  examples: TargetCombination[];
  note?: string;
}

/** Search scoring-equivalence classes, stopping without a false impossibility claim. */
export function findTargetCombinations(
  grid: MatchdayBets,
  leaderboard: LeaderboardData,
  rules: ScoringRules,
  player: string,
  targetRank: number,
  limit = 5,
  supplied: HypotheticalResult[] = [],
): TargetSearch {
  const base = { player, targetRank, examined: 0, examples: [] as TargetCombination[] };
  const target = grid.players.findIndex((p) => p.player === player);
  if (target < 0) {
    return { ...base, achievable: null, complete: false, note: `${player} has no published bets for this matchday.` };
  }
  const names = new Set(grid.players.map((entry) => entry.player));
  if (leaderboard.rankings.some((row) => !names.has(row.name)) ||
      grid.players.some((entry) => grid.matches.some((_, i) => isUnknownBet(entry.bets[i])))) {
    return { ...base, achievable: null, complete: false, note: 'Some predictions are hidden; target reachability cannot be determined yet.' };
  }

  const resolved = grid.matches.map((match) => findResult(match, supplied));
  const open = grid.matches.map((match, index) => ({ match, index })).filter(({ index }) => resolved[index] === null);
  const multiplier = multiplierFor(grid.matchday, rules);
  const before = pointsBefore(leaderboard);
  const starts = grid.players.map((entry) => (before.get(entry.player) ?? 0) +
    resolved.reduce((sum, result, i) => sum + scoreBet(entry.bets[i], result, rules) * multiplier, 0));
  const bounds = grid.players.map((entry, p) => {
    let best = starts[p];
    let worst = starts[p];
    for (const { index } of open) {
      const range = pointRange(entry.bets[index], null, rules);
      best += range.best * multiplier;
      worst += range.worst * multiplier;
    }
    return { best, worst };
  });
  if (1 + bounds.filter((range, p) => p !== target && range.worst > bounds[target].best).length > targetRank) {
    return { ...base, achievable: false, complete: true, note: `No combination of the ${open.length} open match(es) reaches rank ${targetRank}.` };
  }

  // Bound work by both player count and time, including construction of the
  // per-result scoring vectors. A partial search reports unknown, not false.
  const deadline = performance.now() + 150;
  let remainingWork = 1_000_000;
  const canSpend = (amount: number): boolean => {
    remainingWork -= amount;
    return remainingWork >= 0 && performance.now() < deadline;
  };
  const incomplete = (examined: number, examples: TargetCombination[]): TargetSearch => ({
    player, targetRank, examined, examples,
    achievable: examples.length ? true : null,
    complete: examples.length > 0,
    note: 'Search budget reached; pin more results to narrow the search. No impossibility conclusion was made.',
  });
  const choices: { result: string; points: number[] }[][] = [];
  for (const { index } of open) {
    const variants: { result: string; points: number[] }[] = [];
    const vectors = new Set<string>();
    for (const result of resultRepresentatives(grid.players.map((entry) => entry.bets[index]))) {
      if (!canSpend(grid.players.length)) return incomplete(0, []);
      const points = grid.players.map((entry) => scoreBet(entry.bets[index], result, rules) * multiplier);
      const key = points.join(',');
      if (!vectors.has(key)) {
        vectors.add(key);
        variants.push({ result: `${result.home}:${result.away}`, points });
      }
    }
    choices.push(variants);
  }

  const examples: TargetCombination[] = [];
  const indices = Array(open.length).fill(0) as number[];
  let examined = 0;
  let exhausted = false;
  do {
    if (!canSpend(grid.players.length * Math.max(open.length, 1))) return incomplete(examined, examples);
    const totals = starts.slice();
    choices.forEach((variants, i) => {
      variants[indices[i]].points.forEach((points, p) => { totals[p] += points; });
    });
    examined++;
    const rank = 1 + totals.filter((points, p) => p !== target && points > totals[target]).length;
    if (rank <= targetRank) {
      const results = grid.matches.flatMap((match, index) => {
        if (parseScore(match.result)) return [];
        const openIndex = open.findIndex((entry) => entry.index === index);
        const result = openIndex < 0 ? resolved[index]! : choices[openIndex][indices[openIndex]].result;
        return [{ home: match.home, away: match.away, result }];
      });
      examples.push({ results, rank });
      if (examples.length >= Math.max(1, limit)) break;
    }
    let digit = 0;
    while (digit < indices.length && ++indices[digit] === choices[digit].length) {
      indices[digit] = 0;
      digit++;
    }
    exhausted = digit === indices.length;
  } while (!exhausted);

  return {
    player, targetRank, examined, examples,
    achievable: examples.length > 0,
    complete: true,
    note: examples.length ? undefined : `No combination of the ${open.length} open match(es) reaches rank ${targetRank}.`,
  };
}
