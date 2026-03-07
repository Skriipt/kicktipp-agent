import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser, dismissConsent } from '../browser.js';
import { getLeaderboardUrl } from '../url.js';
import { loadPlayer } from '../config.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';

function showMatches($: cheerio.CheerioAPI, content: cheerio.Cheerio<any>): void {
  const matchesTable = content.find('table#spielplanSpiele');
  if (!matchesTable.length) return;
  const tbody = matchesTable.find('tbody');
  if (!tbody.length) return;

  const matchRows: [string, string, string, string][] = [];
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 4) return;
    const date = $(cols[0]).text().trim();
    const home = $(cols[1]).text().trim();
    const away = $(cols[2]).text().trim();
    const resultSpan = $(cols[3]).find('span.kicktipp-ergebnis');
    let result: string;
    if (resultSpan.length) {
      const h = resultSpan.find('span.kicktipp-heim').text().trim();
      const g = resultSpan.find('span.kicktipp-gast').text().trim();
      result = `${h}:${g}`;
    } else {
      result = '-:-';
    }
    matchRows.push([date, home, away, result]);
  });

  if (matchRows.length) {
    const homeWidth = Math.max(...matchRows.map((r) => r[1].length));
    const awayWidth = Math.max(...matchRows.map((r) => r[2].length));
    console.log('Matches:');
    for (const [date, home, away, result] of matchRows) {
      console.log(
        `  ${date.padEnd(17)} ${home.padStart(homeWidth)} vs ${away.padEnd(awayWidth)}  ${result}`,
      );
    }
    console.log();
  }
}

function showBonusQuestions($: cheerio.CheerioAPI, content: cheerio.Cheerio<any>): void {
  const questionsTable = content.find('table.ktable').first();
  if (!questionsTable.length) return;
  const tbody = questionsTable.children('tbody');
  if (!tbody.length) return;

  const questions: [string, string, string][] = [];
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 4) return;
    const question = $(cols[1]).text().trim();
    const abbr = $(cols[2]).text().trim();
    const resultParts: string[] = [];
    $(cols[3]).find('table tr').each((_, subTr) => {
      const medium = $(subTr).find('div.visible-medium-block');
      if (medium.length) {
        resultParts.push(medium.text().trim());
      }
    });
    const result = resultParts.length ? resultParts.join(', ') : '---';
    questions.push([abbr, question, result]);
  });

  if (questions.length) {
    const abbrWidth = Math.max(...questions.map((q) => q[0].length));
    const qWidth = Math.max(...questions.map((q) => q[1].length));
    console.log('Bonus Questions:');
    for (const [abbr, question, result] of questions) {
      console.log(`  ${abbr.padEnd(abbrWidth)}  ${question.padEnd(qWidth)}  ${result}`);
    }
    console.log();
  }
}

function showRankings(
  $: cheerio.CheerioAPI,
  content: cheerio.Cheerio<any>,
  bonus: boolean,
): void {
  const rankingTable = content.find('table#ranking');
  if (!rankingTable.length) return;
  const tbody = rankingTable.find('tbody');
  if (!tbody.length) return;

  const players: [string, string, string, string, string][] = [];
  tbody.find('tr').each((_, tr) => {
    const posTd = $(tr).find('td.position');
    const nameDiv = $(tr).find('div.mg_name');
    const mdTd = $(tr).find('td.spieltagspunkte');
    const bonusTd = $(tr).find('td.bonus');
    const totalTd = $(tr).find('td.gesamtpunkte');
    if (posTd.length && nameDiv.length) {
      players.push([
        posTd.text().trim(),
        nameDiv.text().trim(),
        mdTd.length ? mdTd.text().trim() : '',
        bonusTd.length ? bonusTd.text().trim() : '',
        totalTd.length ? totalTd.text().trim() : '',
      ]);
    }
  });

  if (players.length) {
    const savedPlayer = loadPlayer();
    const nameWidth = Math.max(...players.map((p) => p[1].length));
    console.log('Rankings:');
    if (bonus) {
      console.log(
        `  ${'Pos'.padEnd(5)} ${'Name'.padEnd(nameWidth)} ${'Bonus'.padStart(5)} ${'Total'.padStart(6)}`,
      );
      console.log(`  ${'-'.repeat(nameWidth + 19)}`);
      for (const [pos, name, , bns, total] of players) {
        const marker = savedPlayer && name === savedPlayer ? ' <' : '';
        console.log(
          `  ${pos.padEnd(5)} ${name.padEnd(nameWidth)} ${bns.padStart(5)} ${total.padStart(6)}${marker}`,
        );
      }
    } else {
      console.log(
        `  ${'Pos'.padEnd(5)} ${'Name'.padEnd(nameWidth)} ${'MD'.padStart(5)} ${'Bonus'.padStart(5)} ${'Total'.padStart(6)}`,
      );
      console.log(`  ${'-'.repeat(nameWidth + 24)}`);
      for (const [pos, name, md, bns, total] of players) {
        const marker = savedPlayer && name === savedPlayer ? ' <' : '';
        console.log(
          `  ${pos.padEnd(5)} ${name.padEnd(nameWidth)} ${md.padStart(5)} ${bns.padStart(5)} ${total.padStart(6)}${marker}`,
        );
      }
    }
  }
}

export function registerLeaderboardCommand(program: Command): void {
  program
    .command('leaderboard')
    .description('Display the leaderboard for a matchday')
    .option('--matchday <n>', 'Matchday number (1-34)')
    .option('--bonus', 'Show bonus questions instead of matches')
    .action(async (opts) => {
      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        const matchday = opts.matchday !== undefined ? parseInt(opts.matchday) : undefined;
        const bonus = !!opts.bonus;

        status('Loading leaderboard...');
        await page.goto(getLeaderboardUrl(community, matchday, bonus));
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

        if (bonus) {
          showBonusQuestions($, content);
        } else {
          showMatches($, content);
        }

        showRankings($, content, bonus);
      } finally {
        await browser.close();
      }
    });
}
