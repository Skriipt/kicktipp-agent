import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity, ask } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { escapeCssValue } from '../helpers/escape-css-value.js';
import { assertWritable } from '../read-only.js';
import {
  fetchBonusQuestions,
  loadMatchPredictPage,
  placeBets,
  placeBonusBets,
  type BonusQuestion,
} from '../core.js';
import { appendAudit } from '../audit/log.js';
import { inheritPrintedDate, localizePrintedDate } from '../helpers/match-date.js';
import { runBettingTui } from '../tui/run.js';
import { t } from '../i18n/index.js';

// ── Match betting helpers ──────────────────────────────────────────

async function interactiveMatchBets(page: any, community: string, matchday?: number): Promise<void> {
  status(t('status.loadingBets'));
  const $ = await loadMatchPredictPage(page, community, matchday);
  statusClear();
  const content = $('#kicktipp-content');

  const titleDiv = content.find('div.pagetitle');
  if (titleDiv.length) console.log(titleDiv.text().trim());
  console.log();

  const tbody = content.find('tbody');
  if (!tbody.length) {
    console.log(t('common.noMatches'));
    return;
  }

  interface EditableRow {
    date: string;
    home: string;
    away: string;
    current: string;
    heimName: string;
    gastName: string;
  }
  const editable: EditableRow[] = [];
  let lastDate = '';

  tbody.find('tr').each((_, tr) => {
    const cols = $(tr).find('td');
    if (cols.length < 5) return;
    const betTd = $(cols[3]);
    if (betTd.hasClass('nichttippbar')) return;
    const heimInput = betTd.find('input[id$="_heimTipp"]');
    const gastInput = betTd.find('input[id$="_gastTipp"]');
    if (!heimInput.length || !gastInput.length) return;
    const date = inheritPrintedDate($(cols[0]).text(), lastDate);
    lastDate = date;
    const home = $(cols[1]).text().trim();
    const away = $(cols[2]).text().trim();
    const currentH = heimInput.attr('value') || '';
    const currentG = gastInput.attr('value') || '';
    const current =
      currentH && currentG ? `${currentH}:${currentG}` : '';
    editable.push({
      date,
      home,
      away,
      current,
      heimName: heimInput.attr('name')!,
      gastName: gastInput.attr('name')!,
    });
  });

  if (!editable.length) {
    console.log(t('bet.noEditable'));
    return;
  }

  const chosen: string[] = [];
  for (const row of editable) {
    let prompt = `  ${localizePrintedDate(row.date)} ${row.home} vs ${row.away} `;
    if (row.current) prompt += `[${row.current}] `;
    prompt += t('bet.promptSkip');
    const answer = (await ask(prompt)).trim();
    if (!answer) continue;
    const parts = answer.replace('-', ':').split(':');
    if (parts.length !== 2) {
      console.log(t('bet.invalidFormat'));
      continue;
    }
    const h = parseInt(parts[0]);
    const g = parseInt(parts[1]);
    if (isNaN(h) || isNaN(g)) {
      console.log(t('bet.invalidFormat'));
      continue;
    }
    chosen.push(`${row.home} vs ${row.away}=${h}:${g}`);
  }

  if (!chosen.length) {
    console.log('\n' + t('common.noChanges'));
    return;
  }

  // Same submission path as the non-interactive form, so the log records it.
  await placeBets(page, community, chosen, matchday, true, 'cli:bet');
  console.log('\n' + t('common.betsSaved'));
}

async function fixtureBets(page: any, community: string, bets: string[], matchday?: number): Promise<void> {
  // Delegates to core.placeBets rather than repeating its fixture matching
  // and form filling, so this path is validated and audited like every other.
  status(t('status.loadingBets'));
  const placed = await placeBets(page, community, bets, matchday, true, 'cli:bet');
  statusClear();
  for (const bet of placed) {
    console.log(`  ${bet.home} vs ${bet.away} - ${bet.homeGoals}:${bet.awayGoals}`);
  }
  console.log('\n' + t('common.betsSaved'));
}

// ── Bonus betting helpers ──────────────────────────────────────────

