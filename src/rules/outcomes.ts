import { parseScore, scoreBet, tendencyOf, type Score, type ScoringRules } from './scoring.js';

/** One result from every scoring-equivalence class for these predictions.
 * A result is either an exact prediction, a nonexact result with a predicted
 * goal difference, or an unpredicted difference of either sign (or a draw).
 * Consequently every possible result produces the same points as one entry.
 */
export function resultRepresentatives(bets: readonly (string | null | undefined)[]): Score[] {
  const exact = new Map<string, Score>();
  for (const bet of bets) {
    const score = parseScore(bet);
    if (score && (!Number.isSafeInteger(score.home) || !Number.isSafeInteger(score.away))) {
      throw new RangeError('Prediction goals exceed the supported integer range.');
    }
    if (score) exact.set(`${score.home}:${score.away}`, score);
  }
  const results = [...exact.values()];
  const differences = new Set(results.map((s) => s.home - s.away));
  const addNonexact = (difference: number): void => {
    let home = Math.max(difference, 0);
    let away = Math.max(-difference, 0);
    while (exact.has(`${home}:${away}`)) {
      // There is no further nonexact result in the supported integer range.
      if (home === Number.MAX_SAFE_INTEGER || away === Number.MAX_SAFE_INTEGER) return;
      home++; away++;
    }
    results.push({ home, away });
  };
  for (const difference of differences) if (difference !== 0) addNonexact(difference);
  addNonexact(0);
  for (const sign of [1, -1]) {
    let difference = sign;
    while (differences.has(difference)) difference += sign;
    addNonexact(difference);
  }
  return results;
}

/** Empty means no tip; a hidden placeholder or missing player means unknown. */
export function isUnknownBet(bet: string | null | undefined): boolean {
  return bet == null || (bet !== '' && parseScore(bet) === null);
}

/** Bounds for a prediction, retaining the distinction between missing and hidden. */
export function pointRange(
  bet: string | null | undefined,
  result: Score | null,
  rules: ScoringRules,
): { best: number; worst: number } {
  const parsed = parseScore(bet);
  if (parsed && result) {
    const points = scoreBet(parsed, result, rules);
    return { best: points, worst: points };
  }
  if (bet === '') return { best: 0, worst: 0 };
  const outcome = result ? tendencyOf(result) : parsed ? tendencyOf(parsed) : null;
  const possible = [0];
  if (outcome !== 'draw') possible.push(rules.exact, rules.goalDiff, rules.tendency);
  if (outcome === null || outcome === 'draw') {
    possible.push(rules.drawExact ?? rules.exact, rules.drawTendency ?? rules.tendency);
  }
  return { best: Math.max(...possible), worst: Math.min(...possible) };
}
