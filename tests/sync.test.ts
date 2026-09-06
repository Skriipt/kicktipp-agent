import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { CacheStore } from '../src/cache/store.js';
import { planSeasonSync, syncSeason } from '../src/cache/sync.js';
import { fetchCurrentMatchday, fetchBets } from '../src/core.js';
import { mockFetch, page as htmlPage } from './helpers/mock-fetch.js';
import type { ScheduleMatch } from '../src/core.js';

const now = new Date('2026-09-01T12:00:00.000Z');

const finished: ScheduleMatch[] = [
  { date: '21.08.26 20:30', home: 'FC Bayern', away: 'BVB', result: '2:1' },
];
const upcoming: ScheduleMatch[] = [
  { date: '12.09.26 15:30', home: 'Freiburg', away: 'Köln', result: '-:-' },
];
const open: ScheduleMatch[] = [
  { date: '31.08.26 15:30', home: 'Mainz', away: 'Wolfsburg', result: '-:-' },
];

function cached(entries: [number, ScheduleMatch[]][]): Map<number, ScheduleMatch[]> {
  return new Map(entries);
}

describe('planSeasonSync', () => {
  it('fetches missing matchdays up to the current one and skips the rest of the range only via the caller cap', () => {
    const plan = planSeasonSync({
      from: 1,
      to: 3,
      now,
      cached: cached([[1, finished]]),
    });
    expect(plan).toEqual([
      { matchday: 1, action: 'skip', reason: 'finished' },
      { matchday: 2, action: 'fetch', reason: 'missing' },
      { matchday: 3, action: 'fetch', reason: 'missing' },
    ]);
  });

  it('refreshes an open matchday and leaves a cached future one alone', () => {
    const plan = planSeasonSync({
      from: 5,
      to: 6,
      now,
      cached: cached([
        [5, open],
        [6, upcoming],
      ]),
    });
    expect(plan).toEqual([
      { matchday: 5, action: 'fetch', reason: 'open' },
      { matchday: 6, action: 'skip', reason: 'future' },
    ]);
  });

  it('re-downloads everything in range when refresh is set', () => {
    const plan = planSeasonSync({
      from: 1,
      to: 2,
      refresh: true,
      now,
      cached: cached([
        [1, finished],
        [2, upcoming],
      ]),
    });
    expect(plan.map((step) => step.action)).toEqual(['fetch', 'fetch']);
    expect(plan.every((step) => step.action === 'fetch' && step.reason === 'refresh')).toBe(true);
  });
});

