import { describe, it, expect } from 'vitest';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { fetchBets } from '../src/core.js';
import { mockFetch, page as htmlPage } from './helpers/mock-fetch.js';

/** Shape of kicktipp.com predict HTML before the in-page timezone rewrite. */
const PREDICT = `<div id="kicktipp-content">
  <div class="pagetitle">Prediction ChristianH</div>
  <table id="tippabgabeSpiele"><tbody>
    <tr>
      <td class="nw kicktipp-time">8/28/26 1:30 PM</td>
      <td>FC Bayern Munich</td>
      <td>VfB Stuttgart</td>
      <td>
        <input id="spieltipp_1_heimTipp" name="spieltipp[1].heimTipp" value="">
        <input id="spieltipp_1_gastTipp" name="spieltipp[1].gastTipp" value="">
      </td>
      <td></td>
    </tr>
    <tr>
      <td class="nw kicktipp-time"></td>
      <td>SV Elversberg</td>
      <td>Bayer 04 Leverkusen</td>
      <td>
        <input id="spieltipp_2_heimTipp" name="spieltipp[2].heimTipp" value="">
        <input id="spieltipp_2_gastTipp" name="spieltipp[2].gastTipp" value="">
      </td>
      <td></td>
    </tr>
  </tbody></table>
</div>`;

const BONUS_TAB = `<div id="kicktipp-content">
  <div class="pagetitle">Prediction ChristianH</div>
  <form>
    <input type="hidden" name="spieltagIndex" value="1">
    <input type="hidden" name="bonus" value="true">
    <table id="tippabgabeFragen"><tbody>
      <tr><td>1</td><td>Top scorer?</td><td><select name="q"><option value="-1">-</option></select></td></tr>
    </tbody></table>
  </form>
</div>`;

describe('fetchBets date cells', () => {
  it('inherits a blank kicktipp-time cell from the row above', async () => {
    const { fetchImpl } = mockFetch(() => htmlPage(PREDICT));
    const page = new Page(new CookieJar(), fetchImpl);
    const { matches } = await fetchBets(page, 'cape');
    expect(matches.map((m) => ({ date: m.date, home: m.home }))).toEqual([
      { date: '8/28/26 1:30 PM', home: 'FC Bayern Munich' },
      { date: '8/28/26 1:30 PM', home: 'SV Elversberg' },
    ]);
  });
});

describe('fetchBets when Kicktipp opens the bonus tab', () => {
  it('reloads the match list for the hidden spieltagIndex', async () => {
    const { fetchImpl, calls } = mockFetch((req) => {
      const url = new URL(req.url);
      if (url.searchParams.get('spieltagIndex') === '1' && url.searchParams.get('bonus') !== 'true') {
        return htmlPage(PREDICT);
      }
      return htmlPage(BONUS_TAB);
    });
    const page = new Page(new CookieJar(), fetchImpl);
    const { matches } = await fetchBets(page, 'cape');
    expect(matches.map((m) => m.home)).toEqual(['FC Bayern Munich', 'SV Elversberg']);
    expect(calls.some((c) => c.url.includes('spieltagIndex=1') && !c.url.includes('bonus='))).toBe(true);
  });
});
