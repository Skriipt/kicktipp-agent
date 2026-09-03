import type { ScoringRules } from '../rules/scoring.js';
import { classify, parseScore, scoreBet, tendencyOf, type HitKind } from '../rules/scoring.js';
import { toNumber, type CachedMatchday, type CachedSeason } from './season.js';

export interface FormPoint {
  matchday: number;
  points: number | null;
  /** Mean points across everyone on the leaderboard that matchday. */
  leagueAverage: number | null;
  rank: number | null;
}

export interface Breakdown {
  exact: number;
  goalDiff: number;
  tendency: number;
  miss: number;
  /** Matches counted, i.e. those with both a bet and a result. */
  scored: number;
  /** Points attributed under the scoring rules used. */
  points: number;
}

export interface BetProfile {
  /** How often each outcome was predicted, as a share of scored matches. */
  predicted: { home: number; draw: number; away: number };
  /** How those matches actually finished. */
  actual: { home: number; draw: number; away: number };
  averagePredictedGoals: number | null;
  averageActualGoals: number | null;
  /** The scoreline predicted most often, e.g. "2:1". */
  favouriteScoreline: string | null;
}

export interface Consistency {
  mean: number | null;
  standardDeviation: number | null;
  best: FormPoint | null;
  worst: FormPoint | null;
  /** Share of matchdays scoring below the league average, 0..1. */
  belowAverageShare: number | null;
}

export interface RankMove {
  matchday: number;
  from: number;
  to: number;
  delta: number;
}

export interface DataCompleteness {
  cachedMatchdays: number;
  playedMatchdays: number;
  knownMatchdays: number | null;
  /** Matchdays with a leaderboard, i.e. usable for form and rank. */
  withLeaderboard: number;
  /** Matchdays where this player's bets and results were both available. */
  withBets: number;
  lastSync: string | null;
}