describe('fetchCurrentMatchday', () => {
  it('reads the hidden spieltagIndex from the predict page', async () => {
    const { fetchImpl } = mockFetch(() =>
      htmlPage('<div id="kicktipp-content"><input type="hidden" name="spieltagIndex" value="7"></div>'),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    expect(await fetchCurrentMatchday(page, 'cape')).toBe(7);
  });

  it('returns null when the page has no index', async () => {
    const { fetchImpl } = mockFetch(() => htmlPage('<div id="kicktipp-content"></div>'));
    const page = new Page(new CookieJar(), fetchImpl);
    expect(await fetchCurrentMatchday(page, 'cape')).toBeNull();
  });

  it('reads a Spieltag title when the hidden field is missing', async () => {
    const { fetchImpl } = mockFetch(() =>
      htmlPage('<div id="kicktipp-content"><div class="pagetitle">Spieltag 4</div></div>'),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    expect(await fetchCurrentMatchday(page, 'cape')).toBe(4);
  });
});

const SCHEDULE_HTML = `<div id="kicktipp-content">
  <div class="pagetitle">Spieltag</div>
  <table id="spiele"><tbody>
    <tr>
      <td>31.08.26 15:30</td>
      <td></td>
      <td>Mainz</td>
      <td>Wolfsburg</td>
      <td><span class="kicktipp-ergebnis"><span class="kicktipp-heim">-</span><span class="kicktipp-gast">-</span></span></td>
    </tr>
  </tbody></table>
</div>`;

const BETS_HTML = `<div id="kicktipp-content">
  <div class="pagetitle">Prediction</div>
  <table id="tippabgabeSpiele"><tbody>
    <tr>
      <td>31.08.26 15:30</td>
      <td>Mainz</td>
      <td>Wolfsburg</td>
      <td>
        <input id="spieltipp_1_heimTipp" value="">
        <input id="spieltipp_1_gastTipp" value="">
      </td>
    </tr>
  </tbody></table>
</div>`;

describe('syncSeason', () => {
  let tmp: string;
  let store: CacheStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-sync-'));
    store = new CacheStore('cape', path.join(tmp, 'cape'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stops at the current matchday and does not request later ones', async () => {
    store.write('schedule', { title: 'MD1', matches: finished }, 1);

    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url.includes('/rules')) return htmlPage('<div id="kicktipp-content"><div class="pagecontent"></div></div>');
      if (req.url.includes('/schedule')) return htmlPage(SCHEDULE_HTML);
      if (req.url.includes('/predict')) return htmlPage(BETS_HTML);
      if (req.url.includes('/leaderboard')) return htmlPage('<div id="kicktipp-content"></div>');
      return htmlPage('<div id="kicktipp-content"></div>');
    });
    const page = new Page(new CookieJar(), fetchImpl);

    const result = await syncSeason(page, 'cape', {
      store,
      currentMatchday: 2,
      delayMs: 0,
      now,
    });

    expect(result.fetched).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.knownMatchdays).toBe(2);

    const requested = calls
      .map((c) => {
        const n = new URL(c.url).searchParams.get('spieltagIndex');
        return n ? Number(n) : null;
      })
      .filter((n): n is number => n !== null);
    expect(requested.every((n) => n <= 2)).toBe(true);
    expect(requested).not.toContain(3);
  });

  it('repairs a finished matchday after sync failed between schedule and bets', async () => {
    const completed = SCHEDULE_HTML.replace('kicktipp-heim">-', 'kicktipp-heim">2')
      .replace('kicktipp-gast">-', 'kicktipp-gast">1');
    let fail = true;
    const { fetchImpl, calls } = mockFetch(req => {
      if (req.url.includes('/schedule')) return htmlPage(completed);
      if (req.url.includes('/predict')) {
        if (fail) throw new Error('connection reset');
        return htmlPage(BETS_HTML);
      }
      return htmlPage('<div id="kicktipp-content"></div>');
    });
    const page = new Page(new CookieJar(), fetchImpl);
    await expect(syncSeason(page, 'cape', { store, currentMatchday: 1, delayMs: 0, now })).rejects.toThrow('connection reset');
    expect(store.has('schedule', 1)).toBe(true);
    expect(store.has('bets', 1)).toBe(false);
    fail = false;
    const repaired = await syncSeason(page, 'cape', { store, currentMatchday: 1, delayMs: 0, now });
    expect(repaired.fetched).toBe(1);
    expect(store.has('bets', 1)).toBe(true);
    expect(store.has('leaderboard', 1)).toBe(true);
    expect(store.has('matchdayBets', 1)).toBe(true);
    calls.length = 0;
    const repeated = await syncSeason(page, 'cape', { store, currentMatchday: 1, delayMs: 0, now });
    expect(repeated.skipped).toBe(1);
    expect(calls.some(req => req.url.includes('/predict'))).toBe(false);
  });

  it('selects a fresh season before planning and preserves the old snapshots', async () => {
    let year = '26';
    const { fetchImpl } = mockFetch(req => {
      if (req.url.includes('/schedule')) return htmlPage(SCHEDULE_HTML.replaceAll('.26', '.' + year)
        .replace('kicktipp-heim">-', 'kicktipp-heim">2').replace('kicktipp-gast">-', 'kicktipp-gast">1'));
      if (req.url.includes('/predict')) return htmlPage(BETS_HTML.replaceAll('.26', '.' + year));
      return htmlPage('<div id="kicktipp-content"></div>');
    });
    const page = new Page(new CookieJar(), fetchImpl);
    await syncSeason(page, 'cape', { store, currentMatchday: 1, delayMs: 0, now });
    const oldDir = store.dir;
    store.writeMeta({ knownMatchdays: 34 });
    year = '27';
    const liveStore = new CacheStore('cape', path.join(tmp, 'cape'));
    await fetchBets(page, 'cape', 1, { store: liveStore });
    expect(liveStore.dir).not.toBe(oldDir);
    expect(liveStore.read('schedule', 1)).toBeNull();
    expect(liveStore.read('bets', 1)?.data.matches[0].date).toContain('.27');
    const updated = await syncSeason(page, 'cape', { store, currentMatchday: 1, delayMs: 0, now });
    expect(updated.fetched).toBe(1);
    expect(updated.knownMatchdays).toBe(1);
    expect(store.dir).not.toBe(oldDir);
    expect(store.read('schedule', 1)?.data.matches[0].date).toContain('.27');
    expect(fs.existsSync(path.join(oldDir, 'matchday-01', 'schedule.json'))).toBe(true);
    expect(new CacheStore('cape', path.join(tmp, 'cape')).dir).toBe(store.dir);
  });
});
