import { describe, it, expect } from 'vitest';
import { verifyRules } from '../src/rules/verify.js';
import { parseMultipliers, parseScoringRules } from '../src/rules/parse-rules.js';
import { multiplierFor } from '../src/rules/scoring.js';
import type { LeaderboardData, MatchdayBets, RulesSection } from '../src/core.js';

const RULES = { exact: 4, goalDiff: 3, tendency: 2 };

function grid(over: Partial<MatchdayBets> = {}): MatchdayBets {
  return {
    matchday: 3,
    matches: [
      { date: '', home: 'A', away: 'B', result: '2:1' },
      { date: '', home: 'C', away: 'D', result: '0:0' },
    ],
    players: [
      { player: 'Me', bets: ['2:1', '1:1'] },   // exact 4 + tendency 2 = 6
      { player: 'Papa', bets: ['1:0', '2:0'] }, // goalDiff 3 + miss 0 = 3
    ],
    ...over,
  };
}

function leaderboard(points: Record<string, string>): LeaderboardData {
  return {
    title: 'MD3',
    rankings: Object.entries(points).map(([name, matchdayPoints], i) => ({
      position: String(i + 1),
      name,
      matchdayPoints,
      bonus: '0',
      total: '99',
      isCurrentPlayer: false,
    })),
  };
}

describe('verifyRules', () => {
  it('confirms rules that reproduce every reported score', () => {
    const result = verifyRules(grid(), leaderboard({ Me: '6', Papa: '3' }), RULES);
    expect(result.verified).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.agreed).toBe(2);
    expect(result.players.every((p) => p.agrees)).toBe(true);
  });

  it('verifies separate draw points', () => {
    const result = verifyRules(grid(), leaderboard({ Me: '7', Papa: '3' }), {
      exact: 5,
      goalDiff: 3,
      tendency: 1,
      drawExact: 5,
      drawTendency: 2,
    });
    expect(result.verified).toBe(true);
  });

  it('catches point values that do not reproduce them', () => {
    // With 3/2/1 the computed scores no longer match Kicktipp's numbers.
    const result = verifyRules(grid(), leaderboard({ Me: '6', Papa: '3' }), {
      exact: 3,
      goalDiff: 2,
      tendency: 1,
    });
    expect(result.verified).toBe(false);
    expect(result.agreed).toBeLessThan(result.checked);
  });

  it('accounts for a matchday multiplier', () => {
    const doubled = { ...RULES, multipliers: { 3: 2 } };
    const result = verifyRules(grid(), leaderboard({ Me: '12', Papa: '6' }), doubled);
    expect(result.verified).toBe(true);
  });

  it('refuses to judge an unfinished matchday', () => {
    const unfinished = grid({
      matches: [
        { date: '', home: 'A', away: 'B', result: '2:1' },
        { date: '', home: 'C', away: 'D', result: '-:-' },
      ],
    });
    const result = verifyRules(unfinished, leaderboard({ Me: '6' }), RULES);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/not finished/);
  });

  it('says so when no bets are published', () => {
    const hidden = grid({ players: [], note: 'Deadline has not passed.' });
    const result = verifyRules(hidden, leaderboard({ Me: '6' }), RULES);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe('Deadline has not passed.');
  });

  it('ignores players who are not on the leaderboard', () => {
    const result = verifyRules(grid(), leaderboard({ Me: '6' }), RULES);
    expect(result.checked).toBe(1);
    expect(result.verified).toBe(true);
    expect(result.players.find((p) => p.player === 'Papa')?.reported).toBeNull();
  });

  it('reports when nobody can be compared at all', () => {
    const result = verifyRules(grid(), leaderboard({ Someone: '1' }), RULES);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/none of the players/i);
  });
});

function text(value: string): RulesSection[] {
  return [{ type: 'paragraph', text: value }];
}

describe('parseMultipliers', () => {
  it('reads a doubled final matchday in German', () => {
    expect(parseMultipliers(text('Am Spieltag 34 zählen alle Punkte doppelt.'))).toEqual({ 34: 2 });
  });

  it('reads the English wording', () => {
    expect(parseMultipliers(text('Matchday 34 counts double.'))).toEqual({ 34: 2 });
  });

  it('reads a numeric factor', () => {
    expect(parseMultipliers(text('Spieltag 17 zählt dreifach.'))).toEqual({ 17: 3 });
  });

  it('ignores a matchday outside the season', () => {
    expect(parseMultipliers(text('Spieltag 99 zählt doppelt.'))).toEqual({});
  });

  it('stays empty when nothing says so', () => {
    expect(parseMultipliers(text('Viel Spaß beim Tippen.'))).toEqual({});
  });
});

describe('multiplierFor', () => {
  it('defaults to one', () => {
    expect(multiplierFor(3, RULES)).toBe(1);
    expect(multiplierFor(null, { ...RULES, multipliers: { 3: 2 } })).toBe(1);
  });

  it('applies a configured factor', () => {
    expect(multiplierFor(34, { ...RULES, multipliers: { 34: 2 } })).toBe(2);
  });
});

describe('parseScoringRules confidence', () => {
  it('marks a parsed table as parsed, not verified', () => {
    const parsed = parseScoringRules([
      {
        type: 'table',
        headers: ['Regel', 'Punkte'],
        rows: [
          ['Richtiges Ergebnis', '4'],
          ['Richtige Tordifferenz', '3'],
          ['Richtige Tendenz', '2'],
        ],
      },
    ]);
    expect(parsed?.confidence).toBe('parsed');
  });

  it('carries multipliers through from the surrounding text', () => {
    const parsed = parseScoringRules([
      {
        type: 'table',
        headers: ['Regel', 'Punkte'],
        rows: [['Richtiges Ergebnis', '4'], ['Richtige Tendenz', '2']],
      },
      { type: 'paragraph', text: 'Spieltag 34 zählt doppelt.' },
    ]);
    expect(parsed?.values.multipliers).toEqual({ 34: 2 });
  });
});
