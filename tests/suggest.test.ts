import { describe, it, expect } from 'vitest';
import { impliedProbabilities, parseOdd, toOddsMatches, mostLikely, NEUTRAL_PRIOR } from '../src/analytics/odds.js';
import { expectedPoints, suggestBets } from '../src/analytics/strategies.js';
import { typicalScore, scorelineDistribution } from '../src/analytics/score-map.js';
import type { BetMatch } from '../src/core.js';

const RULES = { exact: 4, goalDiff: 3, tendency: 2 };

function betMatch(over: Partial<BetMatch> = {}): BetMatch {
  return {
    date: '21.08.26 20:30',
    home: 'Bayern',
    away: 'BVB',
    bet: '',
    odds: { home: '1.50', draw: '4.20', away: '6.00' },
    ...over,
  };
}

describe('parseOdd', () => {
  it('reads both decimal separators', () => {
    expect(parseOdd('1.50')).toBe(1.5);
    expect(parseOdd('12,00')).toBe(12);
  });

  it('rejects placeholders and impossible odds', () => {
    expect(parseOdd('-')).toBeNull();
    expect(parseOdd('')).toBeNull();
    expect(parseOdd(undefined)).toBeNull();
    // A decimal odd of 1 or less would pay out no more than the stake.
    expect(parseOdd('1.00')).toBeNull();
  });
});

describe('impliedProbabilities', () => {
  it('removes the bookmaker margin so the three add up to one', () => {
    const p = impliedProbabilities({ home: 1.5, draw: 4.2, away: 6 });
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 10);
    // Raw reciprocals are .667/.238/.167, summing to 1.071 — a 7% margin.
    // Dividing it out leaves 62.2 / 22.2 / 15.6.
    expect(p.home).toBeCloseTo(0.6222, 4);
    expect(p.draw).toBeCloseTo(0.2222, 4);
    expect(p.away).toBeCloseTo(0.1556, 4);
  });

  it('keeps an even market even', () => {
    const p = impliedProbabilities({ home: 3, draw: 3, away: 3 });
    expect(p.home).toBeCloseTo(1 / 3, 10);
  });

  it('ranks the favourite highest', () => {
    const p = impliedProbabilities({ home: 6, draw: 4.2, away: 1.5 });
    expect(mostLikely(p)).toBe('away');
  });
});

describe('toOddsMatches', () => {
  it('carries odds and existing bets through', () => {
    const [match] = toOddsMatches([betMatch({ bet: '2:1' })]);
    expect(match.assumed).toBe(false);
    expect(match.existingBet).toBe('2:1');
    expect(match.probabilities.home).toBeGreaterThan(match.probabilities.away);
  });

  it('falls back to the prior when odds are missing, and says so', () => {
    const [match] = toOddsMatches([betMatch({ odds: { home: '-', draw: '-', away: '-' } })]);
    expect(match.assumed).toBe(true);
    expect(match.probabilities).toEqual(NEUTRAL_PRIOR);
    expect(match.odds).toBeNull();
  });

  it('treats a placeholder bet as no bet', () => {
    const [match] = toOddsMatches([betMatch({ bet: '-' })]);
    expect(match.existingBet).toBeNull();
  });
});

describe('scoreline distribution', () => {
  it('sums to the outcome probabilities it was built from', () => {
    const p = { home: 0.5, draw: 0.3, away: 0.2 };
    const total = scorelineDistribution(p).reduce((s, d) => s + d.probability, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe('typicalScore', () => {
  it('sharpens as the favourite gets heavier', () => {
    expect(typicalScore('home', 0.75)).toEqual({ home: 2, away: 0 });
    expect(typicalScore('home', 0.55)).toEqual({ home: 2, away: 1 });
    expect(typicalScore('home', 0.35)).toEqual({ home: 1, away: 0 });
    expect(typicalScore('away', 0.75)).toEqual({ home: 0, away: 2 });
    expect(typicalScore('draw', 0.3)).toEqual({ home: 1, away: 1 });
  });
});

describe('expectedPoints', () => {
  it('is higher for a bet aligned with the likely outcome', () => {
    const p = { home: 0.7, draw: 0.2, away: 0.1 };
    const backing = expectedPoints({ home: 2, away: 0 }, p, RULES);
    const fading = expectedPoints({ home: 0, away: 2 }, p, RULES);
    expect(backing).toBeGreaterThan(fading);
  });

  it('rises when exact results pay more', () => {
    const p = { home: 0.7, draw: 0.2, away: 0.1 };
    const modest = expectedPoints({ home: 2, away: 0 }, p, RULES);
    const generous = expectedPoints({ home: 2, away: 0 }, p, { exact: 20, goalDiff: 3, tendency: 2 });
    expect(generous).toBeGreaterThan(modest);
  });
});

describe('strategies', () => {
  const heavyFavourite = toOddsMatches([betMatch()]);
  const closeMatch = toOddsMatches([
    betMatch({ odds: { home: '2.60', draw: '3.30', away: '2.70' } }),
  ]);

  it('safe backs the favourite', () => {
    const [pick] = suggestBets(heavyFavourite, RULES, 'safe');
    // 62% home win: a clear favourite, but not a rout — 2:1.
    expect(pick.bet).toBe('2:1');
    expect(pick.reasoning).toMatch(/Bayern 62%/);
  });

  it('ev maximises expected points and beats an arbitrary pick', () => {
    const [pick] = suggestBets(heavyFavourite, RULES, 'ev');
    const alternative = expectedPoints({ home: 0, away: 3 }, heavyFavourite[0].probabilities, RULES);
    expect(pick.expectedPoints).toBeGreaterThan(alternative);
    expect(pick.reasoning).toMatch(/maximises expected points/);
  });

  it('ev follows the rules it is given', () => {
    const exactHeavy = suggestBets(heavyFavourite, { exact: 50, goalDiff: 1, tendency: 1 }, 'ev')[0];
    // With exact results paying that well, the single likeliest scoreline wins.
    expect(exactHeavy.expectedPoints).toBeGreaterThan(5);
  });

  it('contrarian fades the favourite only in a close match', () => {
    const [close] = suggestBets(closeMatch, RULES, 'contrarian');
    expect(close.reasoning).toMatch(/fading the favourite/);

    const [lopsided] = suggestBets(heavyFavourite, RULES, 'contrarian');
    expect(lopsided.reasoning).toMatch(/too one-sided to fade/);
  });

  it('the three strategies disagree where it matters', () => {
    const safeBet = suggestBets(closeMatch, RULES, 'safe')[0].bet;
    const contrarianBet = suggestBets(closeMatch, RULES, 'contrarian')[0].bet;
    expect(safeBet).not.toBe(contrarianBet);
  });

  it('marks suggestions built without odds', () => {
    const noOdds = toOddsMatches([betMatch({ odds: { home: '-', draw: '-', away: '-' } })]);
    const [pick] = suggestBets(noOdds, RULES, 'safe');
    expect(pick.assumed).toBe(true);
    expect(pick.reasoning).toMatch(/no odds published/);
  });

  it('reports the bet already placed so it is not silently replaced', () => {
    const withBet = toOddsMatches([betMatch({ bet: '3:3' })]);
    const [pick] = suggestBets(withBet, RULES, 'safe');
    expect(pick.existingBet).toBe('3:3');
  });

  it('rejects an unknown strategy', () => {
    expect(() => suggestBets(heavyFavourite, RULES, 'lucky' as never)).toThrow(/Unknown strategy/);
  });
});
