import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode, widest } from '../helpers/output.js';
import { fetchTodayMatches, fetchBets, type TodayMatch } from '../core.js';
import { buildDeadlineReport, urgencyWarning } from '../analytics/deadline.js';

function render(matches: TodayMatch[]): string {
  if (!matches.length) return 'No matches today.';

  const lines: string[] = ["Today's matches", ''];
  const homeWidth = widest(matches.map((m) => m.home));
  const awayWidth = widest(matches.map((m) => m.away));

  for (const m of matches) {
    const bet = m.needsBet ? 'NO BET' : m.bet || '-';
    const marker = m.needsBet ? ' <-- needs a bet' : '';
    lines.push(
      `  ${m.time.padEnd(6)} ${m.home.padStart(homeWidth)} vs ${m.away.padEnd(awayWidth)} ` +
        `${bet.padStart(6)}${marker}`,
    );
  }

  const pending = matches.filter((m) => m.needsBet).length;
  lines.push('');
  lines.push(pending ? `${pending} match(es) still need a bet.` : 'All matches have a bet.');
  return lines.join('\n');
}

export function registerTodayCommand(program: Command): void {
  program
    .command('today')
    .description("Show today's matches and which still need bets")
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status("Loading today's matches...");
        const data = await fetchTodayMatches(page, community);
        statusClear();

        // Today's view only knows about today; the warning needs the whole
        // matchday, since an unbetted match may kick off tomorrow morning.
        const { matches } = await fetchBets(page, community);
        const report = buildDeadlineReport(community, null, matches);

        if (opts.json) {
          emitJson({ community, data, deadline: report });
        } else {
          console.log(render(data.matches));
          const warning = urgencyWarning(report);
          if (warning) console.log(`\n${warning}`);
        }
      } finally {
        await page.close();
      }
    });
}
