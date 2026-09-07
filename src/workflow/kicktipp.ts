import { isAllowedHost } from '../http/cookie-jar.js';
import * as cheerio from 'cheerio';
import { launchBrowser, type Page } from '../browser.js';
import { getActiveProfile } from '../config.js';
import { loadMatchPredictPage } from '../core.js';
import { inheritPrintedDate, printedTimeZone, resolveMatchDateStrict } from '../helpers/match-date.js';
import { getScheduleUrl } from '../url.js';
import { assertWritable } from '../read-only.js';
import { fixtureSchema, inSubmissionWindow, sameFixture, type Fixture, type Prediction } from './model.js';
import type { SubmissionAdapter } from './engine.js';

export type WorkflowScope = Pick<Fixture, 'profile' | 'community' | 'season' | 'competition'> & { providerSeasonId: string };
interface Row { fixture: Fixture; homeName: string; awayName: string; score: Prediction['score'] | null }
function identityScope(scope: WorkflowScope) {
  const { providerSeasonId, ...identity } = scope;
  if (!/^[1-9]\d*$/.test(providerSeasonId)) throw new Error('Explicit provider season ID required.');
  return identity;
}
function internalId(name: string, side: 'heim' | 'gast'): string | undefined {
  return name.match(new RegExp(`^spieltippForms\\[([1-9]\\d*)\\]\\.${side}Tipp$`))?.[1];
}
function confirmPageScope(page: Page, scope: WorkflowScope, routes = ['predict', 'tippabgabe']): void {
  const current = new URL(page.url());
  if (current.protocol !== 'https:' || !isAllowedHost(current.hostname) || current.username || current.password
    || (current.port && current.port !== '443')) throw new Error('Untrusted Kicktipp origin.');
  const parts = current.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (page.isAuthRedirect() || page.isNotFound() || parts.length !== 2 || parts[0] !== scope.community || !routes.includes(parts[1])) {
    throw new Error('Kicktipp page outside configured community or unavailable.');
  }
}
function confirmMatchday($: cheerio.CheerioAPI, matchday: number): void {
  if (!Number.isSafeInteger(matchday) || matchday < 1 || matchday > 34) throw new Error('Invalid matchday.');
  const declared = new Set<string>();
  $('input[name="spieltagIndex"], select[name="spieltagIndex"] option:selected').each((_, node) => {
    declared.add($(node).attr('value') ?? '');
  });
  $('.prevnextTitle').each((_, node) => {
    const text = $(node).text().trim();
    const value = text.match(/^(\d+)\.\s*Spieltag$/)?.[1] ?? text.match(/^Matchday\s+(\d+)$/i)?.[1];
    if (value) declared.add(value);
  });
  if (declared.size !== 1 || !declared.has(String(matchday))) throw new Error('Matchday identity not confirmed.');
}
function instant(printed: string): number {
  const kickoff = resolveMatchDateStrict(printed, printedTimeZone(printed));
  if (!kickoff.resolved) throw new Error('Kickoff cannot be resolved unambiguously.');
  return kickoff.instant.getTime();
}

/** Provider season and fixture IDs come from schedule links, never team-name synthesis.
 * Semantic season/competition labels remain operator-configured annotations. */
