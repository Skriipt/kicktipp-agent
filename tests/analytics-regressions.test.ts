import { describe, expect, it, vi } from 'vitest';
import { resultRepresentatives } from '../src/rules/outcomes.js';
import { scoreBet } from '../src/rules/scoring.js';
import { fetchMatchdayBets, type LeaderboardData, type MatchdayBets } from '../src/core.js';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { findTargetCombinations, projectStandings } from '../src/analytics/scenarios.js';
import { analyseRival } from '../src/analytics/rivals.js';
import { computeSeasonStats } from '../src/analytics/season-stats.js';

const RULES = { exact: 4, goalDiff: 3, tendency: 2 };
const MATCH = { date: '', home: 'A', away: 'B', result: '-:-' };
function grid(mine: string, theirs: string, result = '-:-'): MatchdayBets {
  return { matchday: 1, matches: [{ ...MATCH, result }], players: [
    { player: 'Me', bets: [mine] }, { player: 'Rival', bets: [theirs] },
  ] };
}
function board(mine = 0, theirs = 0): LeaderboardData {
  return { title: '', rankings: [['Me', mine], ['Rival', theirs]].map(([name, total]) => ({
    position: '1', name: String(name), total: String(total), matchdayPoints: '0', bonus: '0', isCurrentPlayer: name === 'Me',
  })) };
}

