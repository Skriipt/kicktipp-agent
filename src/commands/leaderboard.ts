import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode, widest } from '../helpers/output.js';
import { localizeMatchDates, localizePrintedDate } from '../helpers/match-date.js';
import { fetchLeaderboard, type LeaderboardData } from '../core.js';
import { t } from '../i18n/index.js';

function render(data: LeaderboardData, bonus: boolean): string {
  const lines: string[] = [];
  if (data.title) lines.push(data.title, '');

  if (bonus && data.bonusQuestions?.length) {
    const qWidth = widest(data.bonusQuestions.map((q) => q.question), 8);
    for (const q of data.bonusQuestions) {
      lines.push(`  ${q.abbreviation.padEnd(6)} ${q.question.padEnd(qWidth)}  ${q.result}`);
    }
    lines.push('');
  } else if (data.matches?.length) {
    const homeWidth = widest(data.matches.map((m) => m.home));
    const awayWidth = widest(data.matches.map((m) => m.away));
    for (const m of data.matches) {
      lines.push(
        `  ${localizePrintedDate(m.date).padEnd(17)} ${m.home.padStart(homeWidth)} vs ${m.away.padEnd(awayWidth)}  ${m.result}`,
      );
    }
    lines.push('');
  }

  if (!data.rankings.length) {
    lines.push(t('common.noRankings'));
    return lines.join('\n');
  }

  const nameWidth = widest(data.rankings.map((r) => r.name), 4);
  lines.push(
    `  ${'Pos'.padEnd(5)} ${'Name'.padEnd(nameWidth)} ${'MD'.padStart(5)} ${'Bonus'.padStart(6)} ${'Total'.padStart(6)}`,
  );
  lines.push(`  ${'-'.repeat(nameWidth + 27)}`);
  for (const r of data.rankings) {
    const marker = r.isCurrentPlayer ? ' <' : '';
    lines.push(
      `  ${r.position.padEnd(5)} ${r.name.padEnd(nameWidth)} ${r.matchdayPoints.padStart(5)} ` +
        `${r.bonus.padStart(6)} ${r.total.padStart(6)}${marker}`,
    );
  }
  return lines.join('\n');
}

export function registerLeaderboardCommand(program: Command): void {
  program
    .command('leaderboard')
    .description(t('cmd.leaderboard.description'))
    .option('--matchday <n>', t('opt.matchday'), parseInt)
    .option('--bonus', t('opt.bonusLeaderboard'))
    .option('--json', t('opt.json'))
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const page = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        const bonus = !!opts.bonus;
        status(t('status.loadingLeaderboard'));
        const data = await fetchLeaderboard(page, community, opts.matchday, bonus);
        statusClear();

        if (opts.json) {
          const payload = data.matches
            ? { ...data, matches: localizeMatchDates(data.matches) }
            : data;
          emitJson({ community, matchday: opts.matchday ?? null, bonus, data: payload });
        }
        else console.log(render(data, bonus));
      } finally {
        await page.close();
      }
    });
}
