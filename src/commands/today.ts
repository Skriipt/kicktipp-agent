import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser, dismissConsent, parseOdds } from '../browser.js';
import { getPredictUrl } from '../url.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';

function parseMatchDate(dateStr: string): Date | null {
  const trimmed = dateStr.trim();
  // US format: M/D/YY h:mm AM/PM
  const usMatch = trimmed.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i,
  );
  if (usMatch) {
    const [, m, d, y, h, min, ampm] = usMatch;
    let hour = parseInt(h);
    if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;
    return new Date(2000 + parseInt(y), parseInt(m) - 1, parseInt(d), hour, parseInt(min));
  }
  // DE format: DD.MM.YY HH:MM
  const deMatch = trimmed.match(/^(\d{2})\.(\d{2})\.(\d{2})\s+(\d{2}):(\d{2})$/);
  if (deMatch) {
    const [, d, m, y, h, min] = deMatch;
    return new Date(2000 + parseInt(y), parseInt(m) - 1, parseInt(d), parseInt(h), parseInt(min));
  }
  return null;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

export function registerTodayCommand(program: Command): void {
  program
    .command('today')
    .description("Show today's matches and which still need bets")
    .action(async () => {
      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        status('Loading matches...');
        await page.goto(getPredictUrl(community));
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

        const now = new Date();

        interface TodayRow {
          time: string;
          home: string;
          away: string;
          bet: string;
          odds: string;
        }
        const rows: TodayRow[] = [];

        tbody.children('tr').each((_, tr) => {
          const cols = $(tr).children('td');
          if (cols.length < 5) return;

          const dateText = $(cols[0]).text().trim();
          const matchDate = parseMatchDate(dateText);
          if (!matchDate || !isSameDay(matchDate, now)) return;

          const home = $(cols[1]).text().trim();
          const away = $(cols[2]).text().trim();

          const betTd = $(cols[3]);
          let bet: string;
          if (betTd.hasClass('nichttippbar')) {
            bet = betTd.text().trim() || '-';
          } else {
            const heimInput = betTd.find('input[id$="_heimTipp"]');
            const gastInput = betTd.find('input[id$="_gastTipp"]');
            if (heimInput.length && gastInput.length) {
              const h = heimInput.attr('value') || '';
              const g = gastInput.attr('value') || '';
              bet = h && g ? `${h}:${g}` : '';
            } else {
              bet = '-';
            }
          }

          const time = matchDate.toLocaleTimeString('de-DE', {
            hour: '2-digit',
            minute: '2-digit',
          });

          const [rateHome, rateDeuce, rateRoad] = parseOdds($, cols[4]);
          const odds = `(${rateHome}/${rateDeuce}/${rateRoad})`;

          rows.push({ time, home, away, bet, odds });
        });

        if (!rows.length) {
          console.log('No matches today.');
          return;
        }

        const homeWidth = Math.max(...rows.map((r) => r.home.length));
        const awayWidth = Math.max(...rows.map((r) => r.away.length));
        let needsBets = 0;

        for (const { time, home, away, bet, odds } of rows) {
          const marker = bet ? ' ' : '*';
          const betDisplay = bet || 'no bet';
          console.log(
            `${marker} ${time}  ${home.padStart(homeWidth)} vs ${away.padEnd(awayWidth)}  ${betDisplay.padStart(6)}  ${odds}`,
          );
          if (!bet) needsBets++;
        }

        if (needsBets > 0) {
          console.log(`\n${needsBets} match${needsBets > 1 ? 'es' : ''} still need${needsBets === 1 ? 's' : ''} bets (* marked).`);
        } else {
          console.log('\nAll bets placed.');
        }
      } finally {
        await browser.close();
      }
    });
}
