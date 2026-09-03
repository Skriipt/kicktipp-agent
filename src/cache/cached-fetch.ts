import { CacheStore, type CacheKind, type CacheKinds } from './store.js';

export class OfflineCacheMiss extends Error {}

export interface CacheOptions {
  /** Where to write through to. Null disables caching entirely. */
  store?: CacheStore | null;
  /** Serve from cache only; never touch the network. */
  offline?: boolean;
}

/** Use the requested matchday, or the most recent one in the cache. */
export function offlineMatchday(store: CacheStore, requested?: number): number {
  if (requested !== undefined) return requested;
  const cached = store.cachedMatchdays();
  if (cached.length) return cached[cached.length - 1];
  throw new OfflineCacheMiss('Nothing is cached yet. Run `kicktipp sync` while online first.');
}

/** Read a cached payload or explain precisely what is missing. */
export function requireCached<K extends CacheKind>(
  store: CacheStore | null | undefined,
  kind: K,
  matchday?: number,
): CacheKinds[K] {
  const cached = store?.read(kind, matchday);
  if (cached) return cached.data;
  const where = matchday === undefined ? kind : `${kind} for matchday ${matchday}`;
  throw new OfflineCacheMiss(
    `No cached ${where}. Run \`kicktipp sync\` while online, or drop --offline.`,
  );
}

/**
 * Run a live fetch and write the result to the cache, or — in offline mode —
 * serve the cached copy instead.
 *
 * The cache is a history, not a bypass: online reads always go to Kicktipp so
 * commands keep showing live data, and the snapshot is a side effect.
 */
export async function throughCache<K extends CacheKind>(
  kind: K,
  matchday: number | undefined,
  opts: CacheOptions,
  live: () => Promise<CacheKinds[K]>,
): Promise<CacheKinds[K]> {
  const { store, offline } = opts;

  if (offline) return requireCached(store, kind, matchday);

  const data = await live();
  if (store) {
    try {
      store.write(kind, data, matchday);
    } catch {
      // A cache that cannot be written must never break the command the user
      // actually asked for.
    }
  }
  return data;
}
