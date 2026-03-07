import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser, dismissConsent } from '../browser.js';
import { getPredictUrl } from '../url.js';
import { ensureCommunity, ask } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';

export function registerSetBetsCommand(program: Command): void {
  program
    .command('set-bets')
    .description('Manually set bets for editable matches')
    .option('--matchday <n>', 'Matchday number (1-34)', parseInt)
    .action(async (opts) => {
      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        status('Loading bets...');
        await page.goto(getPredictUrl(community, opts.matchday));
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);
        statusClear();

        const $ = cheerio.load(await page.content());
        const content = $('#kicktipp-content');

        const titleDiv = content.find('div.pagetitle');
        if (titleDiv.length) console.log(titleDiv.text().trim());
        console.log();

        const tbody = content.find('tbody');
        if (!tbody.length) {
          console.log('No matches found.');
          return;
        }

        interface EditableRow {
          date: string;
          home: string;
          away: string;
          current: string;
          heimName: string;
          gastName: string;
        }
        const editable: EditableRow[] = [];

        tbody.find('tr').each((_, tr) => {
          const cols = $(tr).find('td');
          if (cols.length < 5) return;
          const betTd = $(cols[3]);
          if (betTd.hasClass('nichttippbar')) return;
          const heimInput = betTd.find('input[id$="_heimTipp"]');
          const gastInput = betTd.find('input[id$="_gastTipp"]');
          if (!heimInput.length || !gastInput.length) return;
          const date = $(cols[0]).text().trim();
          const home = $(cols[1]).text().trim();
          const away = $(cols[2]).text().trim();
          const currentH = heimInput.attr('value') || '';
          const currentG = gastInput.attr('value') || '';
          const current =
            currentH && currentG ? `${currentH}:${currentG}` : '';
          editable.push({
            date,
            home,
            away,
            current,
            heimName: heimInput.attr('name')!,
            gastName: gastInput.attr('name')!,
          });
        });

        if (!editable.length) {
          console.log('No editable matches found.');
          return;
        }

        let changed = false;
        for (const row of editable) {
          let prompt = `  ${row.date} ${row.home} vs ${row.away} `;
          if (row.current) prompt += `[${row.current}] `;
          prompt += '(e.g. 2:1, Enter to skip): ';
          const answer = (await ask(prompt)).trim();
          if (!answer) continue;
          const parts = answer.replace('-', ':').split(':');
          if (parts.length !== 2) {
            console.log('    Invalid format, skipping.');
            continue;
          }
          const h = parseInt(parts[0]);
          const g = parseInt(parts[1]);
          if (isNaN(h) || isNaN(g)) {
            console.log('    Invalid format, skipping.');
            continue;
          }
          const heimEl = await page.$(`input[name="${row.heimName}"]`);
          const gastEl = await page.$(`input[name="${row.gastName}"]`);
          if (heimEl) await heimEl.fill(String(h));
          if (gastEl) await gastEl.fill(String(g));
          changed = true;
        }

        if (changed) {
          await Promise.all([
            page.waitForNavigation(),
            page.click('button[name="submitbutton"]'),
          ]);
          console.log('\nBets saved.');
        } else {
          console.log('\nNo changes made.');
        }
      } finally {
        await browser.close();
      }
    });
}
