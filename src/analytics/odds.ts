import type { BetMatch } from '../core.js';

export interface Probabilities {
  home: number;
  draw: number;
  away: number;
}

export interface OddsMatch {
  home: string;
  away: string;
  /** The bet already placed on this match, if any. */
  existingBet: string | null;
  odds: { home: number; draw: number; away: number } | null;
  probabilities: Probabilities;
  /** True when no usable odds were published and a prior was used instead. */
  assumed: boolean;
}

/**
 * Long-run split of Bundesliga-style results, used when a community has no
 * odds. It is a blunt instrument — every match gets the same numbers — and
 * suggestions built on it are flagged as assumed.
 */
export const NEUTRAL_PRIOR: Probabilities = { home: 0.45, draw: 0.27, away: 0.28 };

/** Kicktipp prints odds like "1.5", "12,00" or "-" when it has none. */
export function parseOdd(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.replace(',', '.').match(/\d+(\.\d+)?/);
  if (!match) return null;
  const odd = Number(match[0]);
  // A decimal odd below 1 pays out less than the stake, so it is not real.
  return odd > 1 ? odd : null;
}

/**
 * Turn decimal odds into probabilities that add up to one.
 *
 * The reciprocals of a bookmaker's odds sum to more than 1 — the difference
 * is their margin. Dividing each by the total removes it proportionally,
 * which is the standard first-order de-vig.
 */
export function impliedProbabilities(odds: {
  home: number;
  draw: number;
  away: number;
}): Probabilities {
  const raw = { home: 1 / odds.home, draw: 1 / odds.draw, away: 1 / odds.away };
  const total = raw.home + raw.draw + raw.away;
  if (!Number.isFinite(total) || total <= 0) return { ...NEUTRAL_PRIOR };
  return { home: raw.home / total, draw: raw.draw / total, away: raw.away / total };
}

/** Pair each match with probabilities, falling back to the prior. */
export function toOddsMatches(matches: BetMatch[]): OddsMatch[] {
  return matches.map((match) => {
    const home = parseOdd(match.odds.home);
    const draw = parseOdd(match.odds.draw);
    const away = parseOdd(match.odds.away);
    const complete = home !== null && draw !== null && away !== null;

    return {
      home: match.home,
      away: match.away,
      existingBet: /^\d+:\d+$/.test(match.bet) ? match.bet : null,
      odds: complete ? { home, draw, away } : null,
      probabilities: complete
        ? impliedProbabilities({ home, draw, away })
        : { ...NEUTRAL_PRIOR },
      assumed: !complete,
    };
  });
}

export function mostLikely(p: Probabilities): 'home' | 'draw' | 'away' {
  if (p.home >= p.draw && p.home >= p.away) return 'home';
  if (p.away >= p.draw) return 'away';
  return 'draw';
}
