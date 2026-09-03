import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { Page, parseOdds, getCommunities } from './browser.js';
import {
  getBonusPredictUrl,
  getLeaderboardUrl,
  getOverviewUrl,
  getPredictUrl,
  getRulesUrl,
  getScheduleUrl,
  getTableUrl,
  getAdminMembersUrl,
  getAdminTipsUrl,
} from './url.js';
import { loadCommunity, loadPlayer } from './config.js';
import {
  parseBetArg,
  matchFixture,
  EditableMatch,
} from './helpers/parse-bet-arg.js';
import { escapeCssValue } from './helpers/escape-css-value.js';
import { throughCache, type CacheOptions } from './cache/cached-fetch.js';
import { assertWritable } from './read-only.js';
import {
  displayTimeZone,
  formatKickoffTime,
  inheritPrintedDate,
  isSameCalendarDay,
  parseMatchDate,
} from './helpers/match-date.js';
import { appendAudit, submitAudited, type AuditBet, type BetSource } from './audit/log.js';

// ── Errors ─────────────────────────────────────────────────────────

/** The session is gone or was never valid — logging in again may help. */
export class AuthError extends Error {}

/** The page does not exist — usually a wrong community name. */
export class NotFoundError extends Error {}

/** The page exists but requires Spielleiter (admin) rights. */
export class AdminRequiredError extends Error {}

// ── Shared helpers ─────────────────────────────────────────────────

async function loadPage(page: Page, url: string): Promise<cheerio.CheerioAPI> {
  await page.goto(url);

  // Kicktipp answers an invalid session with a redirect to its login page,
  // and a wrong community with a "not found" page. Keep them apart: only
  // the first one is worth throwing away the session over.
  if (page.isAdminRequired()) {
    throw new AdminRequiredError(
      `Spielleiter (admin) rights are required for ${url}.`,
    );
  }
  if (page.isAuthRedirect()) {
    throw new AuthError(
      `Kicktipp session is not authenticated (redirected to ${page.url()}). Verify credentials.`,
    );
  }
  if (page.isNotFound()) {
    throw new NotFoundError(`Kicktipp page not found: ${url}. Check the community name.`);
  }

  return cheerio.load(await page.content());
}

function spieltagIndexFromPage($: cheerio.CheerioAPI): number | undefined {
  const hidden = $('input[name="spieltagIndex"]').attr('value');
  const selected =
    $('select[name="spieltagIndex"] option:selected').attr('value') ??
    $('select[name="spieltagIndex"]').attr('value');
  const titled = $('#kicktipp-content div.pagetitle')
    .text()
    .match(/(?:Spieltag|Matchday)\s+(\d{1,2})\b/i)?.[1];
  for (const raw of [hidden, selected, titled]) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 34) return n;
  }
  return undefined;
}

/**
 * Bare `/predict` is not always the match list. Kicktipp remembers the last
 * tab; after bonus questions (or some submitted match bets) it serves
 * `#tippabgabeFragen` with hidden `bonus=true` and no `#tippabgabeSpiele`.
 * Reload the same spieltag without the bonus flag so callers see matches.
 */
export async function loadMatchPredictPage(
  page: Page,
  community: string,
  matchday?: number,
): Promise<cheerio.CheerioAPI> {
  let $ = await loadPage(page, getPredictUrl(community, matchday));
  if (matchday !== undefined) return $;
  if ($('#kicktipp-content table#tippabgabeSpiele tbody').length) return $;
  const index = spieltagIndexFromPage($);
  if (index === undefined) return $;
  return loadPage(page, getPredictUrl(community, index));
}


/** Kicktipp's "current" matchday: the spieltag the bare predict page opens. */
export async function fetchCurrentMatchday(page: Page, community: string): Promise<number | null> {
  const $ = await loadMatchPredictPage(page, community);
  return spieltagIndexFromPage($) ?? null;
}

export async function resolveCommunity(page: Page): Promise<string> {
  const saved = loadCommunity();
  if (saved) return saved;
  const all = await getCommunities(page);
  if (!all.length) throw new Error('No communities found. Run `kicktipp set-community` first.');
  throw new Error(`No community set. Available: ${all.join(', ')}. Run \`kicktipp set-community\` first.`);
}

// ── Data types ─────────────────────────────────────────────────────

export interface TodayMatch {
  time: string;
  home: string;
  away: string;
  bet: string;
  odds: { home: string; draw: string; away: string };
  needsBet: boolean;
}

export interface BetMatch {
  date: string;
  home: string;
  away: string;
  bet: string;
  odds: { home: string; draw: string; away: string };
}

export interface ScheduleMatch {
  date: string;
  home: string;
  away: string;
  result: string;
}

export interface RankingEntry {
  position: string;
  name: string;
  matchdayPoints: string;
  bonus: string;
  total: string;
  isCurrentPlayer: boolean;
}

export interface BonusQuestionEntry {
  abbreviation: string;
  question: string;
  result: string;
}