describe('audit regressions: scoring uncertainty and outcome classes', () => {
  it('preserves hidden tip presence through the parser and keeps projections uncertain', async () => {
    const html = `<div id="kicktipp-content"><table id="spielplanSpiele"><tbody>
      <tr><td></td><td>A</td><td>B</td><td></td></tr></tbody></table><table id="ranking"><tbody>
      <tr><td><div class="mg_name">Me</div></td><td class="ereignis">2:0</td></tr>
      <tr><td><div class="mg_name">Rival</div></td><td class="ereignis">-:-</td></tr>
      <tr><td><div class="mg_name">Missing</div></td><td class="ereignis"></td></tr>
      </tbody></table></div>`;
    const page = new Page(new CookieJar(), async () => new Response(html));
    const data = await fetchMatchdayBets(page, 'fixture', 1);
    expect(data.players[1].bets).toEqual(['-:-']);
    expect(data.players[2].bets).toEqual(['']);
    const projection = projectStandings(data, board(), RULES, [{ ...MATCH, result: '2:0' }]);
    expect(projection.exact).toBe(false);
    expect(projection.players.find((p) => p.player === 'Rival')).toMatchObject({ totalWorst: 0, totalBest: 4, exact: false });
    expect(findTargetCombinations(data, board(), RULES, 'Rival', 1).achievable).toBeNull();
  });

  it.each(['2:0', '7:4', '0:12', '5:5'])('finds exact-score paths for %s outside fixed outcome samples', (bet) => {
    const data = grid(bet, bet === '0:12' ? '1:0' : '0:1');
    const search = findTargetCombinations(data, board(0, 3), RULES, 'Me', 1);
    expect(search.achievable).toBe(true);
    expect(search.examples.some((e) => e.results[0].result === bet)).toBe(true);
  });

  it('captures every swing including previously unsampled exact results', () => {
    const analysis = analyseRival(grid('3:0', '1:0'), 'Me', 'Rival', RULES, 0);
    expect(analysis.swingRange).toEqual({ best: 2, worst: -2 });
    expect(analysis.conditions.join(' ')).not.toContain('cannot change');
  });

  it('does not pretend hidden tips are known when both player rows exist', () => {
    const analysis = analyseRival(grid('2:0', '-:-'), 'Me', 'Rival', RULES, 0);
    expect(analysis.mode).toBe('bounds');
    expect(analysis.swingRange).toEqual({ best: 4, worst: -4 });
    const settled = analyseRival(grid('2:0', '-:-', '2:0'), 'Me', 'Rival', RULES, 0);
    expect(settled.gap).toBeNull();
    expect(settled.conditions.join(' ')).not.toContain('finished 4 ahead');
  });

  it('applies multipliers to settled gaps, open swings and season points', () => {
    const rules = { ...RULES, multipliers: { 1: 2 } };
    expect(analyseRival(grid('2:0', '0:1', '2:0'), 'Me', 'Rival', rules, -5).gap).toBe(3);
    expect(analyseRival(grid('2:0', '0:1'), 'Me', 'Rival', rules, -5).swingRange).toEqual({ best: 8, worst: -8 });
    const stats = computeSeasonStats({ community: 'fixture', matchdays: [{ matchday: 1, matchdayBets: grid('2:0', '0:1', '2:0') }] }, 'Me', rules);
    expect(stats.breakdown.points).toBe(8);
  });

  it('prunes a hopeless target for 100 players and eight matches promptly', () => {
    const data: MatchdayBets = {
      matchday: 1,
      matches: Array.from({ length: 8 }, (_, i) => ({ ...MATCH, home: `H${i}`, away: `A${i}` })),
      players: Array.from({ length: 100 }, (_, i) => ({ player: `P${i}`, bets: Array(8).fill('2:1') })),
    };
    const standings: LeaderboardData = { title: '', rankings: data.players.map(({ player }, i) => ({
      position: String(i + 1), name: player, total: String((100 - i) * 100), matchdayPoints: '0', bonus: '0', isCurrentPlayer: false,
    })) };
    const start = performance.now();
    const search = findTargetCombinations(data, standings, RULES, 'P99', 1);
    expect(search.achievable).toBe(false);
    expect(search.examined).toBe(0);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});


describe('complete result classes and bounded target search', () => {
  it('covers every scoring vector in an independent bounded result grid', () => {
    const bets = ['0:0', '4:4', '1:0', '3:0', '7:4', '0:2', '1:5', ''];
    const rules = { exact: 5, goalDiff: 3, tendency: 1, drawExact: 7, drawTendency: 2 };
    const vectors = new Set(resultRepresentatives(bets).map((result) => bets.map((bet) => scoreBet(bet, result, rules)).join(',')));
    for (let home = 0; home <= 9; home++) {
      for (let away = 0; away <= 9; away++) {
        expect(vectors.has(bets.map((bet) => scoreBet(bet, { home, away }, rules)).join(',')), `${home}:${away}`).toBe(true);
      }
    }
  });

  it('retains leaderboard rivals whose entire prediction row is unavailable', () => {
    const data = grid('2:0', '0:1');
    data.players.pop();
    const projected = projectStandings(data, board(0, 3), RULES, [{ ...MATCH, result: '2:0' }]);
    expect(projected.exact).toBe(false);
    expect(projected.players.find((p) => p.player === 'Me')).toMatchObject({ rankBest: 1, rankWorst: 2 });
    expect(projected.players.find((p) => p.player === 'Rival')).toMatchObject({ totalWorst: 3, totalBest: 7 });
    expect(findTargetCombinations(data, board(0, 3), RULES, 'Me', 1).achievable).toBeNull();
  });

  it('does not loop on scores beyond numeric precision', () => {
    expect(() => resultRepresentatives(['999999999999999999999:0'])).toThrow(/integer range/);
    expect(resultRepresentatives([`${Number.MAX_SAFE_INTEGER}:0`]).length).toBeGreaterThan(0);
  });

  it('retains user-pinned results when searching for a target', () => {
    const data = grid('2:0', '0:1');
    const search = findTargetCombinations(data, board(0, 3), RULES, 'Me', 1, 5, [{ ...MATCH, result: '0:1' }]);
    expect(search).toMatchObject({ achievable: false, complete: true });
    const win = findTargetCombinations(data, board(0, 3), RULES, 'Me', 1, 5, [{ ...MATCH, result: '2:0' }]);
    expect(win.examples[0].results).toEqual([{ home: 'A', away: 'B', result: '2:0' }]);
    expect(win.achievable).toBe(true);
  });

  it('reports an exhausted computation budget as unknown, never impossible', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(1000);
    try {
      const search = findTargetCombinations(grid('2:0', '0:1'), board(0, 3), RULES, 'Me', 1);
      expect(search).toMatchObject({ achievable: null, complete: false, examined: 0 });
      expect(search.note).toMatch(/budget/);
    } finally {
      clock.mockRestore();
    }
  });

  it('computes weighted season points through the own-bets fallback too', () => {
    const stats = computeSeasonStats({ community: 'fixture', matchdays: [{
      matchday: 1, schedule: [{ ...MATCH, result: '2:0' }],
      bets: [{ ...MATCH, bet: '2:0', odds: { home: '', draw: '', away: '' } }],
    }] }, 'Me', { ...RULES, multipliers: { 1: 3 } }, 'Me');
    expect(stats.breakdown.points).toBe(12);
  });
});
