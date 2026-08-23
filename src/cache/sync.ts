import { Page } from '../browser.js';
import { CacheStore, isMatchdayFinished } from './store.js';
import {
  fetchSchedule,
  fetchBets,
  fetchLeaderboard,
  fetchMatchdayBets,
  fetchRules,
  NotFoundError,
} from '../core.js';

const MAX_MATCHDAY = 34;
/** Small pause between requests so a backfill stays polite to Kicktipp. */
const REQUEST_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SyncOptions {
  from?: number;
  to?: number;
  refresh?: boolean;
  delayMs?: number;
  onProgress?: (matchday: number) => void;
}

export interface SyncResult {
  community: string;
  fetched: number;
  skipped: number;
  knownMatchdays: number;
  cacheDir: string;
}

/**
 * Walk the season and fill the cache. Resumable: a matchday whose results
 * are all in is never re-fetched unless `refresh` is set, so running this
 * again after a weekend only costs the new matchday.
 */
export async function syncSeason(
  page: Page,
  community: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const store = new CacheStore(community);
  const cache = { store };
  const delay = opts.delayMs ?? REQUEST_DELAY_MS;
  const from = opts.from ?? 1;
  const to = opts.to ?? MAX_MATCHDAY;

  await fetchRules(page, community, cache);

  let fetched = 0;
  let skipped = 0;
  let highest = 0;

  for (let matchday = from; matchday <= to; matchday++) {
    const cached = store.read('schedule', matchday);
    if (!opts.refresh && cached && isMatchdayFinished(cached.data.matches)) {
      skipped++;
      highest = matchday;
      continue;
    }

    opts.onProgress?.(matchday);
    try {
      const schedule = await fetchSchedule(page, community, matchday, cache);
      // An empty schedule means we have walked past the end of the season.
      if (!schedule.matches.length) break;
      highest = matchday;

      await sleep(delay);
      await fetchBets(page, community, matchday, cache);
      await sleep(delay);
      await fetchLeaderboard(page, community, matchday, false, cache);
      await sleep(delay);
      await fetchMatchdayBets(page, community, matchday, cache);
      await sleep(delay);
      fetched++;
    } catch (err) {
      if (err instanceof NotFoundError) break;
      throw err;
    }
  }

  store.writeMeta({ lastSync: new Date().toISOString(), knownMatchdays: highest });
  return { community, fetched, skipped, knownMatchdays: highest, cacheDir: store.dir };
}
