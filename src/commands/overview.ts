import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode, widest } from '../helpers/output.js';
import { fetchOverview, OVERVIEW_VIEW_OPTIONS, type OverviewData } from '../core.js';

function render(data: OverviewData): string {
  const lines = [`Overview: ${data.label}`, ''];
  if (!data.players.length) return lines.concat('No data found.').join('\n');

  const nameWidth = widest(data.players.map((p) => p.name), 4);
  const matchdays = Array.from({ length: data.maxMatchday }, (_, i) => i + 1);

  let header = `  ${'Pos'.padEnd(5)} ${'Name'.padEnd(nameWidth)}`;
  for (const md of matchdays) header += ` ${String(md).padStart(3)}`;
  header += `  ${'B'.padStart(3)} ${'W'.padStart(4)} ${'T'.padStart(5)}`;
  lines.push(header, `  ${'-'.repeat(header.length - 2)}`);

  for (const p of data.players) {
    const marker = p.isCurrentPlayer ? ' <' : '';
    let line = `  ${p.position.padEnd(5)} ${p.name.padEnd(nameWidth)}`;
    for (const md of matchdays) line += ` ${(p.matchdays[md] || '').padStart(3)}`;
    line += `  ${p.bonus.padStart(3)} ${p.wins.padStart(4)} ${p.total.padStart(5)}${marker}`;
    lines.push(line);
  }
  return lines.join('\n');
}

export function registerOverviewCommand(program: Command): void {
  program
    .command('overview')
    .description('Display the season overview')
    .option('--view <value>', `View type: ${OVERVIEW_VIEW_OPTIONS.join(', ')}`, 'matchday-points')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status('Loading overview...');
        const data = await fetchOverview(page, community, opts.view);
        statusClear();

        if (opts.json) emitJson({ community, view: opts.view, data });
        else console.log(render(data));
      } finally {
        await page.close();
      }
    });
}