async function bonusBetsInteractive(
  page: any,
  questions: BonusQuestion[],
): Promise<{ question: string; answer: string }[]> {
  const applied: { question: string; answer: string }[] = [];
  for (const q of questions) {
    console.log(`\n  ${q.question}`);

    for (let si = 0; si < q.selects.length; si++) {
      const sel = q.selects[si];
      const currentOption = sel.options.find(
        (o) => o.value === sel.selected,
      );
      const currentText = currentOption ? currentOption.text : '---';

      if (q.selects.length > 1) {
        console.log(t('bet.slot', { n: si + 1, total: q.selects.length }));
      }
      sel.options.forEach((o, i) =>
        console.log(`    [${i + 1}] ${o.text}`),
      );

      let prompt = t('bet.select');
      if (currentText !== '---') prompt += ` [${currentText}]`;
      prompt += t('bet.selectSkip');
      const answer = (await ask(prompt)).trim();

      if (!answer) continue;
      const idx = parseInt(answer) - 1;
      if (isNaN(idx) || idx < 0 || idx >= sel.options.length) {
        console.log(t('bet.invalidSkip'));
        continue;
      }

      await page.selectOption(
        `select[name="${escapeCssValue(sel.name)}"]`,
        sel.options[idx].value,
      );
      console.log(`    → ${sel.options[idx].text}`);
      applied.push({ question: q.question, answer: sel.options[idx].text });
    }
  }
  return applied;
}

async function bonusBets(page: any, community: string, bets: string[]): Promise<void> {
  if (bets && bets.length > 0) {
    status(t('status.loadingBonus'));
    const applied = await placeBonusBets(page, community, bets, true, 'cli:bet');
    statusClear();
    for (const a of applied) console.log(`  ${a.question} → ${a.answer}`);
    console.log('\n' + t('common.bonusSaved'));
    return;
  }

  status(t('status.loadingBonus'));
  const questions = await fetchBonusQuestions(page, community);
  statusClear();

  if (!questions.length) {
    console.log(t('bet.noBonus'));
    return;
  }

  const applied = await bonusBetsInteractive(page, questions);
  if (!applied.length) {
    console.log('\n' + t('common.noChanges'));
    return;
  }

  const record = {
    at: new Date().toISOString(),
    source: 'cli:bet' as const,
    community,
    matchday: null,
    kind: 'bonus' as const,
    dryRun: false,
    bets: applied.map((a) => ({ fixture: a.question, bet: a.answer, previous: null })),
  };
  appendAudit({ ...record, outcome: 'intent' });
  try {
    await page.click('button[name="submitbutton"]');
  } catch (err) {
    appendAudit({
      ...record,
      at: new Date().toISOString(),
      outcome: `failed:${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }
  appendAudit({ ...record, at: new Date().toISOString(), outcome: 'submitted' });
  console.log('\n' + t('common.bonusSaved'));
}

// ── Command registration ───────────────────────────────────────────

export function registerBetCommand(program: Command): void {
  program
    .command('bet')
    .description(t('cmd.bet.description'))
    .argument('[bets...]', t('cmd.bet.argument'))
    .option('--matchday <n>', t('opt.matchday'), parseInt)
    .option('--bonus', t('opt.bonusBet'))
    .option('--tui', t('opt.tui'))
    .option('--no-tui', t('opt.noTui'))
    .action(async (bets: string[], opts) => {
      assertWritable('Placing bets');

      // The full-screen view is for interactive match betting only: with
      // fixtures given as arguments there is nothing to navigate, and it
      // needs a real terminal to read keys from.
      const wantsTui = opts.tui !== false && !opts.bonus && (!bets || bets.length === 0);
      if (wantsTui && (opts.tui === true || (process.stdin.isTTY && process.stdout.isTTY))) {
        await runBettingTui({ matchday: opts.matchday });
        return;
      }
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        if (opts.bonus) {
          await bonusBets(page, community, bets);
        } else if (bets && bets.length > 0) {
          await fixtureBets(page, community, bets, opts.matchday);
        } else {
          await interactiveMatchBets(page, community, opts.matchday);
        }
      } finally {
        await page.close();
      }
    });
}
