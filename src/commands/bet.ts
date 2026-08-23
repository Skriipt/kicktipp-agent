import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser } from '../browser.js';
import { getBonusPredictUrl, getPredictUrl } from '../url.js';
import { ensureCommunity, ask } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import {
  parseBetArg,
  matchFixture,
  EditableMatch,
} from '../helpers/parse-bet-arg.js';
import { escapeCssValue } from '../helpers/escape-css-value.js';
import { assertWritable } from '../read-only.js';
import { placeBets } from '../core.js';
import { appendAudit } from '../audit/log.js';

// ── Bonus question types and helpers ───────────────────────────────

interface BonusSelect {
  name: string;
  options: { value: string; text: string }[];
  selected: string;
}

interface BonusQuestion {
  question: string;
  selects: BonusSelect[];
}

function parseBonusQuestions(
  $: cheerio.CheerioAPI,
  content: cheerio.Cheerio<any>,
): BonusQuestion[] {
  const table = content.find('table#tippabgabeFragen');
  if (!table.length) return [];
  const tbody = table.find('tbody');
  if (!tbody.length) return [];

  const questions: BonusQuestion[] = [];
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 3) return;
    const question = $(cols[1]).text().trim();
    const selectEls = $(cols[2]).find('select');
    if (!selectEls.length) return;

    const selects: BonusSelect[] = [];
    selectEls.each((_, sel) => {
      const name = $(sel).attr('name')!;
      const options: { value: string; text: string }[] = [];
      let selected = '-1';
      $(sel).find('option').each((_, opt) => {
        const value = $(opt).attr('value') || '';
        const text = $(opt).text().trim();
        if (value !== '-1') options.push({ value, text });
        if ($(opt).attr('selected') !== undefined) selected = value;
      });
      selects.push({ name, options, selected });
    });

    questions.push({ question, selects });
  });

  return questions;
}

function parseBonusBetArg(arg: string): { question: string; answer: string } {
  if (!arg.includes('=')) {
    throw new Error(
      `Invalid bonus bet '${arg}'. Use format: "Question text=Answer"`,
    );
  }
  const eqIdx = arg.lastIndexOf('=');
  const question = arg.slice(0, eqIdx).trim();
  const answer = arg.slice(eqIdx + 1).trim();
  if (!question || !answer) {
    throw new Error(
      `Invalid bonus bet '${arg}'. Both question and answer required.`,
    );
  }
  return { question, answer };
}

function findQuestion(
  questionText: string,
  questions: BonusQuestion[],
): BonusQuestion {
  const match = questions.find(
    (q) => q.question.toLowerCase() === questionText.toLowerCase(),
  );
  if (!match) {
    console.error(`No bonus question found matching: "${questionText}"`);
    console.error('Available questions:');
    questions.forEach((q) => console.error(`  - ${q.question}`));
    process.exit(1);
  }
  return match;
}

function findOption(
  answerText: string,
  select: BonusSelect,
  questionText: string,
): { value: string; text: string } {
  const match = select.options.find(
    (o) => o.text.toLowerCase() === answerText.toLowerCase(),
  );
  if (!match) {
    console.error(
      `No option "${answerText}" found for question "${questionText}"`,
    );
    console.error('Available options:');
    select.options.forEach((o) => console.error(`  - ${o.text}`));
    process.exit(1);
  }
  return match;
}

// ── Match betting helpers ──────────────────────────────────────────

async function interactiveMatchBets(page: any, community: string, matchday?: number): Promise<void> {
  status('Loading bets...');
  await page.goto(getPredictUrl(community, matchday));
  statusClear();

  const $ = cheerio.load(await page.content());
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

  tbody.find('tr').each((_, tr) => {
    const cols = $(tr).find('td');
    if (cols.length < 5) return;
    const betTd = $(cols[3]);
    if (betTd.hasClass('nichttippbar')) return;
    const heimInput = betTd.find('input[id$="_heimTipp"]');
    const gastInput = betTd.find('input[id$="_gastTipp"]');
    if (!heimInput.length || !gastInput.length) return;
    const date = $(cols[0]).text().trim();
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
    let prompt = `  ${row.date} ${row.home} vs ${row.away} `;
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

export interface AppliedBonusBet {
  question: string;
  answer: string;
}

async function bonusBetsNonInteractive(
  page: any,
  questions: BonusQuestion[],
  bets: string[],
): Promise<AppliedBonusBet[]> {
  interface ParsedBet {
    selectName: string;
    value: string;
    questionText: string;
    answerText: string;
  }
  const parsed: ParsedBet[] = [];

  const argsByQuestion = new Map<string, string[]>();
  for (const arg of bets) {
    const { question, answer } = parseBonusBetArg(arg);
    const key = question.toLowerCase();
    if (!argsByQuestion.has(key)) {
      argsByQuestion.set(key, []);
    }
    argsByQuestion.get(key)!.push(answer);
  }

  for (const [, answers] of argsByQuestion) {
    const q = findQuestion(answers[0], questions);
    const firstArg = bets.find((b) => {
      const { question } = parseBonusBetArg(b);
      return question.toLowerCase() === q.question.toLowerCase();
    })!;
    const { question: qText } = parseBonusBetArg(firstArg);

    if (answers.length > q.selects.length) {
      console.error(
        `Too many answers for "${q.question}": got ${answers.length}, max ${q.selects.length}`,
      );
      process.exit(1);
    }

    const usedValues = new Set<string>();
    for (let i = 0; i < answers.length; i++) {
      const option = findOption(answers[i], q.selects[i], q.question);
      if (usedValues.has(option.value)) {
        console.error(
          `Duplicate answer "${answers[i]}" for "${q.question}"`,
        );
        process.exit(1);
      }
      usedValues.add(option.value);
      parsed.push({
        selectName: q.selects[i].name,
        value: option.value,
        questionText: q.question,
        answerText: option.text,
      });
    }
  }

  const applied: AppliedBonusBet[] = [];
  for (const { selectName, value, questionText, answerText } of parsed) {
    console.log(`  ${questionText} → ${answerText}`);
    applied.push({ question: questionText, answer: answerText });
    await page.selectOption(`select[name="${escapeCssValue(selectName)}"]`, value);
  }
  return applied;
}

async function bonusBetsInteractive(
  page: any,
  questions: BonusQuestion[],
): Promise<AppliedBonusBet[]> {
  const applied: AppliedBonusBet[] = [];
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
  status('Loading bonus questions...');
  await page.goto(getBonusPredictUrl(community));
  statusClear();

  const $ = cheerio.load(await page.content());
  const content = $('#kicktipp-content');
  const questions = parseBonusQuestions($, content);

  if (!questions.length) {
    console.log('No editable bonus questions found.');
    return;
  }

  const applied =
    bets && bets.length > 0
      ? await bonusBetsNonInteractive(page, questions, bets)
      : await bonusBetsInteractive(page, questions);

  if (!applied.length) {
    console.log('\nNo changes made.');
    return;
  }

  // The bonus flow drives the form directly rather than going through
  // core.placeBonusBets, so it writes its own audit record.
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
    .action(async (bets: string[], opts) => {
      assertWritable('Placing bets');
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
