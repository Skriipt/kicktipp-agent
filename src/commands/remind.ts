import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { emitJson, setJsonMode } from '../helpers/output.js';
import { fetchBets } from '../core.js';
import { buildDeadlineReport, urgencyWarning } from '../analytics/deadline.js';
import { sendNotification, type NotificationPayload } from '../notify/backends.js';
import { readServiceConfig } from '../service/settings.js';
import { t } from '../i18n/index.js';

export function registerNotifyCommand(program: Command): void {
  program
    .command('notify')
    .description(t('cmd.notify.description'))
    .option('--matchday <n>', t('opt.matchday'), parseInt)
    .option('--warn-hours <n>', t('opt.warnHours'), parseFloat)
    .option('--force', t('cmd.notify.optionForce'))
    .option('--test', t('cmd.notify.optionTest'))
    .option('--json', t('cmd.notify.optionJson'))
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const config = readServiceConfig();
      let payload: NotificationPayload;
      if (opts.test) {
        payload = { summary: t('notify.testSummary'), event: 'test' };
      } else {
        const page = await launchBrowser();
        try {
          const community = await ensureCommunity(page);
          const { matches } = await fetchBets(page, community, opts.matchday);
          const report = buildDeadlineReport(community, opts.matchday ?? null, matches, {
            warnHours: opts.warnHours ?? Math.max(...config.notifications.warnHours),
          });
          payload = {
            summary: urgencyWarning(report) ?? `${report.needsBetCount} match(es) still need a bet in ${community}.`,
            ...report,
          };
          if (!opts.json && !report.urgentCount && !opts.force) {
            console.log(t('notify.nothingUrgent'));
            return;
          }
        } finally {
          await page.close();
        }
      }
      if (opts.json) {
        emitJson(payload);
        return;
      }
      if (!config.notifications.channels.length) throw new Error(t('notify.noChannels'));
      // Attempt every channel even when one provider fails.
      const results = await Promise.allSettled(
        config.notifications.channels.map((channel) => sendNotification(channel, payload)),
      );
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed) throw new Error(`${failed} of ${results.length} notification channel(s) failed. Check the channel settings with kicktipp setup --notifications.`);
      console.log(t('notify.sent'));
    });
}
