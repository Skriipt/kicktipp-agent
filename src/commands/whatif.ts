import { Command } from 'commander';
import { loadCommunity, loadPlayer } from '../config.js';
import { CacheStore } from '../cache/store.js';
import { loadSeason } from '../analytics/season.js';
import { replaySeason, REPLAY_STRATEGIES, type ReplayResult } from '../analytics/replay.js';
import { resolveRulesFromCache } from '../rules/resolve.js';
import { emitJson, setJsonMode } from '../helpers/output.js';

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
    .description('Replay the cached season under a different betting strategy')
    .argument(
      '<strategy>',
      `A scoreline like 2:1, one of ${REPLAY_STRATEGIES.join(', ')}, or suggest:safe|ev|contrarian`,
    )
    .option('--player <name>', 'Player to replay (default: your saved player)')
    .option('--json', 'Output raw JSON')
    .action((strategy: string, opts) => {
      if (opts.json) setJsonMode(true);

      const community = loadCommunity();
      if (!community) {
        console.error('No community set. Run `kicktipp set-community` first.');
        process.exit(1);
      }
      const ownPlayer = loadPlayer();
      const player = opts.player ?? ownPlayer;
      if (!player) {
        console.error('No player set. Run `kicktipp set-player`, or pass --player.');
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
