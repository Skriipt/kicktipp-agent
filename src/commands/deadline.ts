import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode } from '../helpers/output.js';
import { fetchBets } from '../core.js';
import { buildDeadlineReport, type DeadlineReport } from '../analytics/deadline.js';
import { humanDelta } from '../helpers/match-date.js';
import { t } from '../i18n/index.js';

/** `--check` exits with this when something still needs a bet, for cron. */
export const EXIT_URGENT = 2;

function render(report: DeadlineReport): string {
  const lines: string[] = [];
  const md = report.matchday ? ` (matchday ${report.matchday})` : '';
  lines.push(`Deadlines for ${report.community}${md}`);

  if (!report.matches.length) {
    lines.push(t('common.noMatches'));
    return lines.join('\n');
  }

  lines.push(
    report.nextKickoff
      ? `Next kickoff ${report.nextKickoffIn} (${new Date(report.nextKickoff).toLocaleString(undefined, { timeZone: report.timeZone })})`
      : 'Every match has kicked off.',
  );
  lines.push('');

  const now = new Date(report.now);
  for (const match of report.matches) {
    const fixture = `${match.home} vs ${match.away}`;
    const when = match.kickoff ? humanDelta(now, new Date(match.kickoff)) : 'unknown time';
    const state = match.closed
      ? 'closed'
      : match.needsBet
        ? match.urgent
          ? 'NO BET — soon'
          : 'no bet'
        : `bet ${match.bet}`;
    lines.push(`  ${fixture.padEnd(34)} ${when.padEnd(14)} ${state}`);
  }

  lines.push('');
  lines.push(
    report.needsBetCount
      ? `${report.needsBetCount} of ${report.openCount} open match(es) still need a bet` +
          (report.urgentCount ? `, ${report.urgentCount} within ${report.warnHours}h.` : '.')
      : 'All open matches have a bet.',
  );
  lines.push(`Times shown in ${report.timeZone} (set KICKTIPP_TZ to override).`);
  return lines.join('\n');
}

export function registerDeadlineCommand(program: Command): void {
  program
    .command('deadline')
    .description(t('cmd.deadline.description'))
    .option('--matchday <n>', t('opt.matchday'), parseInt)
    .option(
      '--warn-hours <n>',
      t('opt.warnHours'),
      parseFloat,
    )
    .option(
      '--check',
      t('opt.check'),
    )
    .option('--json', t('opt.json'))
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status(t('status.checkingDeadlines'));
        const { matches } = await fetchBets(page, community, opts.matchday);
        statusClear();

        const report = buildDeadlineReport(community, opts.matchday ?? null, matches, {
          warnHours: opts.warnHours,
        });

        if (opts.json) emitJson(report);
        else if (!opts.check) console.log(render(report));
        else if (report.urgentCount) {
          console.log(
            t('deadline.urgent', {
              n: report.urgentCount,
              hours: report.warnHours,
              when: report.nextKickoffIn ?? '',
            }),
          );
        }

        if (opts.check && report.urgentCount) process.exitCode = EXIT_URGENT;
      } finally {
        await page.close();
      }
    });
}
