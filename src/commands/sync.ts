import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { CacheStore, isMatchdayFinished } from '../cache/store.js';
import { fetchSchedule, fetchBets, fetchLeaderboard, fetchMatchdayBets, fetchRules, NotFoundError } from '../core.js';

const MAX_MATCHDAY = 34;
/** Small pause between requests so a backfill stays polite to Kicktipp. */
const REQUEST_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Download this season into the local cache for offline use and analytics')
    .option('--refresh', 'Re-download matchdays that are already cached')
    .option('--from <n>', 'First matchday to sync', parseInt)
    .option('--to <n>', 'Last matchday to sync', parseInt)
    .action(async (opts) => {
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        const store = new CacheStore(community);
        const cache = { store };

        const from = opts.from ?? 1;
        const to = opts.to ?? MAX_MATCHDAY;

        status('Fetching rules...');
        await fetchRules(page, community, cache);

        let fetched = 0;
        let skipped = 0;
        let highest = 0;

        for (let matchday = from; matchday <= to; matchday++) {
          const cachedSchedule = store.read('schedule', matchday);
          if (!opts.refresh && cachedSchedule && isMatchdayFinished(cachedSchedule.data.matches)) {
            skipped++;
            highest = matchday;
            continue;
          }

          status(`Syncing matchday ${matchday}...`);
          try {
            const schedule = await fetchSchedule(page, community, matchday, cache);
            if (!schedule.matches.length) {
              // Past the end of this competition's season.
              break;
            }
            highest = matchday;
            await sleep(REQUEST_DELAY_MS);
            await fetchBets(page, community, matchday, cache);
            await sleep(REQUEST_DELAY_MS);
            await fetchLeaderboard(page, community, matchday, false, cache);
            await sleep(REQUEST_DELAY_MS);
            await fetchMatchdayBets(page, community, matchday, cache);
            await sleep(REQUEST_DELAY_MS);
            fetched++;
          } catch (err) {
            if (err instanceof NotFoundError) break;
            throw err;
          }
        }

        store.writeMeta({ lastSync: new Date().toISOString(), knownMatchdays: highest });
        statusClear();
        console.log(
          `Synced ${fetched} matchday${fetched === 1 ? '' : 's'}` +
            (skipped ? `, skipped ${skipped} already complete` : '') +
            `.\nCache: ${store.dir}`,
        );
      } finally {
        await page.close();
      }
    });
}