export async function fetchWorkflowFixtures(page: Page, scope: WorkflowScope, matchday?: number): Promise<Fixture[]> {
  const identity = identityScope(scope);
  await page.goto(getScheduleUrl(scope.community, matchday));
  confirmPageScope(page, scope, ['schedule', 'tippspielplan']);
  const $ = cheerio.load(await page.content());
  if (matchday === undefined) {
    const text = $('.prevnextTitle').text().trim();
    const raw = text.match(/^(\d+)\.\s*Spieltag$/)?.[1] ?? text.match(/^Matchday\s+(\d+)$/i)?.[1];
    matchday = Number(raw ?? $('input[name="spieltagIndex"]').attr('value'));
  }
  confirmMatchday($, matchday);
  if ($('#spiele').length !== 1) throw new Error('Schedule table unavailable.');
  const fixtures: Fixture[] = []; const ids = new Set<string>(); let previous = '';
  $('#spiele tbody > tr').each((_, node) => {
    const cells = $(node).children('td');
    if (cells.length < 5) {
      if ($(node).attr('data-url') || cells.length > 1) throw new Error('Malformed schedule fixture row.');
      return; // A one-cell heading/separator contains no fixture identity.
    }
    const raw = $(node).attr('data-url');
    if (!raw) throw new Error('Provider fixture identity missing.');
    const url = new URL(raw, page.url());
    if (url.origin !== new URL(page.url()).origin || !url.pathname.startsWith(`/${scope.community}/`)
      || url.searchParams.getAll('tippsaisonId').length !== 1 || url.searchParams.get('tippsaisonId') !== scope.providerSeasonId
      || url.searchParams.getAll('tippspielId').length !== 1) throw new Error('Provider season or fixture identity not confirmed.');
    const fixtureId = url.searchParams.get('tippspielId') ?? '';
    if (!/^[1-9]\d*$/.test(fixtureId) || ids.has(fixtureId)) throw new Error('Provider fixture identity missing or ambiguous.');
    ids.add(fixtureId);
    previous = inheritPrintedDate($(cells[0]).text(), previous);
    fixtures.push(fixtureSchema.parse({ ...identity, matchday: String(matchday), fixtureId,
      home: $(cells[2]).text().trim(), away: $(cells[3]).text().trim(), kickoff: instant(previous) }));
  });
  return fixtures;
}
function rows($: cheerio.CheerioAPI, scope: WorkflowScope, matchday: number, schedule: Fixture[]): Row[] {
  confirmMatchday($, matchday);
  const seasons = $('input[name="tippsaisonId"]').toArray().map(node => $(node).attr('value'));
  if (!seasons.length || seasons.some(value => value !== scope.providerSeasonId)) throw new Error('Provider season identity not confirmed.');
  if ($('#tippabgabeSpiele').length !== 1) throw new Error('Match fixture table missing or ambiguous.');
  let previous = ''; const result: Row[] = []; const ids = new Set<string>();
  $('#tippabgabeSpiele tbody > tr').each((_, node) => {
    const cells = $(node).children('td'); if (cells.length < 4) return;
    previous = inheritPrintedDate($(cells[0]).text(), previous);
    const home = $(cells[1]).text().trim(), away = $(cells[2]).text().trim(), kickoff = instant(previous);
    const matches = schedule.filter(f => f.home === home && f.away === away && f.kickoff === kickoff);
    if (matches.length !== 1) throw new Error('Full fixture identity not confirmed against schedule.');
    const fixture = matches[0];
    if (ids.has(fixture.fixtureId)) throw new Error('Ambiguous fixture row.'); ids.add(fixture.fixtureId);
    const h = $(cells[3]).find('input[id$="_heimTipp"]'), a = $(cells[3]).find('input[id$="_gastTipp"]');
    const homeName = h.attr('name') ?? '', awayName = a.attr('name') ?? '';
    let hv = h.attr('value') ?? '', av = a.attr('value') ?? '';
    if (h.length || a.length) {
      if (h.length !== 1 || a.length !== 1 || internalId(homeName, 'heim') !== fixture.fixtureId
        || internalId(awayName, 'gast') !== fixture.fixtureId) throw new Error('Internal match identity not confirmed.');
    } else {
      if (!$(cells[3]).hasClass('nichttippbar')) throw new Error('Unrecognized prediction row.');
      const saved = $(cells[3]).text().trim().match(/^(\d+)\s*:\s*(\d+)$/);
      hv = saved?.[1] ?? ''; av = saved?.[2] ?? '';
    }
    const score = /^\d+$/.test(hv) && /^\d+$/.test(av) && Number(hv) <= 20 && Number(av) <= 20
      ? { home: Number(hv), away: Number(av) } : null;
    result.push({ fixture, homeName, awayName, score });
  });
  return result;
}

