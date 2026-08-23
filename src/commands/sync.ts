import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { syncSeason } from '../cache/sync.js';

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
        status('Syncing...');
        const result = await syncSeason(page, community, {
          from: opts.from,
          to: opts.to,
          refresh: opts.refresh,
          onProgress: (matchday) => status(`Syncing matchday ${matchday}...`),
        });
        statusClear();
        console.log(
          `Synced ${result.fetched} matchday${result.fetched === 1 ? '' : 's'}` +
            (result.skipped ? `, skipped ${result.skipped} already complete` : '') +
            `.\nCache: ${result.cacheDir}`,
        );
      } finally {
        await page.close();
      }
    });
}
