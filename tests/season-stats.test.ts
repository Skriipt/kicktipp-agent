import { describe, it, expect } from 'vitest';
import { computeSeasonStats } from '../src/analytics/season-stats.js';
import type { CachedSeason } from '../src/analytics/season.js';

const RULES = { exact: 4, goalDiff: 3, tendency: 2 };
const ME = 'Me';

function ranking(name: string, position: string, matchdayPoints: string, total: string) {
  return { position, name, matchdayPoints, bonus: '0', total, isCurrentPlayer: name === ME };
}

/**
 * Two matchdays, hand-checked:
 *  MD1 - bets 2:1 (finished 2:1, exact=4) and 1:1 (finished 0:2, miss=0)
 *  MD2 - bets 3:0 (finished 2:0, goalDiff... 3-0=3, 2-0=2 → tendency=2)
 *        and 0:1 (finished 1:2, goalDiff=3)
 */
const SEASON: CachedSeason = {
  community: 'mycomm',
  knownMatchdays: 2,
  lastSync: '2026-08-01T00:00:00.000Z',
  matchdays: [
    {
      matchday: 1,
      schedule: [
        { date: '', home: 'A', away: 'B', result: '2:1' },
        { date: '', home: 'C', away: 'D', result: '0:2' },
      ],
      bets: [
        { date: '', home: 'A', away: 'B', bet: '2:1', odds: { home: '1.5', draw: '4.0', away: '6.0' } },
        { date: '', home: 'C', away: 'D', bet: '1:1', odds: { home: '2.0', draw: '3.0', away: '3.5' } },
      ],
      leaderboard: {
        title: 'MD1',
        rankings: [ranking(ME, '2', '4', '4'), ranking('Papa', '1', '6', '6')],
      },
    },
    {
      matchday: 2,
      schedule: [
        { date: '', home: 'E', away: 'F', result: '2:0' },
        { date: '', home: 'G', away: 'H', result: '1:2' },
      ],
      bets: [
        { date: '', home: 'E', away: 'F', bet: '3:0', odds: { home: '1.4', draw: '4.5', away: '7.0' } },
        { date: '', home: 'G', away: 'H', bet: '0:1', odds: { home: '3.0', draw: '3.2', away: '2.1' } },
      ],
      leaderboard: {
        title: 'MD2',
        rankings: [ranking(ME, '1', '5', '9'), ranking('Papa', '2', '2', '8')],
      },
    },
  ],
};

describe('computeSeasonStats', () => {
  const stats = computeSeasonStats(SEASON, ME, RULES);

  it('reads points and league average per matchday', () => {
    expect(stats.form).toHaveLength(2);
    expect(stats.form[0]).toMatchObject({ matchday: 1, points: 4, rank: 2, leagueAverage: 5 });
    expect(stats.form[1]).toMatchObject({ matchday: 2, points: 5, rank: 1, leagueAverage: 3.5 });
  });

  it('counts each hit kind and totals the points', () => {
    // exact(4) + miss(0) + tendency(2) + goalDiff(3)
    expect(stats.breakdown).toMatchObject({
      exact: 1,
      goalDiff: 1,
      tendency: 1,
      miss: 1,
      scored: 4,
      points: 9,
    });
  });

  it('tracks the biggest climb', () => {
    expect(stats.biggestClimb).toMatchObject({ matchday: 2, from: 2, to: 1, delta: 1 });
    expect(stats.biggestDrop).toBeNull();
  });

  it('profiles predictions against reality', () => {
    // Predicted: home (2:1), draw (1:1), home (3:0), away (0:1)
    expect(stats.betProfile.predicted).toEqual({ home: 0.5, draw: 0.25, away: 0.25 });
    // Actual: home, away, home, away
    expect(stats.betProfile.actual).toEqual({ home: 0.5, draw: 0, away: 0.5 });
    // (3 + 2 + 3 + 1) / 4 predicted vs (3 + 2 + 2 + 3) / 4 actual
    expect(stats.betProfile.averagePredictedGoals).toBe(2.25);
    expect(stats.betProfile.averageActualGoals).toBe(2.5);
  });

  it('summarises consistency', () => {
    expect(stats.consistency.mean).toBe(4.5);
    expect(stats.consistency.best?.matchday).toBe(2);
    expect(stats.consistency.worst?.matchday).toBe(1);
    // Below average on MD1 (4 < 5), above on MD2 (5 > 3.5).
    expect(stats.consistency.belowAverageShare).toBe(0.5);
    expect(stats.consistency.standardDeviation).toBeCloseTo(0.5, 10);
  });

  it('reports what the numbers rest on', () => {
    expect(stats.completeness).toMatchObject({
      cachedMatchdays: 2,
      playedMatchdays: 2,
      knownMatchdays: 2,
      withLeaderboard: 2,
      withBets: 2,
    });
  });

  it('averages the last five matchdays', () => {
    expect(stats.rolling5).toEqual([4, 4.5]);
  });
});

