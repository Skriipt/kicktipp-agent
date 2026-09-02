import type { Score } from '../rules/scoring.js';
import type { Probabilities } from './odds.js';

/**
 * Scorelines to consider for a match, with how often football actually ends
 * that way given the outcome.
 *
 * These are rounded long-run frequencies for top-flight European league
 * football, normalized per outcome. They exist so that "predict a home win"
 * can be turned into an actual scoreline, and so expected points can weigh
 * one candidate against another. They are deliberately fixed and inspectable
 * rather than fitted — every suggestion has to be explainable.
 */
export const SCORELINE_FREQUENCY: {
  outcome: 'home' | 'draw' | 'away';
  score: Score;
  share: number;
}[] = [
  { outcome: 'home', score: { home: 1, away: 0 }, share: 0.27 },
  { outcome: 'home', score: { home: 2, away: 0 }, share: 0.22 },
  { outcome: 'home', score: { home: 2, away: 1 }, share: 0.24 },
  { outcome: 'home', score: { home: 3, away: 0 }, share: 0.11 },
  { outcome: 'home', score: { home: 3, away: 1 }, share: 0.11 },
  { outcome: 'home', score: { home: 3, away: 2 }, share: 0.05 },

  { outcome: 'draw', score: { home: 1, away: 1 }, share: 0.44 },
  { outcome: 'draw', score: { home: 0, away: 0 }, share: 0.31 },
  { outcome: 'draw', score: { home: 2, away: 2 }, share: 0.20 },
  { outcome: 'draw', score: { home: 3, away: 3 }, share: 0.05 },

  { outcome: 'away', score: { home: 0, away: 1 }, share: 0.29 },
  { outcome: 'away', score: { home: 0, away: 2 }, share: 0.23 },
  { outcome: 'away', score: { home: 1, away: 2 }, share: 0.24 },
  { outcome: 'away', score: { home: 0, away: 3 }, share: 0.11 },
  { outcome: 'away', score: { home: 1, away: 3 }, share: 0.08 },
  { outcome: 'away', score: { home: 2, away: 3 }, share: 0.05 },
];

/** Probability of each candidate scoreline, given the outcome probabilities. */
export function scorelineDistribution(p: Probabilities): { score: Score; probability: number }[] {
  return SCORELINE_FREQUENCY.map(({ outcome, score, share }) => ({
    score,
    probability: p[outcome] * share,
  }));
}

/**
 * The scoreline to predict when backing an outcome: the most common one for
 * that outcome, sharpened when the favourite is heavy.
 */
export function typicalScore(outcome: 'home' | 'draw' | 'away', strength: number): Score {
  if (outcome === 'draw') return strength > 0.4 ? { home: 1, away: 1 } : { home: 1, away: 1 };
  if (outcome === 'home') {
    if (strength >= 0.7) return { home: 2, away: 0 };
    if (strength >= 0.5) return { home: 2, away: 1 };
    return { home: 1, away: 0 };
  }
  if (strength >= 0.7) return { home: 0, away: 2 };
  if (strength >= 0.5) return { home: 1, away: 2 };
  return { home: 0, away: 1 };
}

export function formatScore(score: Score): string {
  return `${score.home}:${score.away}`;
}
