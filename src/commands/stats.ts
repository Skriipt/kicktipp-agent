import { Command } from 'commander';
import { loadPlayer } from '../config.js';
import { CacheStore } from '../cache/store.js';
import { loadSeason } from '../analytics/season.js';
import { computeSeasonStats, type SeasonStats } from '../analytics/season-stats.js';
import { resolveRulesFromCache } from '../rules/resolve.js';
import { t } from '../i18n/index.js';
import { requireCommunity } from '../shared.js';

const BAR = '█';

function bar(value: number, max: number, width = 18): string {
  if (max <= 0 || value <= 0) return '';
  return BAR.repeat(Math.max(1, Math.round((value / max) * width)));
}

function pct(value: number | null): string {
  return value === null ? '   – ' : `${(value * 100).toFixed(0).padStart(3)}%`;
}

function num(value: number | null, digits = 1): string {
  return value === null ? '–' : value.toFixed(digits);
}

function render(stats: SeasonStats, rulesNote: string | undefined): string {
  const lines: string[] = [];
  const { form, breakdown, betProfile, consistency, completeness } = stats;

  lines.push(`Season stats — ${stats.player} in ${stats.community}`);
  lines.push(
    `Based on ${completeness.withLeaderboard} matchday(s) with a leaderboard` +
      `, ${completeness.withBets} with ${stats.player}'s bets` +
      (completeness.knownMatchdays ? ` (season has ${completeness.knownMatchdays} so far)` : '') +
      '.',
  );
  if (completeness.cachedMatchdays === 0) {
    lines.push('\nNothing cached yet — run `kicktipp sync` first.');
    return lines.join('\n');
  }
  lines.push('');

  if (form.length) {
    const maxPoints = Math.max(...form.map((f) => f.points ?? 0), 1);
    lines.push('Form');
    for (const point of form) {
      const avg = point.leagueAverage === null ? '' : ` (avg ${num(point.leagueAverage)})`;
      const rank = point.rank === null ? '' : `  #${point.rank}`;
      lines.push(
        `  MD${String(point.matchday).padStart(2)}  ${String(point.points ?? '–').padStart(3)}  ` +
          `${bar(point.points ?? 0, maxPoints)}${avg}${rank}`,
      );
    }
    lines.push('');
  }

  if (stats.biggestClimb || stats.biggestDrop) {
    if (stats.biggestClimb) {
      const c = stats.biggestClimb;
      lines.push(`Best climb   MD${c.matchday}: #${c.from} → #${c.to} (+${c.delta})`);
    }
    if (stats.biggestDrop) {
      const d = stats.biggestDrop;
      lines.push(`Worst drop   MD${d.matchday}: #${d.from} → #${d.to} (${d.delta})`);
    }
    lines.push('');
  }

  if (breakdown.scored) {
    lines.push(`Hit types (${breakdown.scored} matches, ${breakdown.points} points)`);
    const rows: [string, number][] = [
      ['Exact result', breakdown.exact],
      ['Goal difference', breakdown.goalDiff],
      ['Tendency only', breakdown.tendency],
      ['Missed', breakdown.miss],
    ];
    const max = Math.max(...rows.map(([, n]) => n), 1);
    for (const [label, count] of rows) {
      const share = breakdown.scored ? count / breakdown.scored : 0;
      lines.push(`  ${label.padEnd(16)} ${String(count).padStart(3)}  ${pct(share)}  ${bar(count, max)}`);
    }
    lines.push('');

    lines.push(`${stats.player}'s predictions vs. what happened`);
    lines.push(
      `  Home wins      ${pct(betProfile.predicted.home)} predicted   ${pct(betProfile.actual.home)} actual`,
    );
    lines.push(
      `  Draws          ${pct(betProfile.predicted.draw)} predicted   ${pct(betProfile.actual.draw)} actual`,
    );
    lines.push(
      `  Away wins      ${pct(betProfile.predicted.away)} predicted   ${pct(betProfile.actual.away)} actual`,
    );
    lines.push(
      `  Goals/match    ${num(betProfile.averagePredictedGoals, 2)} predicted   ` +
        `${num(betProfile.averageActualGoals, 2)} actual`,
    );
    if (betProfile.favouriteScoreline) {
      lines.push(`  Go-to scoreline ${betProfile.favouriteScoreline}`);
    }
    lines.push('');
  }

  if (consistency.mean !== null) {
    lines.push('Consistency');
    lines.push(`  Average        ${num(consistency.mean, 2)} points/matchday`);
    lines.push(`  Swing (σ)      ${num(consistency.standardDeviation, 2)}`);
    if (consistency.best) lines.push(`  Best           MD${consistency.best.matchday} (${consistency.best.points})`);
    if (consistency.worst) lines.push(`  Worst          MD${consistency.worst.matchday} (${consistency.worst.points})`);
    if (consistency.belowAverageShare !== null) {
      lines.push(`  Below league   ${pct(consistency.belowAverageShare)} of matchdays`);
    }
    lines.push('');
  }

  lines.push(
    `Scoring: ${stats.rulesUsed.exact}/${stats.rulesUsed.goalDiff}/${stats.rulesUsed.tendency} ` +
      '(exact/difference/tendency)' + (rulesNote ? ` — ${rulesNote}` : ''),
  );
  return lines.join('\n');
}

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description(t('cmd.stats.description'))
    .option('--player <name>', t('opt.player'))
    .option('--compare <name>', t('cmd.stats.optionCompare'))
    .option('--offline', t('opt.offlineStats'))
    .option('--json', t('opt.json'))
    .action((opts) => {
      const community = requireCommunity();

      const player = opts.player ?? loadPlayer();
      if (!player) {
        console.error(t('common.noPlayerOrPass'));
        process.exit(1);
      }

      const store = new CacheStore(community);
      const season = loadSeason(store);
      const rules = resolveRulesFromCache(store);

      // The cached bets page holds only the account owner's predictions, so
      // stats for anyone else must come from the per-player grid.
      const ownPlayer = loadPlayer();
      const primary = computeSeasonStats(season, player, rules.values, ownPlayer);
      const compare = opts.compare
        ? computeSeasonStats(season, opts.compare, rules.values, ownPlayer)
        : null;

      if (opts.json) {
        console.log(JSON.stringify({ rules, stats: primary, compare }, null, 2));
        return;
      }

      console.log(render(primary, rules.warning));
      if (compare) {
        console.log('\n' + '─'.repeat(60) + '\n');
        console.log(render(compare, rules.warning));
      }
    });
}
