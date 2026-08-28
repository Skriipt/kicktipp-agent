import { describe, it, expect } from 'vitest';
import { replaySeason } from '../src/analytics/replay.js';
import type { CachedSeason } from '../src/analytics/season.js';

const RULES = { exact: 4, goalDiff: 3, tendency: 2 };
const ME = 'Me';

/**
 * One matchday, hand-checked. Results 2:1 and 0:2.
 * My real bets: 2:1 (exact, 4) and 1:1 (miss, 0) — six... no, four.
 */
const SEASON: CachedSeason = {
  community: 'c',
  matchdays: [
    {
      matchday: 1,
      schedule: [
        { date: '', home: 'A', away: 'B', result: '2:1' },
        { date: '', home: 'C', away: 'D', result: '0:2' },
      ],
      bets: [
        { date: '', home: 'A', away: 'B', bet: '2:1', odds: { home: '1.5', draw: '4.0', away: '6.0' } },
        { date: '', home: 'C', away: 'D', bet: '1:1', odds: { home: '5.0', draw: '4.0', away: '1.6' } },
      ],
      leaderboard: {
        title: 'MD1',
        rankings: [
          { position: '1', name: 'Papa', matchdayPoints: '7', bonus: '0', total: '7', isCurrentPlayer: false },
          { position: '2', name: ME, matchdayPoints: '4', bonus: '0', total: '4', isCurrentPlayer: true },
        ],
      },
    },
  ],
};

describe('replaySeason', () => {
  it('reproduces the real points under the actual strategy', () => {
    const result = replaySeason(SEASON, ME, RULES, 'actual', ME);
    // 2:1 on 2:1 is exact (4); 1:1 on 0:2 misses (0).
    expect(result.total).toBe(4);
    expect(result.actualTotal).toBe(4);
    expect(result.delta).toBe(0);
    expect(result.matchesScored).toBe(2);
  });

  it('replays a fixed scoreline', () => {
    const result = replaySeason(SEASON, ME, RULES, '2:1', ME);
    // 2:1 on 2:1 exact (4); 2:1 on 0:2 misses (0).
    expect(result.total).toBe(4);
  });

  it('replays always-home and always-away', () => {
    // An even-strength home pick is 2:1, which lands exactly on 2:1 (4) and
    // misses 0:2 entirely.
    expect(replaySeason(SEASON, ME, RULES, 'home', ME).total).toBe(4);
    // An even-strength away pick is 1:2: a miss on 2:1, and on 0:2 the right
    // tendency but the wrong difference (2).
    expect(replaySeason(SEASON, ME, RULES, 'away', ME).total).toBe(2);
  });

  it('replays the odds favourite', () => {
    // Match 1 favours home, match 2 favours away, so both tendencies land.
    const result = replaySeason(SEASON, ME, RULES, 'favorite', ME);
    expect(result.total).toBeGreaterThan(0);
  });

  it('replays a suggest strategy', () => {
    const result = replaySeason(SEASON, ME, RULES, 'suggest:ev', ME);
    expect(result.matchesScored).toBe(2);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it('reports the delta against what actually happened', () => {
    const better = replaySeason(SEASON, ME, RULES, 'home', ME);
    expect(better.actualTotal).toBe(4);
    expect(better.delta).toBe(better.total - 4);
  });

  it('estimates a rank and says it is an estimate', () => {
    const result = replaySeason(SEASON, ME, RULES, 'actual', ME);
    // Papa recorded 7, the replay scores 4, so second.
    expect(result.finalRank).toBe(2);
    expect(result.rankNote).toMatch(/estimate/i);
  });

  it('skips matches with no result', () => {
    const partial: CachedSeason = {
      community: 'c',
      matchdays: [
        {
          matchday: 1,
          schedule: [{ date: '', home: 'A', away: 'B', result: '-:-' }],
          bets: [{ date: '', home: 'A', away: 'B', bet: '2:1', odds: { home: '', draw: '', away: '' } }],
        },
      ],
    };
    const result = replaySeason(partial, ME, RULES, '2:1', ME);
    expect(result.matchesScored).toBe(0);
    expect(result.matchdays).toEqual([]);
  });

  it('prefers the per-player grid when replaying somebody else', () => {
    const withGrid: CachedSeason = {
      community: 'c',
      matchdays: [
        {
          ...SEASON.matchdays[0],
          matchdayBets: {
            matchday: 1,
            matches: SEASON.matchdays[0].schedule!,
            players: [{ player: 'Papa', bets: ['2:1', '0:2'] }],
          },
        },
      ],
    };
    // Papa hit both exactly: 8 points.
    expect(replaySeason(withGrid, 'Papa', RULES, 'actual', ME).total).toBe(8);
  });

  it('scores nothing for a player whose bets are unknown', () => {
    const result = replaySeason(SEASON, 'Papa', RULES, 'actual', ME);
    expect(result.total).toBe(0);
    expect(result.matchesScored).toBe(0);
  });

  it('applies a matchday multiplier', () => {
    const doubled = replaySeason(SEASON, ME, { ...RULES, multipliers: { 1: 2 } }, 'actual', ME);
    expect(doubled.total).toBe(8);
  });

  it('rejects a strategy it does not understand', () => {
    expect(() => replaySeason(SEASON, ME, RULES, 'vibes', ME)).toThrow(/Unknown strategy/);
  });

  it('handles an empty cache', () => {
    const result = replaySeason({ community: 'c', matchdays: [] }, ME, RULES, '2:1', ME);
    expect(result.total).toBe(0);
    expect(result.finalRank).toBeNull();
  });
});
