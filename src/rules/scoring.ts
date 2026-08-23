/**
 * How a community turns a prediction into points.
 *
 * Only Kicktipp's standard three-tier scheme is modelled. Communities with
 * per-match multipliers or odds-based scoring are detected by the parser and
 * reported as unsupported rather than scored wrongly.
 */
export interface ScoringRules {
  /** Right score, e.g. predicted 2:1 and it finished 2:1. */
  exact: number;
  /** Right goal difference on a non-draw, e.g. predicted 2:1, finished 3:2. */
  goalDiff: number;
  /** Right winner (or a draw predicted and drawn), nothing more. */
  tendency: number;
}

export type RulesSource = 'parsed' | 'config' | 'default';

export interface ResolvedRules {
  values: ScoringRules;
  source: RulesSource;
  /** Present when the rules page held something this model cannot express. */
  warning?: string;
}

/** Kicktipp's out-of-the-box scheme, used when nothing better is known. */
export const DEFAULT_RULES: ScoringRules = { exact: 4, goalDiff: 3, tendency: 2 };

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
  return pointsFor(classify(b, r), rules);
}
