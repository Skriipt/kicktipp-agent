import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { DeadlineBonusQuestion } from './analytics/deadline.js';
import type { Page } from './http/page.js';
import { assertReadable } from './http/response.js';
import { getBonusPredictUrl, getScheduleUrl } from './url.js';
import { localizePrintedDate, parseMatchDate, printedTimeZone } from './helpers/match-date.js';

const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim();

function explicitDeadline(text: string): string | null {
  const printed = normalized(text);
  const date = parseMatchDate(printed);
  if (!date || !Number.isFinite(date.getTime())) return null;
  // Reject normalized invalid calendar dates and nonexistent wall-clock times.
  if (localizePrintedDate(printed, printedTimeZone(printed)) !== printed) return null;
  return date.toISOString();
}

async function read(page: Page, url: string): Promise<cheerio.CheerioAPI> {
  await page.goto(url);
  assertReadable(page, url);
  return cheerio.load(await page.content());
}

/**
 * Read bonus completeness and independently published prediction deadlines.
 * Existing bonus-answer APIs deliberately keep their original response shape.
 * Never substitute an event date, match kickoff or an ambiguous title match.
 */
export async function fetchBonusReminders(page: Page, community: string): Promise<DeadlineBonusQuestion[]> {
  return page.runExclusive(async () => {
    const $ = await read(page, getBonusPredictUrl(community));
    const questions: DeadlineBonusQuestion[] = [];
    const titleCounts = new Map<string, number>();
    $('#kicktipp-content table#tippabgabeFragen > tbody > tr').each((_, row) => {
      const cells = $(row).children('td');
      if (cells.length < 3) return;
      const question = normalized($(cells[1]).text());
      if (!question) return;
      titleCounts.set(question, (titleCounts.get(question) ?? 0) + 1);
      const controls = $(cells[2]).find('select');
      const names: string[] = [];
      let missingAnswers = 0;
      let editable = false;
      controls.each((__, control) => {
        const select = $(control);
        const name = select.attr('name');
        if (name) names.push(name);
        if (select.is('[disabled]') || select.parents('fieldset[disabled]').length) return;
        editable = true;
        const options = select.find('option');
        const marked = options.filter('[selected]');
        // For a single select, browsers select the last explicitly selected
        // option, or the first enabled option if none is marked.
        const chosen = marked.length ? marked.last() : options.filter((___, option) =>
          !$(option).is('[disabled]') && !$(option).parents('optgroup[disabled]').length).first();
        const value = chosen.attr('value') ?? chosen.text();
        if (!chosen.length || chosen.is('[disabled]') || chosen.parents('optgroup[disabled]').length ||
          !value.trim() || value === '-1') missingAnswers++;
      });
      const id = createHash('sha256').update(JSON.stringify([community, question, names.sort()])).digest('hex');
      questions.push({ id, question, deadline: null, missingAnswers, editable });
    });
    if (!questions.some(question => question.editable && question.missingAnswers > 0)) return questions;

    const scheduleUrl = new URL(getScheduleUrl(community));
    scheduleUrl.searchParams.set('bonus', 'true');
    const schedule = await read(page, scheduleUrl.href);
    const table = schedule('#kicktipp-content table#fragen');
    const headers = table.children('thead').find('th').toArray();
    const questionColumn = headers.findIndex(header => schedule(header).attr('name') === 'frage');
    const deadlineColumn = headers.findIndex(header => schedule(header).attr('name') === 'tipptermin');
    if (questionColumn < 0 || deadlineColumn < 0) return questions;

    const deadlines = new Map<string, { deadline: string | null; id?: string }[]>();
    table.children('tbody').children('tr').each((_, row) => {
      const cells = schedule(row).children('td');
      const title = normalized(cells.eq(questionColumn).text());
      if (!title) return;
      const entry: { deadline: string | null; id?: string } = {
        deadline: explicitDeadline(cells.eq(deadlineColumn).text()),
      };
      // This identity comes from the matched schedule row. Form array indices
      // are not assumed to be Kicktipp question IDs.
      try {
        const target = new URL(schedule(row).attr('data-url') ?? '', scheduleUrl);
        const season = target.searchParams.get('tippsaisonId');
        const questionId = target.searchParams.get('tippfrageId');
        if (target.origin === scheduleUrl.origin && target.pathname === `${scheduleUrl.pathname}/frage` &&
          season && /^\d+$/.test(season) && questionId && /^\d+$/.test(questionId)) {
          entry.id = `bonus:${season}:${questionId}`;
        }
      } catch { /* Optional identity; the form names still supply a stable key. */ }
      const entries = deadlines.get(title) ?? [];
      entries.push(entry);
      deadlines.set(title, entries);
    });
    return questions.map(question => {
      const matching = deadlines.get(question.question);
      if (titleCounts.get(question.question) !== 1 || matching?.length !== 1) return question;
      return { ...question, deadline: matching[0].deadline, id: matching[0].id ?? question.id };
    });
  });
}
