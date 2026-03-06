import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser, dismissConsent } from '../browser.js';
import { getPredictUrl } from '../url.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import {
  parseBetArg,
  matchFixture,
  EditableMatch,
} from '../helpers/parse-bet-arg.js';

export function registerSetAllBetsCommand(program: Command): void {
  program
    .command('set-all-bets')
    .description('Set bets by fixture, e.g. "Home vs Away=2:1"')
    .argument('<bets...>', 'Bets in format "Home vs Away=H:G"')
    .option('--matchday <n>', 'Matchday number (1-34)', parseInt)
    .action(async (bets: string[], opts) => {
      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        status('Loading bets...');
        await page.goto(getPredictUrl(community, opts.matchday));
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);
        statusClear();

        const $ = cheerio.load(await page.content());
        const tbody = $('#kicktipp-content tbody');
        if (!tbody.length) {
          console.log('No matches found.');
          return;
        }

        const editable: EditableMatch[] = [];
        tbody.find('tr').each((_, tr) => {
          const cols = $(tr).find('td');
          if (cols.length < 5) return;
          const betTd = $(cols[3]);
          if (betTd.hasClass('nichttippbar')) return;
          const heimInput = betTd.find('input[id$="_heimTipp"]');
          const gastInput = betTd.find('input[id$="_gastTipp"]');
          if (!heimInput.length || !gastInput.length) return;
          editable.push({
            home: $(cols[1]).text().trim(),
            away: $(cols[2]).text().trim(),
            heimName: heimInput.attr('name')!,
            gastName: gastInput.attr('name')!,
          });
        });

        if (!editable.length) {
          console.log('No editable matches found.');
          return;
        }

        // Parse and validate all bets before applying
        const parsed: { entry: EditableMatch; h: number; g: number }[] = [];
        const seen = new Set<string>();
        for (const arg of bets) {
          const { home, away, h, g } = parseBetArg(arg);
          const key = `${home.toLowerCase()}|${away.toLowerCase()}`;
          if (seen.has(key)) {
            console.error(`Duplicate fixture: "${home} vs ${away}"`);
            process.exit(1);
          }
          seen.add(key);
          const entry = matchFixture(home, away, editable);
          parsed.push({ entry, h, g });
        }

        // Apply bets
        for (const { entry, h, g } of parsed) {
          console.log(`  ${entry.home} vs ${entry.away} - ${h}:${g}`);
          const heimEl = await page.$(`input[name="${entry.heimName}"]`);
          const gastEl = await page.$(`input[name="${entry.gastName}"]`);
          if (heimEl) await heimEl.fill(String(h));
          if (gastEl) await gastEl.fill(String(g));
        }

        await Promise.all([
          page.waitForNavigation(),
          page.click('button[name="submitbutton"]'),
        ]);
        console.log('\nBets saved.');
      } finally {
        await browser.close();
      }
    });
}
