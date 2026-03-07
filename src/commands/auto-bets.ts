import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { parseMatchRows } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { choosePredictor } from '../predictors/index.js';

export function registerAutoBetsCommand(program: Command): void {
  program
    .command('auto-bets')
    .description('Automatically place bets using a predictor')
    .option('--matchday <n>', 'Matchday number (1-34)', parseInt)
    .option('--predictor <name>', 'Predictor to use')
    .option('--override-bets', 'Override already placed bets')
    .option('--dry-run', 'Print predictions without placing bets')
    .action(async (opts) => {
      const predictor = choosePredictor(opts.predictor);
      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        status(`Loading ${community}...`);
        const matches = await parseMatchRows(page, community, opts.matchday);
        statusClear();
        console.log(`Community: ${community}`);

        if (!matches.length) {
          console.log('  No active matchday found.');
          return;
        }

        for (const { heimName, gastName, match } of matches) {
          if (!heimName || !gastName) {
            console.log(`${match} - no bets possible`);
            continue;
          }

          const heimInput = await page.$(`input[name="${heimName}"]`);
          const gastInput = await page.$(`input[name="${gastName}"]`);
          const currentHome = heimInput
            ? await heimInput.inputValue()
            : '';
          const currentAway = gastInput
            ? await gastInput.inputValue()
            : '';

          if (!opts.overrideBets && (currentHome || currentAway)) {
            console.log(
              `${match} - skipped, already placed ${currentHome}:${currentAway}`,
            );
            continue;
          }

          const [homebet, roadbet] = predictor.predict(match);
          console.log(`${match} - betting ${homebet}:${roadbet}`);
          if (heimInput) await heimInput.fill(String(homebet));
          if (gastInput) await gastInput.fill(String(roadbet));
        }

        if (!opts.dryRun) {
          await Promise.all([
            page.waitForNavigation(),
            page.click('button[name="submitbutton"]'),
          ]);
        } else {
          console.log('INFO: Dry run, no bets were placed');
        }
      } finally {
        await browser.close();
      }
    });
}
