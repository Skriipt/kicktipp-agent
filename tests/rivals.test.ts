import { describe, it, expect } from 'vitest';
import { analyseRival, matchSwing } from '../src/analytics/rivals.js';
import type { MatchdayBets } from '../src/core.js';

const RULES = { exact: 4, goalDiff: 3, tendency: 2 };
const OPEN = { date: '', home: 'Bayern', away: 'BVB', result: '-:-' };

describe('matchSwing on a settled match', () => {
  it('is a fixed difference once the result is in', () => {
    const swing = matchSwing(
      { date: '', home: 'A', away: 'B', result: '2:1' },
      '2:1', // exact, 4
      '1:0', // same difference, 3
      RULES,
      true,
    );
    expect(swing.settled).toBe(1);
    expect(swing.bestForMe).toBe(1);
    expect(swing.worstForMe).toBe(1);
  });

  it('counts a missing bet as zero points', () => {
    const swing = matchSwing(
      { date: '', home: 'A', away: 'B', result: '2:1' },
      '2:1',
      null,
      RULES,
      true,
    );
    expect(swing.settled).toBe(4);
  });
});

describe('matchSwing with both bets known', () => {
  it('gives the range each outcome can produce', () => {
    // I back the home win, the rival backs the away win.
    const swing = matchSwing(OPEN, '2:1', '0:1', RULES, true);

    // A home win pays me and not them; an away win does the reverse.
    expect(swing.byOutcome!.home.best).toBe(4);
    expect(swing.byOutcome!.away.worst).toBe(-4);
    // Neither of us predicted a draw, so a draw changes nothing.
    expect(swing.byOutcome!.draw).toEqual({ best: 0, worst: 0 });
    expect(swing.bestForMe).toBe(4);
    expect(swing.worstForMe).toBe(-4);
  });

  it('is all zeroes when both predicted the same score', () => {
    const swing = matchSwing(OPEN, '2:1', '2:1', RULES, true);
    expect(swing.bestForMe).toBe(0);
    expect(swing.worstForMe).toBe(0);
  });

  it('separates exact from same-difference on the same tendency', () => {
    // Both back the home win, but only one can be exactly right.
    const swing = matchSwing(OPEN, '2:1', '3:1', RULES, true);
    expect(swing.bestForMe).toBeGreaterThan(0);
    expect(swing.worstForMe).toBeLessThan(0);
  });
});

describe('matchSwing with the rival hidden', () => {
  it('widens to bounds and offers no per-outcome detail', () => {
    const swing = matchSwing(OPEN, '2:1', null, RULES, false);
    // Best case: I hit exactly and they score nothing.
    expect(swing.bestForMe).toBe(RULES.exact);
    // Worst case: I miss and they hit exactly.
    expect(swing.worstForMe).toBe(-RULES.exact);
    expect(swing.byOutcome).toBeUndefined();
  });
});

function grid(overrides: Partial<MatchdayBets> = {}): MatchdayBets {
  return {
    matchday: 5,
    matches: [
      { date: '', home: 'Bayern', away: 'BVB', result: '-:-' },
      { date: '', home: 'Freiburg', away: 'VfB', result: '-:-' },
    ],
    players: [
      { player: 'Me', bets: ['2:1', '1:1'] },
      { player: 'Papa', bets: ['0:1', '1:1'] },
    ],
    ...overrides,
  };
}

describe('analyseRival', () => {
  it('works out what it takes to catch up', () => {
    const analysis = analyseRival(grid(), 'Me', 'Papa', RULES, -3);
    expect(analysis.mode).toBe('exact');
    expect(analysis.gap).toBe(-3);
    // Only the first match differs, so at most 4 points can swing.
    expect(analysis.swingRange).toEqual({ best: 4, worst: -4 });
    expect(analysis.conditions[0]).toMatch(/out-score Papa by 4/);
    expect(analysis.conditions.join(' ')).toMatch(/Bayern vs BVB: you gain on Bayern win/);
  });

  it('says so when the gap cannot be closed this matchday', () => {
    const analysis = analyseRival(grid(), 'Me', 'Papa', RULES, -20);
    expect(analysis.conditions[0]).toMatch(/out of reach/);
  });

  it('confirms an unassailable lead', () => {
    const analysis = analyseRival(grid(), 'Me', 'Papa', RULES, 10);
    expect(analysis.conditions[0]).toMatch(/stay ahead whatever happens/);
  });

  it('warns when a lead is still catchable', () => {
    const analysis = analyseRival(grid(), 'Me', 'Papa', RULES, 2);
    expect(analysis.conditions[0]).toMatch(/can still be caught/);
  });

  it('folds already-decided matches into the gap', () => {
    const settled = grid({
      matches: [
        { date: '', home: 'Bayern', away: 'BVB', result: '2:1' },
        { date: '', home: 'Freiburg', away: 'VfB', result: '-:-' },
      ],
    });
    // I hit 2:1 exactly (4), Papa's 0:1 misses (0), so the gap improves by 4.
    const analysis = analyseRival(settled, 'Me', 'Papa', RULES, -5);
    expect(analysis.gap).toBe(-1);
    expect(analysis.swingRange).toEqual({ best: 0, worst: 0 });
  });

  it('drops to bounds when the rival is not in the grid', () => {
    const hidden = grid({ players: [{ player: 'Me', bets: ['2:1', '1:1'] }] });
    const analysis = analyseRival(hidden, 'Me', 'Papa', RULES, -3);
    expect(analysis.mode).toBe('bounds');
    expect(analysis.note).toMatch(/not visible yet/);
    expect(analysis.swingRange.best).toBe(8);
    expect(analysis.swingRange.worst).toBe(-8);
  });

  it('passes through the parser note when no bets were published', () => {
    const empty = grid({ players: [], note: 'Deadline has not passed.' });
    const analysis = analyseRival(empty, 'Me', 'Papa', RULES, -3);
    expect(analysis.mode).toBe('bounds');
    expect(analysis.note).toBe('Deadline has not passed.');
  });

  it('reports only the swing range when standings are unknown', () => {
    const analysis = analyseRival(grid(), 'Me', 'Papa', RULES, null);
    expect(analysis.gap).toBeNull();
    expect(analysis.conditions[0]).toMatch(/not cached/);
  });
});