export interface SeasonStats {
  community: string;
  player: string;
  form: FormPoint[];
  rolling5: (number | null)[];
  biggestClimb: RankMove | null;
  biggestDrop: RankMove | null;
  breakdown: Breakdown;
  betProfile: BetProfile;
  consistency: Consistency;
  rulesUsed: ScoringRules;
  completeness: DataCompleteness;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function standardDeviation(values: number[]): number | null {
  const m = mean(values);
  if (m === null || values.length < 2) return null;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function rowFor(md: CachedMatchday, player: string) {
  return md.leaderboard?.rankings.find((r) => r.name === player);
}

/** Points scored by everyone that matchday, for the league average. */
function leagueAverageFor(md: CachedMatchday): number | null {
  const points = (md.leaderboard?.rankings ?? [])
    .map((r) => toNumber(r.matchdayPoints))
    .filter((n): n is number => n !== null);
  return mean(points);
}

function buildForm(season: CachedSeason, player: string): FormPoint[] {
  return season.matchdays
    .filter((md) => md.leaderboard)
    .map((md) => {
      const row = rowFor(md, player);
      return {
        matchday: md.matchday,
        points: row ? toNumber(row.matchdayPoints) : null,
        leagueAverage: leagueAverageFor(md),
        rank: row ? toNumber(row.position) : null,
      };
    });
}

function rollingAverage(form: FormPoint[], window: number): (number | null)[] {
  return form.map((_, i) => {
    const slice = form
      .slice(Math.max(0, i - window + 1), i + 1)
      .map((f) => f.points)
      .filter((p): p is number => p !== null);
    return slice.length ? mean(slice) : null;
  });
}

function rankMoves(form: FormPoint[]): { climb: RankMove | null; drop: RankMove | null } {
  let climb: RankMove | null = null;
  let drop: RankMove | null = null;

  for (let i = 1; i < form.length; i++) {
    const from = form[i - 1].rank;
    const to = form[i].rank;
    if (from === null || to === null) continue;
    // Rank 1 is best, so a fall in the number is a climb up the table.
    const delta = from - to;
    const move: RankMove = { matchday: form[i].matchday, from, to, delta };
    if (delta > 0 && (!climb || delta > climb.delta)) climb = move;
    if (delta < 0 && (!drop || delta < drop.delta)) drop = move;
  }
  return { climb, drop };
}

/**
 * One player's predictions paired with the final results.
 *
 * The per-player bet grid is preferred, because it covers everybody. The
 * cached bets page only ever holds the logged-in user's own predictions, so
 * it is used only when the player asked about *is* that user — otherwise
 * another player's breakdown would silently be built from your bets.
 */
function scoredPairs(
  season: CachedSeason,
  player: string,
  ownPlayer: string | null,
): { pairs: { bet: string; result: string }[]; matchdaysUsed: number } {
  const pairs: { bet: string; result: string }[] = [];
  let matchdaysUsed = 0;

  for (const md of season.matchdays) {
    const grid = md.matchdayBets;
    const row = grid?.players.find((p) => p.player === player);

    if (grid && row) {
      let used = false;
      row.bets.forEach((bet, i) => {
        const match = grid.matches[i];
        if (!match || !parseScore(bet) || !parseScore(match.result)) return;
        pairs.push({ bet, result: match.result });
        used = true;
      });
      if (used) matchdaysUsed++;
      continue;
    }

    if (player !== ownPlayer || !md.bets || !md.schedule) continue;
    let used = false;
    for (const bet of md.bets) {
      const match = md.schedule.find((s) => s.home === bet.home && s.away === bet.away);
      if (!match) continue;
      if (!parseScore(bet.bet) || !parseScore(match.result)) continue;
      pairs.push({ bet: bet.bet, result: match.result });
      used = true;
    }
    if (used) matchdaysUsed++;
  }

  return { pairs, matchdaysUsed };
}

function buildBreakdown(
  pairs: { bet: string; result: string }[],
  rules: ScoringRules,
): Breakdown {
  const counts: Record<HitKind, number> = { exact: 0, goalDiff: 0, tendency: 0, miss: 0 };
  let points = 0;

  for (const { bet, result } of pairs) {
    const b = parseScore(bet)!;
    const r = parseScore(result)!;
    const kind = classify(b, r);
    counts[kind]++;
    points += scoreBet(b, r, rules);
  }

  return { ...counts, scored: pairs.length, points };
}

function buildBetProfile(pairs: { bet: string; result: string }[]): BetProfile {
  const predicted = { home: 0, draw: 0, away: 0 };
  const actual = { home: 0, draw: 0, away: 0 };
  const scorelines = new Map<string, number>();
  let predictedGoals = 0;
  let actualGoals = 0;

  for (const { bet, result } of pairs) {
    const b = parseScore(bet)!;
    const r = parseScore(result)!;
    predicted[tendencyOf(b)]++;
    actual[tendencyOf(r)]++;
    predictedGoals += b.home + b.away;
    actualGoals += r.home + r.away;
    const key = `${b.home}:${b.away}`;
    scorelines.set(key, (scorelines.get(key) ?? 0) + 1);
  }

  const total = pairs.length;
  const share = (n: number) => (total ? n / total : 0);
  const favourite = [...scorelines.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    predicted: { home: share(predicted.home), draw: share(predicted.draw), away: share(predicted.away) },
    actual: { home: share(actual.home), draw: share(actual.draw), away: share(actual.away) },
    averagePredictedGoals: total ? predictedGoals / total : null,
    averageActualGoals: total ? actualGoals / total : null,
    favouriteScoreline: favourite ? favourite[0] : null,
  };
}

function buildConsistency(form: FormPoint[]): Consistency {
  const scored = form.filter((f) => f.points !== null);
  const points = scored.map((f) => f.points as number);
  const comparable = scored.filter((f) => f.leagueAverage !== null);
  const below = comparable.filter((f) => (f.points as number) < (f.leagueAverage as number));

  const sorted = [...scored].sort((a, b) => (b.points as number) - (a.points as number));

  return {
    mean: mean(points),
    standardDeviation: standardDeviation(points),
    best: sorted[0] ?? null,
    worst: sorted[sorted.length - 1] ?? null,
    belowAverageShare: comparable.length ? below.length / comparable.length : null,
  };
}

/**
 * Everything `kicktipp stats` reports, computed from cached data only.
 *
 * Pure: no I/O, no clock. Metrics degrade independently — a season with
 * leaderboards but no cached bets still yields form and rank history, and
 * `completeness` says exactly how much data each part rests on.
 */
export function computeSeasonStats(
  season: CachedSeason,
  player: string,
  rules: ScoringRules,
  ownPlayer: string | null = player,
): SeasonStats {
  const form = buildForm(season, player);
  const { pairs, matchdaysUsed } = scoredPairs(season, player, ownPlayer);
  const { climb, drop } = rankMoves(form);

  const played = season.matchdays.filter(
    (m) => m.schedule?.length && m.schedule.every((s) => /^\d+:\d+$/.test(s.result)),
  ).length;

  return {
    community: season.community,
    player,
    form,
    rolling5: rollingAverage(form, 5),
    biggestClimb: climb,
    biggestDrop: drop,
    breakdown: buildBreakdown(pairs, rules),
    betProfile: buildBetProfile(pairs),
    consistency: buildConsistency(form),
    rulesUsed: rules,
    completeness: {
      cachedMatchdays: season.matchdays.length,
      playedMatchdays: played,
      knownMatchdays: season.knownMatchdays ?? null,
      withLeaderboard: form.length,
      withBets: matchdaysUsed,
      lastSync: season.lastSync ?? null,
    },
  };
}
