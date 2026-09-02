import { CacheStore, type CacheKind, type CacheKinds } from './store.js';
import { OfflineCacheMiss } from './cached-fetch.js';

/**
 * Which matchday an offline command should work on: the one asked for, or
 * the most recent one in the cache.
 */
export function offlineMatchday(store: CacheStore, requested?: number): number {
  if (requested !== undefined) return requested;
  const cached = store.cachedMatchdays();
  if (!cached.length) {
    throw new OfflineCacheMiss('Nothing is cached yet. Run `kicktipp sync` while online first.');
  }
  return cached[cached.length - 1];
}

/** Read a cached payload or explain precisely what is missing. */
export function requireCached<K extends CacheKind>(
  store: CacheStore,
  kind: K,
  matchday?: number,
): CacheKinds[K] {
  const cached = store.read(kind, matchday);
  if (!cached) {
    const where = matchday === undefined ? kind : `${kind} for matchday ${matchday}`;
    throw new OfflineCacheMiss(
      `No cached ${where}. Run \`kicktipp sync\` while online, or drop --offline.`,
    );
  }
  return cached.data;
}