export interface LeaderboardData {
  title: string;
  matches?: ScheduleMatch[];
  bonusQuestions?: BonusQuestionEntry[];
  rankings: RankingEntry[];
}

export interface OverviewPlayer {
  position: string;
  name: string;
  matchdays: Record<number, string>;
  bonus: string;
  wins: string;
  total: string;
  isCurrentPlayer: boolean;
}

export interface OverviewData {
  label: string;
  maxMatchday: number;
  players: OverviewPlayer[];
}

export interface TableTeam {
  position: string;
  team: string;
  played: string;
  points: string;
  goalsFor: string;
  goalsAgainst: string;
  goalDifference: string;
  wins: string;
  draws: string;
  losses: string;
}

export interface RulesSection {
  type: 'heading' | 'paragraph' | 'table';
  text?: string;
  headers?: string[];
  rows?: string[][];
}

export interface PlacedBet {
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
}

export interface BonusQuestionOption {
  value: string;
  text: string;
}

export interface BonusQuestion {
  question: string;
  selects: {
    name: string;
    options: BonusQuestionOption[];
    selected: string;
  }[];
}


export interface PlayerBets {
  player: string;
  /** One entry per match, aligned with `matches`. Empty string = no bet shown. */
  bets: string[];
}

export interface MatchdayBets {
  matchday?: number;
  matches: ScheduleMatch[];
  players: PlayerBets[];
  /**
   * Set when per-player bets could not be read — most often because the
   * deadline has not passed yet and Kicktipp still hides everyone else's
   * predictions. `players` is then empty rather than wrong.
   */
  note?: string;
}

export interface PlacedBonusBet {
  question: string;
  answer: string;
}

// ── Data functions ─────────────────────────────────────────────────

export async function fetchTodayMatches(page: Page, community: string): Promise<{ title: string; matches: TodayMatch[] }> {
  const $ = await loadMatchPredictPage(page, community);
  const content = $('#kicktipp-content');
  const title = content.find('div.pagetitle').text().trim();
  const tbody = content.find('table#tippabgabeSpiele tbody');
  if (!tbody.length) return { title, matches: [] };

  const now = new Date();
  const zone = displayTimeZone();
  const matches: TodayMatch[] = [];
  let lastDate = '';

  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 4) return;
    const dateText = inheritPrintedDate($(cols[0]).text(), lastDate);
    lastDate = dateText;
    const matchDate = parseMatchDate(dateText);
    if (!matchDate || !isSameCalendarDay(matchDate, now, zone)) return;

    const home = $(cols[1]).text().trim();
    const away = $(cols[2]).text().trim();
    const betTd = $(cols[3]);
    let bet: string;
    if (betTd.hasClass('nichttippbar')) {
      bet = betTd.text().trim() || '-';
    } else {
      const heimInput = betTd.find('input[id$="_heimTipp"]');
      const gastInput = betTd.find('input[id$="_gastTipp"]');
      if (heimInput.length && gastInput.length) {
        const h = heimInput.attr('value') || '';
        const g = gastInput.attr('value') || '';
        bet = h && g ? `${h}:${g}` : '';
      } else {
        bet = '-';
      }
    }

    const time = formatKickoffTime(matchDate, zone);
    // The odds column is only present in communities that have odds enabled
    const [rateHome, rateDraw, rateAway] = cols.length > 4 ? parseOdds($, cols[4]) : ['-', '-', '-'];

    matches.push({
      time, home, away, bet,
      odds: { home: rateHome, draw: rateDraw, away: rateAway },
      needsBet: !bet,
    });
  });

  return { title, matches };
}

export async function fetchBets(page: Page, community: string, matchday?: number, cache: CacheOptions = {}): Promise<{ title: string; matches: BetMatch[] }> {
  return throughCache('bets', matchday, cache, async () => {
  const $ = await loadMatchPredictPage(page, community, matchday);
  const content = $('#kicktipp-content');
  const title = content.find('div.pagetitle').text().trim();
  const tbody = content.find('table#tippabgabeSpiele tbody');
  if (!tbody.length) return { title, matches: [] };

  const matches: BetMatch[] = [];
  let lastDate = '';
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 4) return;
    const date = inheritPrintedDate($(cols[0]).text(), lastDate);
    lastDate = date;
    const home = $(cols[1]).text().trim();
    const away = $(cols[2]).text().trim();

    const betTd = $(cols[3]);
    let bet: string;
    if (betTd.hasClass('nichttippbar')) {
      bet = betTd.text().trim();
    } else {
      const heimInput = betTd.find('input[id$="_heimTipp"]');
      const gastInput = betTd.find('input[id$="_gastTipp"]');
      if (heimInput.length && gastInput.length) {
        const h = heimInput.attr('value') || '';
        const g = gastInput.attr('value') || '';
        bet = h && g ? `${h}:${g}` : '-';
      } else {
        bet = '-';
      }
    }

    // The odds column is only present in communities that have odds enabled
    const [rateHome, rateDraw, rateAway] = cols.length > 4 ? parseOdds($, cols[4]) : ['-', '-', '-'];
    matches.push({ date, home, away, bet, odds: { home: rateHome, draw: rateDraw, away: rateAway } });
  });

  return { title, matches };
  });
}

