import { Command } from 'commander';
import { loadCommunity } from '../config.js';
import { CacheStore } from '../cache/store.js';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function requireCommunity(): string {
  const community = loadCommunity();
  if (!community) {
    console.error('No community set. Run `kicktipp set-community` first.');
    process.exit(1);
  }
  return community;
}

export function registerCacheCommand(program: Command): void {
  const cache = program.command('cache').description('Inspect or clear the local season cache');

  cache
    .command('status')
    .description('Show what is cached')
    .action(() => {
      const store = new CacheStore(requireCommunity());
      const matchdays = store.cachedMatchdays();
      const meta = store.readMeta();

      console.log(`Community:  ${store.community}`);
      console.log(`Location:   ${store.dir}`);
      console.log(`Size:       ${humanSize(store.sizeBytes())}`);
      console.log(`Last sync:  ${meta?.lastSync ?? 'never'}`);
      if (!matchdays.length) {
        console.log('\nNothing cached yet. Run `kicktipp sync`.');
        return;
      }
      console.log(`Matchdays:  ${matchdays.length} cached (${matchdays[0]}-${matchdays[matchdays.length - 1]})`);
      const missingBets = matchdays.filter((m) => !store.has('matchdayBets', m));
      if (missingBets.length) {
        console.log(`            no per-player bets for: ${missingBets.join(', ')}`);
      }
    });

  cache
    .command('clear')
    .description('Delete the cached data for the current community')
    .action(() => {
      const store = new CacheStore(requireCommunity());
      store.clear();
      console.log(`Cleared cache for '${store.community}'.`);
    });
}
