import { describe, it, expect } from 'vitest';
import { projectStandings, findTargetCombinations } from '../src/analytics/scenarios.js';
import type { LeaderboardData, MatchdayBets } from '../src/core.js';

const RULES = { exact: 4, goalDiff: 3, tendency: 2 };

function grid(over: Partial<MatchdayBets> = {}): MatchdayBets {
  return {
    matchday: 5,
    matches: [
      { date: '', home: 'Bayern', away: 'BVB', result: '-:-' },
      { date: '', home: 'Freiburg', away: 'VfB', result: '-:-' },
    ],
    players: [
      { player: 'Me', bets: ['2:1', '1:1'] },
      { player: 'Papa', bets: ['0:1', '2:0'] },
    ],
    ...over,
  };
}

const LEADERBOARD: LeaderboardData = {
  title: 'MD5',
  rankings: [
    // Totals include this matchday's points, which are zero so far.
    { position: '1', name: 'Papa', matchdayPoints: '0', bonus: '0', total: '30', isCurrentPlayer: false },
    { position: '2', name: 'Me', matchdayPoints: '0', bonus: '0', total: '25', isCurrentPlayer: true },
  ],
};

describe('projectStandings with everything pinned', () => {
  const projection = projectStandings(grid(), LEADERBOARD, RULES, [
    { home: 'Bayern', away: 'BVB', result: '2:1' },   // Me exact 4, Papa miss 0
    { home: 'Freiburg', away: 'VfB', result: '2:0' }, // Me miss 0, Papa exact 4
  ]);

  it('is exact and leaves no range', () => {
    expect(projection.exact).toBe(true);
    expect(projection.unspecified).toBe(0);
    expect(projection.note).toBeUndefined();
  });

  it('adds the matchday to the pre-matchday totals', () => {
    const me = projection.players.find((p) => p.player === 'Me')!;
    const papa = projection.players.find((p) => p.player === 'Papa')!;
    expect(me).toMatchObject({ pointsBefore: 25, matchdayBest: 4, totalBest: 29 });
    expect(papa).toMatchObject({ pointsBefore: 30, matchdayBest: 4, totalBest: 34 });
  });

  it('collapses the rank band to a single value', () => {
    const me = projection.players.find((p) => p.player === 'Me')!;
    expect(me.rankBest).toBe(2);
    expect(me.rankWorst).toBe(2);
  });
});

describe('projectStandings with open matches', () => {
  const projection = projectStandings(grid(), LEADERBOARD, RULES, []);

  it('reports a band rather than a number', () => {
    expect(projection.exact).toBe(false);
    expect(projection.unspecified).toBe(2);
    const me = projection.players.find((p) => p.player === 'Me')!;
    // Best: both bets exactly right. Worst: both miss.
    expect(me.matchdayBest).toBe(8);
    expect(me.matchdayWorst).toBe(0);
    expect(me.rankBest).toBeLessThanOrEqual(me.rankWorst);
  });

  it('uses the draw exact value in the best-case range', () => {
    const split = projectStandings(grid(), LEADERBOARD, { ...RULES, drawExact: 6 }, []);
    expect(split.players.find((p) => p.player === 'Me')!.matchdayBest).toBe(10);
  });

  it('tightens as matches get pinned', () => {
    const partial = projectStandings(grid(), LEADERBOARD, RULES, [
      { home: 'Bayern', away: 'BVB', result: '2:1' },
    ]);
    const me = partial.players.find((p) => p.player === 'Me')!;
    expect(partial.unspecified).toBe(1);
    expect(me.matchdayBest - me.matchdayWorst).toBeLessThan(8);
    expect(partial.note).toMatch(/1 match\(es\) left open/);
  });

  it('lets the trailing player reach first place at best', () => {
    const me = projection.players.find((p) => p.player === 'Me')!;
    // Five behind with eight available, so first is reachable.
    expect(me.rankBest).toBe(1);
  });
});

describe('projectStandings edge cases', () => {
  it('counts an already-played match as specified without being told', () => {
    const played = grid({
      matches: [
        { date: '', home: 'Bayern', away: 'BVB', result: '2:1' },
        { date: '', home: 'Freiburg', away: 'VfB', result: '-:-' },
      ],
    });
    const projection = projectStandings(played, LEADERBOARD, RULES, []);
    expect(projection.specified).toBe(1);
    expect(projection.unspecified).toBe(1);
  });

  it('applies a matchday multiplier', () => {
    const projection = projectStandings(grid(), LEADERBOARD, { ...RULES, multipliers: { 5: 2 } }, [
      { home: 'Bayern', away: 'BVB', result: '2:1' },
      { home: 'Freiburg', away: 'VfB', result: '2:0' },
    ]);
    expect(projection.players.find((p) => p.player === 'Me')!.matchdayBest).toBe(8);
  });

  it('refuses to project when bets are still hidden', () => {
    const hidden = grid({ players: [], note: 'Deadline has not passed.' });
    const projection = projectStandings(hidden, LEADERBOARD, RULES, []);
    expect(projection.players).toEqual([]);
    expect(projection.note).toBe('Deadline has not passed.');
  });

  it('ignores a supplied result for a fixture that is not in the matchday', () => {
    const projection = projectStandings(grid(), LEADERBOARD, RULES, [
      { home: 'Nobody', away: 'Nowhere', result: '3:3' },
    ]);
    expect(projection.specified).toBe(0);
  });
});

describe('findTargetCombinations', () => {
  it('finds ways for the trailing player to reach first', () => {
    const search = findTargetCombinations(grid(), LEADERBOARD, RULES, 'Me', 1);
    expect(search.achievable).toBe(true);
    expect(search.examples.length).toBeGreaterThan(0);
    expect(search.examined).toBeGreaterThan(0);
    for (const example of search.examples) {
      expect(example.results).toHaveLength(2);
      expect(example.rank).toBeLessThanOrEqual(1);
    }
  });

  it('says so when a target is out of reach', () => {
    const hopeless: LeaderboardData = {
      title: 'MD5',
      rankings: [
        { position: '1', name: 'Papa', matchdayPoints: '0', bonus: '0', total: '900', isCurrentPlayer: false },
        { position: '2', name: 'Me', matchdayPoints: '0', bonus: '0', total: '25', isCurrentPlayer: true },
      ],
    };
    const search = findTargetCombinations(grid(), hopeless, RULES, 'Me', 1);
    expect(search.achievable).toBe(false);
    expect(search.note).toMatch(/No combination/);
  });

  it('reports an unknown player instead of searching', () => {
    const search = findTargetCombinations(grid(), LEADERBOARD, RULES, 'Nobody', 1);
    expect(search.achievable).toBe(false);
    expect(search.note).toMatch(/no published bets/);
  });

  it('is trivially satisfied when the target rank is already held', () => {
    const search = findTargetCombinations(grid(), LEADERBOARD, RULES, 'Papa', 2);
    expect(search.achievable).toBe(true);
  });
});
