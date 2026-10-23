import * as cheerio from 'cheerio';
import { Page } from './http/page.js';
import { escapeCssValue } from './helpers/escape-css-value.js';

export interface SubmissionTarget {
  name: string;
  value: string;
}

/** Deliberately not an AuthError: a write must never be retried after login. */
export class SubmissionError extends Error {
  constructor(
    readonly outcome: 'rejected' | 'submission_unknown',
    message: string,
  ) {
    super(`${outcome}: ${message}`);
    this.name = 'SubmissionError';
  }
}

const SUBMIT = 'button[name="submitbutton"]';
const CONTEXT_KEYS = ['tipperId', 'tippsaisonId', 'spieltagIndex', 'bonus'];

function fieldSelector(name: string): string {
  return `input[name="${escapeCssValue(name)}"], select[name="${escapeCssValue(name)}"]`;
}

function formState(html: string, url: string, targets: SubmissionTarget[]) {
  const $ = cheerio.load(html);
  const form = $(SUBMIT).closest('form');
  if (form.length !== 1) throw new Error('Expected one identifiable bet form.');
  const action = new URL(form.attr('action') || url, url);
  const context: Record<string, string> = {};
  const formContext: Record<string, string> = {};
  for (const key of CONTEXT_KEYS) {
    const field = form.find(fieldSelector(key));
    const formValues = [...action.searchParams.getAll(key), ...(field.length ? [String(field.val() ?? '')] : [])];
    const values = [...formValues, ...new URL(url).searchParams.getAll(key)];
    if (field.length > 1 || new Set(values).size > 1) throw new Error(`Conflicting ${key} in bet form.`);
    if (values.length) context[key] = values[0];
    if (formValues.length) formContext[key] = formValues[0];
  }
  const values = targets.map(target => {
    const field = form.find(fieldSelector(target.name));
    if (field.length !== 1) throw new Error(`Missing or ambiguous saved field: ${target.name}`);
    return String(field.val() ?? '');
  });
  return { context, formContext, values, action: action.origin + action.pathname, method: form.attr('method')?.toLowerCase() };
}

function loginPage(page: Page): boolean {
  return page.isAuthRedirect() || page.has('input[type="password"]');
}

/** One POST, then an uncached GET of the same member/matchday/bonus form.
 * POST HTML (including echoed input values) is never persistence evidence.
 * Missing/locked fields and partial saves remain unknown; no POST is replayed.
 */
export async function submitVerified(page: Page, targets: SubmissionTarget[]): Promise<void> {
  if (!targets.length || new Set(targets.map(t => t.name)).size !== targets.length) {
    throw new Error('Expected nonempty, unique submission targets.');
  }
  const before = formState(await page.content(), page.url(), targets);
  if (before.method !== 'post') throw new Error('Expected a POST bet form.');
  const readUrl = new URL(page.url());
  // Pin the active tab/day instead of following the server's changing default.
  for (const [key, value] of Object.entries(before.context)) readUrl.searchParams.set(key, value);

  let completed = false;
  let denied = false;
  let postDetail = 'POST response unavailable';
  try {
    await page.click(SUBMIT, { followPostRedirects: false });
    denied = page.isDirectAuthRejection();
    completed = page.status() >= 200 && page.status() < 300 && !loginPage(page) && !denied;
    postDetail = denied ? 'Session expired or submission denied' : `POST HTTP ${page.status()}`;
  } catch (error) {
    postDetail = error instanceof Error ? error.message : String(error);
  }

  let values: string[];
  try {
    await page.reload(readUrl.toString());
    if (page.status() < 200 || page.status() >= 300 || loginPage(page) || page.isNotFound()) {
      throw new Error('Saved values are not accessible.');
    }
    if (page.url() !== readUrl.toString()) throw new Error('Read-back redirected to another context.');
    const saved = formState(await page.content(), page.url(), targets);
    if (saved.action !== before.action || CONTEXT_KEYS.some(key =>
      saved.context[key] !== before.context[key] || saved.formContext[key] !== before.formContext[key])) {
      throw new Error('Read-back form changed member, season, matchday or bonus context.');
    }
    values = saved.values;
  } catch (error) {
    throw new SubmissionError(denied ? 'rejected' : 'submission_unknown',
      `${postDetail}; ${error instanceof Error ? error.message : String(error)} No automatic resubmission.`);
  }

  const matching = targets.filter((target, i) => values[i] === target.value).length;
  if (matching === targets.length) return;
  // An incomplete/lost POST may still be running. A partial save is never a
  // complete rejection, even if the response also reported an error.
  throw new SubmissionError(matching === 0 && (completed || denied) ? 'rejected' : 'submission_unknown',
    `${postDetail}; read-back confirmed ${matching}/${targets.length} target fields. No automatic resubmission.`);
}
