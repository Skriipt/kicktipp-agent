import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode, widest } from '../helpers/output.js';
import { fetchSchedule, type ScheduleMatch } from '../core.js';

function render(title: string, matches: ScheduleMatch[]): string {
  const lines: string[] = [];
  if (title) lines.push(title, '');
  if (!matches.length) return lines.concat('No schedule found.').join('\n');

  const homeWidth = widest(matches.map((m) => m.home));
  const awayWidth = widest(matches.map((m) => m.away));
  for (const m of matches) {
    lines.push(
      `  ${m.date.padEnd(17)} ${m.home.padStart(homeWidth)} vs ${m.away.padEnd(awayWidth)}  ${m.result}`,
    );
  }
  return lines.join('\n');
}

export function registerScheduleCommand(program: Command): void {
  program
    .command('schedule')
    .description('Display the match schedule')
    .option('--matchday <n>', 'Matchday number (1-34)', parseInt)
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status('Loading schedule...');
        const data = await fetchSchedule(page, community, opts.matchday);
        statusClear();

        if (opts.json) emitJson({ community, matchday: opts.matchday ?? null, data });
        else console.log(render(data.title, data.matches));
      } finally {
        await page.close();
      }
    });
}