describe('partial data', () => {
  it('still reports form when no bets are cached', () => {
    const season: CachedSeason = {
      community: 'c',
      matchdays: [{ matchday: 1, leaderboard: SEASON.matchdays[0].leaderboard }],
    };
    const stats = computeSeasonStats(season, ME, RULES);
    expect(stats.form[0].points).toBe(4);
    expect(stats.breakdown.scored).toBe(0);
    expect(stats.completeness.withBets).toBe(0);
  });

  it('still reports the breakdown when no leaderboard is cached', () => {
    const season: CachedSeason = {
      community: 'c',
      matchdays: [{ matchday: 1, schedule: SEASON.matchdays[0].schedule, bets: SEASON.matchdays[0].bets }],
    };
    const stats = computeSeasonStats(season, ME, RULES);
    expect(stats.form).toEqual([]);
    expect(stats.breakdown.exact).toBe(1);
    expect(stats.consistency.mean).toBeNull();
  });

  it('handles a player who is not on the leaderboard', () => {
    const stats = computeSeasonStats(SEASON, 'Nobody', RULES);
    expect(stats.form.every((f) => f.points === null)).toBe(true);
    expect(stats.consistency.mean).toBeNull();
    expect(stats.biggestClimb).toBeNull();
  });

  it('handles an entirely empty cache', () => {
    const stats = computeSeasonStats({ community: 'c', matchdays: [] }, ME, RULES);
    expect(stats.form).toEqual([]);
    expect(stats.breakdown.scored).toBe(0);
    expect(stats.betProfile.favouriteScoreline).toBeNull();
    expect(stats.completeness.cachedMatchdays).toBe(0);
  });

  it('ignores matches that have no result yet', () => {
    const season: CachedSeason = {
      community: 'c',
      matchdays: [
        {
          matchday: 1,
          schedule: [{ date: '', home: 'A', away: 'B', result: '-:-' }],
          bets: [{ date: '', home: 'A', away: 'B', bet: '2:1', odds: { home: '', draw: '', away: '' } }],
        },
      ],
    };
    const stats = computeSeasonStats(season, ME, RULES);
    expect(stats.breakdown.scored).toBe(0);
    expect(stats.completeness.playedMatchdays).toBe(0);
  });

  it('honours different scoring rules', () => {
    const stats = computeSeasonStats(SEASON, ME, { exact: 10, goalDiff: 5, tendency: 1 });
    expect(stats.breakdown.points).toBe(16);
  });
});

describe('whose bets get counted', () => {
  const grid = {
    matches: [
      { date: '', home: 'A', away: 'B', result: '2:1' },
      { date: '', home: 'C', away: 'D', result: '0:2' },
    ],
    players: [
      { player: 'Papa', bets: ['2:1', '0:0'] },
      { player: ME, bets: ['1:0', '0:2'] },
    ],
  };
  const season = {
    community: 'c',
    matchdays: [{ ...SEASON.matchdays[0], matchdayBets: grid }],
  };

  it('uses the per-player grid for another player', () => {
    const stats = computeSeasonStats(season, 'Papa', RULES, ME);
    // Papa: 2:1 on 2:1 is exact, 0:0 on 0:2 is a miss.
    expect(stats.breakdown).toMatchObject({ exact: 1, miss: 1, scored: 2 });
    expect(stats.completeness.withBets).toBe(1);
  });

  it('prefers the grid over the own-bets page for the account owner too', () => {
    const stats = computeSeasonStats(season, ME, RULES, ME);
    // From the grid: 1:0 on 2:1 is the right difference, 0:2 on 0:2 is exact.
    expect(stats.breakdown).toMatchObject({ exact: 1, goalDiff: 1, tendency: 0, miss: 0, scored: 2 });
  });

  it("never attributes the owner's bets to somebody else", () => {
    // No grid cached: Papa has no bets of his own on record.
    const stats = computeSeasonStats(SEASON, 'Papa', RULES, ME);
    expect(stats.breakdown.scored).toBe(0);
    expect(stats.completeness.withBets).toBe(0);
    // ...while his form still comes through from the leaderboard.
    expect(stats.form[0].points).toBe(6);
  });

  it('falls back to the own-bets page for the owner when no grid is cached', () => {
    const stats = computeSeasonStats(SEASON, ME, RULES, ME);
    expect(stats.breakdown.scored).toBe(4);
  });
});
