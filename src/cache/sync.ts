import { Page } from '../browser.js';
import { CacheStore, isMatchdayFinished, isMatchdayUpcoming } from './store.js';
import crypto from 'crypto';
import { parseMatchDate } from '../helpers/match-date.js';
import {
  fetchCurrentMatchday,
  fetchSchedule,
  fetchBets,
  fetchLeaderboard,
  fetchMatchdayBets,
  fetchRules,
  NotFoundError,
  type ScheduleMatch,
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
  /** Test seam: a store rooted somewhere other than the user cache. */
  store?: CacheStore;
  /** Test seam: skip the predict-page discovery request. */
  currentMatchday?: number;
  now?: Date;
}

export interface SyncResult {
  community: string;
  fetched: number;
  skipped: number;
  knownMatchdays: number;
  cacheDir: string;
}

export type SyncDecision =
  | { matchday: number; action: 'fetch'; reason: 'missing' | 'open' | 'refresh' }
  | { matchday: number; action: 'skip'; reason: 'finished' | 'future' };

/**
 * Decide which matchdays in `[from, to]` are worth a network round-trip.
 *
 * Finished cached matchdays never change. Upcoming ones (every kickoff still
 * in the future) only need a first fetch. The caller caps `to` at Kicktipp's
 * current spieltag so we do not walk the unpublished rest of the season.
 */
export function planSeasonSync(input: {
  from: number;
  to: number;
  refresh?: boolean;
  now?: Date;
  cached: ReadonlyMap<number, ScheduleMatch[]>;
}): SyncDecision[] {
  const from = Math.max(1, Math.min(MAX_MATCHDAY, input.from));
  const to = Math.max(from, Math.min(MAX_MATCHDAY, input.to));
  const now = input.now ?? new Date();
  const out: SyncDecision[] = [];
  for (let matchday = from; matchday <= to; matchday++) {
    const matches = input.cached.get(matchday);
    if (input.refresh) {
      out.push({ matchday, action: 'fetch', reason: 'refresh' });
      continue;
    }
    if (!matches) {
      out.push({ matchday, action: 'fetch', reason: 'missing' });
      continue;
    }
    if (isMatchdayFinished(matches)) {
      out.push({ matchday, action: 'skip', reason: 'finished' });
      continue;
    }
    if (isMatchdayUpcoming(matches, now)) {
      out.push({ matchday, action: 'skip', reason: 'future' });
      continue;
    }
    out.push({ matchday, action: 'fetch', reason: 'open' });
  }
  return out;
}

function cachedSchedules(store: CacheStore): Map<number, ScheduleMatch[]> {
  const cached = new Map<number, ScheduleMatch[]>();
  for (const matchday of store.cachedMatchdays()) {
    const envelope = store.read('schedule', matchday);
    // A schedule alone does not mean the previous sync finished this round.
    if (envelope && store.has('bets', matchday) && store.has('leaderboard', matchday) &&
        store.has('matchdayBets', matchday)) cached.set(matchday, envelope.data.matches);
  }
  return cached;
}

function seasonAnchor(matches: ScheduleMatch[]): string | null {
  if (!matches.length) return null;
  const fixtures: string[] = [];
  for (const match of matches) {
    const kickoff = parseMatchDate(match.date);
    if (!kickoff || !match.home || !match.away) return null;
    fixtures.push(JSON.stringify([match.home, match.away, kickoff.toISOString()]));
  }
  return crypto.createHash('sha256').update(JSON.stringify(fixtures.sort())).digest('hex');
}

/**
 * Walk the live slice of the season and fill the cache.
 *
 * Without `--to`, the walk stops at Kicktipp's current matchday. Finished
 * and still-upcoming cached matchdays are skipped, so a weekly run usually
 * costs one open matchday plus any holes.
 */
export async function syncSeason(
  page: Page,
  community: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const store = opts.store ?? new CacheStore(community);
  const cache = { store };
  const delay = opts.delayMs ?? REQUEST_DELAY_MS;
  const from = opts.from ?? 1;
  const discovered = opts.currentMatchday ?? (await fetchCurrentMatchday(page, community));
  const to = opts.to ?? discovered ?? MAX_MATCHDAY;

  // The slug and matchday numbers can be reused next season. Verify a live
  // opening round before trusting completed history; never guess from today.
  // Changed kickoff dates also conservatively start a new cache generation.
  const opening = await fetchSchedule(page, community, 1);
  const anchor = seasonAnchor(opening.matches);
  if (!anchor) throw new Error('Cannot verify the season: opening-round fixtures or kickoff dates are missing.');
  const previousMeta = store.readMeta();
  const previousAnchor = previousMeta?.seasonAnchor ??
    seasonAnchor(store.read('schedule', 1)?.data.matches ?? []);
  if (store.cachedMatchdays().length && previousAnchor !== anchor) store.archive();
  const retainedMeta = store.readMeta();
  store.writeMeta({
    lastSync: retainedMeta?.lastSync,
    knownMatchdays: retainedMeta?.knownMatchdays,
    seasonAnchor: anchor,
  });

  await fetchRules(page, community, cache);

  const plan = planSeasonSync({
    from,
    to,
    refresh: opts.refresh,
    now: opts.now,
    cached: cachedSchedules(store),
  });

  let fetched = 0;
  let skipped = 0;
  let highest = 0;

  for (const step of plan) {
    if (step.action === 'skip') {
      skipped++;
      highest = step.matchday;
      continue;
    }

    opts.onProgress?.(step.matchday);
    try {
      const schedule = step.matchday === 1 ? opening :
        await fetchSchedule(page, community, step.matchday, cache);
      if (step.matchday === 1) store.write('schedule', schedule, 1);
      // An empty schedule means we have walked past the end of the season.
      if (!schedule.matches.length) break;
      highest = step.matchday;

      await sleep(delay);
      await fetchBets(page, community, step.matchday, cache);
      await sleep(delay);
      await fetchLeaderboard(page, community, step.matchday, false, cache);
      await sleep(delay);
      await fetchMatchdayBets(page, community, step.matchday, cache);
      await sleep(delay);
      fetched++;
    } catch (err) {
      if (err instanceof NotFoundError) break;
      throw err;
    }
  }

  const knownMatchdays = Math.max(highest, store.readMeta()?.knownMatchdays ?? 0, discovered ?? 0);
  store.writeMeta({ lastSync: new Date().toISOString(), knownMatchdays, seasonAnchor: anchor });
  return { community, fetched, skipped, knownMatchdays, cacheDir: store.dir };
}
