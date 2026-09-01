import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CacheStore, isMatchdayFinished, isMatchdayUpcoming, SCHEMA_VERSION } from '../src/cache/store.js';
import { throughCache, OfflineCacheMiss } from '../src/cache/cached-fetch.js';

let tmp: string;
let store: CacheStore;

const SCHEDULE = {
  title: 'Matchday 3',
  matches: [
    { date: '21.08.26 20:30', home: 'FC Bayern', away: 'BVB', result: '2:1' },
    { date: '22.08.26 15:30', home: 'SC Freiburg', away: 'VfB', result: '0:0' },
  ],
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-cache-'));
  store = new CacheStore('mycomm', path.join(tmp, 'mycomm'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('CacheStore', () => {
  it('round-trips a per-matchday payload', () => {
    store.write('schedule', SCHEDULE, 3);
    const back = store.read('schedule', 3);
    expect(back?.data).toEqual(SCHEDULE);
    expect(back?.matchday).toBe(3);
    expect(back?.community).toBe('mycomm');
    expect(back?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('round-trips a season-wide payload', () => {
    store.write('rules', [{ type: 'heading', text: 'Punkte' }]);
    expect(store.read('rules')?.data).toEqual([{ type: 'heading', text: 'Punkte' }]);
  });

  it('keeps matchdays apart', () => {
    store.write('schedule', SCHEDULE, 3);
    store.write('schedule', { title: 'Matchday 4', matches: [] }, 4);
    expect(store.read('schedule', 3)?.data.title).toBe('Matchday 3');
    expect(store.read('schedule', 4)?.data.title).toBe('Matchday 4');
  });

  it('returns null for anything not cached', () => {
    expect(store.read('schedule', 9)).toBeNull();
    expect(store.has('rules')).toBe(false);
  });

  it('ignores a payload written by a different schema version', () => {
    store.write('schedule', SCHEDULE, 3);
    const file = path.join(store.dir, 'matchday-03', 'schedule.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, schemaVersion: SCHEMA_VERSION + 1 }));
    expect(store.read('schedule', 3)).toBeNull();
  });

  it('ignores a corrupt file instead of throwing', () => {
    store.write('schedule', SCHEDULE, 3);
    fs.writeFileSync(path.join(store.dir, 'matchday-03', 'schedule.json'), 'not json');
    expect(store.read('schedule', 3)).toBeNull();
  });

  it('writes files owner-only', () => {
    store.write('schedule', SCHEDULE, 3);
    const mode = fs.statSync(path.join(store.dir, 'matchday-03', 'schedule.json')).mode;
    expect(mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind', () => {
    store.write('schedule', SCHEDULE, 3);
    const files = fs.readdirSync(path.join(store.dir, 'matchday-03'));
    expect(files).toEqual(['schedule.json']);
  });

  it('requires a matchday for per-matchday kinds', () => {
    expect(() => store.write('schedule', SCHEDULE)).toThrow(/requires a matchday/);
  });

  it('lists cached matchdays in order', () => {
    store.write('schedule', SCHEDULE, 12);
    store.write('schedule', SCHEDULE, 2);
    store.write('schedule', SCHEDULE, 7);
    expect(store.cachedMatchdays()).toEqual([2, 7, 12]);
  });

  it('reports size and survives an empty cache', () => {
    expect(store.cachedMatchdays()).toEqual([]);
    expect(store.sizeBytes()).toBe(0);
    store.write('schedule', SCHEDULE, 1);
    expect(store.sizeBytes()).toBeGreaterThan(0);
  });

  it('round-trips meta and clears everything', () => {
    store.write('schedule', SCHEDULE, 1);
    store.writeMeta({ lastSync: '2026-08-01T00:00:00.000Z', knownMatchdays: 12 });
    expect(store.readMeta()?.knownMatchdays).toBe(12);
    store.clear();
    expect(store.cachedMatchdays()).toEqual([]);
    expect(store.readMeta()).toBeNull();
  });

  it('keeps two communities separate', () => {
    const other = new CacheStore('other', path.join(tmp, 'other'));
    store.write('schedule', SCHEDULE, 1);
    expect(other.read('schedule', 1)).toBeNull();
  });
});

describe('isMatchdayFinished', () => {
  it('is true only when every match has a result', () => {
    expect(isMatchdayFinished(SCHEDULE.matches)).toBe(true);
    expect(isMatchdayFinished([{ date: '', home: 'a', away: 'b', result: '-:-' }])).toBe(false);
    expect(isMatchdayFinished([])).toBe(false);
  });
});

describe('isMatchdayUpcoming', () => {
  const now = new Date('2026-09-01T12:00:00.000Z');

  it('is true when every kickoff is still in the future', () => {
    expect(
      isMatchdayUpcoming(
        [
          { date: '04.09.26 20:30', home: 'a', away: 'b', result: '-:-' },
          { date: '05.09.26 15:30', home: 'c', away: 'd', result: '-:-' },
        ],
        now,
      ),
    ).toBe(true);
  });

  it('is false once any match has kicked off', () => {
    expect(
      isMatchdayUpcoming(
        [
          { date: '31.08.26 20:30', home: 'a', away: 'b', result: '1:0' },
          { date: '05.09.26 15:30', home: 'c', away: 'd', result: '-:-' },
        ],
        now,
      ),
    ).toBe(false);
  });

  it('is false when a date cannot be parsed', () => {
    expect(isMatchdayUpcoming([{ date: '', home: 'a', away: 'b', result: '-:-' }], now)).toBe(false);
    expect(isMatchdayUpcoming([], now)).toBe(false);
  });
});

describe('throughCache', () => {
  it('fetches live and writes through', async () => {
    let calls = 0;
    const data = await throughCache('schedule', 3, { store }, async () => {
      calls++;
      return SCHEDULE;
    });
    expect(data).toEqual(SCHEDULE);
    expect(calls).toBe(1);
    expect(store.read('schedule', 3)?.data).toEqual(SCHEDULE);
  });

  it('still fetches live when a copy is already cached', async () => {
    store.write('schedule', SCHEDULE, 3);
    let calls = 0;
    await throughCache('schedule', 3, { store }, async () => {
      calls++;
      return { title: 'fresher', matches: [] };
    });
    expect(calls).toBe(1);
    expect(store.read('schedule', 3)?.data.title).toBe('fresher');
  });

  it('serves the cache and makes no request when offline', async () => {
    store.write('schedule', SCHEDULE, 3);
    let calls = 0;
    const data = await throughCache('schedule', 3, { store, offline: true }, async () => {
      calls++;
      return { title: 'should not happen', matches: [] };
    });
    expect(calls).toBe(0);
    expect(data).toEqual(SCHEDULE);
  });

  it('explains an offline miss instead of hanging', async () => {
    await expect(
      throughCache('schedule', 5, { store, offline: true }, async () => SCHEDULE),
    ).rejects.toBeInstanceOf(OfflineCacheMiss);
  });

  it('works with caching switched off', async () => {
    const data = await throughCache('schedule', 3, { store: null }, async () => SCHEDULE);
    expect(data).toEqual(SCHEDULE);
    expect(store.read('schedule', 3)).toBeNull();
  });

  it('never lets a cache write break the command', async () => {
    // A plain file where the cache directory should be: every write fails.
    const blocker = path.join(tmp, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const broken = new CacheStore('x', path.join(blocker, 'x'));
    const data = await throughCache('schedule', 3, { store: broken }, async () => SCHEDULE);
    expect(data).toEqual(SCHEDULE);
  });
});
