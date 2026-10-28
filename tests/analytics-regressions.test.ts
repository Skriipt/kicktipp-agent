import { describe, expect, it } from 'vitest';
import { fetchMatchdayBets, type MatchdayBets } from '../src/core.js';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { computeSeasonStats } from '../src/analytics/season-stats.js';

const RULES = { exact: 4, goalDiff: 3, tendency: 2 };
const MATCH = { date: '', home: 'A', away: 'B', result: '-:-' };
function grid(mine: string, theirs: string, result = '-:-'): MatchdayBets {
  return { matchday: 1, matches: [{ ...MATCH, result }], players: [
    { player: 'Me', bets: [mine] }, { player: 'Other', bets: [theirs] },
  ] };
}

describe('Kicktipp parser and season statistics regressions', () => {
  it('preserves the difference between hidden and missing tips in the parser', async () => {
    const html = `<div id="kicktipp-content"><table id="spielplanSpiele"><tbody>
      <tr><td></td><td>A</td><td>B</td><td></td></tr></tbody></table><table id="ranking"><tbody>
      <tr><td><div class="mg_name">Me</div></td><td class="ereignis">2:0</td></tr>
      <tr><td><div class="mg_name">Other</div></td><td class="ereignis">-:-</td></tr>
      <tr><td><div class="mg_name">Missing</div></td><td class="ereignis"></td></tr>
      </tbody></table></div>`;
    const page = new Page(new CookieJar(), async () => new Response(html));
    const data = await fetchMatchdayBets(page, 'fixture', 1);
    expect(data.players[1].bets).toEqual(['-:-']);
    expect(data.players[2].bets).toEqual(['']);
  });

  it('applies match multipliers to season points', () => {
    const rules = { ...RULES, multipliers: { 1: 2 } };
    const stats = computeSeasonStats({ community: 'fixture', matchdays: [{
      matchday: 1, matchdayBets: grid('2:0', '0:1', '2:0'),
    }] }, 'Me', rules);
    expect(stats.breakdown.points).toBe(8);
  });

  it('computes weighted season points through the own-bets fallback too', () => {
    const stats = computeSeasonStats({ community: 'fixture', matchdays: [{
      matchday: 1, schedule: [{ ...MATCH, result: '2:0' }],
      bets: [{ ...MATCH, bet: '2:0', odds: { home: '', draw: '', away: '' } }],
    }] }, 'Me', { ...RULES, multipliers: { 1: 3 } }, 'Me');
    expect(stats.breakdown.points).toBe(12);
  });
});