export async function fetchSchedule(page: Page, community: string, matchday?: number, cache: CacheOptions = {}): Promise<{ title: string; matches: ScheduleMatch[] }> {
  return throughCache('schedule', matchday, cache, async () => {
  const $ = await loadPage(page, getScheduleUrl(community, matchday));
  const content = $('#kicktipp-content');
  const title = content.find('div.pagetitle').text().trim();
  const table = content.find('table#spiele');
  if (!table.length) return { title, matches: [] };
  const tbody = table.find('tbody');
  if (!tbody.length) return { title, matches: [] };

  const matches: ScheduleMatch[] = [];
  let lastDate = '';
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 5) return;
    const date = inheritPrintedDate($(cols[0]).text(), lastDate);
    lastDate = date;
    const home = $(cols[2]).text().trim();
    const away = $(cols[3]).text().trim();
    const resultSpan = $(cols[4]).find('span.kicktipp-ergebnis');
    let result: string;
    if (resultSpan.length) {
      const h = resultSpan.find('span.kicktipp-heim').text().trim();
      const g = resultSpan.find('span.kicktipp-gast').text().trim();
      result = `${h}:${g}`;
    } else {
      result = '-:-';
    }
    matches.push({ date, home, away, result });
  });

  return { title, matches };
  });
}

export async function fetchLeaderboard(page: Page, community: string, matchday?: number, bonus = false, cache: CacheOptions = {}): Promise<LeaderboardData> {
  // The bonus view is a different payload under the same URL; it is not
  // cached, so it can neither overwrite the regular leaderboard nor be
  // served offline.
  return throughCache('leaderboard', matchday, bonus ? { ...cache, store: null } : cache, async () => {
  const $ = await loadPage(page, getLeaderboardUrl(community, matchday, bonus));
  const content = $('#kicktipp-content');
  const title = content.find('div.pagetitle').text().trim();
  const savedPlayer = loadPlayer();

  // Matches (non-bonus only)
  let matches: ScheduleMatch[] | undefined;
  if (!bonus) {
    const matchesTable = content.find('table#spielplanSpiele');
    if (matchesTable.length) {
      matches = [];
      let lastDate = '';
      matchesTable.find('tbody tr').each((_, tr) => {
        const cols = $(tr).children('td');
        if (cols.length < 4) return;
        const date = inheritPrintedDate($(cols[0]).text(), lastDate);
        lastDate = date;
        const home = $(cols[1]).text().trim();
        const away = $(cols[2]).text().trim();
        const resultSpan = $(cols[3]).find('span.kicktipp-ergebnis');
        let result = '-:-';
        if (resultSpan.length) {
          result = `${resultSpan.find('span.kicktipp-heim').text().trim()}:${resultSpan.find('span.kicktipp-gast').text().trim()}`;
        }
        matches!.push({ date, home, away, result });
      });
    }
  }

  // Bonus questions (bonus only)
  let bonusQuestions: BonusQuestionEntry[] | undefined;
  if (bonus) {
    const questionsTable = content.find('table.ktable').first();
    if (questionsTable.length) {
      bonusQuestions = [];
      questionsTable.find('tbody tr').each((_, tr) => {
        const cols = $(tr).children('td');
        if (cols.length < 4) return;
        const question = $(cols[1]).text().trim();
        const abbreviation = $(cols[2]).text().trim();
        const resultParts: string[] = [];
        $(cols[3]).find('table tr').each((__, subTr) => {
          const medium = $(subTr).find('div.visible-medium-block');
          if (medium.length) resultParts.push(medium.text().trim());
        });
        bonusQuestions!.push({ abbreviation, question, result: resultParts.join(', ') || '---' });
      });
    }
  }

  // Rankings
  const rankings: RankingEntry[] = [];
  content.find('table#ranking tbody tr').each((_, tr) => {
    const posTd = $(tr).find('td.position');
    const nameDiv = $(tr).find('div.mg_name');
    if (!posTd.length || !nameDiv.length) return;
    const name = nameDiv.text().trim();
    rankings.push({
      position: posTd.text().trim(),
      name,
      matchdayPoints: $(tr).find('td.spieltagspunkte').text().trim(),
      bonus: $(tr).find('td.bonus').text().trim(),
      total: $(tr).find('td.gesamtpunkte').text().trim(),
      isCurrentPlayer: !!savedPlayer && name === savedPlayer,
    });
  });

  return { title, matches, bonusQuestions, rankings };
  });
}

const OVERVIEW_VIEWS: Record<string, [string, string]> = {
  'matchday-points': ['spieltagspunkte', 'Matchday points'],
  'standings': ['platzierungen', 'Standings'],
  'standings-diff': ['platzierungsdifferenz', 'Standings difference'],
  'matchday-standings': ['spieltagsplatzierungen', 'Matchday standings'],
  'points-from-leader': ['punkteZurSpitze', 'Points from leader'],
};

