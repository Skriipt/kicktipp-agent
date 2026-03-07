import { Command } from 'commander';
import * as cheerio from 'cheerio';
import { launchBrowser, dismissConsent } from '../browser.js';
import { URL_BASE } from '../url.js';
import { ensureCommunity, ask } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';

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

export function registerSetBonusBetsCommand(program: Command): void {
  program
    .command('set-bonus-bets')
    .description(
      'Set bonus question answers. Interactive if no args, or pass "Question=Answer" args.',
    )
    .argument('[bets...]', 'Bets in format "Question text=Answer"')
    .action(async (bets: string[]) => {
      const { browser, page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        status('Loading bonus questions...');
        await page.goto(
          `${URL_BASE}/${community}/predict?bonus=true`,
        );
        await page.waitForLoadState('domcontentloaded');
        await dismissConsent(page);
        statusClear();

        const $ = cheerio.load(await page.content());
        const content = $('#kicktipp-content');
        const questions = parseBonusQuestions($, content);

        if (!questions.length) {
          console.log('No editable bonus questions found.');
          return;
        }

        let changed = false;

        if (bets && bets.length > 0) {
          // Non-interactive mode
          interface ParsedBet {
            selectName: string;
            value: string;
            questionText: string;
            answerText: string;
          }
          const parsed: ParsedBet[] = [];

          // Group args by question for multi-select support
          const argsByQuestion = new Map<string, string[]>();
          for (const arg of bets) {
            const { question, answer } = parseBonusBetArg(arg);
            const key = question.toLowerCase();
            if (!argsByQuestion.has(key)) {
              argsByQuestion.set(key, []);
            }
            argsByQuestion.get(key)!.push(answer);
          }

          // Validate and match all args
          for (const [, answers] of argsByQuestion) {
            const q = findQuestion(answers[0], questions);
            // Use the original question text from the first arg for lookup
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

          // Apply all bets
          for (const { selectName, value, questionText, answerText } of parsed) {
            console.log(`  ${questionText} → ${answerText}`);
            await page.selectOption(`select[name="${selectName}"]`, value);
          }
          changed = true;
        } else {
          // Interactive mode
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
                `select[name="${sel.name}"]`,
                sel.options[idx].value,
              );
              console.log(`    → ${sel.options[idx].text}`);
              changed = true;
            }
          }
        }

        if (changed) {
          await Promise.all([
            page.waitForNavigation(),
            page.click('button[name="submitbutton"]'),
          ]);
          console.log('\nBonus bets saved.');
        } else {
          console.log('\nNo changes made.');
        }
      } finally {
        await browser.close();
      }
    });
}
