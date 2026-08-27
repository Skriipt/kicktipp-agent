import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { fetchTipStatus, TipStatusKind } from '../tip-status.js';
import { status, statusClear } from '../helpers/spinner.js';

const STATUS_LABELS: Record<TipStatusKind, string> = {
  complete: 'vollständig',
  partial: 'teilweise',
  missing: 'nicht getippt',
};

const STATUS_ICONS: Record<TipStatusKind, string> = {
  complete: '✅',
  partial: '⚠️',
  missing: '❌',
};

export function registerTipStatusCommand(program: Command): void {
  program
    .command('tip-status')
    .description('Show who has fully, partially, or not yet tipped')
    .option('--matchday <n>', 'Matchday number (1-34)')
    .action(async (opts) => {
      const matchday =
        opts.matchday === undefined
          ? undefined
          : Number.parseInt(opts.matchday, 10);

      if (
        matchday !== undefined &&
        (!Number.isInteger(matchday) || matchday < 1 || matchday > 34)
      ) {
        console.error(
          `The matchday '${opts.matchday}' is not valid, use only 1 to 34!`,
        );
        process.exitCode = 1;
        return;
      }

      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status('Loading tip status...');
        const data = await fetchTipStatus(page, community, matchday);
        statusClear();

        console.log(data.title || 'Tippstatus');
        console.log();

        if (!data.players.length) {
          console.log('Keine Tippstatus-Daten gefunden.');
          return;
        }

        const nameWidth = Math.max(
          ...data.players.map((player) => player.name.length),
        );

        for (const player of data.players) {
          const count = `${player.tipped}/${player.total}`;
          console.log(
            `  ${STATUS_ICONS[player.status]} ${player.name.padEnd(nameWidth)} ${count.padStart(5)}  ${STATUS_LABELS[player.status]}`,
          );
        }

        console.log();
        console.log(
          `${data.summary.complete} vollständig · ` +
            `${data.summary.partial} teilweise · ` +
            `${data.summary.missing} nicht getippt`,
        );
      } finally {
        statusClear();
        await browser.close();
      }
    });
}