export class KicktippSubmissionAdapter implements SubmissionAdapter {
  constructor(private readonly scope: WorkflowScope, private readonly createPage: (signal: AbortSignal) => Promise<Page> = signal => {
    if (scope.profile === 'default' && getActiveProfile() !== null) throw new Error('Default authentication profile is not active.');
    return launchBrowser({
    profileId: scope.profile === 'default' ? undefined : scope.profile,
    community: scope.community,
    fetchImpl: (input, init) => {
      signal.throwIfAborted();
      return fetch(input, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
    },
  }); }) {}

  private async current(page: Page, fixture: Fixture, signal: AbortSignal) {
    signal.throwIfAborted();
    fixtureSchema.parse(fixture);
    if (Object.entries(identityScope(this.scope)).some(([key, value]) => fixture[key as keyof Fixture] !== value)) {
      throw new Error('Fixture outside configured scope.');
    }
    const schedule = await fetchWorkflowFixtures(page, this.scope, Number(fixture.matchday));
    signal.throwIfAborted();
    const $ = await loadMatchPredictPage(page, this.scope.community, Number(fixture.matchday));
    signal.throwIfAborted();
    confirmPageScope(page, this.scope);
    const matches = rows($, this.scope, Number(fixture.matchday), schedule).filter(row => sameFixture(fixture, row.fixture));
    if (matches.length !== 1) throw new Error('Full fixture identity not confirmed.');
    return { $, row: matches[0] };
  }

  async submit(fixture: Fixture, score: Prediction['score'], context: { signal: AbortSignal; now: () => number; allowEarlySubmission?: boolean }): Promise<void> {
    const check = () => {
      context.signal.throwIfAborted();
      assertWritable('Workflow submission');
      if (!inSubmissionWindow(fixture, context.now(), context.allowEarlySubmission)) throw new Error('Outside submission window.');
    };
    check();
    if (![score.home, score.away].every(value => Number.isInteger(value) && value >= 0 && value <= 20)) throw new Error('Invalid score.');
    const page = await this.createPage(context.signal);
    try {
      const { $, row } = await this.current(page, fixture, context.signal);
      if (context.allowEarlySubmission && row.score) throw new Error('Test must not overwrite an existing tip.');
      const home = $('input[name]').filter((_, node) => $(node).attr('name') === row.homeName);
      const away = $('input[name]').filter((_, node) => $(node).attr('name') === row.awayName);
      const form = home.closest('form');
      if (home.length !== 1 || away.length !== 1 || form.length !== 1 || away.closest('form')[0] !== form[0]
        || home.attr('disabled') !== undefined || away.attr('disabled') !== undefined) throw new Error('Fixture not editable.');
      const action = new URL(form.attr('action') || page.url(), page.url());
      if (action.pathname !== new URL(page.url()).pathname || action.searchParams.has('bonus')) {
        throw new Error('Unexpected submission route.');
      }
      const fields = new Map<string, string>();
      // Explicit non-match form controls only; hidden bonus/other match values
      // must never leak into the single-fixture POST.
      form.find('input[type="hidden"]').each((_, node) => {
        const input = $(node), name = input.attr('name') ?? '';
        if (!['spieltagIndex', 'tippsaisonId', '_csrf', 'csrf', 'csrfToken', 'token', `spieltippForms[${fixture.fixtureId}].tippAbgegeben`].includes(name)) return;
        if (fields.has(name)) throw new Error('Ambiguous hidden submission field.');
        fields.set(name, input.attr('value') ?? '');
      });
      fields.set(row.homeName, String(score.home)); fields.set(row.awayName, String(score.away));
      const button = form.find('button[name="submitbutton"], input[type="submit"][name="submitbutton"]');
      if (button.length === 1) fields.set('submitbutton', button.attr('value') ?? '');
      check();
      // ID selector is escaped even though its matching names have been checked.
      const selector = `input[name="${row.homeName.replace(/([\\"])/g, '\\$1')}"]`;
      await page.submitSelectedForm(selector, fields, check);
    } finally { await page.close(); }
  }

  async read(fixture: Fixture, signal: AbortSignal): Promise<{ fixture: Fixture; score: Prediction['score'] } | null> {
    signal.throwIfAborted();
    const page = await this.createPage(signal);
    try {
      const { row } = await this.current(page, fixture, signal);
      return row.score ? { fixture: row.fixture, score: row.score } : null;
    } finally { await page.close(); }
  }
}