export const OVERVIEW_VIEW_OPTIONS = Object.keys(OVERVIEW_VIEWS);

export async function fetchOverview(page: Page, community: string, view = 'matchday-points', cache: CacheOptions = {}): Promise<OverviewData> {
  // Only the default view is cached — the other views are the same data
  // rearranged, and they would otherwise overwrite each other.
  return throughCache('overview', undefined, view === 'matchday-points' ? cache : { ...cache, store: null }, async () => {
  if (!(view in OVERVIEW_VIEWS)) {
    throw new Error(`Unknown view '${view}'. Options: ${OVERVIEW_VIEW_OPTIONS.join(', ')}`);
  }
  const [ansicht, label] = OVERVIEW_VIEWS[view];
  const $ = await loadPage(page, getOverviewUrl(community, ansicht));
  const content = $('#kicktipp-content');
  const savedPlayer = loadPlayer();

  const ranking = content.find('table#ranking');
  if (!ranking.length) return { label, maxMatchday: 0, players: [] };
  const tbody = ranking.find('tbody');
  if (!tbody.length) return { label, maxMatchday: 0, players: [] };

  const players: OverviewPlayer[] = [];
  let maxMatchday = 0;

  tbody.find('tr').each((_, tr) => {
    const posTd = $(tr).find('td.position');
    const nameDiv = $(tr).find('div.mg_name');
    if (!posTd.length || !nameDiv.length) return;
    const name = nameDiv.text().trim();
    const matchdays: Record<number, string> = {};
    $(tr).find('td.spieltag').each((__, td) => {
      const classes = $(td).attr('class')?.split(/\s+/) || [];
      for (const cls of classes) {
        if (cls.startsWith('spieltag') && cls !== 'spieltag') {
          const idx = parseInt(cls.replace('spieltag', ''));
          const val = $(td).text().trim();
          if (val) { matchdays[idx] = val; if (idx > maxMatchday) maxMatchday = idx; }
        }
      }
    });
    players.push({
      position: posTd.text().trim(), name, matchdays,
      bonus: $(tr).find('td.bonus').text().trim(),
      wins: $(tr).find('td.siege').text().trim(),
      total: $(tr).find('td.punkte').text().trim(),
      isCurrentPlayer: !!savedPlayer && name === savedPlayer,
    });
  });

  return { label, maxMatchday, players };
  });
}

export async function fetchTable(page: Page, community: string, option?: 'home' | 'away', cache: CacheOptions = {}): Promise<{ label: string; teams: TableTeam[] }> {
  // Home/away tables are separate payloads; only the full table is cached.
  return throughCache('table', undefined, option === undefined ? cache : { ...cache, store: null }, async () => {
  let label = 'League Table';
  if (option === 'home') label = 'League Table (Home)';
  else if (option === 'away') label = 'League Table (Away)';

  const $ = await loadPage(page, getTableUrl(community, option));
  const content = $('#kicktipp-content');
  const table = content.find('table').first();
  if (!table.length) return { label, teams: [] };
  const tbody = table.find('tbody');
  if (!tbody.length) return { label, teams: [] };

  const teams: TableTeam[] = [];
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 10) return;
    teams.push({
      position: $(cols[0]).text().trim(),
      team: $(cols[1]).text().trim(),
      played: $(cols[2]).text().trim(),
      points: $(cols[3]).text().trim(),
      goalsFor: $(cols[4]).text().trim(),
      goalsAgainst: $(cols[5]).text().trim(),
      goalDifference: $(cols[6]).text().trim(),
      wins: $(cols[7]).text().trim(),
      draws: $(cols[8]).text().trim(),
      losses: $(cols[9]).text().trim(),
    });
  });

  return { label, teams };
  });
}

export async function fetchRules(page: Page, community: string, cache: CacheOptions = {}): Promise<RulesSection[]> {
  return throughCache('rules', undefined, cache, async () => {
  const $ = await loadPage(page, getRulesUrl(community));
  const pagecontent = $('#kicktipp-content div.pagecontent');
  if (!pagecontent.length) return [];

  const sections: RulesSection[] = [];
  pagecontent.contents().each((_, child) => {
    if (child.type !== 'tag') return;
    const el = $(child);
    const tagName = (child as any).tagName as string;

    if (tagName === 'h2') {
      sections.push({ type: 'heading', text: el.text().trim() });
    } else if (tagName === 'p') {
      sections.push({ type: 'paragraph', text: el.text().trim() });
    } else if (tagName === 'div') {
      const table = el.find('table');
      if (table.length) {
        const headers: string[] = [];
        table.find('thead th').each((__, th) => { headers.push($(th).text().trim()); });
        const rows: string[][] = [];
        table.find('tbody tr').each((__, tr) => {
          const row: string[] = [];
          $(tr).find('td').each((___, td) => { row.push($(td).text().trim()); });
          rows.push(row);
        });
        if (headers.length) sections.push({ type: 'table', headers, rows });
      } else {
        const classes = el.attr('class') || '';
        if (!classes.includes('level0') && el.find('p').length) {
          sections.push({ type: 'paragraph', text: el.text().trim() });
        }
      }
    }
  });

  return sections;
  });
}

