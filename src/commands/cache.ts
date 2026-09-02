import { Command } from 'commander';
import { loadCommunity } from '../config.js';
import { CacheStore } from '../cache/store.js';
import { t } from '../i18n/index.js';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function requireCommunity(): string {
  const community = loadCommunity();
  if (!community) {
    console.error(t('common.noCommunity'));
    process.exit(1);
  }
  return community;
}

export function registerCacheCommand(program: Command): void {
  const cache = program.command('cache').description(t('cmd.cache.description'));

  cache
    .command('status')
    .description(t('cmd.cache.status'))
    .action(() => {
      const store = new CacheStore(requireCommunity());
      const matchdays = store.cachedMatchdays();
      const meta = store.readMeta();

      console.log(t('cache.community', { name: store.community }));
      console.log(t('cache.location', { dir: store.dir }));
      console.log(t('cache.size', { size: humanSize(store.sizeBytes()) }));
      console.log(t('cache.lastSync', { when: meta?.lastSync ?? t('cache.never') }));
      if (!matchdays.length) {
        console.log('\n' + t('cache.empty'));
        return;
      }
      console.log(t('cache.matchdays', { n: matchdays.length, from: matchdays[0], to: matchdays[matchdays.length - 1] }));
      const missingBets = matchdays.filter((m) => !store.has('matchdayBets', m));
      if (missingBets.length) {
        console.log(t('cache.missingBets', { days: missingBets.join(', ') }));
      }
    });

  cache
    .command('clear')
    .description(t('cmd.cache.clear'))
    .action(() => {
      const store = new CacheStore(requireCommunity());
      store.clear();
      console.log(t('cache.cleared', { name: store.community }));
    });
}
