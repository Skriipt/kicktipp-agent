import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity, ask } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { CacheStore } from '../cache/store.js';
import { fetchBets, placeBets } from '../core.js';
import { resolveRules } from '../rules/resolve.js';
import { toOddsMatches } from '../analytics/odds.js';
import { STRATEGIES, suggestBets, type PinnedBet, type StrategyName, type SuggestedBet } from '../analytics/strategies.js';
import { offlineMatchday, requireCached } from '../cache/offline.js';
import { resolveRulesFromCache } from '../rules/resolve.js';
import { loadCommunity, readDefaultStrategy } from '../config.js';
import { t } from '../i18n/index.js';
import { assertWritable } from '../read-only.js';

/** "Bayern vs BVB=2:1" — same shape the bet command accepts. */
function parsePins(args: string[]): PinnedBet[] {
  return args.map((arg) => {
    const eq = arg.lastIndexOf('=');
    if (eq === -1) throw new Error(`Invalid --pin '${arg}'. Use "Home vs Away=H:G".`);
    const parts = arg.slice(0, eq).split(/\s+vs\.?\s+/i);
    if (parts.length !== 2) throw new Error(`Invalid --pin fixture in '${arg}'.`);
    return { home: parts[0].trim(), away: parts[1].trim(), bet: arg.slice(eq + 1).trim() };
  });
}

function render(
  suggestions: SuggestedBet[],
  strategy: StrategyName,
  rulesNote: string | undefined,
): string {
  const lines: string[] = [];
  const width = Math.max(...suggestions.map((s) => `${s.home} vs ${s.away}`.length), 10);

  lines.push(`Suggested bets — ${strategy} strategy`);
  lines.push('');
  for (const s of suggestions) {
    const marker =
      (s.pinned ? ' [pinned]' : '') +
      (s.existingBet ? ` (already bet ${s.existingBet})` : '');
    lines.push(`  ${`${s.home} vs ${s.away}`.padEnd(width)}  ${s.bet}${marker}`);
    lines.push(`  ${' '.repeat(width)}  ${s.reasoning}`);
  }

  const total = suggestions.reduce((sum, s) => sum + s.expectedPoints, 0);
  lines.push('');
  lines.push(`Expected points across the slip: ${total.toFixed(1)}`);
  if (suggestions.some((s) => s.assumed)) {
    lines.push('Some matches had no published odds; those use a generic prior.');
  }
  if (strategy === 'contrarian') {
    lines.push('Contrarian is high variance by design: it trades average points for separation.');
  }
  if (rulesNote) lines.push(rulesNote);
  lines.push('');
  lines.push('These are suggestions only. Nothing has been submitted.');
  return lines.join('\n');
}

export function registerSuggestCommand(program: Command): void {
  program
    .command('suggest')
    .description(t('cmd.suggest.description'))
    .option('--strategy <name>', t('cmd.suggest.optionStrategy', { strategies: STRATEGIES.join(', ') }))
    .option(
      '--pin <bet...>',
      t('cmd.suggest.optionPin'),
    )
    .option('--matchday <n>', t('opt.matchdayCurrent'), parseInt)
    .option('--place', t('cmd.suggest.optionPlace'))
    .option('--replace', t('cmd.suggest.optionReplace'))
    .option('--yes', t('opt.yesScripts'))
    .option('--offline', t('opt.offlineSuggest'))
    .option('--json', t('opt.json'))
    .action(async (opts) => {
      if (opts.place) assertWritable('Placing bets');
      // Explicit flag wins, then the configured default, then safe.
      const strategy = (opts.strategy ?? readDefaultStrategy() ?? 'safe') as StrategyName;
      const pins = parsePins(opts.pin ?? []);
      if (!STRATEGIES.includes(strategy)) {
        console.error(t('suggest.unknownStrategy', { name: strategy, options: STRATEGIES.join(', ') }));
        process.exit(1);
      }

      if (opts.offline) {
        if (opts.place) {
          console.error(t('suggest.offlinePlace'));
          process.exit(1);
        }
        const community = loadCommunity();
        if (!community) {
          console.error(t('common.noCommunity'));
          process.exit(1);
        }
        const store = new CacheStore(community);
        const matchday = offlineMatchday(store, opts.matchday);
        const { matches } = requireCached(store, 'bets', matchday);
        const rules = resolveRulesFromCache(store);
        const suggestions = suggestBets(toOddsMatches(matches), rules.values, strategy, pins);
        if (opts.json) console.log(JSON.stringify({ strategy, rules, suggestions }, null, 2));
        else console.log(render(suggestions, strategy, rules.warning));
        return;
      }

      const page = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        const store = new CacheStore(community);
        const cache = { store };

        status(t('status.loadingMatchday'));
        const { matches } = await fetchBets(page, community, opts.matchday, cache);
        const rules = await resolveRules(page, community, cache);
        statusClear();

        if (!matches.length) {
          console.log(t('common.noMatchesMatchday'));
          return;
        }

        const suggestions = suggestBets(toOddsMatches(matches), rules.values, strategy, pins);

        if (opts.json) {
          console.log(JSON.stringify({ strategy, rules, suggestions }, null, 2));
          return;
        }

        const note = [
          rules.warning,
          rules.confidence === 'assumed'
            ? 'Scoring values are assumed; run `kicktipp rules --verify` to check them.'
            : null,
        ]
          .filter(Boolean)
          .join(' ');
        console.log(render(suggestions, strategy, note || undefined));
        if (!opts.place) return;

        // Matches that already carry a bet are left alone unless asked for.
        const toPlace = opts.replace ? suggestions : suggestions.filter((s) => !s.existingBet);
        if (!toPlace.length) {
          console.log('\n' + t('suggest.alreadyBet'));
          return;
        }

        console.log('\n' + t('suggest.willPlace', { n: toPlace.length }));

        if (!opts.yes) {
          const answer = (await ask(t('suggest.confirm'))).trim().toLowerCase();
          if (answer !== 'y' && answer !== 'yes' && answer !== 'j' && answer !== 'ja') {
            console.log(t('common.nothingSubmitted'));
            return;
          }
        }

        const args = toPlace.map((s) => `${s.home} vs ${s.away}=${s.bet}`);
        const placed = await placeBets(page, community, args, opts.matchday, true, 'cli:suggest');
        console.log(t('common.submittedCount', { n: placed.length }));
      } finally {
        await page.close();
      }
    });
}
