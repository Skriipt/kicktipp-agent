/**
 * How a community turns a prediction into points.
 *
 * Only Kicktipp's standard three-tier scheme is modelled. Communities with
 * per-match multipliers or odds-based scoring are detected by the parser and
 * reported as unsupported rather than scored wrongly.
 */
export interface ScoringRules {
  /** Right score after a win, e.g. predicted 2:1 and it finished 2:1. */
  exact: number;
  /** Right goal difference on a non-draw, e.g. predicted 2:1, finished 3:2. */
  goalDiff: number;
  /** Right winner, nothing more. */
  tendency: number;
  /** Exact draw; falls back to `exact` for older configs and parsed rules. */
  drawExact?: number;
  /** Inexact draw; falls back to `tendency` for older configs and parsed rules. */
  drawTendency?: number;
  /**
   * Per-matchday point multipliers, for communities that double the final
   * matchday and the like. Applied when a matchday total is aggregated, not
   * per bet, so scoreBet stays a pure per-match function.
   */
  multipliers?: Record<number, number>;
}

export type RulesSource = 'parsed' | 'config' | 'default';

/**
 * How much the point values can be trusted. `verified` is only ever set by
 * a check that recomputed a finished matchday and matched Kicktipp's own
 * numbers for every player.
 */
export type RulesConfidence = 'verified' | 'parsed' | 'assumed';

export interface ResolvedRules {
  values: ScoringRules;
  source: RulesSource;
  confidence: RulesConfidence;
  /** Present when the rules page held something this model cannot express. */
  warning?: string;
  /** Prevent analytics from proceeding with a recognized but unsupported scheme. */
  unsupported?: boolean;
}

/** Kicktipp's out-of-the-box scheme, used when nothing better is known. */
export const DEFAULT_RULES: ScoringRules = { exact: 4, goalDiff: 3, tendency: 2 };

export function formatScoringRules(rules: ScoringRules): string {
  return `win: tendency ${rules.tendency}, difference ${rules.goalDiff}, exact ${rules.exact}; draw: tendency ${rules.drawTendency ?? rules.tendency}, exact ${rules.drawExact ?? rules.exact}`;
}

/** The multiplier a matchday's points are scaled by, default 1. */
export function multiplierFor(matchday: number | null | undefined, rules: ScoringRules): number {
  if (matchday == null) return 1;
  return rules.multipliers?.[matchday] ?? 1;
}

export interface Score {
  home: number;
  away: number;
}

export type HitKind = 'exact' | 'goalDiff' | 'tendency' | 'miss';

/** '2:1' → {home:2, away:1}; anything else → null. */
export function parseScore(value: string | null | undefined): Score | null {
  const match = String(value ?? '').match(/^\s*(\d+)\s*[:\-]\s*(\d+)\s*$/);
  if (!match) return null;
  return { home: Number(match[1]), away: Number(match[2]) };
}

export function tendencyOf(score: Score): 'home' | 'draw' | 'away' {
  if (score.home > score.away) return 'home';
  if (score.home < score.away) return 'away';
  return 'draw';
}

/** Which tier a prediction lands in. */
export function classify(bet: Score, result: Score): HitKind {
  if (bet.home === result.home && bet.away === result.away) return 'exact';
  if (tendencyOf(bet) !== tendencyOf(result)) return 'miss';
  // A predicted draw that is not the exact draw only ever scores tendency:
  // every draw has goal difference zero, so "right difference" would be the
  // same thing twice.
  if (tendencyOf(bet) === 'draw') return 'tendency';
  if (bet.home - bet.away === result.home - result.away) return 'goalDiff';
  return 'tendency';
}

export function pointsFor(kind: HitKind, rules: ScoringRules): number {
  switch (kind) {
    case 'exact':
      return rules.exact;
    case 'goalDiff':
      return rules.goalDiff;
    case 'tendency':
      return rules.tendency;
    default:
      return 0;
  }
}

/** Points a single prediction earns against a final result. */
export function scoreBet(
  bet: string | Score | null | undefined,
  result: string | Score | null | undefined,
  rules: ScoringRules,
): number {
  const b = typeof bet === 'string' || bet == null ? parseScore(bet as string) : bet;
  const r = typeof result === 'string' || result == null ? parseScore(result as string) : result;
  if (!b || !r) return 0;
  const kind = classify(b, r);
  if (tendencyOf(r) === 'draw') {
    if (kind === 'exact') return rules.drawExact ?? rules.exact;
    if (kind === 'tendency') return rules.drawTendency ?? rules.tendency;
  }
  return pointsFor(kind, rules);
}
