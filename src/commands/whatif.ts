import { Command } from 'commander';
import { loadCommunity, loadPlayer } from '../config.js';
import { CacheStore } from '../cache/store.js';
import { loadSeason } from '../analytics/season.js';
import { replaySeason, REPLAY_STRATEGIES, type ReplayResult } from '../analytics/replay.js';
import { resolveRulesFromCache } from '../rules/resolve.js';
import { emitJson, setJsonMode } from '../helpers/output.js';
import { t } from '../i18n/index.js';

function render(result: ReplayResult, baseline: ReplayResult | null): string {
  const lines = [
    `What if ${result.player} had played "${result.strategy}"?`,
    `Replayed ${result.matchesScored} match(es) across ${result.matchdays.length} matchday(s).`,
    '',
  ];

  if (!result.matchdays.length) {
    lines.push('Nothing to replay — run `kicktipp sync` first.');
    return lines.join('\n');
  }

  lines.push(`  ${'MD'.padStart(4)} ${'Strategy'.padStart(9)} ${'Actual'.padStart(7)}`);
  for (const md of result.matchdays) {
    lines.push(
      `  ${String(md.matchday).padStart(4)} ${String(md.points).padStart(9)} ` +
        `${(md.actualPoints ?? '–').toString().padStart(7)}`,
    );
  }

  lines.push('');
  lines.push(`Total under "${result.strategy}": ${result.total}`);
  if (result.actualTotal !== null) {
    const delta = result.delta as number;
    lines.push(
      `Actually scored: ${result.actualTotal} ` +
        `(${delta > 0 ? `+${delta} better` : delta < 0 ? `${delta} worse` : 'identical'})`,
    );
  }
  if (baseline && baseline.strategy !== result.strategy) {
    lines.push(`Baseline "${baseline.strategy}": ${baseline.total}`);
  }
  if (result.finalRank !== null) lines.push(`Estimated rank: #${result.finalRank}`);
  if (result.rankNote) lines.push(`\n${result.rankNote}`);
  return lines.join('\n');
}

export function registerWhatifCommand(program: Command): void {
  program
    .command('whatif')
    .description(t('cmd.whatif.description'))
    .argument(
      '<strategy>',
      t('cmd.whatif.argument', { strategies: REPLAY_STRATEGIES.join(', ') }),
    )
    .option('--player <name>', t('opt.playerReplay'))
    .option('--json', t('opt.json'))
    .action((strategy: string, opts) => {
      if (opts.json) setJsonMode(true);

      const community = loadCommunity();
      if (!community) {
        console.error(t('common.noCommunity'));
        process.exit(1);
      }
      const ownPlayer = loadPlayer();
      const player = opts.player ?? ownPlayer;
      if (!player) {
        console.error(t('common.noPlayerOrPass'));
        process.exit(1);
      }

      const store = new CacheStore(community);
      const season = loadSeason(store);
      const rules = resolveRulesFromCache(store);

      const result = replaySeason(season, player, rules.values, strategy, ownPlayer);
      // "actual" is the natural baseline to compare any strategy against.
      const baseline =
        strategy === 'actual'
          ? null
          : replaySeason(season, player, rules.values, 'actual', ownPlayer);

      if (opts.json) emitJson({ community, rules, result, baseline });
      else console.log(render(result, baseline));
    });
}
