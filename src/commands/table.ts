import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode, widest } from '../helpers/output.js';
import { fetchTable, type TableTeam } from '../core.js';
import { t } from '../i18n/index.js';

function render(label: string, teams: TableTeam[]): string {
  const lines: string[] = [label, ''];
  if (!teams.length) return lines.concat(t('common.noTable')).join('\n');

  const teamWidth = widest(teams.map((t) => t.team), 4);
  lines.push(
    `  ${'Pos'.padEnd(5)} ${'Team'.padEnd(teamWidth)} ${'P'.padStart(3)} ${'Pts'.padStart(4)} ` +
      `${'GF'.padStart(3)} ${'GA'.padStart(3)} ${'GD'.padStart(4)} ${'W'.padStart(3)} ${'D'.padStart(3)} ${'L'.padStart(3)}`,
  );
  lines.push(`  ${'-'.repeat(teamWidth + 33)}`);
  for (const t of teams) {
    lines.push(
      `  ${t.position.padEnd(5)} ${t.team.padEnd(teamWidth)} ${t.played.padStart(3)} ${t.points.padStart(4)} ` +
        `${t.goalsFor.padStart(3)} ${t.goalsAgainst.padStart(3)} ${t.goalDifference.padStart(4)} ` +
        `${t.wins.padStart(3)} ${t.draws.padStart(3)} ${t.losses.padStart(3)}`,
    );
  }
  return lines.join('\n');
}

export function registerTableCommand(program: Command): void {
  program
    .command('table')
    .description(t('cmd.table.description'))
    .option('--home', t('opt.home'))
    .option('--away', t('opt.away'))
    .option('--json', t('opt.json'))
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const option: 'home' | 'away' | undefined = opts.home ? 'home' : opts.away ? 'away' : undefined;
      const page = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status(t('status.loadingTable'));
        const data = await fetchTable(page, community, option);
        statusClear();

        if (opts.json) emitJson({ community, option: option ?? null, data });
        else console.log(render(data.label, data.teams));
      } finally {
        await page.close();
      }
    });
}