// ── Write operations ───────────────────────────────────────────────

function fillMatchBets(
  page: Page,
  $: cheerio.CheerioAPI,
  bets: string[],
  editable: EditableMatch[],
): { placed: PlacedBet[]; audited: AuditBet[] } {
  const seen = new Set<string>();
  const parsed = bets.map((arg) => {
    const { home, away, h, g } = parseBetArg(arg);
    const key = `${home.toLowerCase()}|${away.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Duplicate fixture: "${home} vs ${away}"`);
    seen.add(key);
    return { entry: matchFixture(home, away, editable), h, g };
  });

  const placed: PlacedBet[] = [];
  const audited: AuditBet[] = [];
  for (const { entry, h, g } of parsed) {
    const homeSelector = `input[name="${escapeCssValue(entry.heimName)}"]`;
    const awaySelector = `input[name="${escapeCssValue(entry.gastName)}"]`;
    const previousHome = $(homeSelector).attr('value') || '';
    const previousAway = $(awaySelector).attr('value') || '';
    page.setInputValue(homeSelector, String(h));
    page.setInputValue(awaySelector, String(g));
    placed.push({ home: entry.home, away: entry.away, homeGoals: h, awayGoals: g });
    audited.push({
      fixture: `${entry.home} vs ${entry.away}`,
      bet: `${h}:${g}`,
      previous: previousHome && previousAway ? `${previousHome}:${previousAway}` : null,
    });
  }
  return { placed, audited };
}

export async function placeBets(
  page: Page,
  community: string,
  bets: string[],
  matchday?: number,
  submit = true,
  source: BetSource = 'unknown',
): Promise<PlacedBet[]> {
  // Checked here as well as at the entry points: this is the last line before
  // anything reaches Kicktipp.
  if (submit) assertWritable('Placing bets');
  const $ = await loadMatchPredictPage(page, community, matchday);
  const tbody = $('#kicktipp-content table#tippabgabeSpiele tbody');
  if (!tbody.length) throw new Error('No matches found.');

  const editable: EditableMatch[] = [];
  tbody.find('tr').each((_, tr) => {
    const cols = $(tr).find('td');
    if (cols.length < 4) return;
    const betTd = $(cols[3]);
    const heimInput = betTd.find('input[id$="_heimTipp"]');
    const gastInput = betTd.find('input[id$="_gastTipp"]');
    if (!heimInput.length || !gastInput.length) return;
    editable.push({
      home: $(cols[1]).text().trim(),
      away: $(cols[2]).text().trim(),
      heimName: heimInput.attr('name')!,
      gastName: gastInput.attr('name')!,
    });
  });

  if (!editable.length) throw new Error('No editable matches found.');

  const { placed, audited } = fillMatchBets(page, $, bets, editable);

  const record = {
    at: new Date().toISOString(),
    source,
    community,
    matchday: matchday ?? null,
    kind: 'match' as const,
    dryRun: !submit,
    bets: audited,
  };

  if (!submit) {
    appendAudit({ ...record, outcome: 'dry-run' });
    return placed;
  }

  await submitAudited(record, () => page.click('button[name="submitbutton"]'));

  return placed;
}

