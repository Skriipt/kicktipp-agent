import { describe, expect, it } from 'vitest';
import { parseCommunitiesHtml } from '../src/browser.js';

describe('parseCommunitiesHtml', () => {
  it('discovers membership cards whose display name differs from their permanent URL', () => {
    expect(parseCommunitiesHtml(`<div id="kicktipp-content">
      <a href="/office-2020/"><div class="menu-title-mit-tippglocke">Unsere Bundesliga-Runde</div></a>
      <a href="/office-2020/"><div class="menu-title-mit-tippglocke">Unsere Bundesliga-Runde</div></a>
      <a href="/info/"><div class="menu-title-mit-tippglocke">Information</div></a>
      <a href="/advertisement/">Something else</a>
    </div>`)).toEqual(['office-2020']);
  });
  it('matches a displayed name to its generic community slug', () => {
    const html = `
      <div id="kicktipp-content">
        <a href="/toms-zockerrunde-2627/">Toms Zockerrunde 26/27</a>
        <a href="/toms-zockerrunde-2627/">
          <div class="menu-title-mit-tippglocke">Toms Zockerrunde 26/27</div>
        </a>
        <a href="/info/profil/meinetipprunden">Meine Tipprunden</a>
      </div>
    `;

    expect(parseCommunitiesHtml(html)).toEqual([
      'toms-zockerrunde-2627',
    ]);
  });

  it('ignores links that are not single-segment community URLs', () => {
    const html = `
      <div id="kicktipp-content">
        <a href="/community/tippabgabe">communitytippabgabe</a>
        <a href="javascript:void(0)">void(0)</a>
      </div>
    `;

    expect(parseCommunitiesHtml(html)).toEqual([]);
  });
});
