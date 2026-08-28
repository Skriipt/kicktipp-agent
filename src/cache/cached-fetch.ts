import { CacheStore, type CacheKind, type CacheKinds } from './store.js';

export class OfflineCacheMiss extends Error {}

export interface CacheOptions {
  /** Where to write through to. Null disables caching entirely. */
  store?: CacheStore | null;
  /** Serve from cache only; never touch the network. */
  offline?: boolean;
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

  if (offline) {
    const cached = store?.read(kind, matchday);
    if (!cached) {
      const where = matchday === undefined ? kind : `${kind} for matchday ${matchday}`;
      throw new OfflineCacheMiss(
        `No cached ${where}. Run \`kicktipp sync\` while online, or drop --offline.`,
      );
    }
    return cached.data;
  }

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
