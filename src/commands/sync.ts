import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { syncSeason } from '../cache/sync.js';
import { t } from '../i18n/index.js';

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description(t('cmd.sync.description'))
    .option('--refresh', t('cmd.sync.optionRefresh'))
    .option('--from <n>', t('cmd.sync.optionFrom'), parseInt)
    .option('--to <n>', t('cmd.sync.optionTo'), parseInt)
    .action(async (opts) => {
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status(t('status.syncing'));
        const result = await syncSeason(page, community, {
          from: opts.from,
          to: opts.to,
          refresh: opts.refresh,
          onProgress: (matchday) => status(t('status.syncingMatchday', { n: matchday })),
        });
        statusClear();
        console.log(
          t('sync.done', {
            n: result.fetched,
            skipped: result.skipped ? t('sync.skipped', { n: result.skipped }) : '',
            dir: result.cacheDir,
          }),
        );
      } finally {
        await page.close();
      }
    });
}
