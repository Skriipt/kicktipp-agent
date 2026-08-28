import { classify, parseScore, type ScoringRules, type Score, pointsFor } from '../rules/scoring.js';
import { mostLikely, type OddsMatch, type Probabilities } from './odds.js';
import { formatScore, scorelineDistribution, typicalScore } from './score-map.js';

export type StrategyName = 'safe' | 'ev' | 'contrarian' | 'auto';
export const STRATEGIES: StrategyName[] = ['safe', 'ev', 'contrarian', 'auto'];

/**
 * How much better an EV pick has to be before `auto` prefers it over the
 * safer choice. Below this the two are effectively tied, and the lower
 * variance option wins.
 */
export const AUTO_EV_MARGIN = 0.15;

export interface SuggestedBet {
  home: string;
  away: string;
  bet: string;
  /** True when the user fixed this pick and no strategy was applied. */
  pinned?: boolean;
  probabilities: Probabilities;
  odds: { home: number; draw: number; away: number } | null;
  /** Expected points under the community's rules, for comparison. */
  expectedPoints: number;
  reasoning: string;
  existingBet: string | null;
  /** True when no odds were published and a generic prior was used. */
  assumed: boolean;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Expected points of predicting `bet`, averaged over how matches finish. */
export function expectedPoints(
  bet: Score,
  probabilities: Probabilities,
  rules: ScoringRules,
): number {
  return scorelineDistribution(probabilities).reduce(
    (sum, { score, probability }) => sum + probability * pointsFor(classify(bet, score), rules),
    0,
  );
}

function describeOdds(match: OddsMatch): string {
  if (match.assumed) return 'no odds published, generic prior used';
  const outcome = mostLikely(match.probabilities);
  const label = outcome === 'home' ? match.home : outcome === 'away' ? match.away : 'a draw';
  const odd = match.odds ? ` (odds ${match.odds[outcome].toFixed(2)})` : '';
  return `${label} ${percent(match.probabilities[outcome])}${odd}`;
}

function build(
  match: OddsMatch,
  bet: Score,
  rules: ScoringRules,
  reasoning: string,
): SuggestedBet {
  return {
    home: match.home,
    away: match.away,
    bet: formatScore(bet),
    probabilities: match.probabilities,
    odds: match.odds,
    expectedPoints: expectedPoints(bet, match.probabilities, rules),
    reasoning,
    existingBet: match.existingBet,
    assumed: match.assumed,
  };
}

/** Back the likeliest outcome with its most typical scoreline. */
function safe(match: OddsMatch, rules: ScoringRules): SuggestedBet {
  const outcome = mostLikely(match.probabilities);
  const bet = typicalScore(outcome, match.probabilities[outcome]);
  return build(match, bet, rules, `${describeOdds(match)} → typical scoreline ${formatScore(bet)}`);
}

/**
 * Pick the scoreline with the highest expected points under the community's
 * rules. Where an exact hit pays well this will prefer a likelier exact
 * score over a safer tendency.
 */
function ev(match: OddsMatch, rules: ScoringRules): SuggestedBet {
  const candidates = scorelineDistribution(match.probabilities).map(({ score }) => ({
    score,
    value: expectedPoints(score, match.probabilities, rules),
  }));
  const best = candidates.reduce((a, b) => (b.value > a.value ? b : a));
  return build(
    match,
    best.score,
    rules,
    `${describeOdds(match)} → ${formatScore(best.score)} maximises expected points (${best.value.toFixed(2)})`,
  );
}

/**
 * Deviate from the crowd where the match is close enough that an upset is
 * plausible: back the second-likeliest outcome. High variance by design —
 * it trades average points for separation from the field.
 */
function contrarian(match: OddsMatch, rules: ScoringRules): SuggestedBet {
  const ranked = (['home', 'draw', 'away'] as const)
    .map((outcome) => ({ outcome, p: match.probabilities[outcome] }))
    .sort((a, b) => b.p - a.p);

  const [favourite, second] = ranked;
  // A heavy favourite is not worth fading; take the safe bet instead.
  if (favourite.p - second.p > 0.25) {
    const pick = safe(match, rules);
    return { ...pick, reasoning: `${pick.reasoning} — too one-sided to fade` };
  }

  const bet = typicalScore(second.outcome, second.p);
  return build(
    match,
    bet,
    rules,
    `close match (${percent(favourite.p)} vs ${percent(second.p)}) → fading the favourite with ${formatScore(bet)}`,
  );
}

/**
 * Take the EV pick only when it is meaningfully better than the safe one;
 * otherwise prefer the lower-variance choice. Deterministic, and the
 * threshold is a named constant so the behaviour is inspectable.
 */
function auto(match: OddsMatch, rules: ScoringRules): SuggestedBet {
  const safePick = safe(match, rules);
  const evPick = ev(match, rules);
  if (evPick.expectedPoints - safePick.expectedPoints > AUTO_EV_MARGIN) {
    return { ...evPick, reasoning: `${evPick.reasoning} — clear enough to prefer over the safe pick` };
  }
  return {
    ...safePick,
    reasoning: `${safePick.reasoning} — expected points too close to call, taking the safer pick`,
  };
}

const IMPLEMENTATIONS: Record<StrategyName, (m: OddsMatch, r: ScoringRules) => SuggestedBet> = {
  safe,
  ev,
  contrarian,
  auto,
};

/** A pick the user fixed themselves, which no strategy may override. */
export interface PinnedBet {
  home: string;
  away: string;
  bet: string;
}

function pinnedFor(match: OddsMatch, pins: PinnedBet[]): PinnedBet | undefined {
  return pins.find(
    (p) =>
      p.home.toLowerCase() === match.home.toLowerCase() &&
      p.away.toLowerCase() === match.away.toLowerCase(),
  );
}

export function suggestBets(
  matches: OddsMatch[],
  rules: ScoringRules,
  strategy: StrategyName = 'safe',
  pins: PinnedBet[] = [],
): SuggestedBet[] {
  const pick = IMPLEMENTATIONS[strategy];
  if (!pick) throw new Error(`Unknown strategy '${strategy}'. Options: ${STRATEGIES.join(', ')}`);

  return matches.map((match) => {
    const pin = pinnedFor(match, pins);
    if (!pin) return pick(match, rules);
    const parsed = parseScore(pin.bet);
    if (!parsed) throw new Error(`Invalid pinned bet '${pin.bet}' for ${pin.home} vs ${pin.away}.`);
    return {
      ...build(match, parsed, rules, 'pinned by you'),
      pinned: true,
    };
  });
}
