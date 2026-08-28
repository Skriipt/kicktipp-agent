import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { fetchBets, placeBets } from '../core.js';
import { CacheStore } from '../cache/store.js';
import { resolveRules } from '../rules/resolve.js';
import { toOddsMatches } from '../analytics/odds.js';
import { suggestBets, type StrategyName } from '../analytics/strategies.js';
import { buildDeadlineReport } from '../analytics/deadline.js';
import { readDefaultStrategy } from '../config.js';
import { changedRows, initialState, normalizeDraft, type TuiRow } from './state.js';
import { runScreen } from './screen.js';
import { t } from '../i18n/index.js';

export interface TuiOptions {
  matchday?: number;
  strategy?: StrategyName;
}

/** Load a matchday, run the screen, and submit whatever the user settled on. */
export async function runBettingTui(opts: TuiOptions = {}): Promise<void> {
  const { page } = await launchBrowser();
  try {
    const community = await ensureCommunity(page);
    const cache = { store: new CacheStore(community) };

    status(t('status.loadingMatchday'));
    const { title, matches } = await fetchBets(page, community, opts.matchday);
    const rules = await resolveRules(page, community, cache);
    statusClear();

    if (!matches.length) {
      console.log(t('common.noMatchesMatchday'));
      return;
    }

    const strategy = (opts.strategy ?? readDefaultStrategy() ?? 'safe') as StrategyName;
    const suggestions = suggestBets(toOddsMatches(matches), rules.values, strategy);
    const deadline = buildDeadlineReport(community, opts.matchday ?? null, matches);

    const rows: TuiRow[] = matches.map((match, index) => {
      const saved = /^\d+:\d+$/.test(match.bet) ? match.bet : null;
      const closed = deadline.matches[index]?.closed ?? false;
      return {
        home: match.home,
        away: match.away,
        kickoff: deadline.matches[index]?.kickoff ?? null,
        saved,
        // Start from what is already stored, so a stray keystroke cannot
        // silently blank an existing bet.
        draft: saved ?? '',
        suggestion: suggestions[index]?.bet ?? null,
        odds: match.odds.home || null,
        editable: !closed,
      };
    });

    const finalState = await runScreen(initialState(rows), {
      title: `${title || t('tui.matchday')} — ${community}`,
      deadline: deadline.nextKickoffIn,
    });

    if (finalState.outcome !== 'submit') {
      console.log(t('common.nothingSubmitted'));
      return;
    }

    const changed = changedRows(finalState);
    if (!changed.length) {
      console.log(t('common.nothingToSubmit'));
      return;
    }

    const args = changed.map((row) => `${row.home} vs ${row.away}=${normalizeDraft(row.draft)}`);
    const placed = await placeBets(page, community, args, opts.matchday, true, 'cli:tui');
    console.log(t('common.submittedCountColon', { n: placed.length }));
    for (const bet of placed) {
      console.log(`  ${bet.home} vs ${bet.away} - ${bet.homeGoals}:${bet.awayGoals}`);
    }
  } finally {
    await page.close();
  }
}