export async function fetchBonusQuestions(page: Page, community: string): Promise<BonusQuestion[]> {
  const $ = await loadPage(page, getBonusPredictUrl(community));
  const content = $('#kicktipp-content');
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
    const selects: BonusQuestion['selects'][0][] = [];
    selectEls.each((__, sel) => {
      const name = $(sel).attr('name')!;
      const options: BonusQuestionOption[] = [];
      let selected = '-1';
      $(sel).find('option').each((___, opt) => {
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

/** One bonus question with the answer(s) currently recorded for the player. */
export interface BonusAnswer {
  question: string;
  /** Chosen answers, in slot order. Empty when nothing is answered. */
  answers: string[];
  /** True while the question can still be edited (the form has dropdowns). */
  editable: boolean;
}

/**
 * Read the player's bonus answers, whether the round is open or closed.
 *
 * `fetchBonusQuestions` only returns the editable form, so once the bonus
 * deadline passes it goes empty. This reads the same page but keeps every
 * question: open ones report the option currently selected in each dropdown,
 * locked ones report the answer Kicktipp now prints as plain text. That way
 * "what did I bet?" is answerable after the deadline, not just before it.
 */
export async function fetchBonusBets(page: Page, community: string): Promise<BonusAnswer[]> {
  const $ = await loadPage(page, getBonusPredictUrl(community));
  const tbody = $('#kicktipp-content table#tippabgabeFragen tbody');
  if (!tbody.length) return [];

  const out: BonusAnswer[] = [];
  tbody.children('tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 3) return;
    const question = $(cols[1]).text().trim();
    if (!question) return;

    const answerTd = $(cols[2]);
    const selectEls = answerTd.find('select');

    if (selectEls.length) {
      const answers: string[] = [];
      selectEls.each((__, sel) => {
        let chosen = '';
        $(sel).find('option').each((___, opt) => {
          const value = $(opt).attr('value') || '';
          if ($(opt).attr('selected') !== undefined && value !== '-1') {
            chosen = $(opt).text().trim();
          }
        });
        if (chosen) answers.push(chosen);
      });
      out.push({ question, answers, editable: true });
      return;
    }

    // Locked: the chosen answer is printed as text. Keep it as-is rather than
    // guessing at separators, so multi-part answers are not mangled.
    const text = answerTd.text().replace(/\s+/g, ' ').trim();
    out.push({ question, answers: text ? [text] : [], editable: false });
  });

  return out;
}

function parseBonusBetArg(arg: string): { question: string; answer: string } {
  const eqIdx = arg.lastIndexOf('=');
  if (eqIdx === -1) throw new Error(`Invalid bonus bet '${arg}'. Use format: "Question text=Answer"`);
  const question = arg.slice(0, eqIdx).trim();
  const answer = arg.slice(eqIdx + 1).trim();
  if (!question || !answer) {
    throw new Error(`Invalid bonus bet '${arg}'. Both question and answer required.`);
  }
  return { question, answer };
}

function isEmptyBonusSlot(selected: string): boolean {
  return selected === '-1' || selected === '';
}

/**
 * Ranking questions (relegation, top-N) have several dropdowns. A full set
 * of answers replaces every slot in order. A shorter list fills empty slots
 * so a later call can add the second and third team instead of overwriting
 * the first dropdown again.
 */
function bonusAnswerSlots(
  selects: BonusQuestion['selects'],
  answerCount: number,
): number[] {
  if (answerCount === selects.length) return selects.map((_, i) => i);
  const empty = selects.flatMap((s, i) => (isEmptyBonusSlot(s.selected) ? [i] : []));
  if (empty.length >= answerCount) return empty.slice(0, answerCount);
  return selects.map((_, i) => i).slice(0, answerCount);
}

export async function placeBonusBets(
  page: Page,
  community: string,
  bets: string[],
  submit = true,
  source: BetSource = 'unknown',
): Promise<PlacedBonusBet[]> {
  if (submit) assertWritable('Placing bonus bets');
  const questions = await fetchBonusQuestions(page, community);
  if (!questions.length) throw new Error('No editable bonus questions found.');

  const argsByQuestion = new Map<string, string[]>();
  for (const arg of bets) {
    const { question, answer } = parseBonusBetArg(arg);
    const key = question.toLowerCase();
    if (!argsByQuestion.has(key)) argsByQuestion.set(key, []);
    argsByQuestion.get(key)!.push(answer);
  }

  const placed: PlacedBonusBet[] = [];

  for (const [key, answers] of argsByQuestion) {
    const q = questions.find((qq) => qq.question.toLowerCase() === key);
    if (!q) {
      const requested = bets.find((arg) => parseBonusBetArg(arg).question.toLowerCase() === key);
      const label = requested ? parseBonusBetArg(requested).question : key;
      const available = questions.map((qq) => qq.question).join(', ');
      throw new Error(`No bonus question found matching: "${label}". Available: ${available}`);
    }

    if (answers.length > q.selects.length) {
      throw new Error(`Too many answers for "${q.question}": got ${answers.length}, max ${q.selects.length}`);
    }

    const slots = bonusAnswerSlots(q.selects, answers.length);
    const overwritten = new Set(slots);
    const usedValues = new Set(
      q.selects.filter((_, i) => !overwritten.has(i) && !isEmptyBonusSlot(q.selects[i].selected)).map((s) => s.selected),
    );

    for (let a = 0; a < answers.length; a++) {
      const select = q.selects[slots[a]];
      const option = select.options.find((o) => o.text.toLowerCase() === answers[a].toLowerCase());
      if (!option) {
        const available = select.options.map((o) => o.text).join(', ');
        throw new Error(`No option "${answers[a]}" for question "${q.question}". Available: ${available}`);
      }
      if (usedValues.has(option.value)) {
        throw new Error(`Duplicate answer "${answers[a]}" for "${q.question}"`);
      }
      usedValues.add(option.value);
      await page.selectOption(`select[name="${escapeCssValue(select.name)}"]`, option.value);
      placed.push({ question: q.question, answer: option.text });
    }
  }

  const record = {
    at: new Date().toISOString(),
    source,
    community,
    matchday: null,
    kind: 'bonus' as const,
    dryRun: !submit,
    bets: placed.map((p) => ({ fixture: p.question, bet: p.answer, previous: null })),
  };

  if (!submit) {
    appendAudit({ ...record, outcome: 'dry-run' });
    return placed;
  }

  await submitAudited(record, () => page.click('button[name="submitbutton"]'));

  return placed;
}

/**
 * Read every player's bets for one matchday from the leaderboard page.
 *
 * Kicktipp only reveals other players' predictions once the matchday's
 * deadline has passed; before that the cells are blank. The bet columns sit
 * between the name and the points columns, so they are identified by
 * elimination and then aligned with the match list. If that alignment does
 * not come out exactly, no bets are returned and `note` says why — a wrong
 * alignment would silently attribute predictions to the wrong fixture.
 */
export async function fetchMatchdayBets(
  page: Page,
  community: string,
  matchday?: number,
  cache: CacheOptions = {},
): Promise<MatchdayBets> {
  return throughCache('matchdayBets', matchday, cache, async () => {
  const $ = await loadPage(page, getLeaderboardUrl(community, matchday));
  const resolved = matchday ?? spieltagIndexFromPage($);
  const content = $('#kicktipp-content');

  const matches: ScheduleMatch[] = [];
  let lastDate = '';
  content.find('table#spielplanSpiele tbody tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 4) return;
    const resultSpan = $(cols[3]).find('span.kicktipp-ergebnis');
    const result = resultSpan.length
      ? `${resultSpan.find('span.kicktipp-heim').text().trim()}:${resultSpan.find('span.kicktipp-gast').text().trim()}`
      : '-:-';
    const date = inheritPrintedDate($(cols[0]).text(), lastDate);
    lastDate = date;
    matches.push({
      date,
      home: $(cols[1]).text().trim(),
      away: $(cols[2]).text().trim(),
      result,
    });
  });

  if (!matches.length) {
    return { matchday: resolved, matches, players: [], note: 'No match list found on the leaderboard page.' };
  }

  // Columns that are never bets: rank, rank-change icon, name and points.
  const NON_BET =
    'td.position, td.positionsdifferenz, td.spieltagspunkte, td.bonus, td.gesamtpunkte, td.punkte, td.siege';
  const players: PlayerBets[] = [];
  let extraOrMissing = 0;

  content.find('table#ranking tbody tr').each((_, tr) => {
    const row = $(tr);
    const name = row.find('div.mg_name').text().trim();
    if (!name) return;

    const marked = row.children('td.ereignis');
    const betCells = marked.length
      ? marked.toArray().map((td) => readBetCell($(td)))
      : row.children('td').toArray().flatMap((td) => {
          const cell = $(td);
          if (cell.is(NON_BET)) return [];
          if (cell.find('div.mg_name').length) return [];
          return [readBetCell(cell)];
        });

    if (betCells.length !== matches.length) {
      // A ranking with no tip cells is the usual pre-deadline page, not a
      // broken scrape. Only a *partial* column count is untrustworthy.
      if (betCells.length > 0) extraOrMissing++;
      return;
    }
    players.push({ player: name, bets: betCells });
  });

  if (!players.length) {
    return {
      matchday: resolved,
      matches,
      players: [],
      note: extraOrMissing
        ? 'Bet columns did not line up with the match list, so no bets were read.'
        : 'No per-player bets are published for this matchday yet (the deadline has probably not passed).',
    };
  }

  const withBets = players.filter((p) => p.bets.some((b) => b !== ''));
  if (!withBets.length) {
    return {
      matchday: resolved,
      matches,
      players: [],
      note: 'Kicktipp is still hiding everyone\'s bets for this matchday (deadline not passed).',
    };
  }

  return { matchday: resolved, matches, players };
  });
}

/** Kicktipp.com writes 2-1 and tucks the points in <sub class="p">. */
function readBetCell(cell: cheerio.Cheerio<AnyNode>): string {
  const clone = cell.clone();
  clone.find('sub').remove();
  return normalizeBetCell(clone.text());
}

/** A bet cell holds either a scoreline or a placeholder such as "-" or "–". */
function normalizeBetCell(raw: string): string {
  const text = raw.replace(/\s+/g, '');
  const match = text.match(/(\d+)[:\-](\d+)/);
  return match ? `${match[1]}:${match[2]}` : '';
}


// ── Spielleiter (admin) ────────────────────────────────────────────
//
// Kicktipp lets a community admin fill in bets for another member through
// "Tipps nachtragen". These functions all act with the admin's own session;
// the member is named by the tipperId in the URL.

export interface Member {
  tipperId: string;
  tippsaisonId: string;
  name: string;
  /** A placeholder member with no login of their own. */
  dummy: boolean;
}

/** Read the community's member list, with the ids the admin pages need. */
export async function fetchMembers(page: Page, community: string): Promise<Member[]> {
  const $ = await loadPage(page, getAdminMembersUrl(community));
  const members: Member[] = [];

  $('#kicktipp-content a[href*="tipperId="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const tipperId = new URL(href, 'https://x.invalid').searchParams.get('tipperId');
    const tippsaisonId =
      new URL(href, 'https://x.invalid').searchParams.get('tippsaisonId') || '';
    if (!tipperId) return;
    // The visible name is the row's first cell; the link itself usually just
    // reads "Tipps nachtragen", so it is only a fallback.
    const row = $(el).closest('tr');
    const cellName = row.find('td').first().text().trim();
    const name = (cellName || $(el).text().trim())
      .replace(/\s*\(dummy\)\s*/i, '')
      .trim();
    if (!name) return;
    if (members.some((m) => m.tipperId === tipperId)) return;
    members.push({
      tipperId,
      tippsaisonId,
      name,
      dummy: /dummy/i.test(row.text()),
    });
  });

  return members;
}

/** Resolve a member by numeric id or by name, and say so when ambiguous. */
export function resolveMember(members: Member[], reference: string): Member {
  const byId = members.find((m) => m.tipperId === reference);
  if (byId) return byId;

  const matches = members.filter(
    (m) => m.name.toLowerCase() === reference.toLowerCase(),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `More than one member is called "${reference}". Use their tipperId instead: ` +
        matches.map((m) => m.tipperId).join(', '),
    );
  }
  throw new Error(
    `No member "${reference}" in this community. Known members: ` +
      members.map((m) => m.name).join(', '),
  );
}

function parseEditableRows(
  $: cheerio.CheerioAPI,
): { editable: EditableMatch[]; bets: BetMatch[] } {
  const editable: EditableMatch[] = [];
  const bets: BetMatch[] = [];
  let lastDate = '';

  $('#kicktipp-content tbody tr').each((_, tr) => {
    const cols = $(tr).children('td');
    if (cols.length < 4) return;
    const betTd = $(cols[3]);
    const heimInput = betTd.find('input[id$="_heimTipp"]');
    const gastInput = betTd.find('input[id$="_gastTipp"]');
    const home = $(cols[1]).text().trim();
    const away = $(cols[2]).text().trim();
    if (!home || !away) return;

    const h = heimInput.attr('value') || '';
    const g = gastInput.attr('value') || '';
    const date = inheritPrintedDate($(cols[0]).text(), lastDate);
    lastDate = date;
    bets.push({
      date,
      home,
      away,
      bet: h && g ? `${h}:${g}` : '-',
      odds: cols.length > 4
        ? (() => {
            const [oh, od, oa] = parseOdds($, cols[4]);
            return { home: oh, draw: od, away: oa };
          })()
        : { home: '-', draw: '-', away: '-' },
    });

    if (heimInput.length && gastInput.length) {
      editable.push({
        home,
        away,
        heimName: heimInput.attr('name')!,
        gastName: gastInput.attr('name')!,
      });
    }
  });

  return { editable, bets };
}

/** One member's bets for a matchday, as the admin page shows them. */
export async function fetchBetsForMember(
  page: Page,
  community: string,
  member: Member,
  matchday?: number,
): Promise<{ member: Member; matches: BetMatch[] }> {
  const $ = await loadPage(
    page,
    getAdminTipsUrl(community, member.tipperId, member.tippsaisonId, matchday),
  );
  return { member, matches: parseEditableRows($).bets };
}

/**
 * Place bets on behalf of another member.
 *
 * Deliberately mirrors placeBets, including the audit record, so acting for
 * someone else leaves the same trail as acting for yourself — with the
 * member recorded alongside.
 */
export async function placeBetsForMember(
  page: Page,
  community: string,
  member: Member,
  bets: string[],
  matchday?: number,
  submit = true,
  source: BetSource = 'unknown',
): Promise<PlacedBet[]> {
  if (submit) assertWritable('Placing bets for another member');

  const $ = await loadPage(
    page,
    getAdminTipsUrl(community, member.tipperId, member.tippsaisonId, matchday),
  );
  const { editable } = parseEditableRows($);
  if (!editable.length) {
    throw new Error(`No editable matches on the Tipps-nachtragen page for ${member.name}.`);
  }

  const { placed, audited } = fillMatchBets(page, $, bets, editable);

  // The submission must carry the member's id, or Kicktipp would apply these
  // bets to the admin's own entry. Rather than trust the page, check that the
  // id travels either in the form action or as a hidden field.
  if (submit) {
    const action = $('#kicktipp-content form').attr('action') || '';
    const hasHiddenId = $(`#kicktipp-content form input[name="tipperId"]`).length > 0;
    if (!action.includes(`tipperId=${member.tipperId}`) && !hasHiddenId) {
      throw new Error(
        `Refusing to submit: the Tipps-nachtragen form for ${member.name} does not carry their ` +
          'tipperId, so the bets could land on your own entry. This usually means Kicktipp ' +
          'changed the page; please report it.',
      );
    }
  }

  const record = {
    at: new Date().toISOString(),
    source,
    community,
    matchday: matchday ?? null,
    kind: 'match' as const,
    dryRun: !submit,
    bets: audited,
    onBehalfOf: member.name,
  };

  if (!submit) {
    appendAudit({ ...record, outcome: 'dry-run' });
    return placed;
  }

  await submitAudited(record, () => page.click('button[name="submitbutton"]'));

  return placed;
}
