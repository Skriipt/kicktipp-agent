import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { CacheStore } from '../src/cache/store.js';
import { planSeasonSync, syncSeason } from '../src/cache/sync.js';
import { fetchCurrentMatchday } from '../src/core.js';
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
    store.write('bets', { title: 'MD1', matches: [] }, 1);
    store.write('leaderboard', { title: 'MD1', rankings: [] }, 1);
    store.write('matchdayBets', { matches: [], players: [] }, 1);

    const { fetchImpl, calls } = mockFetch((req) => {
      if (req.url.includes('/rules')) return htmlPage('<div id="kicktipp-content"><div class="pagecontent"></div></div>');
      if (req.url.includes('/schedule') && new URL(req.url).searchParams.get('spieltagIndex') === '1') {
        return htmlPage(SCHEDULE_HTML.replace('31.08.26 15:30', '21.08.26 20:30')
          .replace('Mainz', 'FC Bayern').replace('Wolfsburg', 'BVB')
          .replace('kicktipp-heim">-<', 'kicktipp-heim">2<')
          .replace('kicktipp-gast">-<', 'kicktipp-gast">1<'));
      }
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

    expect(result.fetched).toBe(1);
    expect(result.skipped).toBe(1);
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
});

describe('sync recovery and season boundaries', () => {
  let tmp: string;
  let store: CacheStore;
  const scheduleHtml = (date: string, result = '2:1') => SCHEDULE_HTML
    .replace('31.08.26 15:30', date)
    .replace('kicktipp-heim">-<', `kicktipp-heim">${result.split(':')[0]}<`)
    .replace('kicktipp-gast">-<', `kicktipp-gast">${result.split(':')[1]}<`);
  const scheduleData = (date: string) => ({ title: 'Opening round', matches: [
    { date, home: 'Mainz', away: 'Wolfsburg', result: '2:1' },
  ] });
  const fill = (matchday: number, date: string) => {
    store.write('schedule', scheduleData(date), matchday);
    store.write('bets', { title: 'Bets', matches: [] }, matchday);
    store.write('leaderboard', { title: 'Table', rankings: [] }, matchday);
    store.write('matchdayBets', { matches: [], players: [] }, matchday);
  };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-sync-boundary-'));
    store = new CacheStore('cape', path.join(tmp, 'cape'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('repairs an incomplete finished matchday after the first run fails', async () => {
    let fail = true;
    const { fetchImpl } = mockFetch(req => {
      if (req.url.includes('/schedule')) return htmlPage(scheduleHtml('31.08.26 15:30'));
      if (req.url.includes('/predict') && fail) throw new Error('temporary upstream failure');
      return htmlPage('<div id="kicktipp-content"></div>');
    });
    const page = new Page(new CookieJar(), fetchImpl);
    const opts = { store, currentMatchday: 1, delayMs: 0, now };
    await expect(syncSeason(page, 'cape', opts)).rejects.toThrow('temporary upstream failure');
    expect(store.has('schedule', 1)).toBe(true);
    expect(store.has('bets', 1)).toBe(false);
    fail = false;
    const retry = await syncSeason(page, 'cape', opts);
    expect(retry.fetched).toBe(1);
    expect(store.has('bets', 1)).toBe(true);
    expect(store.has('leaderboard', 1)).toBe(true);
    expect(store.has('matchdayBets', 1)).toBe(true);
  });

  it('archives old completed rounds and resets season length on a verified changed opening round', async () => {
    fill(1, '31.08.25 15:30');
    fill(34, '15.05.26 15:30');
    store.writeMeta({ knownMatchdays: 34, lastSync: '2026-05-16T00:00:00Z' });
    const oldFile = fs.readFileSync(path.join(store.dir, 'matchday-34', 'schedule.json'), 'utf8');
    const { fetchImpl } = mockFetch(req => req.url.includes('/schedule')
      ? htmlPage(scheduleHtml('31.08.26 15:30'))
      : htmlPage('<div id="kicktipp-content"></div>'));
    const result = await syncSeason(new Page(new CookieJar(), fetchImpl), 'cape', {
      store, currentMatchday: 1, delayMs: 0, now,
    });
    expect(result.fetched).toBe(1);
    expect(result.knownMatchdays).toBe(1);
    expect(store.cachedMatchdays()).toEqual([1]);
    expect(store.read('schedule', 1)?.data.matches[0].date).toBe('31.08.26 15:30');
    const archived = fs.readdirSync(tmp).find(name => name.startsWith('cape.archive-'));
    expect(archived).toBeDefined();
    expect(fs.readFileSync(path.join(tmp, archived!, 'matchday-34', 'schedule.json'), 'utf8')).toBe(oldFile);
  });

  it('keeps complete history when opening fixtures stay identical, ignoring results', async () => {
    fill(1, '31.08.26 15:30');
    fill(2, '01.09.26 15:30');
    const { fetchImpl, calls } = mockFetch(req => req.url.includes('/schedule')
      ? htmlPage(scheduleHtml('31.08.26 15:30', '3:1'))
      : htmlPage('<div id="kicktipp-content"></div>'));
    const result = await syncSeason(new Page(new CookieJar(), fetchImpl), 'cape', {
      store, currentMatchday: 2, delayMs: 0, now,
    });
    expect(result.fetched).toBe(0);
    expect(result.skipped).toBe(2);
    expect(store.cachedMatchdays()).toEqual([1, 2]);
    expect(fs.readdirSync(tmp)).toEqual(['cape']);
    expect(calls.filter(req => req.url.includes('/schedule'))).toHaveLength(1);
  });

  it('fails without modifying old history if the live opening round cannot be verified', async () => {
    fill(1, '31.08.25 15:30');
    const previous = store.read('schedule', 1);
    const { fetchImpl } = mockFetch(req => {
      if (req.url.includes('/schedule')) throw new Error('anchor unavailable');
      return htmlPage('<div id="kicktipp-content"></div>');
    });
    await expect(syncSeason(new Page(new CookieJar(), fetchImpl), 'cape', {
      store, currentMatchday: 1, delayMs: 0, now,
    })).rejects.toThrow('anchor unavailable');
    expect(store.read('schedule', 1)).toEqual(previous);
  });
});
