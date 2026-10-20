import * as cheerio from 'cheerio';
import { loadPage, loadMatchPredictPage, spieltagIndexFromPage } from '../core.js';
import { getLeaderboardUrl } from '../url.js';
import { loadPlayer } from '../config.js';
import { inheritPrintedDate, parseMatchDate } from '../helpers/match-date.js';
import type { Page } from '../browser.js';

const text = (s: string) => s.replace(/\s+/g, ' ').trim();
const param = (href: string | undefined, key: string) => href ? new URL(href, 'https://example.invalid').searchParams.get(key) : null;
function context($: cheerio.CheerioAPI, requested?: number) {
  const matchday = spieltagIndexFromPage($);
  if (!matchday || (requested !== undefined && requested !== matchday)) throw new Error('Unresolved or mismatched matchday');
  const season = $('input[name="tippsaisonId"]').attr('value') || param($('.spieltagsauswahl a[href*="tippsaisonId"]').first().attr('href'), 'tippsaisonId');
  if (!season) throw new Error('Missing season');
  return { matchday, season, title: text($('#kicktipp-content .pagetitle').text()) };
}

/** Data only; no upstream HTML, executable attributes or inferred scoring rules. */
export function parseOverview(html: string, player: string | null = null, requested?: number) {
  const $ = cheerio.load(html), ctx = context($, requested);
  const table = $('#ranking');
  if (!table.length) throw new Error('Missing ranking');
  const fixtures = new Map<string, { home: string; away: string; date: string; kickoff: string | null }>();
  let date = '';
  $('#spielplanSpiele tbody tr').each((_, tr) => {
    const row = $(tr), cells = row.children('td');
    if (cells.length < 4) return;
    date = inheritPrintedDate($(cells[0]).text(), date);
    const id = param(row.attr('data-url'), 'tippspielId');
    if (id) fixtures.set(id, { home: text($(cells[1]).text()), away: text($(cells[2]).text()), date, kickoff: parseMatchDate(date)?.toISOString() ?? null });
  });
  const columns = table.find('thead th').map((index, th) => {
    const cell = $(th), href = cell.find('a').attr('href'), matchId = param(href, 'tippspielId');
    const blocks = cell.find('.headerbox').map((_, el) => text($(el).text())).get();
    const kind = cell.hasClass('ereignis') ? 'match' : cell.hasClass('position') ? 'rank' : cell.hasClass('positionsdifferenz') ? 'change' : cell.hasClass('name') ? 'name' : 'value';
    const key = kind === 'match' ? matchId || `event:${cell.attr('data-index') || index}` : (cell.attr('class') || '').split(' ')[0];
    return { key, kind, label: cell.attr('data-label') || (kind === 'match' ? blocks.slice(0, 2).join(' – ') : text(cell.text())),
      ...(kind === 'match' ? { matchId, homeShort: blocks[0] || '', awayShort: blocks[1] || '', result: blocks[2] || null,
        live: cell.attr('data-live') === 'true', finished: !!cell.find('.kicktipp-abpfiff').length,
        ...fixtures.get(matchId || '') } : {}) };
  }).get();
  if (!columns.some(c => c.kind === 'name')) throw new Error('Unrecognized ranking columns');
  const rows = table.find('tbody tr[data-teilnehmer-id]').map((_, tr) => {
    const row = $(tr), id = row.attr('data-teilnehmer-id')!, name = text(row.find('.mg_name').text());
    const tds = row.children('td');
    if (!name || tds.length !== columns.length) throw new Error('Ranking column mismatch');
    const cells = columns.map((col, i) => {
      const cell = $(tds[i]), raw = text(cell.text());
      if (col.kind === 'match') {
        const clone = cell.clone(); clone.find('sub').remove();
        const tip = text(clone.text()), points = text(cell.find('sub.p').text());
        // `f` is Kicktipp's explicit failed/zero-point classification. A blank
        // unfinished cell does not disclose whether a prediction exists.
        const state = tip && /^\d+\s*[:\-]\s*\d+$/.test(tip) ? 'visible'
          : cell.find('[class*="lock"]').length || /verdeckt|hidden|\*/i.test(tip) ? 'hidden'
          : !tip && col.finished ? 'not_tipped' : !tip ? 'unpublished' : 'missing';
        return { text: state === 'visible' ? tip.replace(/\s/g, '').replace('-', ':') : null, state,
          points: points !== '' ? points : cell.hasClass('f') ? '0' : null };
      }
      if (col.kind === 'change') {
        const magnitude = raw.match(/\d+/)?.[0];
        return { text: magnitude || (cell.hasClass('position-icon-gleich') ? '0' : null),
          direction: cell.hasClass('position-icon-up') ? 'up' : cell.hasClass('position-icon-down') ? 'down' : cell.hasClass('position-icon-gleich') ? 'same' : 'unknown' };
      }
      return { text: raw || null };
    });
    return { id, name, isCurrentPlayer: !!player && name === player, cells };
  }).get();
  if (!rows.length || new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Missing or duplicate participants');
  return { ...ctx, columns, rows, live: columns.some(c => c.live), fetchedAt: new Date().toISOString() };
}

export function parseForm(html: string, requested?: number) {
  const $ = cheerio.load(html), ctx = context($, requested);
  const table = $('#tippabgabeSpiele');
  if (!table.length) throw new Error('Missing prediction form');
  let date = '';
  const matches = table.find('tbody tr').map((_, tr) => {
    const cells = $(tr).children('td');
    if (cells.length < 4) return null;
    date = inheritPrintedDate($(cells[0]).text(), date);
    const cell = $(cells[3]), h = cell.find('input[id$="_heimTipp"]'), a = cell.find('input[id$="_gastTipp"]');
    const id = (h.attr('name') || h.attr('id'))?.replace(/[_\.]heimTipp$/, '') || param($(tr).attr('data-url'), 'tippspielId') || `${text($(cells[1]).text())}|${text($(cells[2]).text())}`;
    const editable = !!h.length && !!a.length && !h.is('[disabled],[readonly]') && !a.is('[disabled],[readonly]') && !cell.hasClass('nichttippbar');
    const hv = h.attr('value') ?? '', av = a.attr('value') ?? '';
    const printed = cell.clone(); printed.find('sub').remove();
    const score = h.length ? (hv !== '' && av !== '' ? `${hv}:${av}` : null) : text(printed.text()).match(/\d+\s*[:\-]\s*\d+/)?.[0]?.replace(/\s/g, '').replace('-', ':') ?? null;
    return { id, home: text($(cells[1]).text()), away: text($(cells[2]).text()), date,
      deadline: parseMatchDate(date)?.toISOString() ?? null, editable, bet: score };
  }).get().filter((m): m is NonNullable<typeof m> => m !== null);
  if (new Set(matches.map(m => m.id)).size !== matches.length) throw new Error('Duplicate match ids');
  return { ...ctx, matches, fetchedAt: new Date().toISOString() };
}
export async function fetchDashboardOverview(page: Page, community: string, matchday?: number) {
  await loadPage(page, getLeaderboardUrl(community, matchday));
  return parseOverview(await page.content(), loadPlayer(), matchday);
}
export async function fetchDashboardForm(page: Page, community: string, matchday?: number) {
  await loadMatchPredictPage(page, community, matchday);
  return parseForm(await page.content(), matchday);
}

/** One in-flight upstream read per key across all browsers, bounded freshness. */
export class DashboardCache {
  private generation = 0;
  private entries = new Map<string, { data: unknown; until: number }>();
  private pending = new Map<string, Promise<unknown>>();
  async read<T>(key: string, fetcher: () => Promise<T>, ttl: (data: T) => number): Promise<T> {
    const old = this.entries.get(key);
    if (old && old.until > Date.now()) return old.data as T;
    const running = this.pending.get(key); if (running) return running as Promise<T>;
    const generation = this.generation;
    const job = fetcher().then(data => { if (generation === this.generation) this.entries.set(key, { data, until: Date.now() + ttl(data) }); return data; }).finally(() => this.pending.delete(key));
    this.pending.set(key, job); return job;
  }
  clear() { this.generation++; this.entries.clear(); }
}
