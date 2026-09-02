import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { loadPlayer } from '../config.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode, widest } from '../helpers/output.js';
import { fetchLeaderboard, fetchMatchdayBets } from '../core.js';
import { CacheStore } from '../cache/store.js';
import { resolveRules } from '../rules/resolve.js';
import { t } from '../i18n/index.js';
import {
  findTargetCombinations,
  projectStandings,
  type HypotheticalResult,
  type ScenarioProjection,
} from '../analytics/scenarios.js';

/** "Bayern vs BVB=2:1" — the same shape the bet command accepts. */
function parseScenarioArg(arg: string): HypotheticalResult {
  const eq = arg.lastIndexOf('=');
  if (eq === -1) {
    throw new Error(`Invalid scenario '${arg}'. Use the form "Home vs Away=H:G".`);
  }
  const fixture = arg.slice(0, eq).trim();
  const result = arg.slice(eq + 1).trim();
  const parts = fixture.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) {
    throw new Error(`Invalid fixture '${fixture}'. Use the form "Home vs Away=H:G".`);
  }
  if (!/^\d+:\d+$/.test(result)) {
    throw new Error(`Invalid result '${result}' in '${arg}'. Use the form H:G.`);
  }
  return { home: parts[0].trim(), away: parts[1].trim(), result };
}

function render(projection: ScenarioProjection): string {
  const lines: string[] = [
    `Projected standings — matchday ${projection.matchday ?? 'current'}`,
    projection.exact
      ? `All ${projection.specified} match(es) accounted for; this projection is exact.`
      : `${projection.specified} match(es) pinned, ${projection.unspecified} open — ranks shown as a range.`,
    '',
  ];

  if (!projection.players.length) {
    lines.push(projection.note ?? 'Nothing to project.');
    return lines.join('\n');
  }

  const nameWidth = widest(projection.players.map((p) => p.player), 6);
  lines.push(`  ${'Rank'.padEnd(8)} ${'Player'.padEnd(nameWidth)} ${'Points'.padStart(12)}`);
  lines.push(`  ${'-'.repeat(nameWidth + 24)}`);

  for (const player of projection.players) {
    const rank =
      player.rankBest === player.rankWorst
        ? `#${player.rankBest}`
        : `#${player.rankBest}-${player.rankWorst}`;
    const points =
      player.totalBest === player.totalWorst
        ? String(player.totalBest)
        : `${player.totalWorst}-${player.totalBest}`;
    lines.push(`  ${rank.padEnd(8)} ${player.player.padEnd(nameWidth)} ${points.padStart(12)}`);
  }

  return lines.join('\n');
}

export function registerScenarioCommand(program: Command): void {
  program
    .command('scenario')
    .description(t('cmd.scenario.description'))
    .argument('[results...]', t('cmd.scenario.argument'))
    .option('--matchday <n>', t('opt.matchday'), parseInt)
    .option('--target <rank>', t('cmd.scenario.optionTarget'), parseInt)
    .option('--player <name>', t('opt.playerTarget'))
    .option('--json', t('opt.json'))
    .action(async (results: string[], opts) => {
      if (opts.json) setJsonMode(true);
      const supplied = (results ?? []).map(parseScenarioArg);

      const page = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        const cache = { store: new CacheStore(community) };

        status(t('status.loadingMatchday'));
        const grid = await fetchMatchdayBets(page, community, opts.matchday, cache);
        const leaderboard = await fetchLeaderboard(page, community, opts.matchday, false, cache);
        const rules = await resolveRules(page, community, cache);
        statusClear();

        if (opts.target !== undefined) {
          const player = opts.player ?? loadPlayer();
          if (!player) {
            console.error(t('common.noPlayerOrPass'));
            process.exit(1);
          }
          const search = findTargetCombinations(
            grid,
            leaderboard,
            rules.values,
            player,
            opts.target,
          );
          if (opts.json) {
            emitJson({ community, rules, search });
            return;
          }
          console.log(
            `Looking for ways ${player} reaches rank ${opts.target} ` +
              `(${search.examined} combination(s) examined)`,
          );
          if (!search.achievable) {
            console.log(search.note ?? 'Not achievable.');
            return;
          }
          for (const example of search.examples) {
            console.log(
              `  rank #${example.rank}: ` +
                example.results.map((r) => `${r.home} vs ${r.away} ${r.result}`).join(', '),
            );
          }
          console.log(
            '\nResults are representative of the outcome (home win / draw / away win), not exact scores.',
          );
          return;
        }

        const projection = projectStandings(grid, leaderboard, rules.values, supplied);
        if (opts.json) emitJson({ community, rules, projection });
        else {
          console.log(render(projection));
          if (rules.confidence === 'assumed') {
            console.log('\nScoring values are assumed; run `kicktipp rules --verify` to check them.');
          }
        }
      } finally {
        await page.close();
      }
    });
}
