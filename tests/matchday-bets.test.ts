import { describe, it, expect } from 'vitest';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { fetchMatchdayBets } from '../src/core.js';
import { gapBeforeMatchday } from '../src/analytics/gap.js';
import { mockFetch, page as htmlPage } from './helpers/mock-fetch.js';

const BASE = 'https://www.kicktipp.com';

const MATCHES = `
  <table id="spielplanSpiele"><tbody>
    <tr><td>21.08.26 20:30</td><td>Bayern</td><td>BVB</td>
        <td><span class="kicktipp-ergebnis"><span class="kicktipp-heim">2</span><span class="kicktipp-gast">1</span></span></td></tr>
    <tr><td>22.08.26 15:30</td><td>Freiburg</td><td>VfB</td><td></td></tr>
  </tbody></table>`;

function ranking(rows: string): string {
  return `<table id="ranking"><tbody>${rows}</tbody></table>`;
}

function serve(body: string) {
  const { fetchImpl } = mockFetch(() => htmlPage(`<div id="kicktipp-content">${body}</div>`));
  return new Page(new CookieJar(), fetchImpl);
}

describe('fetchMatchdayBets', () => {
  it('reads each player row and lines the bets up with the matches', async () => {
    const page = serve(MATCHES + ranking(`
      <tr><td class="position">1</td><td><div class="mg_name">Papa</div></td>
          <td>2:1</td><td>1:0</td>
          <td class="spieltagspunkte">7</td><td class="bonus">0</td><td class="gesamtpunkte">30</td></tr>
      <tr><td class="position">2</td><td><div class="mg_name">Me</div></td>
          <td>1:1</td><td>0:2</td>
          <td class="spieltagspunkte">0</td><td class="bonus">0</td><td class="gesamtpunkte">25</td></tr>
    `));

    const grid = await fetchMatchdayBets(page, 'mycomm', 3);
    expect(grid.matches.map((m) => m.home)).toEqual(['Bayern', 'Freiburg']);
    expect(grid.matches[0].result).toBe('2:1');
    expect(grid.matches[1].result).toBe('-:-');
    expect(grid.players).toEqual([
      { player: 'Papa', bets: ['2:1', '1:0'] },
      { player: 'Me', bets: ['1:1', '0:2'] },
    ]);
    expect(grid.note).toBeUndefined();
  });

  it('reads kicktipp.com ranking cells: hyphen scores, point subscripts, rank-change column', async () => {
    const page = serve(MATCHES + ranking(`
      <tr>
        <td class="position right nw">1.</td>
        <td class="positionsdifferenz nw"></td>
        <td class="mg_class"><div class="mg_name">Papa</div></td>
        <td class="nw t ereignis ereignis0">2-1<sub class="p">4</sub></td>
        <td class="nw f ereignis ereignis1">1-0</td>
        <td class="spieltagspunkte">7</td>
        <td class="bonus">0</td>
        <td class="siege">1.00</td>
        <td class="gesamtpunkte">30</td>
      </tr>
    `));

    const grid = await fetchMatchdayBets(page, 'mycomm', 1);
    expect(grid.note).toBeUndefined();
    expect(grid.players).toEqual([{ player: 'Papa', bets: ['2:1', '1:0'] }]);
  });

  it('records the spieltag from the page when no matchday was asked for', async () => {
    const page = serve(
      `<div class="pagetitle">Spieltag 2</div>${MATCHES}${ranking(`
      <tr><td class="position">1</td><td><div class="mg_name">Papa</div></td>
          <td>2:1</td><td>1:0</td>
          <td class="spieltagspunkte">7</td><td class="gesamtpunkte">30</td></tr>
    `)}`,
    );

    const grid = await fetchMatchdayBets(page, 'mycomm');
    expect(grid.matchday).toBe(2);
  });

  it('treats placeholder cells as no bet', async () => {
    const page = serve(MATCHES + ranking(`
      <tr><td class="position">1</td><td><div class="mg_name">Papa</div></td>
          <td>2:1</td><td>–</td>
          <td class="spieltagspunkte">4</td><td class="gesamtpunkte">30</td></tr>
    `));

    const grid = await fetchMatchdayBets(page, 'mycomm', 3);
    expect(grid.players[0].bets).toEqual(['2:1', '']);
  });

  it('reports hidden bets rather than inventing them', async () => {
    const page = serve(MATCHES + ranking(`
      <tr><td class="position">1</td><td><div class="mg_name">Papa</div></td>
          <td></td><td></td>
          <td class="spieltagspunkte">0</td><td class="gesamtpunkte">30</td></tr>
    `));

    const grid = await fetchMatchdayBets(page, 'mycomm', 3);
    expect(grid.players).toEqual([]);
    expect(grid.note).toMatch(/hiding everyone/i);
    // The match list is still useful even without bets.
    expect(grid.matches).toHaveLength(2);
  });

  it('treats a ranking with no tip columns as unpublished, not misaligned', async () => {
    const page = serve(MATCHES + ranking(`
      <tr><td class="position">1</td><td><div class="mg_name">Papa</div></td>
          <td class="spieltagspunkte">0</td><td class="gesamtpunkte">30</td></tr>
    `));

    const grid = await fetchMatchdayBets(page, 'mycomm', 3);
    expect(grid.players).toEqual([]);
    expect(grid.note).toMatch(/not published|deadline/i);
    expect(grid.note).not.toMatch(/did not line up/i);
  });

  it('refuses to guess when the columns do not line up', async () => {
    // Three bet columns against two matches: any alignment would be a guess.
    const page = serve(MATCHES + ranking(`
      <tr><td class="position">1</td><td><div class="mg_name">Papa</div></td>
          <td>2:1</td><td>1:0</td><td>3:3</td>
          <td class="spieltagspunkte">7</td><td class="gesamtpunkte">30</td></tr>
    `));

    const grid = await fetchMatchdayBets(page, 'mycomm', 3);
    expect(grid.players).toEqual([]);
    expect(grid.note).toMatch(/did not line up/i);
  });

  it('says so when there is no match table at all', async () => {
    const page = serve(ranking('<tr><td><div class="mg_name">Papa</div></td></tr>'));
    const grid = await fetchMatchdayBets(page, 'mycomm', 3);
    expect(grid.matches).toEqual([]);
    expect(grid.note).toMatch(/No match list/i);
  });
});

describe('gapBeforeMatchday', () => {
  const leaderboard = {
    title: 'MD3',
    rankings: [
      { position: '1', name: 'Papa', matchdayPoints: '7', bonus: '0', total: '30', isCurrentPlayer: false },
      { position: '2', name: 'Me', matchdayPoints: '0', bonus: '0', total: '25', isCurrentPlayer: true },
    ],
  };

  it('subtracts the matchday back out of the season total', () => {
    // Before this matchday: me 25, Papa 23 → two ahead.
    expect(gapBeforeMatchday(leaderboard, 'Me', 'Papa')).toBe(2);
  });

  it('returns null when a player is missing or nothing is cached', () => {
    expect(gapBeforeMatchday(leaderboard, 'Me', 'Nobody')).toBeNull();
    expect(gapBeforeMatchday(undefined, 'Me', 'Papa')).toBeNull();
  });
});
