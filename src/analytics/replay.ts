import { multiplierFor, parseScore, scoreBet, type ScoringRules } from '../rules/scoring.js';
import { toOddsMatches, mostLikely } from './odds.js';
import { suggestBets, type StrategyName } from './strategies.js';
import { typicalScore, formatScore } from './score-map.js';
import { toNumber, type CachedMatchday, type CachedSeason } from './season.js';

export interface ReplayMatchday {
  matchday: number;
  points: number;
  /** What the player actually scored, from the cached leaderboard. */
  actualPoints: number | null;
  matches: number;
}

export interface ReplayResult {
  strategy: string;
  player: string;
  matchdays: ReplayMatchday[];
  total: number;
  actualTotal: number | null;
  delta: number | null;
  /** Where the synthetic season would have finished, if rankable. */
  finalRank: number | null;
  rankNote?: string;
  matchesScored: number;
}

/** Every strategy this replay understands. */
export const REPLAY_STRATEGIES = ['actual', 'home', 'draw', 'away', 'favorite'] as const;

function isFixed(strategy: string): string | null {
  return /^\d+:\d+$/.test(strategy) ? strategy : null;
}

function suggestStrategy(strategy: string): StrategyName | null {
  const match = strategy.match(/^suggest:(safe|ev|contrarian)$/);
  return match ? (match[1] as StrategyName) : null;
}

/**
 * The bet this strategy would have placed on one match.
 *
 * Returns null when the strategy has nothing to say (e.g. `actual` for a
 * match the player never bet on), so those matches are skipped rather than
 * counted as misses.
 */
function betFor(
  strategy: string,
  md: CachedMatchday,
  index: number,
  player: string,
  ownPlayer: string | null,
  rules: ScoringRules,
): string | null {
  const fixed = isFixed(strategy);
  if (fixed) return fixed;

  const betsPage = md.bets?.[index];

  if (strategy === 'actual') {
    const grid = md.matchdayBets;
    const row = grid?.players.find((p) => p.player === player);
    if (row) return row.bets[index] || null;
    if (player === ownPlayer && betsPage && /^\d+:\d+$/.test(betsPage.bet)) return betsPage.bet;
    return null;
  }

  if (strategy === 'home' || strategy === 'draw' || strategy === 'away') {
    return formatScore(typicalScore(strategy, 0.5));
  }

  if (strategy === 'favorite') {
    if (!betsPage) return formatScore(typicalScore('home', 0.5));
    const [odds] = toOddsMatches([betsPage]);
    const outcome = mostLikely(odds.probabilities);
    return formatScore(typicalScore(outcome, odds.probabilities[outcome]));
  }

  const named = suggestStrategy(strategy);
  if (named) {
    if (!betsPage) return null;
    const [suggestion] = suggestBets(toOddsMatches([betsPage]), rules, named);
    return suggestion.bet;
  }

  throw new Error(
    `Unknown strategy '${strategy}'. Use a scoreline like 2:1, one of ` +
      `${REPLAY_STRATEGIES.join(', ')}, or suggest:safe|ev|contrarian.`,
  );
}

/**
 * Replay a season as if the player had followed a different strategy.
 *
 * Only matches with a final result and a usable synthetic bet are scored, so
 * a thin cache produces a smaller but still honest total rather than a wrong
 * one. Ranks are estimated against the other players' recorded totals, which
 * include bonus points the replay does not model — hence the note.
 */
export function replaySeason(
  season: CachedSeason,
  player: string,
  rules: ScoringRules,
  strategy: string,
  ownPlayer: string | null = player,
): ReplayResult {
  const matchdays: ReplayMatchday[] = [];
  let matchesScored = 0;

  for (const md of season.matchdays) {
    const schedule = md.schedule ?? md.matchdayBets?.matches;
    if (!schedule?.length) continue;

    let points = 0;
    let scored = 0;
    schedule.forEach((match, index) => {
      if (!parseScore(match.result)) return;
      const bet = betFor(strategy, md, index, player, ownPlayer, rules);
      if (!bet) return;
      points += scoreBet(bet, match.result, rules);
      scored++;
    });

    if (!scored) continue;
    const row = md.leaderboard?.rankings.find((r) => r.name === player);
    matchdays.push({
      matchday: md.matchday,
      points: points * multiplierFor(md.matchday, rules),
      actualPoints: row ? toNumber(row.matchdayPoints) : null,
      matches: scored,
    });
    matchesScored += scored;
  }

  const total = matchdays.reduce((sum, md) => sum + md.points, 0);
  const actualPoints = matchdays
    .map((md) => md.actualPoints)
    .filter((p): p is number => p !== null);
  const actualTotal = actualPoints.length === matchdays.length && matchdays.length
    ? actualPoints.reduce((a, b) => a + b, 0)
    : null;

  // Rank the synthetic season against everyone else's recorded totals.
  const last = [...season.matchdays].reverse().find((md) => md.leaderboard);
  let finalRank: number | null = null;
  let rankNote: string | undefined;
  if (last?.leaderboard) {
    const others = last.leaderboard.rankings
      .filter((r) => r.name !== player)
      .map((r) => toNumber(r.total))
      .filter((n): n is number => n !== null);
    finalRank = others.filter((n) => n > total).length + 1;
    rankNote =
      'Rank is an estimate: other players are compared on their recorded totals, ' +
      'which include bonus points this replay does not model.';
  }

  return {
    strategy,
    player,
    matchdays,
    total,
    actualTotal,
    delta: actualTotal === null ? null : total - actualTotal,
    finalRank,
    rankNote,
    matchesScored,
  };
}
