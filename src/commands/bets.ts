import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode, widest } from '../helpers/output.js';
import { fetchBets, type BetMatch } from '../core.js';

function odds(match: BetMatch): string {
  const { home, draw, away } = match.odds;
  if (!home && !draw && !away) return '';
  return `  (${home || '-'}/${draw || '-'}/${away || '-'})`;
}

function render(title: string, matches: BetMatch[]): string {
  const lines: string[] = [];
  if (title) lines.push(title, '');
  if (!matches.length) return lines.concat('No matches found.').join('\n');

  const homeWidth = widest(matches.map((m) => m.home));
  const awayWidth = widest(matches.map((m) => m.away));
  for (const m of matches) {
    const bet = (m.bet || '-').padStart(5);
    lines.push(
      `  ${m.date.padEnd(17)} ${m.home.padStart(homeWidth)} vs ${m.away.padEnd(awayWidth)} ${bet}${odds(m)}`,
    );
  }
  return lines.join('\n');
}

export function registerBetsCommand(program: Command): void {
  program
    .command('bets')
    .description('Show bets/predictions for a matchday')
    .option('--matchday <n>', 'Matchday number (1-34)', parseInt)
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status('Loading bets...');
        const data = await fetchBets(page, community, opts.matchday);
        statusClear();

        if (opts.json) emitJson({ community, matchday: opts.matchday ?? null, data });
        else console.log(render(data.title, data.matches));
      } finally {
        await page.close();
      }
    });
}
