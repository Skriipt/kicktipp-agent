import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity, ask } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { CacheStore } from '../cache/store.js';
import { fetchBets, placeBets } from '../core.js';
import { resolveRules } from '../rules/resolve.js';
import { toOddsMatches } from '../analytics/odds.js';
import { STRATEGIES, suggestBets, type StrategyName, type SuggestedBet } from '../analytics/strategies.js';
import { offlineMatchday, requireCached } from '../cache/offline.js';
import { resolveRulesFromCache } from '../rules/resolve.js';
import { loadCommunity } from '../config.js';
import { assertWritable } from '../read-only.js';

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
    const marker = s.existingBet ? ' (already bet ' + s.existingBet + ')' : '';
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
    .description('Suggest a bet slip from the published odds (prints only unless --place)')
    .option('--strategy <name>', `One of: ${STRATEGIES.join(', ')}`, 'safe')
    .option('--matchday <n>', 'Matchday number (1-34). Omit for the current one.', parseInt)
    .option('--place', 'Submit the slip after confirmation')
    .option('--replace', 'Also overwrite matches that already have a bet')
    .option('--yes', 'Skip the confirmation prompt (for scripts)')
    .option('--offline', 'Use only cached data; make no requests (implies no --place)')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      if (opts.place) assertWritable('Placing bets');
      const strategy = opts.strategy as StrategyName;
      if (!STRATEGIES.includes(strategy)) {
        console.error(`Unknown strategy '${strategy}'. Options: ${STRATEGIES.join(', ')}`);
        process.exit(1);
      }

      if (opts.offline) {
        if (opts.place) {
          console.error('--offline cannot be combined with --place.');
          process.exit(1);
        }
        const community = loadCommunity();
        if (!community) {
          console.error('No community set. Run `kicktipp set-community` first.');
          process.exit(1);
        }
        const store = new CacheStore(community);
        const matchday = offlineMatchday(store, opts.matchday);
        const { matches } = requireCached(store, 'bets', matchday);
        const rules = resolveRulesFromCache(store);
        const suggestions = suggestBets(toOddsMatches(matches), rules.values, strategy);
        if (opts.json) console.log(JSON.stringify({ strategy, rules, suggestions }, null, 2));
        else console.log(render(suggestions, strategy, rules.warning));
        return;
      }

      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        const store = new CacheStore(community);
        const cache = { store };

        status('Loading odds...');
        const { matches } = await fetchBets(page, community, opts.matchday, cache);
        const rules = await resolveRules(page, community, cache);
        statusClear();

        if (!matches.length) {
          console.log('No matches found for this matchday.');
          return;
        }

        const suggestions = suggestBets(toOddsMatches(matches), rules.values, strategy);

        if (opts.json) {
          console.log(JSON.stringify({ strategy, rules, suggestions }, null, 2));
          return;
        }

        console.log(render(suggestions, strategy, rules.warning));
        if (!opts.place) return;

        // Matches that already carry a bet are left alone unless asked for.
        const toPlace = opts.replace ? suggestions : suggestions.filter((s) => !s.existingBet);
        const skipped = suggestions.length - toPlace.length;

        if (!toPlace.length) {
          console.log('\nEvery match already has a bet. Use --replace to overwrite them.');
          return;
        }

        console.log(
          `\nAbout to submit ${toPlace.length} bet(s)` +
            (skipped ? `, leaving ${skipped} existing bet(s) untouched` : '') +
            '.',
        );

        if (!opts.yes) {
          const answer = (await ask('Submit these bets? [y/N]: ')).trim().toLowerCase();
          if (answer !== 'y' && answer !== 'yes') {
            console.log('Nothing submitted.');
            return;
          }
        }

        const args = toPlace.map((s) => `${s.home} vs ${s.away}=${s.bet}`);
        const placed = await placeBets(page, community, args, opts.matchday, true);
        console.log(`Submitted ${placed.length} bet(s).`);
      } finally {
        await page.close();
      }
    });
}
