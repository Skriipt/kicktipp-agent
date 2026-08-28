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

// ── Match betting helpers ──────────────────────────────────────────

async function interactiveMatchBets(page: any, community: string, matchday?: number): Promise<void> {
  status('Loading bets...');
  const $ = await loadMatchPredictPage(page, community, matchday);
  statusClear();
  const content = $('#kicktipp-content');

  const titleDiv = content.find('div.pagetitle');
  if (titleDiv.length) console.log(titleDiv.text().trim());
  console.log();

  const tbody = content.find('tbody');
  if (!tbody.length) {
    console.log('No matches found.');
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
    console.log('No editable matches found.');
    return;
  }

  const chosen: string[] = [];
  for (const row of editable) {
    let prompt = `  ${localizePrintedDate(row.date)} ${row.home} vs ${row.away} `;
    if (row.current) prompt += `[${row.current}] `;
    prompt += '(e.g. 2:1, Enter to skip): ';
    const answer = (await ask(prompt)).trim();
    if (!answer) continue;
    const parts = answer.replace('-', ':').split(':');
    if (parts.length !== 2) {
      console.log('    Invalid format, skipping.');
      continue;
    }
    const h = parseInt(parts[0]);
    const g = parseInt(parts[1]);
    if (isNaN(h) || isNaN(g)) {
      console.log('    Invalid format, skipping.');
      continue;
    }
    chosen.push(`${row.home} vs ${row.away}=${h}:${g}`);
  }

  if (!chosen.length) {
    console.log('\nNo changes made.');
    return;
  }

  // Same submission path as the non-interactive form, so the log records it.
  await placeBets(page, community, chosen, matchday, true, 'cli:bet');
  console.log('\nBets saved.');
}

async function fixtureBets(page: any, community: string, bets: string[], matchday?: number): Promise<void> {
  // Delegates to core.placeBets rather than repeating its fixture matching
  // and form filling, so this path is validated and audited like every other.
  status('Loading bets...');
  const placed = await placeBets(page, community, bets, matchday, true, 'cli:bet');
  statusClear();
  for (const bet of placed) {
    console.log(`  ${bet.home} vs ${bet.away} - ${bet.homeGoals}:${bet.awayGoals}`);
  }
  console.log('\nBets saved.');
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
        console.log(`    Slot ${si + 1}/${q.selects.length}:`);
      }
      sel.options.forEach((o, i) =>
        console.log(`    [${i + 1}] ${o.text}`),
      );

      let prompt = `    Select`;
      if (currentText !== '---') prompt += ` [${currentText}]`;
      prompt += ' (Enter to skip): ';
      const answer = (await ask(prompt)).trim();

      if (!answer) continue;
      const idx = parseInt(answer) - 1;
      if (isNaN(idx) || idx < 0 || idx >= sel.options.length) {
        console.log('    Invalid selection, skipping.');
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
    status('Loading bonus questions...');
    const applied = await placeBonusBets(page, community, bets, true, 'cli:bet');
    statusClear();
    for (const a of applied) console.log(`  ${a.question} → ${a.answer}`);
    console.log('\nBonus bets saved.');
    return;
  }

  status('Loading bonus questions...');
  const questions = await fetchBonusQuestions(page, community);
  statusClear();

  if (!questions.length) {
    console.log('No editable bonus questions found.');
    return;
  }

  const applied = await bonusBetsInteractive(page, questions);
  if (!applied.length) {
    console.log('\nNo changes made.');
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
  console.log('\nBonus bets saved.');
}

// ── Command registration ───────────────────────────────────────────

export function registerBetCommand(program: Command): void {
  program
    .command('bet')
    .description(
      'Place bets. Interactive if no args, or pass "Home vs Away=H:G" args. Use --bonus for bonus questions.',
    )
    .argument('[bets...]', 'Bets: "Home vs Away=H:G" or with --bonus "Question=Answer"')
    .option('--matchday <n>', 'Matchday number (1-34)', parseInt)
    .option('--bonus', 'Place bonus question bets')
    .option('--tui', 'Full-screen matchday view (default on an interactive terminal)')
    .option('--no-tui', 'Force the line-by-line prompts instead')
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
