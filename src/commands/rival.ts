import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { loadCommunity, loadPlayer } from '../config.js';
import { status, statusClear } from '../helpers/spinner.js';
import { CacheStore } from '../cache/store.js';
import { fetchLeaderboard, fetchMatchdayBets } from '../core.js';
import { resolveRules } from '../rules/resolve.js';
import { analyseRival, type RivalAnalysis } from '../analytics/rivals.js';
import { gapBeforeMatchday } from '../analytics/gap.js';
import { offlineMatchday, requireCached } from '../cache/offline.js';
import { resolveRulesFromCache } from '../rules/resolve.js';

function sign(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function render(analysis: RivalAnalysis, rulesNote: string | undefined): string {
  const lines: string[] = [];
  const md = analysis.matchday ? ` — matchday ${analysis.matchday}` : '';
  lines.push(`${analysis.player} vs ${analysis.rival}${md}`);

  if (analysis.gap === null) {
    lines.push('Standings unknown.');
  } else if (analysis.gap > 0) {
    lines.push(`You are ${analysis.gap} point(s) ahead going into the open matches.`);
  } else if (analysis.gap < 0) {
    lines.push(`You are ${-analysis.gap} point(s) behind going into the open matches.`);
  } else {
    lines.push('Dead level going into the open matches.');
  }

  if (analysis.mode === 'bounds') {
    lines.push('Mode: best/worst bounds — the rival\'s bets are not public yet.');
  }
  if (analysis.note) lines.push(`Note: ${analysis.note}`);
  lines.push('');

  const width = Math.max(...analysis.perMatch.map((m) => `${m.home} vs ${m.away}`.length), 10);
  lines.push(`  ${'Match'.padEnd(width)}  ${'You'.padEnd(6)} ${'Them'.padEnd(6)}  Swing`);
  for (const swing of analysis.perMatch) {
    const label = `${swing.home} vs ${swing.away}`.padEnd(width);
    const mine = (swing.myBet ?? '–').padEnd(6);
    const theirs = (swing.rivalBet ?? '–').padEnd(6);
    const range =
      swing.settled !== undefined
        ? `settled ${sign(swing.settled)}`
        : `${sign(swing.worstForMe)} … ${sign(swing.bestForMe)}`;
    lines.push(`  ${label}  ${mine} ${theirs}  ${range}`);
  }

  lines.push('');
  lines.push(
    `Still on the table: ${sign(analysis.swingRange.worst)} … ${sign(analysis.swingRange.best)} points.`,
  );
  lines.push('');
  for (const condition of analysis.conditions) lines.push(`• ${condition}`);
  if (rulesNote) lines.push(`\n${rulesNote}`);
  return lines.join('\n');
}

export function registerRivalCommand(program: Command): void {
  program
    .command('rival')
    .description('Work out what it would take to overtake another player')
    .argument('<name>', 'Player to compare against')
    .option('--matchday <n>', 'Matchday number (1-34). Omit for the current one.', parseInt)
    .option('--offline', 'Use only cached data; make no requests')
    .option('--json', 'Output raw JSON')
    .action(async (name: string, opts) => {
      if (opts.offline) {
        const community = loadCommunity();
        if (!community) {
          console.error('No community set. Run `kicktipp set-community` first.');
          process.exit(1);
        }
        const player = loadPlayer();
        if (!player) {
          console.error('No player set. Run `kicktipp set-player` first.');
          process.exit(1);
        }
        const store = new CacheStore(community);
        const matchday = offlineMatchday(store, opts.matchday);
        const grid = requireCached(store, 'matchdayBets', matchday);
        const leaderboard = store.read('leaderboard', matchday)?.data;
        const rules = resolveRulesFromCache(store);
        const analysis = analyseRival(
          grid,
          player,
          name,
          rules.values,
          gapBeforeMatchday(leaderboard, player, name),
        );
        if (opts.json) console.log(JSON.stringify({ rules, analysis }, null, 2));
        else console.log(render(analysis, rules.warning));
        return;
      }

      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        const player = loadPlayer();
        if (!player) {
          console.error('No player set. Run `kicktipp set-player` first.');
          process.exit(1);
        }

        const store = new CacheStore(community);
        const cache = { store };

        status('Loading matchday...');
        const grid = await fetchMatchdayBets(page, community, opts.matchday, cache);
        const leaderboard = await fetchLeaderboard(page, community, opts.matchday, false, cache);
        const rules = await resolveRules(page, community, cache);
        statusClear();

        const analysis = analyseRival(
          grid,
          player,
          name,
          rules.values,
          gapBeforeMatchday(leaderboard, player, name),
        );

        if (opts.json) {
          console.log(JSON.stringify({ rules, analysis }, null, 2));
          return;
        }
        console.log(render(analysis, rules.warning));
      } finally {
        await page.close();
      }
    });
}
