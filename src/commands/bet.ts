import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { assertWritable } from '../read-only.js';
import { placeBets, placeBonusBets } from '../core.js';
import { t } from '../i18n/index.js';

export function registerBetCommand(program: Command): void {
  program
    .command('bet')
    .description(t('cmd.bet.description'))
    .argument('<bets...>', t('cmd.bet.argument'))
    .option('--matchday <n>', t('opt.matchday'), parseInt)
    .option('--bonus', t('opt.bonusBet'))
    .action(async (bets: string[], opts) => {
      assertWritable('Placing bets');
      const page = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        if (opts.bonus) {
          status(t('status.loadingBonus'));
          const applied = await placeBonusBets(page, community, bets, true, 'cli:bet');
          statusClear();
          for (const answer of applied) console.log(`  ${answer.question} → ${answer.answer}`);
          console.log(t('common.bonusSaved'));
        } else {
          status(t('status.loadingBets'));
          const placed = await placeBets(page, community, bets, opts.matchday, true, 'cli:bet');
          statusClear();
          for (const bet of placed) {
            console.log(`  ${bet.home} vs ${bet.away} - ${bet.homeGoals}:${bet.awayGoals}`);
          }
          console.log(t('common.betsSaved'));
        }
      } finally {
        await page.close();
      }
    });
}
