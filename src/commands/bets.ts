import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser, dismissConsent, parseOdds } from '../browser.js';
import { getPredictUrl } from '../url.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';

export function registerBetsCommand(program: Command): void {
  program
    .command('bets')
    .description('Show bets/predictions for a matchday')
    .option('--matchday <n>', 'Matchday number (1-34)')
    .action(async (opts) => {
      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        const matchday = opts.matchday !== undefined ? parseInt(opts.matchday) : undefined;

        status('Loading bets...');
        await page.goto(getPredictUrl(community, matchday));
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);
        statusClear();

        const $ = cheerio.load(await page.content());
        const content = $('#kicktipp-content');

        // Print title
        const titleDiv = content.find('div.pagetitle');
        if (titleDiv.length) {
          console.log(titleDiv.text().trim());
        }
        console.log();

        const tbody = content.find('tbody');
        if (!tbody.length) {
          console.log('No matches found.');
          return;
        }

        const rowsData: [string, string, string, string, string][] = [];
        tbody.children('tr').each((_, tr) => {
          const cols = $(tr).children('td');
          if (cols.length < 5) return;

          const date = $(cols[0]).text().trim();
          const home = $(cols[1]).text().trim();
          const away = $(cols[2]).text().trim();

          const betTd = $(cols[3]);
          let bet: string;
          if (betTd.hasClass('nichttippbar')) {
            // Past matchday - shows locked prediction as text
            bet = betTd.text().trim();
          } else {
            // Current matchday - read values from inputs
            const heimInput = betTd.find('input[id$="_heimTipp"]');
            const gastInput = betTd.find('input[id$="_gastTipp"]');
            if (heimInput.length && gastInput.length) {
              const h = heimInput.attr('value') || '';
              const g = gastInput.attr('value') || '';
              if (h && g) {
                bet = `${h}-${g}`;
              } else {
                bet = '-';
              }
            } else {
              bet = '-';
            }
          }

          const [rateHome, rateDeuce, rateRoad] = parseOdds($, cols[4]);
          const odds = `(${rateHome}/${rateDeuce}/${rateRoad})`;

          rowsData.push([date, home, away, bet, odds]);
        });

        if (rowsData.length) {
          const homeWidth = Math.max(...rowsData.map((r) => r[1].length));
          const awayWidth = Math.max(...rowsData.map((r) => r[2].length));
          for (const [date, home, away, bet, odds] of rowsData) {
            console.log(
              `  ${date.padEnd(17)} ${home.padStart(homeWidth)} vs ${away.padEnd(awayWidth)}  ${bet.padStart(5)}  ${odds}`,
            );
          }
        }
      } finally {
        await browser.close();
      }
    });
}
